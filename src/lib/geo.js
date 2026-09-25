// src/lib/geo.js — local examples on the public pages, from the visitor's approximate location.
//
// Cloudflare puts a city-level guess on every request (request.cf: city, region, regionCode,
// postalCode, country, ...). The Worker uses it only to swap the example town in the page copy
// ("What's the best plumber in Hicksville, NY?"); nothing here is logged or stored.
// Only request.cf is read, never a client-sent header, and every value is checked strictly
// before it goes near the HTML. Anything unusable falls back to DEFAULT_GEO, the town the
// static pages already use, so the page reads the same with or without this.
//
// Pure: no I/O. addGeoHandlers() takes the HTMLRewriter instance to extend, so the Worker and
// the tests (Miniflare) share it.

import { freeQuestions } from '../../scanner/questions.js';
import { US_STATES } from '../../scanner/config.js';

/** The example the static HTML is written for (Long Island, where the first batch is). */
export const DEFAULT_GEO = Object.freeze({
  town: 'Massapequa', state: 'NY', stateName: 'New York', zip: '11758', country: 'US', source: 'default',
});

/** The trade the homepage example questions are for. */
export const EXAMPLE_TRADE = 'plumbing';

const TOWN_MAX = 40;
// Letters (any script, with accents), spaces, . ' - and nothing else; starts with a letter.
const TOWN_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;

