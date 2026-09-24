// scanner/engines/_common.js — helpers shared by the engine adapters.
// Runtime-agnostic: global fetch/AbortController only.

import { DEFAULT_TIMEOUT_MS } from '../config.js';

export const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * fetch + JSON parse with a timeout and one retry on 429/5xx/network error.
 * Never throws. Returns { ok, status, json, text, error, attempts }.
 * `json` is the parsed body whenever the body was JSON, success or not.
 */
export async function fetchJson(fetchImpl, url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1, retryDelayMs = 2000 } = {}) {
  let last = { ok: false, status: 0, json: null, text: null, error: 'not attempted', attempts: 0 };
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    let timedOut = false;
    try {
      const res = await fetchImpl(url, { ...init, signal: ac?.signal });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      last = {
        ok: res.ok,
        status: res.status,
        json,
        text: json ? null : truncate(text, 2000),
        error: res.ok ? null : `HTTP ${res.status}: ${errorMessage(json) || truncate(text, 300) || res.statusText || 'error'}`,
        attempts: attempt,
      };
      if (res.ok || !RETRY_STATUSES.has(res.status)) return last;
    } catch (e) {
      timedOut = e?.name === 'AbortError';
      last = {
        ok: false, status: 0, json: null, text: null, attempts: attempt,
        error: timedOut ? `timeout after ${timeoutMs}ms` : `network error: ${e?.message || e}`,
      };
      // A timed-out call may still be billed; don't pay twice.
      if (timedOut) return last;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (attempt <= retries && retryDelayMs > 0) await sleep(retryDelayMs * attempt);
  }
  return last;
}

export function errorMessage(json) {
  if (!json || typeof json !== 'object') return null;
  const e = json.error;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.message || e.status || JSON.stringify(e).slice(0, 300);
  if (json.status_message && json.status_code && json.status_code !== 20000) return `${json.status_code} ${json.status_message}`;
  if (json.message) return json.message;
  return null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncate(s, n) {
  if (s == null) return s;
  s = String(s);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Lower-case hostname without a leading "www.". Null if not a URL. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Tracking params some APIs append to cited URLs (OpenAI adds utm_source=openai).
const STRIP_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

export function cleanUrl(url) {
  try {
    const u = new URL(url);
    for (const p of STRIP_PARAMS) u.searchParams.delete(p);
    if (u.hash === '#:~:text=' || u.hash.startsWith('#:~:text=')) u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Build a citation list: clean URLs, add domain, drop empties, dedupe by URL (first wins).
 * Input items: { url, title?, domain?, ...extra }.
 */
export function makeCitations(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    if (!it || !it.url) continue;
    const url = cleanUrl(String(it.url));
    if (seen.has(url)) continue;
    seen.add(url);
    const c = { ...it, url, domain: it.domain ? String(it.domain).toLowerCase().replace(/^www\./, '') : domainOf(url) };
    if (c.title == null || c.title === '') delete c.title;
    out.push(c);
  }
  return out;
}

export function questionText(question) {
  return typeof question === 'string' ? question : String(question?.text || '');
}

/** Result skeleton every adapter returns (see docs/CONTRACT_V2.md). */
export function baseResult(engine, model, request) {
  return {
    engine,
    ok: false,
    text: null,
    citations: [],
    request,
    raw: null,
    costUsd: 0,
    error: null,
    askedAt: new Date().toISOString(),
    model,
  };
}

/** Finalise a result; never throws. */
export function finish(result, patch) {
  Object.assign(result, patch);
  if (result.ok && !(result.text && result.text.trim())) {
    result.ok = false;
    result.error ||= 'empty answer';
  }
  if (!result.ok && !result.error) result.error = 'unknown error';
  if (result.ok) result.error = null;
  result.costUsd = Math.round((Number(result.costUsd) || 0) * 1e6) / 1e6;
  return result;
}

/** Ping result skeleton. */
export async function timedPing(engine, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { engine, ms: Date.now() - t0, ...r };
  } catch (e) {
    return { engine, ok: false, status: 0, error: String(e?.message || e), detail: null, ms: Date.now() - t0 };
  }
}
