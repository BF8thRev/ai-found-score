// Live preview on the free-report form: "Here's what <assistant> said just now".
//
// After a visitor's first submit passes Turnstile, POST /api/request returns a short-lived signed
// preview token (signPreviewToken) that carries the request id and what they typed. The page can
// then POST /api/live-preview {request_id, question_id, token} to ask ONE of their five questions to
// ONE assistant right away (handleLivePreview). No second Turnstile solve, no DB read of the request.
//
// Brakes, in order:
//   1. Off unless Turnstile is configured, a signing key exists (PREVIEW_SIGNING_KEY, else
//      TURNSTILE_SECRET_KEY), an engine has a key, and the Supabase service key is set (the caps
//      below are counted from scan_usage; without it they can't be enforced, so no preview).
//   2. A valid, unexpired token for this request_id (proves the Turnstile-checked first submit).
//   3. PREVIEW_LIMITER binding (per IP, per minute: the binding has no daily period).
//   4. From today's (UTC) scan_usage rows kind='other', answer_ref 'live-preview:*':
//        global spend  >= LIVE_PREVIEW_DAILY_USD (default 1.00) -> off for the day
//        this IP       >= PER_IP_DAILY attempts                 -> "try tomorrow"
//        this request  >= PER_REQUEST_OK answers                -> "already asked"
//      The IP is stored only as a keyed one-way code (ipCode), never the address.
//   5. One engine call (cheapest with a key: PREVIEW_ORDER), ~40 s cap, no extractor call. Its cost
//      is recorded as scan_usage {kind 'other', provider <engine>, answer_ref
//      'live-preview:<request_id>:<question_id>:<ipcode>'}.
// Any failure -> 200 {ok:false, message} ("We'll include it in your full report.").
//
// Local testing: SCANNER_DRY_RUN=1 + a localhost request answers from the recorded fixtures and
// skips Supabase entirely (src/admin/dry-run.js). Pure helpers are exported for tests.

import { buildQuestions } from '../../scanner/questions.js';
import { resolveKeys, enginesConfigured, ENGINE_NAMES, priceCall, TYPICAL_CALL } from '../../scanner/config.js';
import { ENGINES } from '../../scanner/engines/index.js';
import { usageRow, saveUsage } from '../../scanner/store.js';
import { turnstileConfigured } from './turnstile.js';

/** Cheapest first. */
export const PREVIEW_ORDER = ['gemini', 'chatgpt', 'google_ai_mode', 'perplexity', 'claude'];
export const PREVIEW_TIMEOUT_MS = 40_000;
export const DEFAULT_DAILY_USD = 1;
export const PER_IP_DAILY = 3;
export const PER_REQUEST_OK = 1;
export const TOKEN_TTL_S = 60 * 60;
export const REF_PREFIX = 'live-preview';

