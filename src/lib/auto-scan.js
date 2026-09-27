// Automatic scans for free-report requests (POST /api/request, src/lib/report-request.js).
//
// A new request that passed Turnstile gets a report link right away (/report/<token>, token: 22
// random chars from [A-Za-z0-9_-]) and a `scans` row (trigger 'request') that the report page reads
// while the report is being made (pendingReportStatus → GET /api/report/<token> answers 202).
//
//   AUTO_SCAN=on         start a ScanWorkflow for it at once (freeEngines(env), 1 run, FREE_QUESTION_COUNT questions).
//   AUTO_SCAN unset/off  the row is 'queued'; /admin lists it with a "Run now" button (runQueuedScan).
//
// Brakes, in order (a request that trips one is QUEUED, never dropped; the page still gets its link):
//   1. Dedupe: the same normalized business name + ZIP (request_key) within 7 days → nothing is
//      scanned. The earlier request's token is NEVER handed out (anyone can type a business's name
//      and ZIP; its token may be paid for). This request gets its own new token instead: a copy of
//      the finished report when there is one (locked until this token is paid for), else a queued
//      row (reason 'duplicate', no request_key so it never becomes a dedupe anchor itself).
//   2. Per-IP: the REQUEST_LIMITER binding, bucket 'autoscan' (per minute, per location).
//   3. Daily caps over today's (UTC) automatic request scans in `scans` (queued rows don't count):
//        AUTO_SCAN_DAILY_MAX (default 25) scans, AUTO_SCAN_DAILY_USD (default 20) dollars.
//      Reserve-then-verify, like src/lib/live-preview.js: our row is written first as 'running' with
//      its estimated cost (est_cost_usd), then today's rows are re-read. Count: only rows ordered
//      before ours (created_at, id) count, so of two racing requests at the cap exactly one runs.
//      Spend: every other row counts (finished scans at their real cost, unfinished ones at the larger
//      of estimate and cost so far), which fails closed. A request that loses is demoted to 'queued'.
//      The dedupe check is re-run the same way after the write, so two identical submits at the same
//      moment start one scan (the later one becomes a queued duplicate with its own token).
// Needs supabase/v4_ladder.sql (request_key, business, est_cost_usd) and SUPABASE_SERVICE_KEY. Any
// failure before the row exists → null (the request is still saved; the page just gets no link).
//
// Local dry run (SCANNER_DRY_RUN=1 + localhost): no Supabase at all. The workflow answers from the
// recorded fixtures and the token's state lives in this isolate's memory (DRY_RUN_REQUESTS).

import { freeEngines, activeEngines, estimateScanCost, priceCall, TYPICAL_CALL } from '../../scanner/config.js';
import { canStore, upsertScan, stableUuid, getScan, saveReport } from '../../scanner/store.js';
import { resolveKeys } from '../../scanner/config.js';
import { parseScanRequest } from '../admin/scan-core.js';
import { normalizeBizName } from '../../shared/report-v2.js';
import { FREE_QUESTION_COUNT } from '../../scanner/questions.js';
import { rowsBefore, startOfUtcDay } from './live-preview.js';
import { linkRequestToken } from './notify.js';

export const DEFAULT_DAILY_MAX = 25;
export const DEFAULT_DAILY_USD = 20;
export const DEDUPE_DAYS = 7;
/** Queue reason for a request made on the way to checkout. */
export const PAID_INTENT = 'paid-intent';
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

