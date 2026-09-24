// scanner/engines/perplexity.js — Perplexity Agent API (the replacement for Sonar chat completions).
//
// Sonar chat completions retire on 2026-09-27; Perplexity maps `sonar` → preset "fast".
// Docs: https://docs.perplexity.ai/api-reference/agent-post
//       https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to
//   POST https://api.perplexity.ai/v1/agent   (Authorization: Bearer <key>)
//   body: { preset: "fast", input, tools: [{ type: "web_search", user_location: { city, region, country } }] }
//   The API rejects unknown fields with HTTP 400, so the body stays minimal.
//   response: { status, output: [
//       { type: "message", content: [{ type: "output_text", text, annotations: [{ type: "url_citation", url, title }] }] },
//       { type: "search_results", queries: [...], results: [{ id, url, title, snippet, date }] } ],
//     output_text?, usage: { input_tokens, output_tokens, cost: { total_cost, ... } }, error }
//   Citations appear as [n] markers in the text; n matches search_results.results[].id.
//   Failed runs can return HTTP 200 with status "failed" and `error` set.
//
// The parser also accepts the legacy Sonar shape (choices[0].message.content + citations[] +
// search_results[]) so old recorded responses still parse.

import { resolveKeys, priceCall, stateName } from '../config.js';
import { fetchJson, makeCitations, questionText, baseResult, finish, timedPing } from './_common.js';

export const id = 'perplexity';
export const API_URL = 'https://api.perplexity.ai/v1/agent';

export function buildRequest({ question, business, model }) {
  const body = model.includes('/') ? { model } : { preset: model };
  body.input = questionText(question);
  const loc = { country: 'US' };
  if (business?.town) loc.city = String(business.town);
  if (business?.state || business?.town) loc.region = stateName(business?.state);
  // Request fields override preset values; web_search is the fast preset's own tool.
  body.tools = [{ type: 'web_search', user_location: loc }];
  return body;
}

/** Parse an Agent API (or legacy Sonar) body into { text, citations, cost }. */
export function parseResponse(json) {
  if (Array.isArray(json?.choices)) return parseSonar(json);
  const out = Array.isArray(json?.output) ? json.output : [];
  const texts = [];
  const annotations = [];
  const results = [];
  for (const item of out) {
    if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (c?.type !== 'output_text') continue;
        texts.push(c.text || '');
        for (const a of c.annotations || []) if (a?.type === 'url_citation' && a.url) annotations.push({ url: a.url, title: a.title || null });
      }
    } else if (item?.type === 'search_results') {
      for (const r of item.results || []) if (r?.url) results.push(r);
    }
  }
  const text = texts.join('\n\n') || (typeof json?.output_text === 'string' ? json.output_text : '');
  const cites = citedFromMarkers(text, results, annotations);
  const usage = json?.usage || {};
  const searches = usage.tool_calls_details?.web_search?.invocation ?? (results.length ? 1 : 0);
  return {
    text,
    citations: makeCitations(cites),
    reportedCost: typeof usage.cost?.total_cost === 'number' ? usage.cost.total_cost : null,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    searches,
    status: json?.status || null,
    apiError: json?.error ? (json.error.message || JSON.stringify(json.error)) : null,
  };
}

// Sources the answer actually cites: [n] markers → search result with id n (or the n-th result
// when ids are absent), plus url_citation annotations. If the answer has no markers at all,
// fall back to every returned search result, flagged `uncited: true`.
function citedFromMarkers(text, results, annotations) {
  const nums = [...String(text).matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
  const byId = new Map(results.filter((r) => r.id != null).map((r) => [Number(r.id), r]));
  const cites = [];
  for (const n of nums) {
    const r = byId.get(n) || (byId.size === 0 ? results[n - 1] : null);
    if (r) cites.push({ url: r.url, title: r.title || null, ref: n });
  }
  cites.push(...annotations);
  if (!cites.length) for (const r of results) cites.push({ url: r.url, title: r.title || null, uncited: true });
  return cites;
}

function parseSonar(json) {
  const text = json.choices?.[0]?.message?.content || '';
  const titles = new Map((json.search_results || []).map((r) => [r.url, r.title]));
  const urls = Array.isArray(json.citations) && json.citations.length ? json.citations : (json.search_results || []).map((r) => r.url);
  const usage = json.usage || {};
  const cost = typeof usage.cost?.total_cost === 'number' ? usage.cost.total_cost : (typeof usage.total_cost === 'number' ? usage.total_cost : null);
  return {
    text,
    citations: makeCitations(urls.map((url) => ({ url, title: titles.get(url) || null }))),
    reportedCost: cost,
    inputTokens: usage.prompt_tokens || 0,
    outputTokens: usage.completion_tokens || 0,
    searches: 1,
    status: 'completed',
    apiError: null,
  };
}

export async function ask({ question, business, env, fetchImpl = fetch, timeoutMs } = {}) {
  const keys = resolveKeys(env);
  const model = keys.perplexityModel;
  const body = buildRequest({ question, business, model });
  const request = { method: 'POST', url: API_URL, body };
  const result = baseResult(id, model, request);
  try {
    if (!keys.perplexityKey) return finish(result, { error: 'missing PERPLEXITY_API_KEY' });
    const r = await fetchJson(fetchImpl, API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.perplexityKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs });
    result.raw = r.json ?? (r.text ? { body: r.text } : null);
    if (!r.ok) return finish(result, { error: r.error });
    const p = parseResponse(r.json);
    const costUsd = p.reportedCost ?? priceCall(id, p);
    if (p.status && !['completed', 'incomplete'].includes(p.status)) {
      return finish(result, { costUsd, error: `run ${p.status}${p.apiError ? `: ${p.apiError}` : ''}` });
    }
    return finish(result, { ok: true, text: p.text, citations: p.citations, costUsd });
  } catch (e) {
    return finish(result, { error: `adapter error: ${e?.message || e}` });
  }
}

/**
 * Light live check: one tiny Agent API request with tools switched off (max_tool_calls: 0)
 * and a short output cap. Costs a fraction of a cent. Perplexity has no free key-check endpoint.
 */
export async function ping(env, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  return timedPing(id, async () => {
    const keys = resolveKeys(env);
    if (!keys.perplexityKey) return { ok: false, status: 0, error: 'missing PERPLEXITY_API_KEY', detail: null };
    const m = keys.perplexityModel;
    const body = { ...(m.includes('/') ? { model: m } : { preset: m }), input: 'Reply with the word OK.', max_tool_calls: 0, max_output_tokens: 64 };
    const r = await fetchJson(fetchImpl, API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.perplexityKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs, retries: 0 });
    const failed = r.ok && r.json?.status === 'failed';
    return {
      ok: r.ok && !failed,
      status: r.status,
      error: failed ? `run failed: ${r.json?.error?.message || ''}` : r.error,
      detail: r.ok ? { model: r.json?.model, status: r.json?.status, costUsd: r.json?.usage?.cost?.total_cost ?? null } : null,
    };
  });
}
