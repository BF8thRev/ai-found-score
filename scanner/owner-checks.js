// scanner/owner-checks.js — what the owner's own website and Google listing say, checked before a
// report is built. No logins: public pages and the Google Places API only.
//
//   1. Website: robots.txt (are AI crawlers blocked?), sitemap, schema.org LocalBusiness markup,
//      and the phone number and street address the site shows (schema first, then the page text).
//   2. Google: the business's Google Maps listing via the Places API (New) Text Search, when a key
//      is set (GOOGLE_PLACES_API_KEY; aliases in scanner/config.js). Picked by website match, else name.
//   3. Compare: Google's name, phone and address against the website (or what the owner gave us).
//
// runOwnerChecks() → { siteCheck, listings, issues, facts } for buildReport: `listings` fill the
// report's listings section, `issues` are extra fixes (same shape as scanner/extract/issues.js),
// `facts` (phone, address) are the owner's details as their own website states them.
// Every check fails soft: a site that won't load or a missing key just means fewer findings.

import { resolveKeys } from './config.js';
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
    return { ok: true, status: res.status, text, url: res.url || url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * Crawl the owner's site. → siteCheck:
 * { url, reachable, robots: { found, blocked: [{ agent, who }] }, sitemap, schema: { found, types },
 *   onSite: { phone, address } }  (onSite values are what the site states, '' if not found)
 */
export async function checkSite(website, { fetchImpl = fetch } = {}) {
  const u = siteUrl(website);
  if (!u) return null;
  const origin = u.origin;
  const [home, robots] = await Promise.all([getText(fetchImpl, origin + '/'), getText(fetchImpl, origin + '/robots.txt')]);
  const groups = robots.ok ? parseRobots(robots.text) : [];
  const blocked = robots.ok ? AI_BOTS.filter((b) => blocksHome(groups, b.agent)) : [];
  let sitemap = robots.ok && /^\s*sitemap\s*:/im.test(robots.text);
  if (!sitemap) sitemap = (await getText(fetchImpl, origin + '/sitemap.xml')).ok;
  const page = home.ok ? readHomePage(home.text) : null;
  return {
    url: origin,
    reachable: home.ok,
    robots: { found: robots.ok, blocked },
    sitemap: !!sitemap,
    schema: { found: !!(page && page.schema), types: page ? page.schemaTypes.slice(0, 10) : [] },
    onSite: { phone: page ? page.phone : '', address: page ? page.address : '' },
  };
}

// ---------------------------------------------------------------------------
// Google Places
// ---------------------------------------------------------------------------

export const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
export const PLACES_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.businessStatus';

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

/** → { ok, place | null, error } */
export async function findGooglePlace(business, env, { fetchImpl = fetch } = {}) {
  const key = resolveKeys(env).googlePlacesKey;
  if (!key) return { ok: false, place: null, error: 'no key' };
  const textQuery = [business.name, business.town, [business.state, business.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  try {
    const res = await fetchImpl(PLACES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS },
      body: JSON.stringify({ textQuery, maxResultCount: 5 }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, place: null, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, place: pickPlace(j.places, business), error: null };
  } catch (e) {
    return { ok: false, place: null, error: String(e?.message || e).slice(0, 200) };
  }
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
 * → { siteCheck | null, listings: [...], issues: [...], facts: { phone?, address? }, google: { ok, error } }
 */
export async function runOwnerChecks(business, env, { fetchImpl = fetch } = {}) {
  const b = business || {};
  const [siteCheck, g] = await Promise.all([
    checkSite(b.website, { fetchImpl }).catch(() => null),
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
  return { siteCheck, listings, issues: ownerIssues({ siteCheck, google, business: b, truth }), facts, google: { ok: g.ok, error: g.error } };
}
