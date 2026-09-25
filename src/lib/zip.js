// src/lib/zip.js — GET /api/zip?zip=11758 → the town for a ZIP, so the free-report form asks for
// the ZIP only and shows "Massapequa, NY · change".
//
// Source: api.zippopotam.us (free, no key; one primary place per ZIP, sometimes a few). Answers are
// cached at the edge for 30 days. Any failure → {ok:false}; the form then shows a town box instead.

import { US_STATES } from '../../scanner/config.js';
import { cleanTown } from './geo.js';

export const CACHE_SECONDS = 30 * 24 * 3600;
export const SOURCE = 'https://api.zippopotam.us/us/';

/** Zippopotam JSON → [{ town, state }] (clean town names, US state codes only, no duplicates). */
export function parsePlaces(json) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(json?.places) ? json.places : []) {
    const town = cleanTown(p?.['place name']);
    const state = String(p?.['state abbreviation'] || '').toUpperCase();
    if (!town || !Object.hasOwn(US_STATES, state)) continue;
    const key = `${town.toLowerCase()}|${state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ town, state });
  }
  return out.slice(0, 10);
}

const reply = (body, maxAge) => Response.json(body, { headers: { 'Cache-Control': `public, max-age=${maxAge}` } });

/** deps: { fetchImpl, cache } */
export async function handleZip(url, deps = {}) {
  const zip = String(url.searchParams.get('zip') || '').trim();
  if (!/^\d{5}$/.test(zip)) return Response.json({ ok: false, error: 'ZIP must be 5 digits.' }, { status: 400 });
  const cache = deps.cache ?? (typeof caches !== 'undefined' ? caches.default : null);
  const key = new Request(`${url.origin}/api/zip?zip=${zip}`, { method: 'GET' });
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return hit; } catch { /* miss */ }
  }
  let places = [];
  let ok = false;
  try {
    const res = await (deps.fetchImpl || fetch)(SOURCE + zip, { signal: AbortSignal.timeout(4000) });
    if (res.ok) { places = parsePlaces(await res.json()); ok = true; }
    else if (res.status === 404) ok = true; // not a real ZIP: a cacheable "no places"
  } catch { /* network: not cached */ }
  const out = reply({ ok: places.length > 0, zip, places }, ok ? CACHE_SECONDS : 60);
  if (ok && cache) { try { await cache.put(key, out.clone()); } catch { /* ignore */ } }
  return out;
}