/** A town name safe for the page, or '' if the value isn't plainly a town name. */
export function cleanTown(v) {
  if (typeof v !== 'string') return '';
  const t = v.normalize('NFC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  if (!t || t.length > TOWN_MAX || !TOWN_RE.test(t)) return '';
  return t;
}

/** "11758" or "11758-1234" → "11758"; anything else → ''. */
export function cleanZip(v) {
  const m = /^(\d{5})(?:-\d{4})?$/.exec(typeof v === 'string' ? v.trim() : '');
  return m ? m[1] : '';
}

/** "NY" if it's a US state (or DC) code, else ''. */
export function cleanState(v) {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return Object.hasOwn(US_STATES, s) ? s : '';
}

/**
 * request.cf → { town, state, stateName, zip, country, source: 'ip' | 'default' }.
 * Personalised only for a US request with a clean city and state; otherwise DEFAULT_GEO.
 * A missing or odd ZIP just leaves zip '' (the town is still used).
 */
export function geoFromCf(cf) {
  if (!cf || typeof cf !== 'object' || cf.country !== 'US') return { ...DEFAULT_GEO };
  const town = cleanTown(cf.city);
  const state = cleanState(cf.regionCode);
  if (!town || !state) return { ...DEFAULT_GEO };
  return { town, state, stateName: US_STATES[state], zip: cleanZip(cf.postalCode), country: 'US', source: 'ip' };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Dev only: `?geo=Hicksville,NY,11801` (or `?geo=off` for "no location") stands in for
 * request.cf, because `wrangler dev` has no real visitor location. Honoured only when the
 * request's own hostname is localhost, so it can never change a production page.
 * → a cf-like object, or null to use the real request.cf.
 */
export function devGeoOverride(url) {
  if (!url || !LOCAL_HOSTS.has(url.hostname)) return null;
  const raw = url.searchParams.get('geo');
  if (raw == null) return null;
  if (raw === 'off') return {};
  const [city, regionCode, postalCode] = raw.split(',').map((s) => s.trim());
  return { country: 'US', city, regionCode, postalCode };
}

// Crawlers get the default example, so search snippets don't show a data centre's town.
const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse/i;

/** The geo for this request (Worker side): dev override, then request.cf; bots get the default. */
export function geoForRequest(request, url = new URL(request.url)) {
  const dev = devGeoOverride(url);
  if (dev) return geoFromCf(dev);
  if (BOT_UA.test(request.headers.get('User-Agent') || '')) return { ...DEFAULT_GEO };
  return geoFromCf(request.cf);
}

// A neighbouring town for the "near ..." questions, like the demo's North Babylon → Deer Park.
// Long Island only; anywhere else the questions just use the town itself.
const NEARBY_NY = {
  massapequa: 'Seaford', 'massapequa park': 'Massapequa', seaford: 'Wantagh', wantagh: 'Seaford',
  'north babylon': 'Deer Park', 'deer park': 'North Babylon', 'west babylon': 'North Babylon',
  babylon: 'West Babylon', lindenhurst: 'Copiague', copiague: 'Lindenhurst', amityville: 'Massapequa',
  farmingdale: 'Bethpage', bethpage: 'Plainview', plainview: 'Hicksville', hicksville: 'Plainview',
  levittown: 'Hicksville', 'east meadow': 'Levittown', merrick: 'Bellmore', bellmore: 'Merrick',
  freeport: 'Merrick', baldwin: 'Freeport', oceanside: 'Rockville Centre', 'rockville centre': 'Oceanside',
  lynbrook: 'Valley Stream', 'valley stream': 'Lynbrook', hempstead: 'Garden City', 'garden city': 'Mineola',
  mineola: 'Garden City', huntington: 'Huntington Station', 'huntington station': 'Huntington',
  commack: 'Hauppauge', hauppauge: 'Smithtown', smithtown: 'Hauppauge', 'bay shore': 'Islip',
  islip: 'Bay Shore', brentwood: 'Bay Shore', ronkonkoma: 'Holbrook', holbrook: 'Ronkonkoma',
  patchogue: 'Medford', medford: 'Patchogue', 'glen cove': 'Oyster Bay', 'oyster bay': 'Glen Cove',
};

/** Neighbouring town for {near}, or '' when we don't have one. */
export function nearbyTown(town, state) {
  if (state !== 'NY') return '';
  return NEARBY_NY[String(town || '').toLowerCase()] || '';
}

/** The homepage's example questions for this geo: the scanner's own templates, same as /api/questions. */
export function exampleQuestions(geo, trade = EXAMPLE_TRADE) {
  const g = geo || DEFAULT_GEO;
  return freeQuestions({ trade, town: g.town, state: g.state, zip: g.zip, nearbyTown: nearbyTown(g.town, g.state) });
}

/** Short stable tag for the ETag ('' for the default page), so a 304 never crosses towns. */
export function geoTag(geo) {
  if (!geo || geo.source !== 'ip') return '';
  // FNV-1a: the ETag carries a hash, not the town.
  let h = 0x811c9dc5;
  for (const ch of `${geo.town}|${geo.state}|${geo.zip}`) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `-geo.${h.toString(36)}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Add the location markers to an HTMLRewriter:
 *   <span data-geo-town>Massapequa</span>        town
 *   <span data-geo-state>NY</span>               state code ("name" → "New York")
 *   <span data-geo-zip>11758</span>              ZIP (element removed if we have none)
 *   <input data-geo-placeholder="town|zip">      placeholder = town / ZIP (ZIP: "5 digits" if none)
 *   <input data-geo-value="state">               value = state code (the form's hidden state)
 *   <ol data-geo-questions="plumbing">           the three example questions, as <li>s
 *   <p data-geo-hint hidden>                     shown only when the location came from the visitor
 * Text goes in as text (escaped by HTMLRewriter); the question list is escaped here.
 */
export function addGeoHandlers(rewriter, geo) {
  const g = geo || DEFAULT_GEO;
  return rewriter
    .on('[data-geo-town]', { element(el) { el.setInnerContent(g.town); } })
    .on('[data-geo-state]', {
      element(el) { el.setInnerContent(el.getAttribute('data-geo-state') === 'name' ? g.stateName : g.state); },
    })
    .on('[data-geo-zip]', { element(el) { if (g.zip) el.setInnerContent(g.zip); else el.remove(); } })
    .on('[data-geo-placeholder]', {
      element(el) {
        const kind = el.getAttribute('data-geo-placeholder');
        if (kind === 'town') el.setAttribute('placeholder', g.town);
        else if (kind === 'zip') el.setAttribute('placeholder', g.zip || '5 digits');
      },
    })
    .on('[data-geo-value]', {
      element(el) { if (el.getAttribute('data-geo-value') === 'state') el.setAttribute('value', g.state); },
    })
    .on('[data-geo-questions]', {
      element(el) {
        const qs = exampleQuestions(g, el.getAttribute('data-geo-questions') || EXAMPLE_TRADE);
        el.setInnerContent(qs.map((q) => `<li>${escapeHtml(q.text)}</li>`).join(''), { html: true });
      },
    })
    .on('[data-geo-hint]', { element(el) { if (g.source === 'ip') el.removeAttribute('hidden'); } });
}
