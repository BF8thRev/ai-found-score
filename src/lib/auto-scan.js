// Automatic scans for free-report requests (POST /api/request, src/lib/report-request.js).
//
// A new request that passed Turnstile gets a report link right away (/report/<token>, token: 22
// random chars from [A-Za-z0-9_-]) and a `scans` row (trigger 'request') that the report page reads
// while the report is being made (pendingReportStatus → GET /api/report/<token> answers 202).
//
//   AUTO_SCAN=on         start a ScanWorkflow for it at once (activeEngines(env), 1 run, 5 questions).
//   AUTO_SCAN unset/off  the row is 'queued'; /admin lists it with a "Run now" button (runQueuedScan).
//
// Brakes, in order (a request that trips one is QUEUED, never dropped; the page still gets its link):
//   1. Dedupe: the same normalized business name + ZIP (request_key) within 7 days → the existing
//      report token is returned and nothing new is created or scanned.
//   2. Per-IP: the REQUEST_LIMITER binding, bucket 'autoscan' (per minute, per location).
//   3. Daily caps over today's (UTC) automatic request scans in `scans` (queued rows don't count):
//        AUTO_SCAN_DAILY_MAX (default 25) scans, AUTO_SCAN_DAILY_USD (default 20) dollars.
//      Reserve-then-verify, like src/lib/live-preview.js: our row is written first as 'running' with
//      its estimated cost (est_cost_usd), then today's rows are re-read. Count: only rows ordered
//      before ours (created_at, id) count, so of two racing requests at the cap exactly one runs.
//      Spend: every other row counts (finished scans at their real cost, unfinished ones at the larger
//      of estimate and cost so far), which fails closed. A request that loses is demoted to 'queued'.
//      The dedupe check is re-run the same way after the write, so two identical submits at the same
//      moment end up on one report.
// Needs supabase/v4_ladder.sql (request_key, business, est_cost_usd) and SUPABASE_SERVICE_KEY. Any
// failure before the row exists → null (the request is still saved; the page just gets no link).
//
// Local dry run (SCANNER_DRY_RUN=1 + localhost): no Supabase at all. The workflow answers from the
// recorded fixtures and the token's state lives in this isolate's memory (DRY_RUN_REQUESTS).

import { activeEngines, estimateScanCost, priceCall, TYPICAL_CALL } from '../../scanner/config.js';
import { canStore, upsertScan, stableUuid, getScan } from '../../scanner/store.js';
import { resolveKeys } from '../../scanner/config.js';
import { parseScanRequest } from '../admin/scan-core.js';
import { normalizeBizName } from '../../shared/report-v2.js';
import { rowsBefore, startOfUtcDay } from './live-preview.js';

export const DEFAULT_DAILY_MAX = 25;
export const DEFAULT_DAILY_USD = 20;
export const DEDUPE_DAYS = 7;
/** Tokens this module hands out: 22 chars of base64url (128 random bits). */
export const REQUEST_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Any token worth looking up in `scans` (older admin tokens are 10 chars). */
const LOOKUP_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** token → { scanId, status } for local dry runs only (no database). */
export const DRY_RUN_REQUESTS = new Map();

// ---------------------------------------------------------------------------
// config + pure helpers
// ---------------------------------------------------------------------------

export function autoScanOn(env) {
  return String(env?.AUTO_SCAN ?? '').trim().toLowerCase() === 'on';
}

