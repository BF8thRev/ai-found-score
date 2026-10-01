// src/lib/site-check.js — the gate before a scan: is the website real, and does the business name
// look like a name? GET /api/site-check?website=&name= (both forms call it on submit, before
// anything is saved or scanned) and POST /api/request (the same check again, so a script can't skip it).
//
// Website:
//   - must be a public web address: no IPs, no localhost, a real-looking top-level domain
//   - Facebook, Yelp, Google and other big platforms block robots, so those only need a page path
//   - anything else is fetched once: any answer from the server counts, even 403 (bot walls).
//     No answer (the name doesn't exist, the server is gone) or a Cloudflare "origin down" code
//     → not reachable. A parked "this domain is for sale" page → not a business site.
//   - too slow to answer → let it through: a slow site is still a real site.
// Name: a light check for keyboard mashes and test strings, not a spell check.
//
// → { ok: true, url, zip?, town?, state?, name?, kind?, kindFrom? }
//   | { ok: false, field: 'website' | 'business_name', reason, error }
// zip/town/state: from the home page (schema, then "Town, ST 12345"), else the Google listing whose
// website is this site (GET /api/site-check only). name: the business's own name from its page
// (schema, og:site_name, <title>) or its Google listing. kind: what it does (scanner/kind.js).
// The form prefills from these; the owner checks them. Nothing here is treated as a fact.
// GET /api/site-check without ?name= (or with an empty one) checks the website only: the form asks
// for the website first and fills the name in from the answer.

import { resolveKeys, stateAbbr } from '../../scanner/config.js';
import { placesSearch } from '../../scanner/owner-checks.js';
import { findName, kindFromPage, guessKind } from '../../scanner/kind.js';
import { cleanTown, cleanState } from './geo.js';

export const SITE_CHECK_TIMEOUT_MS = 5000;
const PARKED_MAX_CHARS = 60_000;

// Pages owners paste instead of a website. These answer robots with walls or logins.
const PLATFORM_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'yelp.com', 'google.com', 'g.page', 'goo.gl', 'maps.app.goo.gl',
  'nextdoor.com', 'linkedin.com', 'tiktok.com', 'x.com', 'twitter.com', 'angi.com', 'angieslist.com',
  'houzz.com', 'thumbtack.com', 'bbb.org', 'homeadvisor.com', 'yellowpages.com', 'tripadvisor.com',
];
// Cloudflare's own "the site behind me is down / doesn't exist" answers.
const ORIGIN_DOWN = new Set([521, 522, 523, 530]);
const PARKED_RE = /domain (?:name )?(?:is|may be) for sale|buy this domain|this domain is parked|parked free|domain parking|parkingcrew|sedoparking|bodis\.com|afternic|hugedomains/i;
// Whole-name matches only: "123 Plumbing" and "JKL Construction" are real names.
const MASH_RE = /^(?:asdf[a-z]*|qwer[a-z]*|zxcv[a-z]*|test(?:ing)?\d*|test(?:business|company|biz)|sample|fake|n\/?a|none|null|undefined|blah|abc|abc123)$/i;

export const MESSAGES = {
  format: 'That doesn\'t look like a web address. Enter your website, like yourbusiness.com, or paste your Facebook or Yelp page.',
  platform: 'Paste the full link to your business page, not just the site\'s home page.',
  unreachable: 'We couldn\'t find a website at that address. Check the spelling, or paste your Facebook or Yelp page instead.',
  parked: 'That address shows a "domain for sale" page, not a business. Check the spelling, or paste your Facebook or Yelp page instead.',
  name: 'Please enter your real business name, the way customers know it.',
};

/** A public http(s) address, else null. (scanner/kind.js publicSite also drops social pages.) */
function parseSite(w) {
  if (!w || /\s/.test(w)) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  // Letters in the last part, 2 or more: "garage", "garage.c", "10.0.0.1" and "my.local" all fail.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) || /\.(local|localhost|internal)$/.test(host)) return null;
  return u;
}

const bad = (field, reason) => ({ ok: false, field, reason, error: MESSAGES[reason] });

const isPlatform = (host) => PLATFORM_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));

