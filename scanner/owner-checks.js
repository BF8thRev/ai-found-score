// scanner/owner-checks.js — what the owner's own website and Google listing say, checked before a
// report is built. No logins: public pages and the Google Places API only.
//
//   1. Website: robots.txt (are AI crawlers blocked?), sitemap, schema.org LocalBusiness markup,
//      and the phone number and street address the site shows (schema first, then the page text).
//      Also: /llms.txt, https (and whether http:// forwards to it), the homepage title, meta
//      description and H1 (do they say the trade and the town?), FAQPage schema, links to service
//      and town pages, and Google's PageSpeed Insights mobile score (only with a key: PAGESPEED_API_KEY,
//      else the Places key; that key's project must have the PageSpeed Insights API enabled).
//   2. Google: the business's Google Maps listing via the Places API (New) Text Search, when a key
//      is set (GOOGLE_PLACES_API_KEY; aliases in scanner/config.js). Picked by website match, else name.
//      Its rating and review count too, and (lookupCompetitorReviews) those of the businesses AI named most.
//   3. Compare: Google's name, phone and address against the website (or what the owner gave us).
//
// runOwnerChecks() → { siteCheck, listings, issues, facts, reviews } for buildReport: `listings` fill the
// report's listings section, `issues` are extra fixes (same shape as scanner/extract/issues.js),
// `facts` (phone, address) are the owner's details as their own website states them, `reviews` the
// owner's Google rating and review count.
// Every check fails soft: a site that won't load or a missing key just means fewer findings.

import { resolveKeys } from './config.js';
import { TRADES, TRADE_ALIASES, normalizeTrade } from './questions.js';
import { normalizeName, phoneKey, streetKey, findPhones, findStreets } from './extract/normalize.js';

export const FETCH_TIMEOUT_MS = 8000;
export const MAX_PAGE_BYTES = 1_500_000;
export const UA = 'Mozilla/5.0 (compatible; AIFoundScoreBot/1.0; +https://aifoundscore.com/about)';

/** The crawlers AI assistants use to read websites, with who runs them. */
export const AI_BOTS = [
  { agent: 'GPTBot', who: 'ChatGPT (training)' },
  { agent: 'OAI-SearchBot', who: 'ChatGPT search' },
  { agent: 'ChatGPT-User', who: 'ChatGPT' },
  { agent: 'ClaudeBot', who: 'Claude' },
  { agent: 'Claude-SearchBot', who: 'Claude search' },
  { agent: 'PerplexityBot', who: 'Perplexity' },
  { agent: 'Google-Extended', who: 'Gemini' },
  { agent: 'Googlebot', who: 'Google Search and AI Overviews' },
  { agent: 'Bingbot', who: 'Bing and Copilot' },
];

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/** robots.txt text → [{ agents: [lowercase], rules: [{ allow, path }] }]. */
export function parseRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'disallow') cur.rules.push({ allow: false, path: val });
      else if (key === 'allow') cur.rules.push({ allow: true, path: val });
    }
  }
  return groups;
}

/** Is the site's home page closed to this user agent? Longest matching rule wins, allow on a tie. */
export function blocksHome(groups, agent) {
  const a = agent.toLowerCase();
  const group = groups.find((g) => g.agents.includes(a)) || groups.find((g) => g.agents.includes('*'));
  if (!group) return false;
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    if (!'/'.startsWith(r.path.replace(/\*$/, '').replace(/\$$/, '')) && r.path !== '/') continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !!best && !best.allow;
}

// ---------------------------------------------------------------------------
// the home page
// ---------------------------------------------------------------------------

// Schema types that describe a page, not a business. Anything else with a phone or address counts
// (schema.org has hundreds of business subtypes: Plumber, LaundryOrDryCleaner, RoofingContractor, ...).
const PAGE_TYPES = /^(WebSite|WebPage|FAQPage|BreadcrumbList|ItemList|ImageObject|SiteNavigationElement|SearchAction|Question|Answer|Article|BlogPosting|Offer|AggregateRating|Review|Person)$/;
const isBusinessNode = (n) => [].concat(n['@type'] || []).some((t) => !PAGE_TYPES.test(String(t))) && !!(n.telephone || n.address);

/** "6312540914" / "+1 631-254-0914" → "(631) 254-0914"; anything else unchanged. */
export function formatPhone(s) {
  const k = phoneKey(s);
  return k ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : String(s || '').trim();
}

function flattenLd(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return out; }
  if (node && typeof node === 'object') {
    out.push(node);
    if (node['@graph']) flattenLd(node['@graph'], out);
  }
  return out;
}

