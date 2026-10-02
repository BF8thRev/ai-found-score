// Cited sources: taken straight from each engine's citation data (never from a model),
// normalized to domain + URL. For the top cited directory pages, optionally fetch the
// page and look for the owner (name or phone) and who is listed first.
// Runtime-agnostic: injectable fetchImpl.

import { domainOf, normalizeUrl, normalizeName, phoneKey, digits, nameVariants, squashName } from './normalize.js';
import { getText, parseRobots, robotsAllows, siteUrl } from '../owner-checks.js';
import { directoryFor } from '../../shared/directories.js';

export const DIRECTORY_DOMAINS = [
  'yellowpages.com', 'superpages.com', 'yelp.com', 'angi.com', 'angieslist.com', 'homeadvisor.com',
  'bbb.org', 'manta.com', 'mapquest.com', 'thumbtack.com', 'houzz.com', 'porch.com', 'nextdoor.com',
  'citysearch.com', 'chamberofcommerce.com', 'merchantcircle.com', 'foursquare.com', 'local.yahoo.com',
  'dexknows.com', 'hotfrog.com', 'brownbook.net', 'cylex.us.com', 'judysbook.com', 'birdeye.com',
];

export function isDirectory(domain) {
  return DIRECTORY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Sites that list businesses: a cited page here is a list the owner can get onto (shared/action-plan.js too). */
export const LIST_SITE_RE = /(^|\.)(yelp|angi|angieslist|bbb|homeadvisor|thumbtack|yellowpages|mapquest|porch|networx|manta|superpages|foursquare|buildzoom|houzz|birdeye|clutch|themanifest|goodfirms|upcity|designrush|expertise|sortlist|agencyspotter|odwyerpr|provokemedia|prweek|publicrelationsdatabase|communicationsmatch|tripadvisor|nextdoor|avvo|justia|martindale|findlaw|lawyers|healthgrades|zocdoc|vitals|opentable|theknot|weddingwire)\.(com|org|net|co)$/i;
/** Never something to get "listed" on: social threads, job boards, press-release wires, encyclopedias. */
export const NOT_A_LIST_RE = /(^|\.)(aaaa|ana|iabc|prsa|reddit|quora|facebook|instagram|linkedin|x|twitter|tiktok|youtube|wikipedia|glassdoor|indeed|4dayweek|ziprecruiter|publicnow|prnewswire|businesswire|globenewswire|einpresswire|google|apple|bing)\.(com|org|io|net)$/i;
/** A cited URL that reads like a list of businesses ("best PR firms", "/agencies/new-york"). */
export const LIST_PATH_RE = /rank|best|top|list|director|agencies|firms|companies/i;

/** A cited page worth reading for the owner's name: a directory or list site, or a page that reads like a list. */
export function looksLikeList(domain, url = '') {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (!d || NOT_A_LIST_RE.test(d)) return false;
  return isDirectory(d) || LIST_SITE_RE.test(d) || LIST_PATH_RE.test(String(url || ''));
}

/**
 * Where a business adds itself, for the directories we know (each checked by hand to load, Oct 2 2026).
 * Others (Clutch, The Manifest, Yellow Pages, Manta) turn our crawler away, so their pages are unconfirmed
 * and left out: the owner gets "look for 'add your company'" instead of a link we haven't seen work.
 */
export const ADD_URLS = Object.freeze({
  'bbb.org': 'https://www.bbb.org/get-listed',
  'yelp.com': 'https://business.yelp.com/',
  'goodfirms.co': 'https://www.goodfirms.co/get-listed',
  'communicationsmatch.com': 'https://www.communicationsmatch.com/account/registration',
  'thumbtack.com': 'https://www.thumbtack.com/pro',
  'angi.com': 'https://www.angi.com/pro',
  'houzz.com': 'https://pro.houzz.com/pro',
});
export function addUrlFor(domain) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  const k = Object.keys(ADD_URLS).find((x) => d === x || d.endsWith(`.${x}`));
  if (k) return ADD_URLS[k];
  // Else the sign-up page in shared/directories.js (each checked on the directory's own site).
  const known = directoryFor(d);
  return (known && known.signUpUrl) || null;
}