/** What one automatic scan is reserved at: FREE_QUESTION_COUNT questions × engines × 1 run, extraction, and the headline re-ask. */
export function estimateRequestScanUsd(engines) {
  const base = estimateScanCost({ engines, questions: FREE_QUESTION_COUNT, runs: 1 }).total;
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

/** How many times a report may be tried automatically before the page says something went wrong. */
export const MAX_ATTEMPTS = 2;

/**
 * The report page's state for a token that has no report yet, from its `scans` rows (newest first).
 * → 'running' | 'paid' (the paid audit is being made) | 'queued' | 'failed' | null (no request scan for this token).
 * A scan that failed (or whose report didn't pass the guardrails) is retried once by the cron
 * (retryFailedScans), so the first failure still reads 'queued'; after MAX_ATTEMPTS it's 'failed'.
 */
export function statusFromRows(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  const running = list.filter((r) => r.status === 'running');
  if (running.length) return running.some((r) => r.trigger === 'paid') ? 'paid' : 'running';
  if (list.some((r) => r.status === 'queued')) return 'queued';
  const storeFailed = (r) => (Array.isArray(r.errors) ? r.errors : []).some((e) => e && e.kind === 'store');
  // Done and valid: the report row is being written (or the read raced it).
  if (list.some((r) => r.status === 'done' && r.report_valid === true && !storeFailed(r))) return 'running';
  return list.length >= MAX_ATTEMPTS ? 'failed' : 'queued';
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

/** The newest stored v2 report for a token (service key), or null. */
async function readStoredReport(env, token, fetchImpl) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scan_results?report_token=eq.${encodeURIComponent(token)}&version=eq.2&select=business_id,report,scanned_at&order=scanned_at.desc&limit=1`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`scan_results read failed: ${res.status}`);
  const [row] = await res.json();
  return row && row.report && typeof row.report === 'object' ? row : null;
}

/**
 * A duplicate request (same business within DEDUPE_DAYS) gets its OWN token, never the earlier one:
 * a copy of the earlier finished report (unpaid, so it is served locked), or, while that report
 * isn't ready, a queued row that /admin can run. Nothing is scanned. `rowWritten`: our scans row
 * already exists (the post-write re-check) and is replaced/removed here.
 */
async function reuseWithNewToken(env, prior, { token, scanId, base, notes, rowWritten, fetchImpl }) {
  try {
    const stored = prior.report_token ? await readStoredReport(env, prior.report_token, fetchImpl) : null;
    if (stored) {
      await saveReport(env, { scanId: null, businessId: stored.business_id, reportToken: token, report: { ...stored.report, id: token } }, { fetchImpl });
      if (rowWritten) await deleteScan(env, scanId, { fetchImpl }).catch(() => upsertScan(env, { id: scanId, status: 'failed', est_cost_usd: 0, request_key: null, notes: 'duplicate request (report copied)' }, { fetchImpl }).catch(() => {}));
      return { token, status: 'reused', scanId: prior.id };
    }
  } catch (e) {
    console.error('[auto-scan] duplicate copy failed', String(e?.message || e).slice(0, 200));
  }
  try {
    await upsertScan(env, { ...base, status: 'queued', est_cost_usd: 0, request_key: null, notes: `${notes} · queued: duplicate` }, { fetchImpl });
  } catch (e) {
    console.error('[auto-scan] duplicate row failed', String(e?.message || e).slice(0, 200));
    return null;
  }
  return { token, status: 'queued', scanId, reason: 'duplicate' };
}

// ---------------------------------------------------------------------------
// start (or queue) the scan for a new request
// ---------------------------------------------------------------------------

/**
 * @param {object} env
 * @param {object} req      the saved request: { id, businessName, trade, town, state, zip, website, phone }
 * @param {object} o        { request (for the per-IP limiter), dryRun, now, fetchImpl, limiter, uuid,
 *                            paidIntent (queue it: the buyer is on the way to checkout) }
 * @returns {Promise<null | { token, status: 'running'|'queued'|'reused', scanId, reason? }>}  token is always
 *   this request's own new token ('reused' = the earlier report was copied to it).
 */
export async function startRequestScan(env, req, o = {}) {
  const now = o.now ?? Date.now();
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const engines = freeEngines(o.dryRun ? o.dryEnv || env : env);
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
  const params = { ...parsed.params, engines, scanId, reportToken: token, questionLimit: FREE_QUESTION_COUNT };
  const on = autoScanOn(env);

  // ---- local dry run: fixtures, no database -------------------------------------------------
  if (o.dryRun) {
    if (o.paidIntent || !on || !env.SCAN_WORKFLOW) {
      DRY_RUN_REQUESTS.set(token, { scanId, status: 'queued' });
      return { token, status: 'queued', scanId, reason: o.paidIntent ? PAID_INTENT : on ? 'no-workflow' : 'auto-scan-off' };
    }
    await env.SCAN_WORKFLOW.create({ id: scanId, params: { ...params, dryRun: true } });
    DRY_RUN_REQUESTS.set(token, { scanId, status: 'running' });
    return { token, status: 'running', scanId };
  }

  if (!canStore(env)) return null;
  // So the "report ready" email can find this request's address (src/lib/notify.js).
  await linkRequestToken(env, req.id, token, { fetchImpl }).catch(() => false);
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
  const base = {
    id: scanId, business_name: business.name, report_token: token, trigger: 'request', engines, runs: 1,
    questions: FREE_QUESTION_COUNT, calls_total: FREE_QUESTION_COUNT * engines.length, notes: params.notes, request_key: key, business,
  };
  const dup = { token, scanId, base, notes: params.notes, fetchImpl };
  if (prior) return reuseWithNewToken(env, prior, { ...dup, rowWritten: false });

  // 2. Per-IP brake.
  let reason = null;
  // Someone who came to pay goes to checkout: their paid scan starts when the payment lands. The
  // free scan waits (retryFailedScans runs it if they leave checkout without paying).
  if (o.paidIntent) reason = PAID_INTENT;
  else if (!on) reason = 'auto-scan-off';
  else if (!engines.length) reason = 'no-engine';
  else if (!env.SCAN_WORKFLOW) reason = 'no-workflow';
  else if (await ipLimited(env, o)) reason = 'ip';

  // 3. Reserve.
  const est = estimateRequestScanUsd(engines.length ? engines : ['chatgpt']);
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
    if (hit) return reuseWithNewToken(env, hit, { ...dup, rowWritten: true });
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
  const invalid = row.status === 'done' && row.report_valid === false;
  if (row.status !== 'queued' && row.status !== 'failed' && !invalid) return { ok: false, status: 409, error: `That scan is ${row.status}.` };
  const engines = freeEngines(env);
  if (!engines.length) return { ok: false, status: 503, error: 'No engine has a key.' };
  const parsed = parseScanRequest({ business: row.business || {}, engines, runs: 1, trigger: 'request', notes: row.notes || 'free-report request' });
  if (!parsed.ok) return { ok: false, status: 422, error: `This row can't be scanned: ${parsed.error} (apply supabase/v4_ladder.sql so requests keep their details).` };
  const scanId = row.status === 'queued' ? row.id : uuid();
  const est = estimateRequestScanUsd(engines);
  try {
    await upsertScan(env, {
      id: scanId, business_name: row.business_name, report_token: row.report_token, trigger: 'request', status: 'running',
      engines, runs: 1, questions: FREE_QUESTION_COUNT, calls_total: FREE_QUESTION_COUNT * engines.length, notes: `${parsed.params.notes} · run now`,
      request_key: row.request_key ?? null, business: parsed.params.business, est_cost_usd: est,
    }, { fetchImpl });
    await env.SCAN_WORKFLOW.create({
      id: scanId,
      params: { ...parsed.params, engines, scanId, reportToken: row.report_token, questionLimit: FREE_QUESTION_COUNT, dryRun: false },
    });
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    await upsertScan(env, { id: scanId, status: row.status === 'queued' ? 'queued' : 'failed', est_cost_usd: 0, errors: [{ kind: 'workflow', error }] }, { fetchImpl }).catch(() => {});
    return { ok: false, status: 500, error: `could not start the workflow: ${error}` };
  }
  return { ok: true, scanId };
}

// ---------------------------------------------------------------------------
// Hands-off recovery, run by the Worker's cron (src/worker.js scheduled)
// ---------------------------------------------------------------------------

/** Rows older than this aren't picked up any more (a long outage doesn't replay a backlog). */
export const RETRY_WINDOW_HOURS = 48;
/** A request queued on the way to checkout gets its free scan after this long without a payment. */
export const ABANDONED_CHECKOUT_MINUTES = 60;
/** Most scans started per cron run. */
export const RETRY_MAX_PER_RUN = 10;

const attemptFailed = (r) => r.status === 'failed' || (r.status === 'done' && r.report_valid === false);

/**
 * What the cron should start, from recent scans rows (pure). A token is picked when:
 *   - its request scan failed once (or its report failed the guardrails) and nothing else is going
 *     on for it: retried once (MAX_ATTEMPTS in all), only with AUTO_SCAN on (off = a person decides);
 *   - its paid scan failed once: retried once, always (it's paid for);
 *   - it was queued on the way to checkout (PAID_INTENT) ABANDONED_CHECKOUT_MINUTES ago and no paid
 *     scan exists: the free scan runs (AUTO_SCAN on), so the owner still gets their free report.
 * rows: [{ id, report_token, trigger, status, report_valid, notes, created_at }]
 * → [{ kind: 'request-retry'|'paid-retry'|'abandoned', id, token }]
 */
export function pickRecoveries(rows, { now = Date.now(), autoScan = false } = {}) {
  const byToken = new Map();
  for (const r of rows || []) {
    if (!r?.report_token) continue;
    if (!byToken.has(r.report_token)) byToken.set(r.report_token, []);
    byToken.get(r.report_token).push(r);
  }
  const out = [];
  for (const [token, list] of byToken) {
    const busy = list.some((r) => r.status === 'running' || (r.status === 'done' && r.report_valid === true));
    if (busy) continue;
    const paid = list.filter((r) => r.trigger === 'paid');
    if (paid.length) {
      if (paid.length < MAX_ATTEMPTS && paid.every(attemptFailed)) out.push({ kind: 'paid-retry', id: paid[0].id, token });
      continue;
    }
    if (!autoScan) continue;
    const req = list.filter((r) => r.trigger === 'request');
    const queued = req.find((r) => r.status === 'queued');
    if (queued) {
      const age = now - Date.parse(queued.created_at);
      if (String(queued.notes || '').includes(`queued: ${PAID_INTENT}`) && age >= ABANDONED_CHECKOUT_MINUTES * 60_000) out.push({ kind: 'abandoned', id: queued.id, token });
      continue;
    }
    const failed = req.filter(attemptFailed);
    if (failed.length && failed.length < MAX_ATTEMPTS && failed.length === req.length) {
      const newest = failed.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      out.push({ kind: 'request-retry', id: newest.id, token });
    }
  }
  return out.slice(0, RETRY_MAX_PER_RUN);
}

/** Cron: retry failed scans once and run the free scan for abandoned checkouts. Never throws. */
export async function retryFailedScans(env, { now = Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!env.SCAN_WORKFLOW || !canStore(env)) return { ok: false, reason: 'not configured' };
    const since = new Date(now - RETRY_WINDOW_HOURS * 3600_000).toISOString();
    const rows = await readRows(env, `trigger=in.(request,paid)&report_token=not.is.null&created_at=gte.${encodeURIComponent(since)}&select=id,report_token,trigger,status,report_valid,notes,created_at&order=created_at.desc&limit=1000`, fetchImpl);
    const picks = pickRecoveries(rows, { now, autoScan: autoScanOn(env) });
    const results = [];
    for (const p of picks) {
      let r;
      if (p.kind === 'paid-retry') {
        r = await startFullScan(env, { token: p.token, trigger: 'paid', scanId: await stableUuid(`paid-retry:${p.token}`), notes: 'paid scan, automatic retry' }, { fetchImpl })
          .catch((e) => ({ ok: false, reason: String(e?.message || e).slice(0, 200) }));
      } else {
        r = await runQueuedScan(env, p.id, { fetchImpl }).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }));
      }
      results.push({ ...p, ok: !!r?.ok, ...(r?.ok ? {} : { why: r?.reason || r?.error }) });
    }
    return { ok: true, started: results.filter((r) => r.ok).length, results };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Left checkout without paying (Stripe's cancel link): start this request's free scan now, so the
 * owner lands on their free report instead. Only a PAID_INTENT row, only with AUTO_SCAN on. Never throws.
 */
export async function startAbandonedCheckout(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!autoScanOn(env) || !REQUEST_TOKEN_RE.test(String(token || ''))) return { ok: false, reason: 'off' };
    const rows = await readRows(env, `report_token=eq.${encodeURIComponent(token)}&select=id,report_token,trigger,status,report_valid,notes,created_at&order=created_at.desc&limit=10`, fetchImpl);
    const pick = pickRecoveries(rows, { now: Infinity, autoScan: true }).find((p) => p.kind === 'abandoned');
    if (!pick) return { ok: false, reason: 'nothing to start' };
    return await runQueuedScan(env, pick.id, { fetchImpl });
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// The paid audit: a fresh scan with all 5 questions on every engine with a key
// ---------------------------------------------------------------------------

/** Tiers whose payment starts the full scan (the $49 audit and everything above it). */
export const FULL_SCAN_TIERS = ['xray', 'fix_kit', 'be_the_answer'];

/** The scan id for a paid scan: stable per Stripe Checkout Session, so a retried webhook starts nothing new. */
export function paidScanId(sessionId) {
  return stableUuid(`paid-scan:${sessionId}`);
}

/** The business a token's scans ask about: the newest scans row's `business`, else the stored report's. */
export async function readPlanBusiness(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const b = await readScanBusiness(env, token, fetchImpl).catch(() => null);
  return b || (await readStoredReport(env, token, fetchImpl).catch(() => null))?.report?.business || null;
}

/** The newest `business` a scans row kept for this token (request scans store it), or null. */
async function readScanBusiness(env, token, fetchImpl) {
  const rows = await readRows(env, `report_token=eq.${encodeURIComponent(token)}&business=not.is.null&select=business&order=created_at.desc&limit=1`, fetchImpl);
  const b = rows[0]?.business;
  return b && typeof b === 'object' ? b : null;
}

/**
 * Start the full audit scan for a paid report token: every question (no questionLimit), every
 * engine with a key (activeEngines, not the free three), 1 run, under the SAME token. The newest
 * v2 report for a token is the one served (src/lib/db.js getReport), so the owner's link keeps
 * showing the free scan, now unlocked, until the full one is saved. Caps and dedupe don't apply:
 * it's paid for. One paid scan per token: a second payment (a Fix Kit after the audit) or a
 * retried webhook starts nothing. The business comes from the request's scans row, else from the
 * stored report. Never throws: the payment is already recorded, and /admin can re-run by hand.
 * → { ok: true, scanId } | { ok: false, reason }
 */
export async function startPaidScan(env, { token, sessionId, tier }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!FULL_SCAN_TIERS.includes(tier)) return { ok: false, reason: 'tier' };
    if (!token || !LOOKUP_TOKEN_RE.test(String(token)) || !sessionId) return { ok: false, reason: 'no-token' };
    return await startFullScan(env, { token, trigger: 'paid', scanId: await paidScanId(sessionId), notes: `paid ${tier} ${sessionId}` }, { fetchImpl });
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 300) };
  }
}