function addressText(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return addressText(a[0]);
  return [a.streetAddress, a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** HTML → the page's plain text (scripts and styles dropped, tags to spaces, entities decoded). */
export function pageText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/**
 * Home page HTML → { schemaTypes, schema: { name, phone, address }, phone, address }.
 * phone/address: from LocalBusiness-type schema first, then tel: links, then the page text.
 */
export function readHomePage(html) {
  const h = String(html || '');
  const nodes = [];
  for (const m of h.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { flattenLd(JSON.parse(m[1].trim()), nodes); } catch { /* bad JSON-LD: ignore */ }
  }
  const types = [...new Set(nodes.flatMap((n) => [].concat(n['@type'] || [])).map(String))];
  const biz = nodes.find(isBusinessNode) || null;
  const schema = biz ? {
    name: typeof biz.name === 'string' ? biz.name.trim() : '',
    phone: typeof biz.telephone === 'string' ? biz.telephone.trim() : '',
    address: addressText(biz.address).trim(),
  } : null;
  const text = pageText(h);
  const tel = /href=["']tel:([^"']+)["']/i.exec(h);
  const phone = (schema && phoneKey(schema.phone) && schema.phone)
    || (tel && phoneKey(decodeURIComponent(tel[1])) && decodeURIComponent(tel[1]).trim())
    || (() => { const p = findPhones(text)[0]; return p ? text.substr(p.index, 20).match(/[\d()+.\s-]{10,20}/)[0].trim() : ''; })();
  const street = findStreets(text)[0];
  const address = (schema && streetKey(schema.address) && schema.address) || (street ? street.raw.replace(/[.,]$/, '') : '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1];
  return { schemaTypes: types, schema, phone: phone ? formatPhone(phone) : '', address: address || '', hasTitle: !!(title && title.trim()) };
}

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

export function siteUrl(website) {
  const w = String(website || '').trim();
  if (!w || /\s/.test(w)) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`);
    // Social pages aren't the owner's own site: no robots.txt or schema to check.
    if (/(^|\.)(facebook|instagram|yelp|google|linkedin|nextdoor|x|twitter)\.com$/i.test(u.hostname)) return null;
    return u;
  } catch { return null; }
}

async function getText(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    const text = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    return { ok: true, status: res.status, text, url: res.url || url, contentType };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e?.message || e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// more website checks: pure helpers first, then the fetchers
// ---------------------------------------------------------------------------

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** pageText plus numeric entities (&#8211; &#x27;), for short strings like a title. */
function cleanText(html) {
  const cp = (n) => { try { return String.fromCodePoint(n); } catch { return ' '; } };
  return pageText(html)
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => cp(parseInt(n, 16)))
    .trim();
}

/** Homepage HTML → { title, description, h1 } ('' when missing). */
export function readMeta(html) {
  const h = String(html || '');
  const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1] || '');
  let description = '';
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\bname\s*=\s*["']?description["'\s/>]/i.test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (c) { description = cleanText(c[1] ?? c[2]); break; }
  }
  const h1 = cleanText((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(h) || [])[1] || '');
  return { title: title.slice(0, 200), description: description.slice(0, 400), h1: h1.slice(0, 200) };
}

/**
 * The words a page might use for this trade: what the owner gave us, the TRADES key, the noun a
 * homeowner types (scanner/questions.js) and its aliases. "plumbing" → plumbing, plumber, ...
 */
export function tradeWords(trade) {
  const raw = String(trade || '').trim().toLowerCase();
  if (!raw) return [];
  const words = [raw];
  const key = normalizeTrade(raw);
  if (key) {
    words.push(key.replace(/_/g, ' '), TRADES[key].trade);
    for (const [alias, k] of Object.entries(TRADE_ALIASES)) if (k === key) words.push(alias);
  }
  return [...new Set(words.map((w) => w.replace(/[\s_-]+/g, ' ').trim()).filter((w) => w.length >= 3))];
}

/** The homeowner noun for a trade ("plumbing" → "plumber"); the owner's own word when unknown. */
export function tradeNoun(trade) {
  const key = normalizeTrade(trade);
  return key ? TRADES[key].trade : String(trade || '').trim().toLowerCase();
}

/** Does the text use any of these words (whole words, plural s/es allowed, spaces or hyphens between)? */
export function mentionsAny(text, words) {
  const t = String(text || '');
  if (!t) return false;
  return (words || []).filter(Boolean).some((w) => {
    const body = String(w).trim().split(/\s+/).map(escapeRe).join('[\\s_-]+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?:s|es)?(?![\\p{L}\\p{N}])`, 'iu').test(t);
  });
}

/**
 * readMeta(html) plus the owner's trade and town → { title, description, h1, mentionsTrade, mentionsTown }.
 * mentionsTrade / mentionsTown: does the title, description or H1 say it? null when we don't know
 * the trade (or town) to look for.
 */
export function metaCheck(html, business = {}) {
  const m = readMeta(html);
  const all = [m.title, m.description, m.h1].join(' \n ');
  const words = tradeWords(business.trade);
  const town = String(business.town || '').trim();
  return {
    ...m,
    mentionsTrade: words.length ? mentionsAny(all, words) : null,
    mentionsTown: town ? mentionsAny(all, [town]) : null,
  };
}

const ASSET_RE = /\.(jpe?g|png|gif|webp|svg|ico|pdf|css|js|xml|txt|zip|mp4|mp3)$/i;

/** Homepage HTML → its links to other pages on the same site: [{ path, text }], one per path. */
export function readLinks(html, base) {
  let b;
  try { b = new URL(base); } catch { return []; }
  const host = b.hostname.replace(/^www\./i, '').toLowerCase();
  const seen = new Map();
  for (const m of String(html || '').matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!href || /^(#|mailto:|tel:|sms:|javascript:)/i.test(href)) continue;
    let u;
    try { u = new URL(href, b); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./i, '').toLowerCase() !== host) continue;
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
    path = path.replace(/\/+$/, '') || '/';
    if (path === '/' || ASSET_RE.test(path)) continue;
    const text = cleanText(m[4]).slice(0, 120);
    const cur = seen.get(path);
    if (!cur) seen.set(path, { path, text });
    else if (!cur.text && text) cur.text = text;
  }
  return [...seen.values()];
}