export const MSG = {
  off: 'Live answers are switched off right now. We\'ll include every answer in your full report.',
  fallback: 'We couldn\'t get an answer just now. We\'ll include it in your full report.',
  cap: 'We\'ve run all of today\'s live answers. We\'ll include this one in your full report.',
  ipLimit: 'That\'s all the live answers for your connection today. We\'ll include the rest in your full report.',
  requestLimit: 'You\'ve seen a live answer for this request. The rest are in your full report.',
  busy: 'Too many tries from your connection. Wait a minute and try again.',
  expired: 'This page has been open a while. Reload it to ask a question live.',
  bad: 'Bad request',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function signingKey(env) {
  return String(env?.PREVIEW_SIGNING_KEY || env?.TURNSTILE_SECRET_KEY || '').trim();
}

/** Global daily cap in USD (LIVE_PREVIEW_DAILY_USD, default 1.00; 0 switches previews off). */
export function dailyCapUsd(env) {
  const raw = String(env?.LIVE_PREVIEW_DAILY_USD ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_USD;
}

/** First engine in PREVIEW_ORDER with a key, or null. */
export function pickEngine(env) {
  const on = enginesConfigured(env);
  return PREVIEW_ORDER.find((e) => on[e] && ENGINES[e]) || null;
}

/**
 * Whether previews can run. `dryRun` (local only) doesn't need the Supabase service key.
 * → { enabled, reason: null | 'turnstile' | 'signing-key' | 'no-engine' | 'no-store' | 'cap-zero' }
 */
export function livePreviewStatus(env, { dryRun = false } = {}) {
  if (!turnstileConfigured(env)) return { enabled: false, reason: 'turnstile' };
  if (!signingKey(env)) return { enabled: false, reason: 'signing-key' };
  // A dry run answers from fixtures (dryRunEnv supplies fake keys), so it needs no real key.
  if (!dryRun && !pickEngine(env)) return { enabled: false, reason: 'no-engine' };
  const k = resolveKeys(env);
  if (!dryRun && !(k.supabaseUrl && k.supabaseServiceKey)) return { enabled: false, reason: 'no-store' };
  if (dailyCapUsd(env) <= 0) return { enabled: false, reason: 'cap-zero' };
  return { enabled: true, reason: null };
}

// ---------------------------------------------------------------------------
// signed token
// ---------------------------------------------------------------------------

const b64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function hmac(key, text) { // key: the secret; text: what is signed
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(text)));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * Token for a request that just passed Turnstile. `req` = { id, businessName, trade, town, zip, state }.
 * → "payload.signature" (base64url), or null without a signing key.
 */
export async function signPreviewToken(env, req, { now = Date.now() } = {}) {
  const key = signingKey(env);
  if (!key || !req?.id) return null;
  const body = {
    v: 1,
    id: req.id,
    n: String(req.businessName || '').slice(0, 120),
    t: req.trade || '',
    c: String(req.town || '').slice(0, 60),
    z: req.zip || '',
    s: req.state || 'NY',
    exp: Math.floor(now / 1000) + TOKEN_TTL_S,
  };
  const payload = b64u(enc.encode(JSON.stringify(body)));
  return `${payload}.${b64u(await hmac(key, `${REF_PREFIX}:v1:${payload}`))}`;
}

/** → the token's fields { id, name, trade, town, zip, state } or null (bad signature, expired, malformed). */
export async function verifyPreviewToken(env, token, { now = Date.now() } = {}) {
  const key = signingKey(env);
  if (!key || typeof token !== 'string' || token.length > 2000) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  try {
    const want = await hmac(key, `${REF_PREFIX}:v1:${payload}`);
    if (!sameBytes(want, unb64u(sig))) return null;
    const b = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (b?.v !== 1 || !UUID_RE.test(String(b.id)) || !(Number(b.exp) * 1000 > now)) return null;
    return { id: b.id, name: String(b.n || ''), trade: String(b.t || ''), town: String(b.c || ''), zip: String(b.z || ''), state: String(b.s || 'NY') };
  } catch {
    return null;
  }
}

/** Keyed one-way code for an IP (12 hex chars), so the per-IP daily count stores no address. */
export async function ipCode(env, ip) {
  const bytes = await hmac(signingKey(env) || 'none', `${REF_PREFIX}:ip:${ip || 'unknown'}`);
  return Array.from(bytes.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Where `name` appears in `text` as a literal, case-insensitive substring.
 * → [[start, end], ...] (non-overlapping, in order). Regex metacharacters in the name are literal.
 */
export function nameRanges(text, name) {
  const t = String(text ?? '');
  const n = String(name ?? '').trim();
  if (!t || n.length < 2) return [];
  const re = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const out = [];
  for (const m of t.matchAll(re)) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Unique cited domains, in order. */
export function citedDomains(citations) {
  const seen = new Set();
  const out = [];
  for (const c of citations || []) {
    const d = String(c?.domain || '').toLowerCase().replace(/^www\./, '');
    if (d && !seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out.slice(0, 20);
}

export function startOfUtcDay(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Decide from today's usage rows whether one more preview may run.
 * rows: [{ cost_usd, answer_ref, ok }]. → null (go) or { reason, message }.
 */
export function capCheck(rows, { capUsd, requestId, ip, estimateUsd = 0 }) {
  let spent = 0;
  let perIp = 0;
  let perRequest = 0;
  for (const r of rows || []) {
    spent += Number(r?.cost_usd) || 0;
    const parts = String(r?.answer_ref || '').split(':');
    if (parts[0] !== REF_PREFIX) continue;
    if (ip && parts[3] === ip) perIp++;
    if (parts[1] === requestId && r?.ok !== false) perRequest++;
  }
  if (spent + estimateUsd > capUsd) return { reason: 'cap', message: MSG.cap };
  if (perIp >= PER_IP_DAILY) return { reason: 'ip', message: MSG.ipLimit };
  if (perRequest >= PER_REQUEST_OK) return { reason: 'request', message: MSG.requestLimit };
  return null;
}

// ---------------------------------------------------------------------------
// Supabase (service key; scan_usage is service-only)
// ---------------------------------------------------------------------------

export async function readTodayUsage(env, sinceIso, { fetchImpl = fetch } = {}) {
  const k = resolveKeys(env);
  const q = `kind=eq.other&answer_ref=like.${REF_PREFIX}*&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,created_at,cost_usd,answer_ref,ok&limit=5000`;
  const res = await fetchImpl(`${k.supabaseUrl}/rest/v1/scan_usage?${q}`, {
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`scan_usage read failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

/** Update one scan_usage row (the preview's reservation) in place. Never throws. */
export async function patchUsage(env, id, fields, { fetchImpl = fetch } = {}) {
  try {
    const k = resolveKeys(env);
    const res = await fetchImpl(`${k.supabaseUrl}/rest/v1/scan_usage?id=eq.${id}`, {
      method: 'PATCH',
      headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Rows that were reserved before ours, for the per-request / per-IP limits. Concurrent previews
 * each write a reservation first and then re-count. Order is (created_at, id): a row written after
 * we had already re-read sorts after ours, so it can't be skipped by the later request. The id
 * only breaks created_at ties. The DOLLAR cap does not use this: it counts every other row.
 */
export function rowsBefore(rows, ownId) {
  const key = (r) => [String(r?.created_at || ''), String(r?.id || '')];
  const own = (rows || []).find((r) => r?.id === ownId);
  // Our own row not visible (should not happen): count every other row, i.e. stay conservative.
  const [oc, oi] = [own ? String(own.created_at || '') : '~', String(ownId)];
  return (rows || []).filter((r) => {
    if (r?.id === ownId) return false;
    const [c, i] = key(r);
    return c < oc || (c === oc && i < oi);
  });
}

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const soft = (message, reason) => reply({ ok: false, reason, message });

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `timeout after ${ms}ms`, costUsd: 0, timedOut: true }), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * POST /api/live-preview. deps (tests / dry run):
 *   now, fetchImpl (engine calls), readUsage(env, sinceIso), saveUsage(env, rows),
 *   limiter ({limit({key})} ; default env.PREVIEW_LIMITER), dryRun (skip Supabase), timeoutMs, waitUntil
 */
export async function handleLivePreview(request, env, deps = {}) {
  const now = deps.now ?? Date.now();
  const dryRun = !!deps.dryRun;
  const status = livePreviewStatus(env, { dryRun });
  if (!status.enabled) return soft(MSG.off, `off:${status.reason}`);

  let body;
  try { body = await request.json(); } catch { body = null; }
  const requestId = String(body?.request_id || '').trim().toLowerCase();
  const questionId = String(body?.question_id || '').trim();
  if (!UUID_RE.test(requestId) || !/^[a-z0-9_-]{1,40}$/i.test(questionId)) return reply({ ok: false, reason: 'bad', message: MSG.bad }, 400);

  const tok = await verifyPreviewToken(env, body?.token, { now });
  if (!tok || tok.id !== requestId) return reply({ ok: false, reason: 'token', message: MSG.expired }, 403);

  // Per-IP, per-minute brake (the binding only has 10 s / 60 s periods).
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limiter = deps.limiter ?? env?.PREVIEW_LIMITER;
  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key: `preview:${ip}` });
      if (!success) return reply({ ok: false, reason: 'busy', message: MSG.busy }, 429);
    } catch (e) {
      console.error('[live-preview] limiter failed', String(e?.message || e).slice(0, 200));
    }
  }

  let question = null;
  try {
    question = buildQuestions({ trade: tok.trade, town: tok.town, zip: tok.zip, state: tok.state }).find((q) => q.id === questionId) || null;
  } catch { /* no town: treated as a bad request */ }
  if (!question) return reply({ ok: false, reason: 'bad', message: MSG.bad }, 400);

  const engine = pickEngine(env);
  const code = await ipCode(env, ip);

  // Daily caps from scan_usage. Fail closed: if they can't be counted, nothing is spent.
  if (!dryRun) {
    let rows;
    try {
      rows = await (deps.readUsage || readTodayUsage)(env, startOfUtcDay(now));
    } catch (e) {
      console.error('[live-preview] usage read failed', String(e?.message || e).slice(0, 200));
      return soft(MSG.fallback, 'store');
    }
    const stop = capCheck(rows, {
      capUsd: dailyCapUsd(env), requestId, ip: code, estimateUsd: priceCall(engine, TYPICAL_CALL[engine]),
    });
    if (stop) return soft(stop.message, stop.reason);
  }

  // Reserve the estimated cost BEFORE spending, then re-count including every other reservation.
  const estimateUsd = priceCall(engine, TYPICAL_CALL[engine]);
  const answerRef = `${REF_PREFIX}:${requestId}:${question.id}:${code}`;
  const reservationId = (deps.uuid || (() => crypto.randomUUID()))();
  if (!dryRun) {
    const reserved = await (deps.saveUsage || saveUsage)(env, [usageRow({
      id: reservationId, kind: 'other', provider: engine, model: null, costUsd: estimateUsd,
      ok: true, error: 'pending', answerRef,
    })]).catch((e) => ({ ok: false, error: String(e?.message || e) }));
    if (!reserved || reserved.ok === false) return soft(MSG.fallback, 'store');
    let rows;
    try {
      rows = await (deps.readUsage || readTodayUsage)(env, startOfUtcDay(now));
    } catch {
      rows = null;
    }
    // Spend: every other row today, including other in-flight reservations (fails closed: two
    // racing requests near the cap may both stop). Limits: only rows ordered before ours, so
    // exactly one of two racing previews for the same request goes ahead.
    const others = rows && rows.filter((r) => r?.id !== reservationId);
    const stop = !rows
      ? { reason: 'store', message: MSG.fallback }
      : capCheck(others, { capUsd: dailyCapUsd(env), requestId: null, ip: null, estimateUsd })
        || capCheck(rowsBefore(rows, reservationId), { capUsd: Infinity, requestId, ip: code, estimateUsd: 0 });
    if (stop) {
      await (deps.patchUsage || patchUsage)(env, reservationId, { cost_usd: 0, ok: false, error: `cancelled: ${stop.reason}` });
      return soft(stop.message, stop.reason);
    }
  }

  const business = { name: tok.name, town: tok.town, state: tok.state, zip: tok.zip, trade: tok.trade };
  const timeoutMs = deps.timeoutMs ?? PREVIEW_TIMEOUT_MS;
  let result;
  try {
    result = await withTimeout(ENGINES[engine].ask({
      question: { id: question.id, text: question.text },
      business,
      env,
      fetchImpl: deps.fetchImpl || fetch,
      timeoutMs,
      // Gemini: don't follow each citation redirect (up to a dozen extra subrequests); titles carry the domain.
      resolveRedirects: false,
      retries: 0,
    }), timeoutMs);
  } catch (e) {
    result = { ok: false, error: `adapter error: ${e?.message || e}`, costUsd: 0 };
  }

  if (!dryRun) {
    // A timed-out call reports cost 0 but the provider may still bill it: keep the estimate.
    const cost = result?.timedOut ? estimateUsd : (result?.costUsd || 0);
    const write = (deps.patchUsage || patchUsage)(env, reservationId, {
      provider: engine, model: result?.model || null, cost_usd: cost,
      ok: result?.ok === true, error: result?.ok ? null : String(result?.error || 'failed').slice(0, 500),
    }).then((r) => { if (r && r.ok === false) console.error('[live-preview] usage update failed', String(r.error).slice(0, 200)); });
    if (deps.waitUntil) deps.waitUntil(write); else await write;
  }

  if (!result?.ok || !String(result.text || '').trim()) {
    console.warn('[live-preview] engine failed', engine, String(result?.error || '').slice(0, 200));
    return soft(MSG.fallback, result?.timedOut ? 'timeout' : 'engine');
  }

  const text = String(result.text);
  const ranges = nameRanges(text, tok.name);
  return reply({
    ok: true,
    engine,
    assistant: ENGINE_NAMES[engine] || engine,
    question: question.text,
    questionId: question.id,
    answer: text,
    citations: citedDomains(result.citations),
    named: ranges.length > 0,
    ranges,
    businessName: tok.name,
    askedAt: result.askedAt || new Date(now).toISOString(),
  });
}