/** A business name that is plainly not one ("asdf", "test", "zzzz", "!!!"). */
export function checkName(name) {
  const s = String(name ?? '').trim();
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return bad('business_name', 'name');
  if (/^(.)\1+$/i.test(letters)) return bad('business_name', 'name');
  if (MASH_RE.test(s.replace(/\s+/g, ''))) return bad('business_name', 'name');
  return { ok: true };
}

/** deps: { fetchImpl, timeoutMs } */
export async function checkWebsite(website, { fetchImpl = (...a) => fetch(...a), timeoutMs = SITE_CHECK_TIMEOUT_MS } = {}) {
  const u = parseSite(String(website ?? '').trim());
  if (!u) return bad('website', 'format');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (isPlatform(host)) {
    return u.pathname.replace(/\/+$/, '') || u.search ? { ok: true, url: u.href } : bad('website', 'platform');
  }
  let res;
  try {
    res = await fetchImpl(u.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIFoundScore/1.0; +https://aifoundscore.com)', Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: true, url: u.href, slow: true };
    return bad('website', 'unreachable');
  }
  if (ORIGIN_DOWN.has(res.status)) return bad('website', 'unreachable');
  if (res.ok && /html/i.test(res.headers.get('Content-Type') || 'text/html')) {
    const html = await res.text().catch(() => '');
    if (PARKED_RE.test(html.slice(0, PARKED_MAX_CHARS))) return bad('website', 'parked');
    // The form asks for the website first: the page supplies the ZIP/town, the name and the kind
    // when it shows them (each only when found, so the answer stays small and the test shapes exact).
    const out = { ok: true, url: u.href };
    const place = findPlace(html);
    if (place.zip) out.zip = place.zip;
    if (place.town) { out.town = place.town; out.state = place.state; }
    const name = findName(html);
    if (name) out.name = name;
    const kind = kindFromPage(html);
    if (kind) { out.kind = kind; out.kindFrom = 'website'; }
    return out;
  }
  return { ok: true, url: u.href };
}

/** "NY" / "New York" → "NY"; anything that isn't a US state → ''. */
const stateCode = (s) => (String(s || '').trim() ? cleanState(stateAbbr(String(s).trim())) : '');
/** The town at the end of a run of text: the trailing capitalized words ("Located in beautiful Plainview" → "Plainview"). */
function trailingTown(raw) {
  const t = String(raw || '').trim();
  const m = /((?:[A-Z][A-Za-z.'’-]*\s*){1,4})$/.exec(t);
  const pick = m ? m[1].trim() : t;
  return cleanTown(pick.split(' ').length <= 4 ? pick : '') || '';
}

/**
 * The business's ZIP (and town, state) from its home page. Schema address first (it is the
 * business's own); else the most frequent "Town, ST 12345" in the text (ties: the first one), so a
 * footer address beats a one-off mention of a nearby town.
 * → { zip, town, state } with '' for anything not found.
 */
export function findPlace(html) {
  const s = String(html || '').slice(0, 400_000);
  const none = { zip: '', town: '', state: '' };
  const schemaZip = /"postalCode"\s*:\s*"(\d{5})(?:-\d{4})?"/.exec(s);
  if (schemaZip) {
    const town = cleanTown((/"addressLocality"\s*:\s*"([^"]{1,60})"/.exec(s) || [])[1]);
    const state = stateCode((/"addressRegion"\s*:\s*"([^"]{1,30})"/.exec(s) || [])[1]);
    return { zip: schemaZip[1], town: town || '', state: town ? state : '' };
  }
  const text = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ');
  const counts = new Map();
  const seen = new Map(); // zip → { town, state } from its first mention
  for (const m of text.matchAll(/([A-Za-z][A-Za-z.'’ -]{1,40}?)\s*,\s*([A-Z]{2}|New York|New Jersey|Connecticut)\.?,?\s+(\d{5})(?:-\d{4})?\b/g)) {
    const zip = m[3];
    counts.set(zip, (counts.get(zip) || 0) + 1);
    if (!seen.has(zip)) {
      // The town is the last comma-free run before ", ST": "1800 Arctic Ave, Bohemia" → "Bohemia";
      // "Serving Bohemia" → "Bohemia" (cleanTown drops a leading street number too).
      const raw = m[1].split(/,|\s{2,}|\d+\s/).pop()
        .replace(/^.*?\b(?:drive|dr|street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|way|court|ct|place|pl|highway|hwy|turnpike|tpke|parkway|pkwy|route|rte)\.?\s+(?:(?:suite|ste|unit|floor|fl|apt|#)\.?\s*\w+\s+)?/i, '')
        .trim();
      seen.set(zip, { town: trailingTown(raw), state: stateCode(m[2]) });
    }
  }
  let best = '';
  for (const [z, n] of counts) if (!best || n > counts.get(best)) best = z;
  if (!best) return none;
  const t = seen.get(best) || { town: '', state: '' };
  return { zip: best, town: t.town, state: t.town ? t.state : '' };
}

/** The business's ZIP from its home page, or '' (findPlace().zip). */
export function findZip(html) {
  return findPlace(html).zip;
}

/** The whole gate: the name first (no network), then the website when there is one. */
export async function checkSubmission({ name, website } = {}, deps = {}) {
  const n = checkName(name);
  if (!n.ok) return n;
  if (!String(website ?? '').trim()) return { ok: true, url: null };
  return checkWebsite(website, deps);
}

/**
 * GET /api/site-check?website=&name=
 * Without a name (the form asks for the website first) only the website is checked, and the
 * answer carries what the page and the Google listing say the business is called.
 */
export async function handleSiteCheck(url, deps = {}) {
  const p = url.searchParams;
  const typed = String(p.get('name') || '').trim().slice(0, 120);
  const r = await checkSubmission({ name: typed || 'ok', website: String(p.get('website') || '').slice(0, 160) }, deps);
  if (r.ok && r.url && deps.env) {
    // No ZIP on the page (bot wall, no address on the home page), or no name yet: ask Google for
    // the listing whose website is this site. Searched by the typed name, else the page's own.
    const searchName = typed || r.name || '';
    if (searchName && (!r.zip || !r.name)) {
      const place = await placeFromPlaces(searchName, r.url, deps.env, deps).catch(() => null);
      if (place) {
        if (!r.zip && place.zip) { r.zip = place.zip; if (place.town) { r.town = place.town; r.state = place.state; } }
        if (!r.name && place.name) r.name = place.name;
      }
    }
  }
  if (r.ok && r.url) {
    // What it does: the typed name first (the owner's words), then the page.
    const byName = guessKind(typed);
    if (byName) { r.kind = byName; r.kindFrom = 'name'; }
    if (!r.kind && r.name && !typed) { const k = guessKind(r.name); if (k) { r.kind = k; r.kindFrom = 'name'; } }
  }
  return Response.json(r, { headers: { 'Cache-Control': 'no-store' } });
}

const hostOf = (s) => { try { return new URL(s).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/**
 * The ZIP from the business's Google listing, or ''. One Places Text Search by name (address and
 * website only, the cheaper field tier). Only a listing whose website is this same site counts:
 * a name alone could be another business with the same name. Needs the Places key; else ''.
 */
export async function zipFromPlaces(name, siteUrl, env, deps = {}) {
  return (await placeFromPlaces(name, siteUrl, env, deps))?.zip || '';
}

/**
 * The Google listing whose website is this site: → { zip, town, state, name } (each '' when the
 * listing doesn't show it), or null when there is no key, no name to search by, or no such listing.
 */
export async function placeFromPlaces(name, siteUrl, env, { placesFetch = (...a) => fetch(...a) } = {}) {
  const key = resolveKeys(env).googlePlacesKey;
  const host = hostOf(siteUrl);
  if (!key || !host || isPlatform(host) || !String(name || '').trim()) return null;
  const r = await placesSearch(String(name).trim().slice(0, 120), key, 'places.formattedAddress,places.websiteUri,places.displayName', placesFetch);
  const place = (r.places || []).find((pl) => pl.websiteUri && hostOf(pl.websiteUri) === host);
  if (!place) return null;
  const m = /(?:^|,)\s*([^,]{1,60}?)\s*,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\b/.exec(place.formattedAddress || '');
  const town = m ? trailingTown(m[1]) : '';
  return { zip: m ? m[3] : '', town, state: m && town ? stateCode(m[2]) : '', name: String(place.displayName?.text || place.displayName || '').trim().slice(0, 80) };
}