/**
 * A full scan (every question, every engine with a key, 1 run) under an existing report token.
 * `trigger` 'paid' (after payment) or 'recheck' (30 days later); one of each per token. Throws on
 * a store failure; a workflow that won't start marks the row failed and returns { ok: false }.
 */
async function startFullScan(env, { token, trigger, scanId, notes, business: given = null }, { fetchImpl }) {
  if (!env.SCAN_WORKFLOW) return { ok: false, reason: 'no-workflow' };
  if (!canStore(env)) return { ok: false, reason: 'no-store' };
  // 'paid' and 'recheck' run once per token; a 'monthly' scan once per scan id (one per month).
  if (trigger === 'monthly') {
    if ((await readRows(env, `id=eq.${scanId}&select=id`, fetchImpl)).length) return { ok: false, reason: 'already' };
  } else {
    const rows = await readByToken(env, token, { fetchImpl });
    if (rows.some((r) => r.trigger === trigger && r.status !== 'failed')) return { ok: false, reason: 'already' };
  }
  const engines = activeEngines(env);
  if (!engines.length) return { ok: false, reason: 'no-engine' };
  let business = given || await readPlanBusiness(env, token, { fetchImpl });
  const parsed = parseScanRequest({ business: business || {}, engines, runs: 1, trigger, notes });
  if (!parsed.ok) return { ok: false, reason: `business: ${parsed.error}` };
  const questions = 5;
  await upsertScan(env, {
    id: scanId, business_name: parsed.params.business.name, report_token: token, trigger, status: 'running',
    engines, runs: 1, questions, calls_total: questions * engines.length, notes: parsed.params.notes,
    business: parsed.params.business, est_cost_usd: estimateScanCost({ engines, questions, runs: 1 }).total,
  }, { fetchImpl });
  try {
    await env.SCAN_WORKFLOW.create({
      id: scanId,
      params: { ...parsed.params, engines, scanId, reportToken: token, questionLimit: null, dryRun: false },
    });
  } catch (e) {
    const error = String(e?.message || e).slice(0, 300);
    await upsertScan(env, { id: scanId, status: 'failed', est_cost_usd: 0, errors: [{ kind: 'workflow', error }] }, { fetchImpl }).catch(() => {});
    return { ok: false, reason: `workflow: ${error}` };
  }
  return { ok: true, scanId };
}

