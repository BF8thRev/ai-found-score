// scanner/engines/gemini.js — Gemini API generateContent with Grounding with Google Search.
//
// Docs: https://ai.google.dev/gemini-api/docs/google-search , https://ai.google.dev/api/generate-content
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   header x-goog-api-key; body { contents: [{ role: "user", parts: [{ text }] }], tools: [{ google_search: {} }] }
//   candidates[0].content.parts[].text (parts with thought: true are skipped)
//   candidates[0].groundingMetadata: { webSearchQueries[], groundingChunks[{ web: { uri, title, domain? } }],
//                                      groundingSupports[], searchEntryPoint }
//   usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, toolUsePromptTokenCount }
//
// groundingChunks[].web.uri is a vertexaisearch.cloud.google.com/grounding-api-redirect/... link and
// web.title is usually the site's domain. By default we follow each redirect once (no body read)
// to record the real page URL; the redirect link is kept as `redirectUrl`.

import { resolveKeys, priceCall } from '../config.js';
import { fetchJson, makeCitations, questionText, baseResult, finish, timedPing, domainOf } from './_common.js';

export const id = 'gemini';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_REDIRECTS_RESOLVED = 12;

export function buildRequest({ question }) {
  return {
    contents: [{ role: 'user', parts: [{ text: questionText(question) }] }],
    tools: [{ google_search: {} }],
  };
}

const looksLikeDomain = (s) => typeof s === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim());

/** Parse a generateContent body into { text, citations (unresolved), usage, searches }. */
export function parseResponse(json) {
  const cand = json?.candidates?.[0] || {};
  const parts = cand.content?.parts || [];
  const text = parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
  const gm = cand.groundingMetadata || {};
  const cites = [];
  for (const ch of gm.groundingChunks || []) {
    const w = ch?.web;
    if (!w?.uri) continue;
    const titleDomain = looksLikeDomain(w.title) ? w.title.toLowerCase() : null;
    const uriDomain = domainOf(w.uri);
    const isRedirect = uriDomain === 'vertexaisearch.cloud.google.com';
    cites.push({
      url: w.uri,
      title: w.title || null,
      domain: w.domain || titleDomain || (isRedirect ? null : uriDomain),
    });
  }
  const u = json?.usageMetadata || {};
  const queries = Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries : [];
  return {
    text,
    citations: cites,
    queries,
    // Billed per search query executed; a grounded answer with no query list counts as one.
    searches: queries.length || (cites.length ? 1 : 0),
    inputTokens: (u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0),
    outputTokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
    finishReason: cand.finishReason || null,
    blockReason: json?.promptFeedback?.blockReason || null,
  };
}

/** Follow one hop of a grounding redirect without downloading the page. Returns the target or null. */
export async function resolveRedirect(fetchImpl, url, timeoutMs = 8000) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: ac?.signal });
    const loc = res.headers?.get?.('location');
    try { await res.body?.cancel?.(); } catch { /* ignore */ }
    if (loc && res.status >= 300 && res.status < 400) return new URL(loc, url).toString();
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveCitations(fetchImpl, cites) {
  const toResolve = cites.filter((c) => domainOf(c.url) === 'vertexaisearch.cloud.google.com').slice(0, MAX_REDIRECTS_RESOLVED);
  await Promise.all(toResolve.map(async (c) => {
    const target = await resolveRedirect(fetchImpl, c.url);
    if (target) {
      c.redirectUrl = c.url;
      c.url = target;
      c.domain = domainOf(target) || c.domain;
    }
  }));
  return cites;
}

export async function ask({ question, business, env, fetchImpl = fetch, timeoutMs, resolveRedirects } = {}) {
  const keys = resolveKeys(env);
  const model = keys.geminiModel;
  const body = buildRequest({ question, business });
  const request = { method: 'POST', url: `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, body };
  const result = baseResult(id, model, request);
  try {
    if (!keys.geminiKey) return finish(result, { error: 'missing GEMINI_API_KEY' });
    const r = await fetchJson(fetchImpl, request.url, {
      method: 'POST',
      headers: { 'x-goog-api-key': keys.geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { timeoutMs });
    result.raw = r.json ?? (r.text ? { body: r.text } : null);
    if (!r.ok) return finish(result, { error: r.error });
    const p = parseResponse(r.json);
    const costUsd = priceCall(id, { inputTokens: p.inputTokens, outputTokens: p.outputTokens, searches: p.searches });
    if (!p.text) {
      const why = p.blockReason ? `blocked: ${p.blockReason}` : `no text (finishReason ${p.finishReason || 'none'})`;
      return finish(result, { costUsd, error: why });
    }
    let cites = p.citations;
    if (resolveRedirects ?? keys.geminiResolveRedirects) cites = await resolveCitations(fetchImpl, cites);
    return finish(result, { ok: true, text: p.text, citations: makeCitations(cites), costUsd });
  } catch (e) {
    return finish(result, { error: `adapter error: ${e?.message || e}` });
  }
}

/** Light live check: GET /v1beta/models/{model} (free; proves the key and model name). */
export async function ping(env, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  return timedPing(id, async () => {
    const keys = resolveKeys(env);
    if (!keys.geminiKey) return { ok: false, status: 0, error: 'missing GEMINI_API_KEY', detail: null };
    const r = await fetchJson(fetchImpl, `${API_BASE}/models/${encodeURIComponent(keys.geminiModel)}`, {
      headers: { 'x-goog-api-key': keys.geminiKey },
    }, { timeoutMs, retries: 0 });
    return { ok: r.ok, status: r.status, error: r.error, detail: r.ok ? { model: r.json?.name } : null };
  });
}