const SERVICE_RE = /(?<!\p{L})services?(?!\p{L})/iu;
const AREA_RE = /service[\s_-]*areas?|areas?[\s_-]+(?:we[\s_-]+)?serve|towns?[\s_-]+we[\s_-]+serve|cities[\s_-]+we[\s_-]+serve|(?<!\p{L})locations?(?!\p{L})/iu;

/**
 * Links (readLinks) → { internalLinks, servicePages, townPages }: how many of its own pages the
 * homepage links to, how many are about a service (the path or link text says "service" or the
 * trade), and how many about a place (the owner's town, the nearby town, "service area", "areas we serve").
 */
export function countPages(links, business = {}) {
  const list = Array.isArray(links) ? links : [];
  const words = tradeWords(business.trade);
  const towns = [business.town, business.nearbyTown].map((t) => String(t || '').trim()).filter(Boolean);
  const say = (l) => `${l.path} ${l.text || ''}`;
  return {
    internalLinks: list.length,
    servicePages: list.filter((l) => SERVICE_RE.test(say(l)) || mentionsAny(say(l), words)).length,
    townPages: list.filter((l) => AREA_RE.test(say(l)) || mentionsAny(say(l), towns)).length,
  };
}

/**
 * A fetched /llms.txt ({ ok, contentType, text }) → is it a real llms.txt? A 200 that is empty, or
 * an HTML page (many sites answer every path with their homepage), doesn't count.
 */
export function isLlmsTxt(r) {
  if (!r || !r.ok) return false;
  const t = String(r.text || '').trim();
  if (!t) return false;
  if (/html/i.test(r.contentType || '')) return false;
  return !/^<(!doctype|html|head|body|\?xml)/i.test(t);
}

/**
 * Does http://host/ forward visitors to https? Follows up to `maxHops` redirects by hand
 * (redirect: 'manual'), since a chain often goes http://a → http://www.a → https://www.a.
 * → true (lands on https), false (serves the page over plain http), null (couldn't tell).
 */
export async function httpRedirectsToHttps(url, { fetchImpl = fetch, maxHops = 4 } = {}) {
  let cur = url;
  try {
    for (let i = 0; i <= maxHops; i++) {
      const res = await fetchImpl(cur, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      try { res.body?.cancel?.(); } catch { /* nothing to free */ }
      // A runtime that followed the redirects anyway reports where it ended up.
      if (res.url && /^https:/i.test(res.url)) return true;
      if (res.type === 'opaqueredirect') return null;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return false;
        const next = new URL(loc, cur);
        if (next.protocol === 'https:') return true;
        cur = next.href;
        continue;
      }
      return res.status >= 200 && res.status < 300 ? false : null;
    }
    return false;
  } catch {
    return null;
  }
}

export const PAGESPEED_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
/** PageSpeed Insights loads the page on Google's side, which is slow (often 10-20s). Skipped past this. */
export const PAGESPEED_TIMEOUT_MS = 25000;

/** A PageSpeed Insights v5 response → the performance score 0-100, or null. */
export function parsePageSpeed(j) {
  const perf = j && j.lighthouseResult && j.lighthouseResult.categories && j.lighthouseResult.categories.performance;
  const s = perf && perf.score;
  return typeof s === 'number' && s >= 0 && s <= 1 ? Math.round(s * 100) : null;
}

/**
 * Google PageSpeed Insights mobile performance score → { score, strategy: 'mobile' } | null.
 * Key: PAGESPEED_API_KEY, else the Places key (both are Google Cloud keys; the PageSpeed Insights
 * API must be enabled on the key's project, or Google answers 403 and we skip). Free at our volume.
 */