// ---------------------------------------------------------------------------
// The free 30-day re-check (every paid plan): run daily by the Worker's cron (src/worker.js scheduled)
// ---------------------------------------------------------------------------

export const RECHECK_DAYS = 30;
/** Payments older than this are never re-checked (a missed day catches up; an old backlog doesn't). */
export const RECHECK_WINDOW_DAYS = 14;
/** Most re-checks started per run: a brake on a burst of sales a month ago. */
export const RECHECK_MAX_PER_RUN = 20;

/** Live payments for a full-scan plan made RECHECK_DAYS ago (within the window), oldest first. */
export function readDuePayments(env, nowMs, { fetchImpl = fetch } = {}) {
  const until = new Date(nowMs - RECHECK_DAYS * 86400_000).toISOString();
  const since = new Date(nowMs - (RECHECK_DAYS + RECHECK_WINDOW_DAYS) * 86400_000).toISOString();
  const { base, headers } = supa(env);
  const q = `tier=in.(${FULL_SCAN_TIERS.join(',')})&livemode=eq.true&report_token=not.is.null&paid_at=lte.${encodeURIComponent(until)}&paid_at=gte.${encodeURIComponent(since)}&select=report_token,paid_at&order=paid_at.asc&limit=200`;
  return fetchImpl(`${base}/payments?${q}`, { headers, signal: AbortSignal.timeout(8000) }).then(async (res) => {
    if (!res.ok) throw new Error(`payments read failed: ${res.status}`);
    return res.json();
  });
}

