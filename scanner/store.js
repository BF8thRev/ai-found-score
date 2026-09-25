// scanner/store.js — Supabase writes for the scanner, via the REST API (fetch only).
//
// Uses SUPABASE_URL + SUPABASE_SERVICE_KEY (service key bypasses RLS; Worker-side only).
// Tables come from supabase/setup.sql + supabase/scan_v2.sql.

import { resolveKeys } from './config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl) throw new Error('missing SUPABASE_URL');
  if (!k.supabaseServiceKey) throw new Error('missing SUPABASE_SERVICE_KEY');
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function failText(res) {
  try { return (await res.text()).slice(0, 500); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Key-fragment scrubbing. Provider errors sometimes echo part of the key back
// (OpenAI 401: "Incorrect API key provided: sk-proj-****abcd"). Nothing
// key-shaped is ever stored or shown.
// ---------------------------------------------------------------------------
const KEY_PATTERNS = [
  [/(Incorrect API key provided:\s*)[^\s,;"']+?(?=[.\s,;"']|$)/gi, '$1[redacted]'],
  [/\b(?:sk|rk|pk)-(?:proj-|ant-|svcacct-|admin-|live-|test-)?[A-Za-z0-9_*-]{3,}/g, '[redacted-key]'],
  [/\bpplx-[A-Za-z0-9_*-]{3,}/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_*-]{8,}/g, '[redacted-key]'],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_*-]{3,}/g, '[redacted-key]'],
  [/\bwhsec_[A-Za-z0-9_*-]{3,}/g, '[redacted-key]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  [/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=*-]{8,}/gi, '$1[redacted]'],
  [/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1[redacted]'],
  [/((?:x-api-key|x-goog-api-key|api[-_ ]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._*-]{6,}/gi, '$1[redacted]'],
];

/** Strip key-like fragments from a string (masked or not). Non-strings pass through. */
export function scrubKeyFragments(value) {
  if (typeof value !== 'string' || !value) return value;
  let s = value;
  for (const [re, rep] of KEY_PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Same, for any JSON value (used on failed responses before they are stored). */
export function scrubJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(scrubKeyFragments(JSON.stringify(value)));
  } catch {
    return null;
  }
}

/**
 * A stable UUID (v4-shaped) derived from a string, so a retried Workflow step writes the
 * same row id and an upsert makes the write idempotent. Web Crypto only.
 */
export async function stableUuid(seed) {
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(seed))));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** One scan_raw row for one engine call (see supabase/scan_v2.sql). Pass `id` for idempotent upserts. */
export function rawRow({ scanId, businessId, call, id }) {
  return {
    ...(id ? { id } : {}),
    scan_id: scanId,
    business_id: isUuid(businessId) ? businessId : null,
    engine: call.engine,
    question_id: call.questionId,
    question_text: call.questionText ?? null,
    run: call.run,
    model: call.model ?? null,
    request: call.request ?? null,
    // A failed call's body is an error message, which may echo a masked key.
    response: call.ok ? (call.raw ?? null) : scrubJson(call.raw ?? null),
    answer_text: call.text ?? null,
    citations: call.citations ?? [],
    ok: !!call.ok,
    error: call.error == null ? null : scrubKeyFragments(String(call.error)).slice(0, 2000),
    cost_usd: Number(call.costUsd) || 0,
    asked_at: call.askedAt,
  };
}

/**
 * Insert scan_raw rows (one per call, failed calls included). Batched in chunks so a full scan
 * costs 1 subrequest instead of 40 (Workers cap subrequests per invocation).
 * @returns {Promise<{ok:boolean, count:number, error:string|null}>} never throws
 */
export async function saveRaw(env, rows, { fetchImpl = fetch, chunk = 50, replace = false } = {}) {
  try {
    const { base, headers } = supa(env);
    let count = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const part = rows.slice(i, i + chunk);
      // Rows with a stable id (Workflow steps) are upserts: a retried step can't duplicate a row.
      // `replace` overwrites a stored row with the same id (a resumed local scan re-asking a
      // call that failed last time); otherwise the first row written wins.
      const withIds = part.every((r) => r.id);
      const resolution = replace ? 'merge-duplicates' : 'ignore-duplicates';
      const res = await fetchImpl(`${base}/scan_raw${withIds ? '?on_conflict=id' : ''}`, {
        method: 'POST',
        headers: { ...headers, Prefer: withIds ? `return=minimal,resolution=${resolution}` : 'return=minimal' },
        body: JSON.stringify(part),
      });
      if (!res.ok) return { ok: false, count, error: `scan_raw insert failed: ${res.status} ${await failText(res)}` };
      count += part.length;
    }
    return { ok: true, count, error: null };
  } catch (e) {
    return { ok: false, count: 0, error: String(e?.message || e) };
  }
}

/** Store adapter for runScan({ store }). */
export function supabaseStore(env, { fetchImpl = fetch } = {}) {
  return {
    async saveCalls({ scanId, businessId, calls }) {
      return saveRaw(env, calls.map((call) => rawRow({ scanId, businessId, call })), { fetchImpl });
    },
  };
}

/**
 * Write the finished v2 report to scan_results. Throws on failure (caller decides).
 * @returns {Promise<object>} the inserted row
 */
export async function saveReport(env, { scanId, businessId, reportToken, report }, { fetchImpl = fetch } = {}) {
  if (!reportToken) throw new Error('saveReport: reportToken is required');
  const { base, headers } = supa(env);
  const row = {
    business_id: isUuid(businessId) ? businessId : null,
    report_token: reportToken,
    scan_id: isUuid(scanId) ? scanId : null,
    version: 2,
    report,
    scanned_at: report?.generatedAt || new Date().toISOString(),
    named_by_ai: report?.totals ? report.totals.namedYou > 0 : null,
  };
  const res = await fetchImpl(`${base}/scan_results`, { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`scan_results insert failed: ${res.status} ${await failText(res)}`);
  const [saved] = await res.json();
  return saved || row;
}

/**
 * Replace the report on an existing scan_results row (a rebuilt report for the same scan and
 * token). Updated in place, so the report link keeps working and no duplicate row appears.
 * Throws on failure.
 */
export async function updateReport(env, rowId, { report }, { fetchImpl = fetch } = {}) {
  if (rowId == null || rowId === '') throw new Error('updateReport: row id is required');
  const { base, headers } = supa(env);
  const patch = {
    report,
    scanned_at: report?.generatedAt || new Date().toISOString(),
    named_by_ai: report?.totals ? report.totals.namedYou > 0 : null,
  };
  const res = await fetchImpl(`${base}/scan_results?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`scan_results update failed: ${res.status} ${await failText(res)}`);
  const rows = await res.json();
  if (!rows.length) throw new Error(`scan_results update matched no row (id ${rowId})`);
  return rows[0];
}

/**
 * The previous v2 scan's { generatedAt, totals } for a business, or null.
 * Pass `excludeScanId` / `beforeIso` to skip the scan being built right now.
 */
export async function getBaseline(env, businessId, { excludeScanId, beforeIso, fetchImpl = fetch } = {}) {
  if (!isUuid(businessId)) return null;
  const { base, headers } = supa(env);
  let q = `business_id=eq.${businessId}&version=eq.2&report=not.is.null&select=scan_id,scanned_at,report->generatedAt,report->totals&order=scanned_at.desc&limit=5`;
  if (beforeIso) q += `&scanned_at=lt.${encodeURIComponent(beforeIso)}`;
  const res = await fetchImpl(`${base}/scan_results?${q}`, { headers });
  if (!res.ok) throw new Error(`scan_results baseline read failed: ${res.status} ${await failText(res)}`);
  const rows = await res.json();
  const prev = rows.find((r) => !excludeScanId || r.scan_id !== excludeScanId);
  if (!prev || !prev.totals) return null;
  return { generatedAt: prev.generatedAt || prev.scanned_at, totals: prev.totals };
}

// ---------------------------------------------------------------------------
// Cost & business tracking (supabase/admin_v3.sql): scans, scan_usage.
// ---------------------------------------------------------------------------

/** True when Supabase writes are possible with this env. */
export function canStore(env) {
  const k = resolveKeys(env);
  return !!(k.supabaseUrl && k.supabaseServiceKey);
}

/**
 * One scan_usage row: a paid API call that is not an engine answer (extractor calls, pings).
 * `usage` is { input_tokens, output_tokens } (Anthropic shape) or { inputTokens, outputTokens }.
 */
export function usageRow({ id, scanId, kind = 'extract', provider = 'anthropic', model = null, usage = null, searches = 0, costUsd = 0, ok = true, error = null, answerRef = null }) {
  return {
    ...(id ? { id } : {}),
    scan_id: isUuid(scanId) ? scanId : null,
    kind,
    provider,
    model,
    input_tokens: Number(usage?.input_tokens ?? usage?.inputTokens) || 0,
    output_tokens: Number(usage?.output_tokens ?? usage?.outputTokens) || 0,
    searches: Number(searches) || 0,
    cost_usd: Math.round((Number(costUsd) || 0) * 1e6) / 1e6,
    ok: !!ok,
    error: error == null ? null : scrubKeyFragments(String(error)).slice(0, 2000),
    answer_ref: answerRef,
  };
}

/** Insert scan_usage rows (idempotent when rows carry ids). Never throws. */
export async function saveUsage(env, rows, { fetchImpl = fetch } = {}) {
  if (!rows.length) return { ok: true, count: 0, error: null };
  try {
    const { base, headers } = supa(env);
    const withIds = rows.every((r) => r.id);
    const res = await fetchImpl(`${base}/scan_usage${withIds ? '?on_conflict=id' : ''}`, {
      method: 'POST',
      headers: { ...headers, Prefer: withIds ? 'return=minimal,resolution=ignore-duplicates' : 'return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!res.ok) return { ok: false, count: 0, error: `scan_usage insert failed: ${res.status} ${await failText(res)}` };
    return { ok: true, count: rows.length, error: null };
  } catch (e) {
    return { ok: false, count: 0, error: String(e?.message || e) };
  }
}

/**
 * Sum of cost_usd over EVERY scan_usage row of a scan (all runs, resumes and rebuilds).
 * This is what scans.extract_cost_usd must equal. Returns null when it can't be read (never throws).
 */
export async function sumUsageCost(env, scanId, { fetchImpl = fetch } = {}) {
  try {
    if (!isUuid(scanId)) return null;
    const { base, headers } = supa(env);
    const res = await fetchImpl(`${base}/scan_usage?scan_id=eq.${scanId}&select=cost_usd`, { headers });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    return Math.round(rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;
  } catch {
    return null;
  }
}

const SCAN_COLUMNS = ['id', 'business_id', 'business_name', 'report_token', 'status', 'engines', 'runs', 'questions',
  'started_at', 'finished_at', 'calls_total', 'calls_ok', 'engine_cost_usd', 'extract_cost_usd', 'total_cost_usd',
  'named_you', 'first_you', 'answers', 'report_valid', 'errors', 'trigger', 'notes',
  // supabase/v4_ladder.sql: free-report requests (src/lib/auto-scan.js)
  'request_key', 'business', 'est_cost_usd'];

function scanPatch(patch) {
  const out = {};
  for (const k of SCAN_COLUMNS) if (patch[k] !== undefined) out[k] = patch[k];
  if (out.business_id !== undefined && !isUuid(out.business_id)) out.business_id = null;
  return out;
}

/** Create or update a `scans` row by id (upsert, safe to retry). Throws on failure. */
export async function upsertScan(env, row, { fetchImpl = fetch } = {}) {
  if (!isUuid(row.id)) throw new Error('upsertScan: id must be a uuid');
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scans?on_conflict=id`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal,resolution=merge-duplicates' },
    body: JSON.stringify(scanPatch(row)),
  });
  if (!res.ok) throw new Error(`scans upsert failed: ${res.status} ${await failText(res)}`);
}

/** Read one `scans` row (or null). */
/**
 * One scan_raw row by id, or null. Used when a workflow step is retried after its write already
 * landed, so the engine isn't billed twice for the same answer. Never throws.
 */
export async function getRawById(env, id, { fetchImpl = fetch } = {}) {
  try {
    if (!isUuid(id)) return null;
    const { base, headers } = supa(env);
    const res = await fetchImpl(`${base}/scan_raw?id=eq.${id}&select=engine,question_id,question_text,run,model,answer_text,citations,ok,error,cost_usd,asked_at&limit=1`, { headers });
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

export async function getScan(env, id, { fetchImpl = fetch } = {}) {
  if (!isUuid(id)) return null;
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scans?id=eq.${id}&select=*&limit=1`, { headers });
  if (!res.ok) throw new Error(`scans read failed: ${res.status} ${await failText(res)}`);
  const [row] = await res.json();
  return row || null;
}

/** Per-call progress for a scan from scan_raw + scan_usage: counts, cost so far, recent errors. */
export async function scanProgress(env, scanId, { fetchImpl = fetch } = {}) {
  if (!isUuid(scanId)) return null;
  const { base, headers } = supa(env);
  const [raw, usage] = await Promise.all([
    fetchImpl(`${base}/scan_raw?scan_id=eq.${scanId}&select=engine,question_id,run,ok,error,cost_usd`, { headers }),
    fetchImpl(`${base}/scan_usage?scan_id=eq.${scanId}&select=kind,ok,error,cost_usd,answer_ref`, { headers }),
  ]);
  if (!raw.ok) throw new Error(`scan_raw read failed: ${raw.status} ${await failText(raw)}`);
  const rawRows = await raw.json();
  const usageRows = usage.ok ? await usage.json() : [];
  const sum = (rows) => Math.round(rows.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;
  const byEngine = {};
  for (const r of rawRows) {
    const e = (byEngine[r.engine] ||= { calls: 0, ok: 0, costUsd: 0 });
    e.calls++;
    if (r.ok) e.ok++;
    e.costUsd = Math.round((e.costUsd + (Number(r.cost_usd) || 0)) * 1e6) / 1e6;
  }
  return {
    callsDone: rawRows.length,
    callsOk: rawRows.filter((r) => r.ok).length,
    extractionsDone: usageRows.filter((r) => r.kind === 'extract').length,
    engineCostUsd: sum(rawRows),
    extractCostUsd: sum(usageRows),
    costUsd: Math.round((sum(rawRows) + sum(usageRows)) * 1e6) / 1e6,
    byEngine,
    errors: [
      ...rawRows.filter((r) => !r.ok).map((r) => `${r.engine} ${r.question_id} r${r.run}: ${scrubKeyFragments(String(r.error || 'failed'))}`),
      ...usageRows.filter((r) => !r.ok).map((r) => `extract ${r.answer_ref || ''}: ${scrubKeyFragments(String(r.error || 'failed'))}`),
    ].slice(0, 20),
  };
}

/** The v2 scan_results row already saved for a scan (so a retried save step doesn't insert twice). */
export async function findReportByScan(env, scanId, { fetchImpl = fetch } = {}) {
  if (!isUuid(scanId)) return null;
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/scan_results?scan_id=eq.${scanId}&version=eq.2&select=id,report_token&limit=1`, { headers });
  if (!res.ok) throw new Error(`scan_results read failed: ${res.status} ${await failText(res)}`);
  const [row] = await res.json();
  return row || null;
}

/**
 * Find or create the `businesses` row for a scan. With `business.id`, loads that row and fills
 * missing fields from it. Otherwise matches on exact name (+ phone when given), else inserts.
 * Returns the merged business (with `id`). Throws on DB errors.
 * (businesses has no town/zip columns; those stay on the scan params.)
 */
export async function ensureBusiness(env, business, { fetchImpl = fetch } = {}) {
  const { base, headers } = supa(env);
  const merge = (row) => ({
    ...business,
    id: row.id,
    name: business.name || row.name,
    trade: business.trade || row.trade,
    phone: business.phone || row.phone || null,
    website: business.website || row.website || null,
    address: business.address || row.address || null,
  });
  if (isUuid(business.id)) {
    const res = await fetchImpl(`${base}/businesses?id=eq.${business.id}&select=*&limit=1`, { headers });
    if (!res.ok) throw new Error(`businesses read failed: ${res.status} ${await failText(res)}`);
    const [row] = await res.json();
    if (row) return merge(row);
  }
  if (!business.name) throw new Error('business.name is required');
  let q = `name=eq.${encodeURIComponent(business.name)}&select=*&order=created_at.asc&limit=1`;
  if (business.phone) q += `&phone=eq.${encodeURIComponent(business.phone)}`;
  const found = await fetchImpl(`${base}/businesses?${q}`, { headers });
  if (!found.ok) throw new Error(`businesses read failed: ${found.status} ${await failText(found)}`);
  const [hit] = await found.json();
  if (hit) return merge(hit);
  const row = {
    name: String(business.name).slice(0, 200),
    trade: business.trade ?? null,
    phone: business.phone ?? null,
    website: business.website ?? null,
    address: business.address ?? null,
  };
  const res = await fetchImpl(`${base}/businesses`, { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`businesses insert failed: ${res.status} ${await failText(res)}`);
  const [saved] = await res.json();
  return { ...business, id: saved.id };
}