export async function checkSpeed(url, env = {}, { fetchImpl = fetch, timeoutMs = PAGESPEED_TIMEOUT_MS } = {}) {
  const k = resolveKeys(env);
  const key = k.pagespeedKey || k.googlePlacesKey;
  if (!key || !url) return null;
  const q = new URLSearchParams({ url, strategy: 'mobile', category: 'performance', key });
  try {
    const res = await fetchImpl(`${PAGESPEED_URL}?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const score = parsePageSpeed(await res.json());
    return score == null ? null : { score, strategy: 'mobile' };
  } catch {
    return null;
  }
}

/**
 * Crawl the owner's site. → siteCheck:
 * { url, reachable, robots: { found, blocked: [{ agent, who }] }, sitemap, schema: { found, types },
 *   onSite: { phone, address },            (what the site states, '' if not found)
 *   llmsTxt: boolean,
 *   https: { loads: boolean, redirects: boolean | null },   (redirects: does http:// forward to https)
 *   meta: { title, description, h1, mentionsTrade, mentionsTown } | null,   (null: homepage didn't load)
 *   faqSchema: boolean | null,
 *   pages: { internalLinks, servicePages, townPages } | null,
 *   speed: { score (0-100), strategy: 'mobile' } | null }   (null: no key, or PageSpeed failed or timed out)
 * opts.business ({ trade, town, nearbyTown }) feeds the trade/town checks; opts.env the PageSpeed key.
 */
export async function checkSite(website, { fetchImpl = fetch, business = {}, env = {} } = {}) {
  const u = siteUrl(website);
  if (!u) return null;
  let origin = u.origin;
  // Slow and independent of the rest: started first, awaited last.
  const speedP = checkSpeed(`${u.origin}/`, env, { fetchImpl }).catch(() => null);
  const redirectP = httpRedirectsToHttps(`http://${u.host}/`, { fetchImpl }).catch(() => null);
  let [home, robots, llms] = await Promise.all([
    getText(fetchImpl, origin + '/'), getText(fetchImpl, origin + '/robots.txt'), getText(fetchImpl, origin + '/llms.txt'),
  ]);
  // A site with no working https still counts as reachable over plain http.
  if (!home.ok && u.protocol === 'https:') {
    const plain = await getText(fetchImpl, `http://${u.host}/`);
    if (plain.ok) {
      home = plain;
      let o = `http://${u.host}`;
      try { o = new URL(plain.url || o).origin; } catch { /* keep plain http */ }
      if (o !== origin) {
        origin = o;
        [robots, llms] = await Promise.all([getText(fetchImpl, origin + '/robots.txt'), getText(fetchImpl, origin + '/llms.txt')]);
      }
    }
  }
  const groups = robots.ok ? parseRobots(robots.text) : [];
  const blocked = robots.ok ? AI_BOTS.filter((b) => blocksHome(groups, b.agent)) : [];
  let sitemap = robots.ok && /^\s*sitemap\s*:/im.test(robots.text);
  if (!sitemap) sitemap = (await getText(fetchImpl, origin + '/sitemap.xml')).ok;
  const page = home.ok ? readHomePage(home.text) : null;
  let httpsLoads = home.ok && /^https:/i.test(home.url || origin);
  // Owner gave us an http:// address: see whether the https one works too.
  if (!httpsLoads && u.protocol === 'http:') httpsLoads = (await getText(fetchImpl, `https://${u.host}/`)).ok;
  const [redirects, speed] = await Promise.all([redirectP, speedP]);
  return {
    url: origin,
    reachable: home.ok,
    robots: { found: robots.ok, blocked },
    sitemap: !!sitemap,
    schema: { found: !!(page && page.schema), types: page ? page.schemaTypes.slice(0, 10) : [] },
    onSite: { phone: page ? page.phone : '', address: page ? page.address : '' },
    llmsTxt: isLlmsTxt(llms),
    https: { loads: !!httpsLoads, redirects: httpsLoads ? redirects : null },
    meta: home.ok ? metaCheck(home.text, business) : null,
    faqSchema: page ? page.schemaTypes.includes('FAQPage') : null,
    pages: home.ok ? countPages(readLinks(home.text, home.url || origin + '/'), business) : null,
    speed: home.ok ? speed : null,
  };
}

// ---------------------------------------------------------------------------
// Google Places
// ---------------------------------------------------------------------------

export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
// rating and userRatingCount move the Text Search call up a Places SKU tier (Enterprise); at our
// volume (a few calls per report) it stays inside Google's monthly free usage.
export const PLACES_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.businessStatus,places.rating,places.userRatingCount';
/** Field mask for a competitor's reviews: just enough to pick the place and read its rating. */
export const REVIEW_FIELDS = 'places.id,places.displayName,places.googleMapsUri,places.rating,places.userRatingCount';
/** Most competitor review lookups per report (each is one Places Text Search call). */
export const MAX_REVIEW_LOOKUPS = 3;

const hostOf = (s) => { try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** Best Places result for this business: same website host first, else the closest name. */
export function pickPlace(places, business) {
  const list = Array.isArray(places) ? places : [];
  const host = hostOf(business.website || '');
  if (host) {
    const byHost = list.find((p) => p.websiteUri && hostOf(p.websiteUri) === host);
    if (byHost) return byHost;
  }
  const want = normalizeName(business.name);
  if (!want) return null;
  return list.find((p) => normalizeName(p.displayName?.text) === want)
    || list.find((p) => { const n = normalizeName(p.displayName?.text); return n && (n.includes(want) || want.includes(n)); })
    || null;
}

/** One Places Text Search call → { ok, places: [...], error }. */
async function placesSearch(textQuery, key, fieldMask, fetchImpl) {
  try {
    const res = await fetchImpl(PLACES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify({ textQuery, maxResultCount: 5 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, places: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, places: Array.isArray(j && j.places) ? j.places : [], error: null };
  } catch (e) {
    return { ok: false, places: [], error: String(e?.message || e).slice(0, 200) };
  }
}

/** → { ok, place | null, error } */
export async function findGooglePlace(business, env, { fetchImpl = fetch } = {}) {
  const key = resolveKeys(env).googlePlacesKey;
  if (!key) return { ok: false, place: null, error: 'no key' };
  const textQuery = [business.name, business.town, [business.state, business.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const r = await placesSearch(textQuery, key, PLACES_FIELDS, fetchImpl);
  return { ok: r.ok, place: r.ok ? pickPlace(r.places, business) : null, error: r.error };
}

/** A Places result → { rating: number | null, count: integer } (a place with no reviews has neither field). */
export function placeReviews(place) {
  const rating = typeof place?.rating === 'number' && place.rating >= 0 && place.rating <= 5 ? Math.round(place.rating * 10) / 10 : null;
  const n = Number(place?.userRatingCount);
  return { rating, count: Number.isInteger(n) && n >= 0 ? n : 0 };
}

/**
 * Google reviews for the businesses AI named most. names: competitor names as the report shows
 * them (at most MAX_REVIEW_LOOKUPS are looked up, in the order given). Each is searched as
 * "<name> <town> <state>" and kept only when a result's name matches (pickPlace); no match, no key
 * or a failed call just leaves that name out.
 * → [{ name, rating, count, placeUrl? }]  (name is the report's name, not Google's)
 */
export async function lookupCompetitorReviews(names, business, env, { fetchImpl = fetch } = {}) {
  const key = resolveKeys(env).googlePlacesKey;
  if (!key) return [];
  const b = business || {};
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n.trim()))].slice(0, MAX_REVIEW_LOOKUPS);
  const found = await Promise.all(list.map(async (name) => {
    const r = await placesSearch([name, b.town, b.state].filter(Boolean).join(' '), key, REVIEW_FIELDS, fetchImpl);
    const place = r.ok ? pickPlace(r.places, { name }) : null;
    if (!place) return null;
    return { name, ...placeReviews(place), ...(place.googleMapsUri ? { placeUrl: place.googleMapsUri } : {}) };
  }));
  return found.filter(Boolean);
}

/** Google's review link for a Place ID (opens the "write a review" box on the listing). */
export const reviewLink = (placeId) => `https://search.google.com/local/writereview?placeid=${encodeURIComponent(placeId)}`;

/**
 * reviews = { you: { rating, count } | null, competitors: [{ name, rating, count }] } → a fix when the
 * owner has under half the Google reviews of the most-reviewed competitor AI named (which has 10+),
 * else null. The title carries no names or numbers: it is visible on the free report.
 */
export function reviewsIssue({ reviews, placeId, business }) {
  const you = reviews && reviews.you;
  if (!you || !Number.isInteger(you.count)) return null;
  const top = ((reviews && reviews.competitors) || [])
    .filter((c) => c && c.name && Number.isInteger(c.count))
    .sort((a, b) => b.count - a.count)[0];
  if (!top || top.count < 10 || you.count * 2 >= top.count) return null;
  const b = business || {};
  const name = b.name || 'your business';
  const stars = (r) => (typeof r.rating === 'number' ? `, rated ${r.rating}★` : '');
  const link = placeId ? reviewLink(placeId) : '';
  const copyText = link ? [
    { label: 'Your Google review link', text: link },
    { label: 'A message to send customers', text: `Hi, thanks for choosing ${name}. If you have a moment, a quick Google review helps other people${b.town ? ` in ${b.town}` : ''} find us: ${link}` },
  ] : [];
  return {
    kind: 'few_reviews', severity: 'medium',
    title: 'You have far fewer Google reviews than the business AI names most',
    description: `${top.name} has ${top.count} Google ${top.count === 1 ? 'review' : 'reviews'}${stars(top)}. ${name} has ${you.count}${stars(you)}. When people ask AI for a well-reviewed business, AI leans on Google reviews.`,
    steps: [
      'Make a list of your recent customers who were happy with the job.',
      link
        ? 'Send each one your Google review link (below) by text or email, ideally within a day or two of the job.'
        : 'Get your review link from your Google Business Profile ("Ask for reviews"), then send it to each one by text or email, ideally within a day or two of the job.',
      'Reply to every review, good or bad, in a sentence or two.',
      'Don’t offer discounts or gifts for reviews and don’t write reviews yourself: Google removes them.',
    ],
    ...(copyText.length ? { copyText } : {}),
  };
}

// ---------------------------------------------------------------------------
// compare + issues
// ---------------------------------------------------------------------------

/**
 * Google listing vs the owner's own details → a report listing:
 * { platform: 'Google', status: 'match' | 'mismatch' | 'unchecked', details, url, fields: { name, phone, address } }
 * plus `diffs` (which fields differ) for the issue builder.
 */
export function compareListing(place, truth, business) {
  if (!place) {
    return {
      platform: 'Google', status: 'mismatch', url: null, diffs: ['missing'],
      details: `We couldn't find a Google Maps listing for ${business.name}${business.town ? ` near ${business.town}` : ''}.`,
      fields: {},
    };
  }
  const fields = { name: place.displayName?.text || '', phone: place.nationalPhoneNumber || '', address: place.formattedAddress || '' };
  const diffs = [];
  const checked = [];
  if (truth.phone && phoneKey(truth.phone)) {
    checked.push('phone');
    if (phoneKey(fields.phone) !== phoneKey(truth.phone)) diffs.push('phone');
  }
  if (truth.address && streetKey(truth.address)) {
    checked.push('address');
    if (streetKey(fields.address) !== streetKey(truth.address)) diffs.push('address');
  }
  if (business.name) {
    checked.push('name');
    const a = normalizeName(fields.name);
    const b = normalizeName(business.name);
    if (a !== b && !a.includes(b) && !b.includes(a)) diffs.push('name');
  }
  const label = { name: 'name', phone: 'phone number', address: 'address' };
  const src = truth.source === 'website' ? 'your website' : 'what you told us';
  let status = 'match';
  let details;
  if (diffs.length) {
    status = 'mismatch';
    details = diffs.map((d) => `Google shows ${d === 'phone' ? fields.phone || 'no phone number' : d === 'address' ? fields.address || 'no address' : fields.name}; ${src} says ${d === 'phone' ? truth.phone : d === 'address' ? truth.address : business.name}.`).join(' ');
  } else if (checked.length > 1) {
    details = `Your ${checked.map((c) => label[c]).join(', ').replace(/, ([^,]*)$/, ' and $1')} on Google match ${src}.`;
  } else {
    status = 'unchecked';
    details = 'Found on Google Maps. We couldn’t read a phone number or address on your website to compare it with.';
  }
  return { platform: 'Google', status, url: place.googleMapsUri || null, diffs, details, fields };
}

const q = (s) => `"${s}"`;
const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
const an = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
const listAnd = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const whereOf = (b) => [b.town, b.state].filter(Boolean).join(', ');

/** Suggested homepage title and meta description from the owner's details → { title, description }. */
export function suggestMeta(business, phone = '') {
  const b = business || {};
  const noun = tradeNoun(b.trade);
  const where = whereOf(b);
  const title = [b.name, [noun && cap(noun), where && `in ${where}`].filter(Boolean).join(' ')].filter(Boolean).join(' | ');
  const description = `${b.name || ''}${noun ? ` is ${an(noun)} ${noun}` : ''}${where ? ` serving ${where} and nearby towns` : ''}.${phone ? ` Call ${phone}.` : ''}`.trim();
  return { title, description };
}

/** A starting llms.txt (https://llmstxt.org) from the owner's details and what their site states. */
export function llmsTxtSkeleton(business, siteCheck) {
  const b = business || {};
  const sc = siteCheck || {};
  const noun = tradeNoun(b.trade);
  const where = whereOf(b);
  const phone = (sc.onSite && sc.onSite.phone) || b.phone || '';
  const address = (sc.onSite && sc.onSite.address) || b.address || '';
  const url = `${sc.url || ''}/`;
  const lines = [`# ${b.name}`, '', `> ${b.name}${noun ? ` is ${an(noun)} ${noun}` : ''}${where ? ` serving ${where}` : ''}.`, '', '## Contact'];
  if (phone) lines.push(`- Phone: ${phone}`);
  if (address) lines.push(`- Address: ${address}`);
  lines.push(`- Website: ${url}`, '', '## Key pages', `- [Home](${url}): who we are, what we do and where we work`);
  return lines.join('\n');
}

/** A starting FAQPage JSON-LD block from the owner's details (the owner edits it to match the page). */
export function faqJsonLd(business, phone = '') {
  const b = business || {};
  const name = b.name || 'our business';
  const noun = tradeNoun(b.trade);
  const where = whereOf(b);
  const qa = [];
  if (noun) qa.push([`What does ${name} do?`, `${name} is ${an(noun)} ${noun}${where ? ` in ${where}` : ''}.`]);
  if (where) qa.push([`What areas does ${name} serve?`, `${name} serves ${where} and nearby towns.`]);
  if (phone) qa.push([`How do I contact ${name}?`, `Call ${phone}.`]);
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(([question, answer]) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
  }, null, 2);
}

/**
 * Fixes for the newer website checks (llms.txt, https, title and description, FAQ schema, service
 * and town pages, speed), for a site that loaded. None is 'high': a blocked AI crawler stays the
 * most severe website finding. A field that is missing (not checked) never raises a fix.
 */
export function siteIssues({ siteCheck: sc, business }) {
  const out = [];
  if (!sc || !sc.reachable) return out;
  const b = business || {};
  const name = b.name || '';
  const noun = tradeNoun(b.trade);
  const phone = (sc.onSite && sc.onSite.phone) || b.phone || '';
  const host = String(sc.url || '').replace(/^https?:\/\//, '');

  if (sc.https && sc.https.loads === false) {
    out.push({
      kind: 'site_no_https', severity: 'medium',
      title: 'Your website doesn’t load over a secure https:// address',
      description: `We could only load ${host} over plain http://. Browsers mark sites like that "Not secure", and search engines and AI tools prefer secure pages.`,
      steps: [
        'Ask your web host, or whoever manages your site, to turn on a free SSL certificate. Most hosts have a one-click switch.',
        'Then have every http:// address forward to https://.',
        `Open https://${host}/ in your browser and check it shows a padlock.`,
      ],
    });
  } else if (sc.https && sc.https.loads === true && sc.https.redirects === false) {
    out.push({
      kind: 'site_http_no_redirect', severity: 'low',
      title: 'The http:// address of your website doesn’t forward to the secure https:// one',
      description: `http://${host}/ still opens without forwarding to https://. Anyone who lands on the old address sees a "Not secure" page, and search engines may treat the two as separate copies of your site.`,
      steps: [
        'In your web host or site builder settings, turn on "Force HTTPS", or ask whoever manages your site to redirect http:// to https://.',
        `Type http://${host}/ into your browser and check it ends up on https://.`,
      ],
    });
  }

  if (sc.llmsTxt === false) {
    out.push({
      kind: 'site_no_llms_txt', severity: 'low',
      title: 'Your website has no llms.txt file',
      description: 'llms.txt is a newer, optional plain-text file that tells AI tools in a few lines who you are and which pages matter. Not every AI assistant reads it yet, but it is quick to add and does no harm.',
      steps: [
        'Copy the text below and edit it so every line is true. Add your main service pages under "Key pages".',
        `Save it as a plain text file named llms.txt at the top level of your site, so it opens at ${sc.url}/llms.txt. If someone manages your site, send them the text.`,
        'Open that address in your browser and check it shows the text.',
      ],
      ...(name ? { copyText: [{ label: 'llms.txt', text: llmsTxtSkeleton(b, sc), format: 'code' }] } : {}),
    });
  }

  const m = sc.meta;
  if (m && typeof m === 'object') {
    const noTitle = m.title === '';
    const noDesc = m.description === '';
    const gaps = [m.mentionsTrade === false && 'what you do', m.mentionsTown === false && 'where you work'].filter(Boolean);
    if (noTitle || noDesc || gaps.length) {
      const sug = suggestMeta(b, phone);
      const example = [noun && cap(noun), b.town && `in ${b.town}`].filter(Boolean).join(' ');
      out.push({
        kind: 'site_title_meta', severity: noTitle || gaps.length ? 'medium' : 'low',
        title: noTitle ? 'Your homepage has no page title'
          : gaps.length ? `Your homepage title and heading don’t say ${listAnd(gaps)}`
            : 'Your homepage has no meta description',
        description: [
          noTitle ? 'Your homepage has no page title, the line search engines and AI tools read first.' : '',
          gaps.length ? `Your homepage's title, meta description and main heading don't say ${listAnd(gaps)}.` : '',
          noDesc ? 'There is no meta description, the short summary shown under your link in search results.' : '',
          example ? `These lines are how a crawler learns that you are a match for "${example}".` : '',
        ].filter(Boolean).join(' '),
        steps: [
          'Open your homepage\'s SEO settings in your site builder (often called "SEO title" and "meta description"), or send this fix to whoever manages your site.',
          noTitle || gaps.length ? 'Set the page title to the suggested title below. Keep it under about 60 characters.' : '',
          'Set the meta description to the suggested description below.',
          gaps.length || !m.h1 ? `Make the main heading at the top of your homepage say what you do and where${example ? `, for example "${example}"` : ''}.` : '',
        ].filter(Boolean),
        ...(name ? {
          copyText: [
            ...(noTitle || gaps.length ? [{ label: 'Suggested page title', text: sug.title }] : []),
            { label: 'Suggested meta description', text: sug.description },
          ],
        } : {}),
      });
    }
  }

  if (sc.faqSchema === false) {
    out.push({
      kind: 'site_no_faq_schema', severity: 'low',
      title: 'Your website has no FAQ schema',
      description: 'FAQ schema is a small block of code that marks the questions and answers on a page so search engines and AI tools can read them as questions and answers. We found none on your homepage.',
      steps: [
        'Put a few questions customers often ask, with short answers, on your site first.',
        'Add the code below to that page, and change each question and answer to match what the page says, word for word.',
        'Test the page at search.google.com/test/rich-results and check it reads an FAQ.',
      ],
      ...(name ? { copyText: [{ label: 'FAQPage schema (JSON-LD)', text: faqJsonLd(b, phone), format: 'code' }] } : {}),
    });
  }

  const p = sc.pages;
  if (p && typeof p === 'object' && (p.servicePages === 0 || p.townPages === 0)) {
    const miss = [p.servicePages === 0 && 'your services', p.townPages === 0 && 'the towns you serve'].filter(Boolean);
    const n = Number(p.internalLinks) || 0;
    const example = noun && b.town ? ` (say, "${noun} in ${b.town}")` : '';
    out.push({
      kind: 'site_thin_pages', severity: 'low',
      title: `Your homepage doesn’t link to pages about ${listAnd(miss)}`,
      description: `Your homepage links to ${n} other ${n === 1 ? 'page' : 'pages'} on your site, and none is about ${listAnd(miss)}. A page about one service in one place${example} gives AI a page that answers that exact search.`,
      steps: [
        p.servicePages === 0 ? 'Make a page for each main service you offer, with a plain title that names the service.' : '',
        p.townPages === 0 ? `Make a "Service area" page that lists the towns you work in${b.town ? `, starting with ${b.town}` : ''}.` : '',
        'Link to these pages from your homepage menu or footer.',
      ].filter(Boolean),
    });
  }

  if (sc.speed && typeof sc.speed.score === 'number' && sc.speed.score < 50) {
    const s = sc.speed.score;
    out.push({
      kind: 'site_slow', severity: 'medium',
      title: `Your website is slow on phones (Google speed score ${s} out of 100)`,
      description: `Google PageSpeed Insights scored your homepage ${s} out of 100 on a phone. Google calls anything under 50 poor. Slow pages lose visitors, and crawlers may give up on them.`,
      steps: [
        `Run the test yourself at pagespeed.web.dev with ${sc.url} to see what slows the page down.`,
        'Shrink large photos before uploading them. Most site builders can resize images for you.',
        'Remove plugins, pop-ups, sliders and videos the homepage doesn’t need.',
        'If someone manages your site, send them the PageSpeed Insights report.',
      ],
    });
  }
  return out;
}

/** Fix items for what the checks found (fixed templates, like scanner/extract/issues.js). */
export function ownerIssues({ siteCheck, google, business, truth }) {
  const out = [];
  const name = business.name || 'your business';
  if (siteCheck && siteCheck.robots.blocked.length) {
    const ai = siteCheck.robots.blocked.filter((b) => !['Googlebot', 'Bingbot'].includes(b.agent));
    const search = siteCheck.robots.blocked.filter((b) => ['Googlebot', 'Bingbot'].includes(b.agent));
    const all = [...search, ...ai];
    out.push({
      kind: 'site_blocks_ai', severity: 'high',
      title: `Your website blocks ${all.map((b) => b.who).join(', ').replace(/, ([^,]*)$/, ' and $1')} from reading it`,
      description: `Your site's robots.txt tells ${all.map((b) => b.agent).join(', ')} to stay out. AI can't quote a website it isn't allowed to read.`,
      steps: [
        `Open ${siteCheck.url}/robots.txt, or ask whoever manages your website to.`,
        'Remove the "Disallow: /" lines for the crawlers listed above, or add the lines below.',
        'Save it, then open the file in your browser to check the change is live.',
      ],
      copyText: [{ label: 'Lines to add to robots.txt', text: all.map((b) => `User-agent: ${b.agent}\nAllow: /`).join('\n\n') }],
    });
  }
  if (siteCheck && siteCheck.reachable && (!siteCheck.onSite.phone || !siteCheck.onSite.address)) {
    const missing = [!siteCheck.onSite.phone && 'phone number', !siteCheck.onSite.address && 'street address'].filter(Boolean);
    out.push({
      kind: 'site_missing_nap', severity: 'medium',
      title: `Your website doesn't show your ${missing.join(' or ')} where AI can read it`,
      description: `We read ${siteCheck.url} and couldn't find your ${missing.join(' or ')} in the page text or its business markup. AI and listing sites check your own website first.`,
      steps: [
        `Add your ${missing.join(' and ')} as plain text in the footer of every page, written the same way as on your Google listing.`,
        'Make the phone number a tap-to-call link.',
        'Add LocalBusiness schema with the same details (see the schema fix in this report).',
      ],
    });
  }
  if (siteCheck && siteCheck.reachable) out.push(...siteIssues({ siteCheck, business }));
  if (google) {
    if (google.diffs.includes('missing')) {
      out.push({
        kind: 'google_missing', severity: 'high',
        title: 'We couldn’t find you on Google Maps',
        description: google.details + ' AI assistants lean on Google Maps for local answers.',
        steps: [
          `Search Google Maps for ${q(`${name}${business.town ? ` ${business.town}` : ''}`)}. If your listing appears under another name, note it.`,
          'If there is no listing, create one at business.google.com with your exact name, address and phone.',
          'If there is one you don’t manage, use "Claim this business" on the listing.',
        ],
      });
    } else {
      for (const field of google.diffs) {
        const label = { name: 'name', phone: 'phone number', address: 'address' }[field];
        const right = field === 'phone' ? truth.phone : field === 'address' ? truth.address : business.name;
        out.push({
          kind: 'listing_differs', severity: 'high',
          title: `Google shows a different ${label} than ${truth.source === 'website' ? 'your website' : 'you gave us'}`,
          description: google.details,
          steps: [
            'Open your Google Business Profile (business.google.com), or search your business name on Google and use "Edit profile".',
            `Change the ${label} to match the text below exactly.`,
            'If you don’t manage the listing, use "Suggest an edit" on Google Maps. Google decides whether to accept it.',
          ],
          copyText: [{ label: `Your ${label}`, text: right }],
        });
      }
    }
  }
  return out;
}

/**
 * Everything above, for one business. deps: { fetchImpl }.
 * → { siteCheck | null, listings: [...], issues: [...], facts: { phone?, address? }, google: { ok, error },
 *     reviews: { rating, count, placeId } | null }   (reviews null: no key, a failed call, or no listing found)
 */
export async function runOwnerChecks(business, env, { fetchImpl = fetch } = {}) {
  const b = business || {};
  const [siteCheck, g] = await Promise.all([
    checkSite(b.website, { fetchImpl, business: b, env }).catch(() => null),
    findGooglePlace(b, env, { fetchImpl }).catch((e) => ({ ok: false, place: null, error: String(e) })),
  ]);
  const siteTruth = siteCheck && (siteCheck.onSite.phone || siteCheck.onSite.address);
  const truth = siteTruth
    ? { phone: siteCheck.onSite.phone || b.phone || '', address: siteCheck.onSite.address || b.address || '', source: 'website' }
    : { phone: b.phone || '', address: b.address || '', source: 'owner' };
  const google = g.ok ? compareListing(g.place, truth, b) : null;
  const listings = google ? [{ platform: google.platform, status: google.status, details: google.details, fields: google.fields, ...(google.url ? { url: google.url } : {}) }] : [];
  const facts = {};
  if (siteCheck && siteCheck.onSite.phone) facts.phone = siteCheck.onSite.phone;
  if (siteCheck && siteCheck.onSite.address) facts.address = siteCheck.onSite.address;
  const reviews = g.ok && g.place ? { ...placeReviews(g.place), placeId: g.place.id || null } : null;
  return { siteCheck, listings, issues: ownerIssues({ siteCheck, google, business: b, truth }), facts, google: { ok: g.ok, error: g.error }, reviews };
}