/**
 * Start the 30-day re-check for every paid report that's due: a full scan under the same token,
 * compared against the audit (scan-workflow baseline by token). Once per token, at most
 * RECHECK_MAX_PER_RUN per run, never throws. RECHECK_SCAN=off turns it off.
 * → { started: [token], skipped: { reason: n }, error? }
 */
export async function startDueRechecks(env, { now = Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
  const out = { started: [], skipped: {} };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
  if (String(env?.RECHECK_SCAN ?? '').trim().toLowerCase() === 'off') return { ...out, error: 'off' };
  if (!canStore(env) || !env.SCAN_WORKFLOW) return { ...out, error: 'not configured' };
  let due;
  try {
    due = await readDuePayments(env, now, { fetchImpl });
  } catch (e) {
    return { ...out, error: String(e?.message || e).slice(0, 200) };
  }
  const tokens = [...new Set(due.map((p) => p.report_token).filter((t) => LOOKUP_TOKEN_RE.test(String(t))))];
  for (const token of tokens) {
    if (out.started.length >= RECHECK_MAX_PER_RUN) { skip('max-per-run'); continue; }
    try {
      const r = await startFullScan(env, { token, trigger: 'recheck', scanId: await stableUuid(`recheck-scan:${token}`), notes: '30-day re-check' }, { fetchImpl });
      if (r.ok) out.started.push(token);
      else skip(r.reason.split(':')[0]);
    } catch (e) {
      skip('error');
      console.error('[recheck] start failed', String(e?.message || e).slice(0, 200));
    }
  }
  return out;
}

/** True while a paid full scan for this token is running (the report page says the full audit is on its way). */
export async function paidScanRunning(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!canStore(env) || !LOOKUP_TOKEN_RE.test(String(token || ''))) return false;
  try {
    const rows = await readByToken(env, token, { fetchImpl });
    return rows.some((r) => r.trigger === 'paid' && (r.status === 'running' || r.status === 'queued'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Be the Answer: a re-scan every month for a year, for the plan's report and each extra town.
// Run daily by the Worker's cron next to the 30-day re-check (src/worker.js scheduled).
// ---------------------------------------------------------------------------

export const PLAN_TIER = 'be_the_answer';
export const PLAN_MONTHS = 12;
export const MONTH_DAYS = 30;
/** Most monthly scans started per run. */
export const MONTHLY_MAX_PER_RUN = 30;
/** A report scanned this recently (paid scan, re-check, monthly) is not scanned again this month. */
export const MONTHLY_MIN_GAP_DAYS = 20;

/** Which plan month is due `nowMs` for a plan paid at `paidAtMs`: 1..PLAN_MONTHS, else 0 (none due, or too late to catch up). */
export function planMonthDue(paidAtMs, nowMs) {
  const days = Math.floor((nowMs - paidAtMs) / 86400_000);
  const m = Math.floor(days / MONTH_DAYS);
  if (m < 1 || m > PLAN_MONTHS) return 0;
  return days - m * MONTH_DAYS < RECHECK_WINDOW_DAYS ? m : 0;
}

/** Live Be the Answer payments young enough to have a month due, oldest first. */
export function readPlanPayments(env, nowMs, { fetchImpl = fetch } = {}) {
  const since = new Date(nowMs - ((PLAN_MONTHS * MONTH_DAYS) + RECHECK_WINDOW_DAYS) * 86400_000).toISOString();
  const { base, headers } = supa(env);
  const q = `or=(tier.eq.${PLAN_TIER},amount_cents.eq.49900)&livemode=eq.true&report_token=not.is.null&paid_at=gte.${encodeURIComponent(since)}&select=report_token,paid_at&order=paid_at.asc&limit=500`;
  return fetchImpl(`${base}/payments?${q}`, { headers, signal: AbortSignal.timeout(8000) }).then(async (res) => {
    if (!res.ok) throw new Error(`payments read failed: ${res.status}`);
    return res.json();
  });
}

/** The extra towns on a plan: [{ town_token, town, state, zip }]. */
export async function readPlanTowns(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/plan_towns?report_token=eq.${encodeURIComponent(token)}&select=town_token,town,state,zip,created_at&order=created_at.asc&limit=10`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`plan_towns read failed: ${res.status}`);
  return res.json();
}

/** The plan a town token belongs to (its parent report token), or null. */
export async function readPlanParent(env, townToken, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!canStore(env) || !LOOKUP_TOKEN_RE.test(String(townToken || ''))) return null;
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/plan_towns?town_token=eq.${encodeURIComponent(townToken)}&select=report_token&limit=1`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const [row] = await res.json();
  return row?.report_token || null;
}

/** The business for one of a plan's towns: the plan's business, asked about that town instead. */
export function townBusiness(business, { town, state, zip }) {
  const { nearbyTown, id, ...rest } = business || {};
  return { ...rest, town, state, ...(zip ? { zip } : { zip: undefined }) };
}

/** A plan town's first scan (month 0), started when the owner adds the town. */
export async function startTownScan(env, { townToken, business }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    return await startFullScan(env, {
      token: townToken, trigger: 'monthly', scanId: await stableUuid(`monthly:${townToken}:0`), notes: 'Be the Answer: new town', business,
    }, { fetchImpl });
  } catch (e) {
    return { ok: false, reason: String(e?.message || e).slice(0, 200) };
  }
}

/** Attempts per (token, month): a month whose scan failed is started once more, under a second id. */
export const MONTHLY_ATTEMPTS = 2;

/** The scan id for attempt `attempt` (1-based) of month `month` on `token`. Attempt 1 keeps the original id. */
export function monthlyScanId(token, month, attempt = 1) {
  return stableUuid(attempt === 1 ? `monthly:${token}:${month}` : `monthly:${token}:${month}:${attempt}`);
}

/** Start month `month` for one report, retrying under the next id when an earlier attempt failed. */
async function startMonthlyScan(env, { token, month, business }, { fetchImpl }) {
  let r = { ok: false, reason: 'already' };
  for (let attempt = 1; attempt <= MONTHLY_ATTEMPTS; attempt++) {
    const scanId = await monthlyScanId(token, month, attempt);
    r = await startFullScan(env, { token, trigger: 'monthly', scanId, notes: `Be the Answer month ${month}`, business }, { fetchImpl });
    if (r.ok || r.reason !== 'already') return r;
    const [row] = await readRows(env, `id=eq.${scanId}&select=status`, fetchImpl);
    if (row?.status !== 'failed') return r;
  }
  return r;
}

/**
 * Start every monthly Be the Answer scan that's due: for each plan, month m (1..12, counted from the
 * payment), its own report and each extra town. Once per (token, month); skipped when that report
 * was scanned in the last MONTHLY_MIN_GAP_DAYS (the 30-day re-check covers month 1 of a plan bought
 * with the audit). At most MONTHLY_MAX_PER_RUN per run; never throws. RECHECK_SCAN=off turns it off too.
 * → { started: [token], skipped: { reason: n }, error? }
 */
export async function startDueMonthly(env, { now = Date.now(), fetchImpl = (...a) => fetch(...a) } = {}) {
  const out = { started: [], skipped: {} };
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1; };
  if (String(env?.RECHECK_SCAN ?? '').trim().toLowerCase() === 'off') return { ...out, error: 'off' };
  if (!canStore(env) || !env.SCAN_WORKFLOW) return { ...out, error: 'not configured' };
  let payments;
  try {
    payments = await readPlanPayments(env, now, { fetchImpl });
  } catch (e) {
    return { ...out, error: String(e?.message || e).slice(0, 200) };
  }
  // The first plan payment per token sets its calendar.
  const plans = new Map();
  for (const p of payments) if (LOOKUP_TOKEN_RE.test(String(p.report_token)) && !plans.has(p.report_token)) plans.set(p.report_token, Date.parse(p.paid_at));
  for (const [token, paidAt] of plans) {
    const m = planMonthDue(paidAt, now);
    if (!m) { skip('not-due'); continue; }
    let towns = [];
    try { towns = await readPlanTowns(env, token, { fetchImpl }); } catch { skip('towns'); }
    const parentBusiness = towns.length ? await readPlanBusiness(env, token, { fetchImpl }) : null;
    const targets = [{ token }, ...towns.map((t) => ({ token: t.town_token, business: parentBusiness ? townBusiness(parentBusiness, t) : null }))];
    for (const t of targets) {
      if (out.started.length >= MONTHLY_MAX_PER_RUN) { skip('max-per-run'); continue; }
      try {
        const recent = (await readByToken(env, t.token, { fetchImpl })).some((r) => ['paid', 'recheck', 'monthly'].includes(r.trigger)
          && r.status !== 'failed' && now - Date.parse(r.created_at) < MONTHLY_MIN_GAP_DAYS * 86400_000);
        if (recent) { skip('recent'); continue; }
        const r = await startMonthlyScan(env, { token: t.token, month: m, business: t.business || null }, { fetchImpl });
        if (r.ok) out.started.push(t.token);
        else skip(r.reason.split(':')[0]);
      } catch (e) {
        skip('error');
        console.error('[monthly] start failed', String(e?.message || e).slice(0, 200));
      }
    }
  }
  return out;
}
