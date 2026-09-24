// Homepage proof line: "We've checked N local businesses so far. AI named X of them in most of its answers."
//
// GET /api/proof -> { show: false } until N >= PROOF_MIN_SCANS (default 20), then
//                   { show: true, checked: N, namedMost: X }.
// N = businesses with a real v2 report (scan_results.version = 2), latest report per business.
// Samples are left out (report_token "sample-*", report.sample, no business_id).
// X = those whose latest report names them in more than half of its answers.
// Read with the anon key (scan_results has a public select policy); cached 1 hour at the edge.

export const DEFAULT_MIN_SCANS = 20;
export const CACHE_SECONDS = 3600;

export function minScans(env) {
  const n = Number(String(env?.PROOF_MIN_SCANS ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MIN_SCANS;
}

/**
 * rows: [{ business_id, report_token, scanned_at, totals: {answers, namedYou}, sample }], any order.
 * → { show, checked, namedMost } (checked/namedMost only when show).
 */
export function computeProof(rows, { min = DEFAULT_MIN_SCANS } = {}) {
  const latest = new Map();
  for (const r of rows || []) {
    if (!r || !r.business_id) continue;
    if (String(r.report_token || '').startsWith('sample-') || r.sample === true) continue;
    const answers = Number(r.totals?.answers);
    if (!Number.isInteger(answers) || answers <= 0) continue;
    const prev = latest.get(r.business_id);
    if (!prev || String(r.scanned_at || '') > String(prev.scanned_at || '')) latest.set(r.business_id, r);
  }
  const checked = latest.size;
  if (checked < min) return { show: false };
  let namedMost = 0;
  for (const r of latest.values()) {
    if ((Number(r.totals.namedYou) || 0) * 2 > Number(r.totals.answers)) namedMost++;
  }
  return { show: true, checked, namedMost };
}

export async function readProofRows(env, { fetchImpl = fetch } = {}) {
  const key = String(env?.SUPABASE_ANON_KEY || '').trim();
  const base = String(env?.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || !key) throw new Error('supabase not configured');
  const q = 'version=eq.2&select=business_id,report_token,scanned_at,totals:report->totals,sample:report->sample&order=scanned_at.desc&limit=5000';
  const res = await fetchImpl(`${base}/rest/v1/scan_results?${q}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`scan_results read failed: ${res.status}`);
  return res.json();
}

/**
 * GET /api/proof. deps: { readRows, cache (a Cache, default caches.default), waitUntil }.
 * Any failure -> { show: false } (the block just stays hidden), cached briefly.
 */
export async function handleProof(request, env, deps = {}) {
  const cache = deps.cache ?? (typeof caches !== 'undefined' ? caches.default : null);
  const cacheKey = new Request(new URL('/api/proof?v=1', request.url).toString(), { method: 'GET' });
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch { /* cache is best-effort */ }
  }
  let body;
  let maxAge = CACHE_SECONDS;
  try {
    body = computeProof(await (deps.readRows || readProofRows)(env), { min: minScans(env) });
  } catch (e) {
    console.error('[proof] read failed', String(e?.message || e).slice(0, 200));
    body = { show: false };
    maxAge = 300;
  }
  const res = Response.json(body, { headers: { 'Cache-Control': `public, max-age=${maxAge}` } });
  if (cache) {
    const put = cache.put(cacheKey, res.clone()).catch(() => {});
    if (deps.waitUntil) deps.waitUntil(put); else await put;
  }
  return res;
}