/** normalizeCitation({url,...}) → { domain, url } | null */
export function normalizeCitation(c) {
  const raw = typeof c === 'string' ? c : c && c.url;
  if (!raw || !/^https?:\/\//i.test(raw)) return null;
  const url = normalizeUrl(raw);
  const domain = domainOf(url);
  return domain ? { domain, url } : null;
}

/** collectSources(answers) → [{ domain, url, citedIn, youListed:null, youPosition:null, topListed:null }] */
export function collectSources(answers) {
  const byUrl = new Map();
  for (const a of answers) {
    for (const c of a.citations || []) {
      const n = normalizeCitation(c);
      if (!n) continue;
      if (!byUrl.has(n.url)) byUrl.set(n.url, { ...n, citedIn: [], youListed: null, youPosition: null, topListed: null });
      const s = byUrl.get(n.url);
      if (!s.citedIn.includes(a.id)) s.citedIn.push(a.id);
    }
  }
  return [...byUrl.values()];
}

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

export function htmlToText(html) {
  return decode(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/** Ordered business names listed on a directory page (JSON-LD first, then common markup). */
export function listingNames(html) {
  const names = [];
  const push = (n) => {
    const t = decode(String(n || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (t && !names.some((x) => normalizeName(x) === normalizeName(t))) names.push(t);
  };
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v.itemListElement)) {
        [...v.itemListElement]
          .sort((a, b) => (a.position || 0) - (b.position || 0))
          .forEach((it) => push((it.item && it.item.name) || it.name));
        return;
      }
      if (v['@graph']) walk(v['@graph']);
    };
    walk(data);
  }
  if (names.length) return names;
  const re = /<(a|h[1-4]|span|div)\b[^>]*class="[^"]*\b(?:business-name|businessName|biz-name|listing-name|result-name)\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of String(html || '').matchAll(re)) push(m[2]);
  return names;
}

/** checkDirectoryPage(html, business) → { youListed, youPosition, topListed, listingsRead, listed } */
export function checkDirectoryPage(html, business) {
  const names = listingNames(html);
  const owner = normalizeName(business.name);
  const phone = phoneKey(business.phone);
  const idx = names.findIndex((n) => {
    const nn = normalizeName(n);
    return nn === owner || (owner && ` ${nn} `.includes(` ${owner} `));
  });
  const text = htmlToText(html);
  const inText = !!owner && ` ${normalizeName(text)} `.includes(` ${owner} `);
  const phoneHit = !!phone && digits(text).includes(phone);
  return {
    youListed: idx !== -1 || inText || phoneHit,
    youPosition: idx === -1 ? null : idx + 1,
    topListed: names[0] || null,
    listingsRead: names.length,
    // The listing names read on the page, in order (data, never copy): the X-Ray gap sheet uses them.
    listed: names.slice(0, 30),
  };
}