function numEnv(raw, fallback) {
  const s = String(raw ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function autoScanLimits(env) {
  return {
    max: Math.floor(numEnv(env?.AUTO_SCAN_DAILY_MAX, DEFAULT_DAILY_MAX)),
    usd: numEnv(env?.AUTO_SCAN_DAILY_USD, DEFAULT_DAILY_USD),
  };
}

/** A random, unguessable report token: 16 random bytes as base64url (22 chars, [A-Za-z0-9_-]). */
export function newRequestToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The scan id for a request token (also the Workflow instance id): stable, so a dry run can find it. */
export function requestScanId(token) {
  return stableUuid(`request-scan:${token}`);
}

/** Dedupe key: normalized business name + ZIP ("harborview plumbing and heating|11758"). */
export function requestKey(business) {
  return `${normalizeBizName(business?.name).trim()}|${String(business?.zip || '').trim()}`;
}

/** What one automatic scan is reserved at: 5 questions × engines × 1 run, extraction, and the headline re-ask. */
export function estimateRequestScanUsd(engines) {
  const base = estimateScanCost({ engines, questions: 5, runs: 1 }).total;
  const confirm = Math.max(0, ...engines.map((e) => priceCall(e, TYPICAL_CALL[e]))) + priceCall('extract', TYPICAL_CALL.extract);
  return Math.round((base + confirm) * 1e6) / 1e6;
}

/** Money a `scans` row stands for: finished scans at their cost, anything else at max(estimate, cost so far). */
export function rowCostUsd(r) {
  const total = Number(r?.total_cost_usd) || 0;
  if (r?.status === 'done') return total;
  return Math.max(total, Number(r?.est_cost_usd) || 0);
}

/**
 * Cap check over today's non-queued request rows (ours included). → null (go) | 'count' | 'spend'.
 * Count: rows ordered before ours. Spend: every other row plus our estimate (fails closed).
 */
export function capDecision(rows, ownId, { max, usd, estimateUsd }) {
  const live = (rows || []).filter((r) => r && r.status !== 'queued');
  if (max <= 0 || rowsBefore(live, ownId).length >= max) return 'count';
  const spent = live.filter((r) => r.id !== ownId).reduce((s, r) => s + rowCostUsd(r), 0);
  if (usd <= 0 || spent + (Number(estimateUsd) || 0) > usd) return 'spend';
  return null;
}

/** The earliest other live row for the same request key ordered before ours, or null. */
export function dedupeHit(rows, ownId) {
  const earlier = rowsBefore((rows || []).filter((r) => r && r.status !== 'failed' && r.report_token), ownId);
  return earlier[0] || null;
}

/**
 * The report page's state for a token that has no report yet, from its `scans` rows (newest first).
 * → 'running' | 'queued' | null (no request scan for this token).
 * A failed scan or a report that didn't pass the guardrails waits for a person ("Run now"): 'queued'.
 */
export function statusFromRows(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  if (list.some((r) => r.status === 'running')) return 'running';
  if (list.some((r) => r.status === 'queued')) return 'queued';
  const storeFailed = (r) => (Array.isArray(r.errors) ? r.errors : []).some((e) => e && e.kind === 'store');
  // Done and valid: the report row is being written (or the read raced it). Anything else needs a person.
  if (list.some((r) => r.status === 'done' && r.report_valid === true && !storeFailed(r))) return 'running';
  return 'queued';
}

// ---------------------------------------------------------------------------
// Supabase (service key; `scans` is service-only)
// ---------------------------------------------------------------------------

function supa(env) {
  const k = resolveKeys(env);
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function readRows(env, query, fetchImpl) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scans?${query}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`scans read failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

/** Request rows with this key since `sinceIso` (oldest first). */
export function readByKey(env, key, sinceIso, { fetchImpl = fetch } = {}) {
  return readRows(env, `trigger=eq.request&request_key=eq.${encodeURIComponent(key)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,created_at,status,report_token&order=created_at.asc,id.asc&limit=50`, fetchImpl);
}

/** Today's request rows that are not queued (the caps count these). */
export function readTodayRequestScans(env, sinceIso, { fetchImpl = fetch } = {}) {
  return readRows(env, `trigger=eq.request&status=neq.queued&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,created_at,status,est_cost_usd,total_cost_usd&limit=2000`, fetchImpl);
}

/** Every scan row for a report token, newest first. */
export function readByToken(env, token, { fetchImpl = fetch } = {}) {
  return readRows(env, `report_token=eq.${encodeURIComponent(token)}&select=id,status,report_valid,errors,trigger,created_at&order=created_at.desc&limit=10`, fetchImpl);
}

async function deleteScan(env, id, { fetchImpl = fetch } = {}) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scans?id=eq.${id}`, { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } });
  if (!res.ok) throw new Error(`scans delete failed: ${res.status}`);
}

// ---------------------------------------------------------------------------
// start (or queue) the scan for a new request
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {object} req      the saved request: { id, businessName, trade, town, state, zip, website, phone }
 * @param {object} o        { request (for the per-IP limiter), dryRun, now, fetchImpl, limiter, uuid }
 * @returns {Promise<null | { token, status: 'running'|'queued'|'reused', scanId, reason? }>}
 */
export async function startRequestScan(env, req, o = {}) {
  const now = o.now ?? Date.now();
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const engines = activeEngines(o.dryRun ? o.dryEnv || env : env);
  const parsed = parseScanRequest({
    business: { name: req.businessName, trade: req.trade, town: req.town, state: req.state, zip: req.zip, website: req.website, phone: req.phone },
    engines: engines.length ? engines : undefined,
    runs: 1,
    trigger: 'request',
    notes: `free-report request ${req.id}`,
  });
  if (!parsed.ok) return null;
  const business = parsed.params.business;
  const token = newRequestToken();
  const scanId = await requestScanId(token);
  const params = { ...parsed.params, engines, scanId, reportToken: token, questionLimit: null };
  const on = autoScanOn(env);

  // ---- local dry run: fixtures, no database -------------------------------------------------
  if (o.dryRun) {
    if (!on || !env.SCAN_WORKFLOW) {
      DRY_RUN_REQUESTS.set(token, { scanId, status: 'queued' });
      return { token, status: 'queued', scanId, reason: on ? 'no-workflow' : 'auto-scan-off' };
    }
    await env.SCAN_WORKFLOW.create({ id: scanId, params: { ...params, dryRun: true } });
    DRY_RUN_REQUESTS.set(token, { scanId, status: 'running' });
    return { token, status: 'running', scanId };
  }

  if (!canStore(env)) return null;
  const key = requestKey(business);
  const since = new Date(now - DEDUPE_DAYS * 86400_000).toISOString();

  // 1. Dedupe (checked again after our row is written).
  let prior;
  try {
    prior = dedupeHit(await readByKey(env, key, since, { fetchImpl }), null);
  } catch (e) {
    console.error('[auto-scan] dedupe read failed', String(e?.message || e).slice(0, 200));
    return null;
  }
  if (prior) return { token: prior.report_token, status: 'reused', scanId: prior.id };

  // 2. Per-IP brake.
  let reason = null;
  if (!on) reason = 'auto-scan-off';
  else if (!engines.length) reason = 'no-engine';
  else if (!env.SCAN_WORKFLOW) reason = 'no-workflow';
  else if (await ipLimited(env, o)) reason = 'ip';

  // 3. Reserve.
  const est = estimateRequestScanUsd(engines.length ? engines : ['chatgpt']);
  const base = {
    id: scanId, business_name: business.name, report_token: token, trigger: 'request', engines, runs: 1,
    questions: 5, calls_total: 5 * engines.length, notes: params.notes, request_key: key, business,
  };
  try {
    await upsertScan(env, { ...base, status: reason ? 'queued' : 'running', est_cost_usd: reason ? 0 : est }, { fetchImpl });
  } catch (e) {
    console.error('[auto-scan] scans row failed (apply supabase/v4_ladder.sql?)', String(e?.message || e).slice(0, 200));
    return null;
  }
  const queue = async (why, extra = {}) => {
    await upsertScan(env, { id: scanId, status: 'queued', est_cost_usd: 0, notes: `${params.notes} · queued: ${why}`, ...extra }, { fetchImpl })
      .catch((e) => console.error('[auto-scan] queue update failed', String(e?.message || e).slice(0, 200)));
    return { token, status: 'queued', scanId, reason: why };
  };

  // Verify the dedupe: of two identical submits at once, the later one gives way.
  try {
    const hit = dedupeHit(await readByKey(env, key, since, { fetchImpl }), scanId);
    if (hit) {
      await deleteScan(env, scanId, { fetchImpl }).catch(() => upsertScan(env, { id: scanId, status: 'failed', est_cost_usd: 0, notes: 'duplicate request' }, { fetchImpl }).catch(() => {}));
      return { token: hit.report_token, status: 'reused', scanId: hit.id };
    }
  } catch (e) {
    console.error('[auto-scan] dedupe re-read failed', String(e?.message || e).slice(0, 200));
    if (!reason) return queue('store');
  }
  if (reason) return { token, status: 'queued', scanId, reason };

  // Verify the caps.
  let rows;
  try {
    rows = await readTodayRequestScans(env, startOfUtcDay(now), { fetchImpl });
  } catch (e) {
    console.error('[auto-scan] cap read failed', String(e?.message || e).slice(0, 200));
    return queue('store');
  }
  const stop = capDecision(rows, scanId, { ...autoScanLimits(env), estimateUsd: est });
  if (stop) return queue(stop === 'count' ? 'daily-count-cap' : 'daily-spend-cap');

  // Start.
  try {
    await env.SCAN_WORKFLOW.create({ id: scanId, params: { ...params, dryRun: false } });
  } catch (e) {
    console.error('[auto-scan] workflow start failed', String(e?.message || e).slice(0, 200));
    return queue('workflow', { errors: [{ kind: 'workflow', error: String(e?.message || e).slice(0, 300) }] });
  }
  return { token, status: 'running', scanId };
}

async function ipLimited(env, o) {
  const limiter = o.limiter ?? env?.REQUEST_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function' || !o.request) return false;
  const ip = o.request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    const { success } = await limiter.limit({ key: `autoscan:${ip}` });
    return !success;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// the report page while a report is being made
// ---------------------------------------------------------------------------

/**
 * 'running' | 'queued' | null for a token with no stored report yet.
 * o: { dryRun, fetchImpl }. Never throws (a failed read → null, i.e. the usual 404).
 */
export async function pendingReportStatus(env, token, o = {}) {
  if (!LOOKUP_TOKEN_RE.test(String(token || ''))) return null;
  if (o.dryRun) {
    const d = DRY_RUN_REQUESTS.get(token);
    if (!d) return null;
    if (d.status === 'queued' || !env.SCAN_WORKFLOW) return 'queued';
    try {
      const st = await (await env.SCAN_WORKFLOW.get(d.scanId)).status();
      if (['queued', 'running', 'waiting', 'waitingForPause', 'paused', 'unknown'].includes(st.status)) return 'running';
      // A dry run stores nothing, so a finished one has no report to show: say so plainly.
      return st.status === 'complete' ? 'dry-run-complete' : 'queued';
    } catch {
      return 'running';
    }
  }
  if (!canStore(env)) return null;
  try {
    return statusFromRows(await readByToken(env, token, { fetchImpl: o.fetchImpl || ((...a) => fetch(...a)) }));
  } catch (e) {
    console.error('[report] pending lookup failed', String(e?.message || e).slice(0, 200));
    return null;
  }
}

// ---------------------------------------------------------------------------
// /admin "Run now"
// ---------------------------------------------------------------------------

/**
 * Start a queued (or failed) request scan by hand. Caps don't apply: a person decided.
 * A queued row starts under its own id; a failed row gets a new row + id (Workflow ids are single-use)
 * with the same report token, so the owner's link keeps working.
 * → { ok: true, scanId } | { ok: false, status, error }
 */
export async function runQueuedScan(env, id, { fetchImpl = (...a) => fetch(...a), uuid = () => crypto.randomUUID() } = {}) {
  if (!env.SCAN_WORKFLOW) return { ok: false, status: 500, error: 'SCAN_WORKFLOW binding missing (wrangler.jsonc)' };
  if (!canStore(env)) return { ok: false, status: 503, error: 'SUPABASE_SERVICE_KEY not set' };
  const row = await getScan(env, id, { fetchImpl }).catch(() => null);
  if (!row || row.trigger !== 'request') return { ok: false, status: 404, error: 'No request scan with that id.' };
  if (row.status !== 'queued' && row.status !== 'failed') return { ok: false, status: 409, error: `That scan is ${row.status}.` };
  const engines = activeEngines(env);
  if (!engines.length) return { ok: false, status: 503, error: 'No engine has a key.' };
  const parsed = parseScanRequest({ business: row.business || {}, engines, runs: 1, trigger: 'request', notes: row.notes || 'free-report request' });
  if (!parsed.ok) return { ok: false, status: 422, error: `This row can't be scanned: ${parsed.error} (apply supabase/v4_ladder.sql so requests keep their details).` };
  const scanId = row.status === 'queued' ? row.id : uuid();
  const est = estimateRequestScanUsd(engines);
  try {
    await upsertScan(env, {
      id: scanId, business_name: row.business_name, report_token: row.report_token, trigger: 'request', status: 'running',
      engines, runs: 1, questions: 5, calls_total: 5 * engines.length, notes: `${parsed.params.notes} · run now`,
      request_key: row.request_key ?? null, business: parsed.params.business, est_cost_usd: est,
    }, { fetchImpl });
    await env.SCAN_WORKFLOW.create({
      id: scanId,
      params: { ...parsed.params, engines, scanId, reportToken: row.report_token, questionLimit: null, dryRun: false },
    });
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    await upsertScan(env, { id: scanId, status: row.status === 'queued' ? 'queued' : 'failed', est_cost_usd: 0, errors: [{ kind: 'workflow', error }] }, { fetchImpl }).catch(() => {});
    return { ok: false, status: 500, error: `could not start the workflow: ${error}` };
  }
  return { ok: true, scanId };
}
