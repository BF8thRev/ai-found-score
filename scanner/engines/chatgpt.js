// scanner/engines/chatgpt.js — OpenAI Responses API with the web_search tool.
//
// Docs: https://developers.openai.com/api/docs/guides/tools-web-search
//   POST https://api.openai.com/v1/responses
//   body: { model, input, tools: [{ type: "web_search", user_location: {...} }],
//           include: ["web_search_call.action.sources"] }
//   output[]: { type: "web_search_call", action: { type: "search", queries, sources } }
//             { type: "message", content: [{ type: "output_text", text,
//               annotations: [{ type: "url_citation", url, title, start_index, end_index }] }] }
// Citations = url_citation annotations only (what the answer actually cites).

import { resolveKeys, priceCall, stateName } from '../config.js';
import { fetchJson, makeCitations, questionText, baseResult, finish, timedPing } from './_common.js';

export const id = 'chatgpt';
export const API_BASE = 'https://api.openai.com/v1';

export function buildRequest({ question, business, model }) {
  const location = { type: 'approximate', country: 'US' };
  if (business?.town) location.city = String(business.town);
  if (business?.state || business?.town) location.region = stateName(business?.state);
  const body = {
    model,
    input: questionText(question),
    tools: [{ type: 'web_search', user_location: location }],
    include: ['web_search_call.action.sources'],
    store: false,
  };
  // Keep reasoning light on reasoning models (web_search rejects "minimal"); others reject the field.
  if (/^(gpt-5|o\d)/i.test(model)) body.reasoning = { effort: 'low' };
  return body;
}

/** Parse a Responses API body into { text, citations, usage, searches }. */
export function parseResponse(json) {
  const out = Array.isArray(json?.output) ? json.output : [];
  const texts = [];
  const cites = [];
  let searches = 0;
  for (const item of out) {
    if (item?.type === 'web_search_call') {
      if (!item.action || item.action.type === 'search' || item.action.type == null) searches++;
    } else if (item?.type === 'message') {
      for (const c of item.content || []) {
        if (c?.type !== 'output_text') continue;
        texts.push(c.text || '');
        for (const a of c.annotations || []) {
          if (a?.type === 'url_citation' && a.url) cites.push({ url: a.url, title: a.title || null });
        }
      }
    }
  }
  const text = texts.join('\n\n') || (typeof json?.output_text === 'string' ? json.output_text : '');
  const usage = json?.usage || {};
  return {
    text,
    citations: makeCitations(cites),
    searches,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    status: json?.status || null,
  };
}

export async function ask({ question, business, env, fetchImpl = fetch, timeoutMs } = {}) {
  const keys = resolveKeys(env);
  const model = keys.openaiModel;
  const body = buildRequest({ question, business, model });
  const request = { method: 'POST', url: `${API_BASE}/responses`, body };
  const result = baseResult(id, model, request);
  try {
    if (!keys.openaiKey) return finish(result, { error: 'missing OPENAI_API_KEY' });
    const r = await fetchJson(fetchImpl, request.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs });
    result.raw = r.json ?? (r.text ? { body: r.text } : null);
    if (!r.ok) return finish(result, { error: r.error });
    const p = parseResponse(r.json);
    const costUsd = priceCall(id, { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: p.searches });
    if (p.status && p.status !== 'completed' && !p.text) {
      return finish(result, { costUsd, error: `response status ${p.status}${r.json?.error ? `: ${r.json.error.message || ''}` : ''}` });
    }
    return finish(result, { ok: true, text: p.text, citations: p.citations, costUsd });
  } catch (e) {
    return finish(result, { error: `adapter error: ${e?.message || e}` });
  }
}

/** Light live check: GET /v1/models/{model} (free; proves the key and model are valid). */
export async function ping(env, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  return timedPing(id, async () => {
    const keys = resolveKeys(env);
    if (!keys.openaiKey) return { ok: false, status: 0, error: 'missing OPENAI_API_KEY', detail: null };
    const r = await fetchJson(fetchImpl, `${API_BASE}/models/${encodeURIComponent(keys.openaiModel)}`, {
      headers: { Authorization: `Bearer ${keys.openaiKey}` },
    }, { timeoutMs, retries: 0 });
    return { ok: r.ok, status: r.status, error: r.error, detail: r.ok ? { model: r.json?.id } : null };
  });
}
