// src/lib/site-platform.js — the website builder for reports scanned before the scanner recorded it.
//
// New scans store siteCheck.platform (scanner/owner-checks.js checkSite; null when no builder was
// recognised). Reports from before that have no `platform` key at all; for those, lookupPlatform()
// fetches the homepage once and runs the same detectPlatform() (shared/platform-detect.js).
//
// Not written back to the stored report: preview builds read and write the production database, and
// rewriting a validated report from a page view (racing the monthly re-check that also writes it) is
// a risk for one small field. Instead the answer is kept in the Worker's Cache API, keyed by the site's
// host: one homepage fetch per site per data centre per week, and a failed fetch is retried after an hour.
//
//   withPlatform(report, deps)       → the report, with siteCheck.platform filled in when it was missing
//                                      (fetches on a cache miss; never throws; the report as is on failure)
//   cachedPlatform(report, deps)     → the same, from the cache only (no fetch): for the report page,
//                                      which must not wait on someone else's website
//   lookupPlatform(website, deps)    → { id, name, confidence, evidence } | null
//
// deps: { fetchImpl, cache (a Cache; default caches.default when it exists), waitUntil }.

import { getText, siteUrl } from '../../scanner/owner-checks.js';
import { detectPlatform } from '../../shared/platform-detect.js';

export const PLATFORM_TIMEOUT_MS = 5000;
export const PLATFORM_MAX_BYTES = 1_000_000;
const FOUND_TTL = 7 * 24 * 3600;
const NOT_FOUND_TTL = 24 * 3600;
const FAILED_TTL = 3600;

const defaultCache = () => (typeof caches !== 'undefined' && caches.default ? caches.default : null);
const cacheKey = (host) => new Request(`https://aifoundscore.com/__cache/site-platform/v1/${encodeURIComponent(host)}`, { method: 'GET' });

/** Does this report still need its builder looked up? (a stored siteCheck without a `platform` key) */
export function needsPlatform(report) {
  const sc = report && report.siteCheck;
  return !!(sc && typeof sc === 'object' && !Object.hasOwn(sc, 'platform') && websiteOf(report));
}

function websiteOf(report) {
  const u = siteUrl((report.siteCheck && report.siteCheck.url) || (report.business && report.business.website));
  return u ? u.origin : null;
}

async function readCache(cache, host) {
  if (!cache) return undefined;
  try {
    const hit = await cache.match(cacheKey(host));
    if (!hit) return undefined;
    const j = await hit.json();
    return j && Object.hasOwn(j, 'platform') ? j.platform : undefined;
  } catch { return undefined; }
}

/** The builder for one website: from the cache, else one homepage fetch (then cached). */
export async function lookupPlatform(website, { fetchImpl = (...a) => fetch(...a), cache = defaultCache(), waitUntil = null } = {}) {
  const u = siteUrl(website);
  if (!u) return null;
  const host = u.host.toLowerCase();
  const hit = await readCache(cache, host);
  if (hit !== undefined) return hit;
  const home = await getText(fetchImpl, `${u.origin}/`, { timeoutMs: PLATFORM_TIMEOUT_MS, maxBytes: PLATFORM_MAX_BYTES });
  const platform = home.ok ? detectPlatform(home.text, home.headers, home.url || `${u.origin}/`) : null;
  if (cache) {
    const ttl = !home.ok ? FAILED_TTL : platform ? FOUND_TTL : NOT_FOUND_TTL;
    const put = cache.put(cacheKey(host), Response.json({ platform }, { headers: { 'Cache-Control': `public, max-age=${ttl}` } })).catch(() => {});
    if (waitUntil) waitUntil(put); else await put;
  }
  return platform;
}

const withIt = (report, platform) => ({ ...report, siteCheck: { ...report.siteCheck, platform } });

export async function withPlatform(report, deps = {}) {
  if (!needsPlatform(report)) return report;
  try {
    return withIt(report, await lookupPlatform(websiteOf(report), deps));
  } catch (e) {
    console.warn('[site-platform] lookup failed', String(e?.message || e).slice(0, 200));
    return report;
  }
}

export async function cachedPlatform(report, { cache = defaultCache(), waitUntil = null, fetchImpl } = {}) {
  if (!needsPlatform(report)) return report;
  const host = new URL(websiteOf(report)).host.toLowerCase();
  const hit = await readCache(cache, host);
  if (hit !== undefined) return withIt(report, hit);
  // Not known yet: look it up after the page is sent, so the next visit has it.
  if (waitUntil && cache) waitUntil(lookupPlatform(websiteOf(report), { cache, fetchImpl, waitUntil }).catch(() => null));
  return report;
}