const hostOf = (s) => { try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A bot wall instead of the page: Cloudflare's "Just a moment...", a CAPTCHA, "Access denied".
const CHALLENGE_RE = /cf-chl|challenge-platform|g-recaptcha|h-captcha|hcaptcha|captcha-delivery|Just a moment\.\.\.|Attention Required|Access denied|Pardon Our Interruption|Are you a robot/i;
/** Below this much text (and no listings read), a page is a shell its scripts fill in: never "not listed". */
export const MIN_READABLE_TEXT = 300;

/**
 * One cited page read for the owner → the checkDirectoryPage fields plus
 *   listedBy: 'website' (a link to, or the text of, the owner's own domain) | 'name' | 'phone' | null,
 *   profileUrl: where we saw them (a link on the same site whose text is their name, else this page) | null,
 *   checkReason: 'blocked' | 'empty' when the page can't settle it (youListed then null, never false).
 * opts.names: other spellings of the owner's name (the website's own, siteCheck.brand); opts.pageUrl.
 */
export function checkListingPage(html, business, { names = [], pageUrl = '' } = {}) {
  const b = business || {};
  const h = String(html || '');
  const base = checkDirectoryPage(h, b);
  const text = htmlToText(h);
  if (CHALLENGE_RE.test(h) && text.length < 3000 && !base.listingsRead) {
    return { ...base, youListed: null, youPosition: null, listedBy: null, profileUrl: null, checkReason: 'blocked' };
  }
  // Every spelling of the name, as words (≥ 3 letters or digits, so "PR" alone never matches).
  const wants = [...new Set([b.name, ...names].flatMap((n) => nameVariants(n)).map(normalizeName).filter((w) => squashName(w).length >= 3))];
  const ntext = ` ${normalizeName(text)} `;
  const isUs = (n) => { const nn = normalizeName(n); return wants.some((w) => nn === w || ` ${nn} `.includes(` ${w} `)); };
  const idx = base.listed.findIndex(isUs);
  const byName = idx !== -1 || wants.some((w) => ntext.includes(` ${w} `));
  // The owner's own domain: a link to it (also inside a redirect link's query) or the domain written out.
  // A Facebook or Yelp page as the "website" is no evidence: every list links to those sites.
  const host = siteUrl(b.website) ? hostOf(b.website) : '';
  let byDomain = false;
  let profileUrl = null;
  const pageHost = hostOf(pageUrl);
  for (const m of h.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = m[1].replace(/&amp;/g, '&');
    let abs = '';
    try { abs = new URL(href, pageUrl || undefined).href; } catch { abs = href; }
    if (host) {
      let dec = abs;
      try { dec = decodeURIComponent(abs); } catch { /* keep as is */ }
      if (hostOf(abs) === host || new RegExp(`(^|[/.=:])(www\\.)?${escRe(host)}(?=[/?&#:"']|$)`, 'i').test(dec)) byDomain = true;
    }
    if (!profileUrl && pageHost && hostOf(abs) === pageHost && /^https?:/i.test(abs) && isUs(htmlToText(m[2]))) profileUrl = abs;
  }
  if (!byDomain && host) byDomain = new RegExp(`(?<![\\w.-])(www\\.)?${escRe(host)}(?![\\w-])`, 'i').test(text);
  const phone = phoneKey(b.phone);
  const byPhone = !!phone && digits(text).includes(phone);
  const listed = byDomain || byName || byPhone;
  if (!listed && text.length < MIN_READABLE_TEXT && !base.listingsRead) {
    return { ...base, youListed: null, youPosition: null, listedBy: null, profileUrl: null, checkReason: 'empty' };
  }
  return {
    ...base,
    youListed: listed,
    youPosition: idx === -1 ? null : idx + 1,
    listedBy: byDomain ? 'website' : byName ? 'name' : byPhone ? 'phone' : null,
    profileUrl: listed ? (profileUrl || pageUrl || null) : null,
  };
}

// "Add your business", "claim your listing", "get listed", "submit your agency", "list your company".
const JOIN_LINK_RE = /\b(add (your|a) (business|company|agency|firm|practice|listing)|claim (your|this|my) (business|listing|profile|page|company)|get listed|list (your|my) (business|company|agency|firm|practice)|submit (your |a )?(business|company|agency|firm|listing|entry|nomination)|join (us )?(as a|for free)|create (a |your )?(free )?(business |company )?(profile|listing)|for (businesses|agencies|pros|providers|companies))\b/i;
const FEE_RE = /\b(entry fees?|entry form fee|fees? to enter|submission fees?|listing fees?|paid (listing|membership)|per (entry|submission))\b/i;
const PRICING_LINK_RE = /\b(pricing|plans and pricing|entry fees?|fees)\b/i;
const FREE_RE = /\b(free (listing|profile|to join|to list|basic)|(list|join|add)[^.]{0,30}\bfor free|it'?s free|at no cost|free of charge)\b/i;

/**
 * joinHints(html, pageUrl) → { verdict: 'looks_free' | 'has_fee' | 'unknown', url, feeUrl } | null
 * Our best read of a page we were allowed to read, for a site that isn't in shared/directories.js:
 * a "get listed / claim / submit" link, and whether the page talks about it being free or about a fee.
 * Never a fact: the plan labels it "our best read". null when the page shows neither.
 */
export function joinHints(html, pageUrl = '') {
  const h = String(html || '');
  let url = null;
  let feeUrl = null;
  for (const m of h.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = htmlToText(m[2]);
    if (!label || label.length > 80) continue;
    let abs = '';
    try { abs = new URL(m[1].replace(/&amp;/g, '&'), pageUrl || undefined).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    if (!url && JOIN_LINK_RE.test(label)) url = abs;
    if (!feeUrl && PRICING_LINK_RE.test(label)) feeUrl = abs;
  }
  const text = htmlToText(h);
  const fee = FEE_RE.test(text);
  const free = FREE_RE.test(text);
  if (!url && !feeUrl && !fee) return null;
  const verdict = fee || (feeUrl && !free) ? 'has_fee' : free && url ? 'looks_free' : 'unknown';
  return { verdict, url, feeUrl };
}

/** Most cited pages read for the owner per report (plain GETs, a few at a time, each with a timeout). */
export const MAX_LIST_READS = 12;
const READ_TIMEOUT_MS = 8000;
// The product token in our user agent (owner-checks.js UA): the robots.txt group we obey, else "*".
const ROBOTS_AGENT = 'aifoundscorebot';

/**
 * buildSources({ answers, business, fetchImpl, maxFetch, names }) → sources[]
 * The cited pages that look like lists (looksLikeList: directories, list sites, "best/top" pages; never
 * the owner's own site, social sites or wires) are read, up to maxFetch, cited in answers that didn't
 * name the owner first. Each is read the way the site allows: robots.txt obeyed (our agent's group, else
 * "*"), our own user agent, a timeout, no login, no retries around a block. Per page:
 *   youListed true / false (we read the page) / null (we couldn't: checkReason says why);
 *   checkReason: 'robots' (robots.txt says no) | 'blocked' (403/401/429 or a bot wall) | 'error'
 *   (timeout, 404, 5xx) | 'not_html' (a PDF, an image) | 'empty' (the list loads by script);
 *   listedBy, profileUrl (checkListingPage); addUrl: the directory's "add your business" page (ADD_URLS).
 * names: other spellings of the owner's name to look for (the website's own).
 */
export async function buildSources({ answers, business, fetchImpl, maxFetch = MAX_LIST_READS, names = [] }) {
  const sources = collectSources(answers);
  const lost = new Set(answers.filter((a) => !a.namedYou).map((a) => a.id));
  const lostCount = (s) => s.citedIn.filter((id) => lost.has(id)).length;
  const own = hostOf((business && business.website) || '');
  const listy = sources.filter((s) => (!own || (s.domain !== own && !s.domain.endsWith(`.${own}`))) && looksLikeList(s.domain, s.url));
  for (const s of listy) { const add = addUrlFor(s.domain); if (add) s.addUrl = add; }
  const known = (s) => (isDirectory(s.domain) || LIST_SITE_RE.test(s.domain) ? 0 : 1);
  const toRead = listy
    .sort((a, b) => lostCount(b) - lostCount(a) || known(a) - known(b) || b.citedIn.length - a.citedIn.length)
    .slice(0, Math.max(0, maxFetch));
  const doFetch = fetchImpl || globalThis.fetch;
  if (doFetch && toRead.length) {
    const robots = new Map();
    // robots.txt: missing (4xx) means no rules; a 5xx or no answer means we don't know, so we don't read.
    const robotsFor = (origin) => {
      if (!robots.has(origin)) {
        robots.set(origin, getText(doFetch, `${origin}/robots.txt`, { timeoutMs: READ_TIMEOUT_MS, maxBytes: 500_000 })
          .then((r) => (r.ok ? parseRobots(r.text) : r.status >= 400 && r.status < 500 ? [] : null)));
      }
      return robots.get(origin);
    };
    const read = async (s) => {
      let u;
      try { u = new URL(s.url); } catch { s.checkReason = 'error'; return; }
      const groups = await robotsFor(u.origin);
      if (groups === null) { s.checkReason = 'error'; s.checkError = 'robots.txt did not load'; return; }
      if (!robotsAllows(groups, ROBOTS_AGENT, u.pathname + u.search)) { s.checkReason = 'robots'; return; }
      const r = await getText(doFetch, s.url, { timeoutMs: READ_TIMEOUT_MS });
      if (!r.ok) {
        s.checkError = r.status ? `HTTP ${r.status}` : String(r.error || 'no answer');
        s.checkReason = [401, 403, 429].includes(r.status) ? 'blocked' : 'error';
        return;
      }
      if (r.contentType && !/html|text\/plain|xml/i.test(r.contentType)) { s.checkReason = 'not_html'; return; }
      // Not in our table of directories: our best read of how to join, from the page itself.
      if (!directoryFor(s.domain)) { const j = joinHints(r.text, r.url || s.url); if (j) s.joinGuess = j; }
      const c = checkListingPage(r.text, business, { names, pageUrl: r.url || s.url });
      if (c.checkReason) { s.checkReason = c.checkReason; return; }
      const { checkReason, ...found } = c;
      Object.assign(s, found, { checked: true });
      if (!s.profileUrl) delete s.profileUrl;
      if (!s.listedBy) delete s.listedBy;
    };
    for (let i = 0; i < toRead.length; i += 4) {
      await Promise.all(toRead.slice(i, i + 4).map((s) => read(s).catch((e) => { s.checkReason = 'error'; s.checkError = String((e && e.message) || e).slice(0, 200); })));
    }
  }
  return sources.sort((a, b) => b.citedIn.length - a.citedIn.length);
}

/** What a reader sees for a page we couldn't read (checkReason), or '' when there's no reason on file. */
export const CHECK_REASON_TEXT = Object.freeze({
  robots: 'the site asks crawlers not to read this page',
  blocked: 'the site blocks automated checks',
  error: 'the page didn’t load when we checked',
  not_html: 'it isn’t a web page we can read',
  empty: 'its list loads in a way we can’t read',
});
