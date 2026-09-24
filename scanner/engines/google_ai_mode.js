// scanner/engines/google_ai_mode.js — Google AI Mode through DataForSEO's SERP API (live, advanced).
//
// Docs: https://docs.dataforseo.com/v3/serp/google/ai_mode/live/advanced/
//   POST https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced   (HTTP Basic auth: login:password)
//   body: [{ keyword, location_name: "North Babylon,New York,United States", language_code: "en", device }]
//   response: { status_code: 20000, cost, tasks: [{ status_code, status_message, cost,
//     result: [{ items: [{ type: "ai_overview", markdown, items: [{ type, text, markdown, references, links }],
//                          references: [{ type: "ai_overview_reference", source, domain, url, title, text }] }] }] }] }
// Text = the ai_overview item's `markdown` (falls back to its elements' text).
// Citations = `references` (top level, then per element), never links scraped from the text.
//
// DataForSEO location names are "City,State,Country". A small town may be missing from their
// list; on a location error we retry once at state level and record that in the request.

import { resolveKeys, priceCall, stateName } from '../config.js';
import { fetchJson, makeCitations, questionText, baseResult, finish, timedPing } from './_common.js';

export const id = 'google_ai_mode';
export const API_BASE = 'https://api.dataforseo.com/v3';
export const ENDPOINT = `${API_BASE}/serp/google/ai_mode/live/advanced`;

export function locationName(business) {
  const state = stateName(business?.state);
  return business?.town ? `${String(business.town).trim()},${state},United States` : `${state},United States`;
}

export function buildRequest({ question, business, location }) {
  return [{
    keyword: questionText(question),
    location_name: location || locationName(business),
    language_code: 'en',
    device: 'mobile',
  }];
}

function basicAuth(login, password) {
  const s = `${login}:${password}`;
  // btoa is global in Workers and Node 16+; the credentials are ASCII.
  return `Basic ${btoa(s)}`;
}

/** Parse a DataForSEO response into { text, citations, cost, taskStatus }. */
export function parseResponse(json) {
  const task = json?.tasks?.[0] || null;
  const taskStatus = task?.status_code ?? null;
  const taskMessage = task?.status_message ?? null;
  const cost = typeof task?.cost === 'number' ? task.cost : (typeof json?.cost === 'number' ? json.cost : null);
  const res = task?.result?.[0] || null;
  const items = res?.items || [];
  const ai = items.find((i) => i?.type === 'ai_overview') || items.find((i) => i?.markdown || i?.text) || null;
  let text = '';
  const refs = [];
  if (ai) {
    text = ai.markdown || (ai.items || []).map((e) => e?.markdown || e?.text || '').filter(Boolean).join('\n\n') || ai.text || '';
    for (const r of ai.references || []) refs.push(r);
    for (const e of ai.items || []) for (const r of e?.references || []) refs.push(r);
  }
  const citations = makeCitations(refs.map((r) => ({ url: r.url, title: r.title || null, domain: r.domain || null, source: r.source || undefined })));
  return { text, citations, cost, taskStatus, taskMessage, hasResult: !!res, itemTypes: res?.item_types || [] };
}

const isLocationError = (p) => p.taskStatus >= 40000 && /location/i.test(String(p.taskMessage || ''));

export async function ask({ question, business, env, fetchImpl = fetch, timeoutMs } = {}) {
  const keys = resolveKeys(env);
  const model = 'google-ai-mode/live';
  let body = buildRequest({ question, business });
  const request = { method: 'POST', url: ENDPOINT, body };
  const result = baseResult(id, model, request);
  try {
    if (!keys.dataforseoLogin || !keys.dataforseoPassword) return finish(result, { error: 'missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD' });
    const headers = { Authorization: basicAuth(keys.dataforseoLogin, keys.dataforseoPassword), 'Content-Type': 'application/json' };
    const call = (b) => fetchJson(fetchImpl, ENDPOINT, { method: 'POST', headers, body: JSON.stringify(b) }, { timeoutMs });

    let r = await call(body);
    let p = r.ok && r.json ? parseResponse(r.json) : null;
    let totalCost = p?.cost || 0;
    if (p && isLocationError(p) && business?.town) {
      const fallback = `${stateName(business?.state)},United States`;
      request.locationFallback = { from: body[0].location_name, to: fallback, reason: p.taskMessage };
      request.firstResponse = r.json;
      body = buildRequest({ question, business, location: fallback });
      request.body = body;
      r = await call(body);
      p = r.ok && r.json ? parseResponse(r.json) : null;
      totalCost += p?.cost || 0;
    }
    result.raw = r.json ?? (r.text ? { body: r.text } : null);
    if (!r.ok) return finish(result, { costUsd: totalCost, error: r.error });
    if (r.json?.status_code !== 20000) return finish(result, { costUsd: totalCost, error: `DataForSEO ${r.json?.status_code}: ${r.json?.status_message}` });
    if (p.taskStatus !== 20000) return finish(result, { costUsd: totalCost, error: `DataForSEO task ${p.taskStatus}: ${p.taskMessage}` });
    const costUsd = totalCost || priceCall(id, { tasks: 1 });
    if (!p.text) return finish(result, { costUsd, error: `no AI Mode answer in result (item types: ${p.itemTypes.join(', ') || 'none'})` });
    return finish(result, { ok: true, text: p.text, citations: p.citations, costUsd });
  } catch (e) {
    return finish(result, { error: `adapter error: ${e?.message || e}` });
  }
}

/** Light live check: GET /v3/appendix/user_data (free; returns account balance). */
export async function ping(env, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  return timedPing(id, async () => {
    const keys = resolveKeys(env);
    if (!keys.dataforseoLogin || !keys.dataforseoPassword) return { ok: false, status: 0, error: 'missing DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD', detail: null };
    const r = await fetchJson(fetchImpl, `${API_BASE}/appendix/user_data`, {
      headers: { Authorization: basicAuth(keys.dataforseoLogin, keys.dataforseoPassword) },
    }, { timeoutMs, retries: 0 });
    const ok = r.ok && r.json?.status_code === 20000;
    const data = r.json?.tasks?.[0]?.result?.[0];
    return {
      ok,
      status: r.status,
      error: ok ? null : (r.error || `DataForSEO ${r.json?.status_code}: ${r.json?.status_message}`),
      detail: ok ? { balanceUsd: data?.money?.balance ?? null } : null,
    };
  });
}
