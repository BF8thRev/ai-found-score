// Listed or not, through a search engine that has already read the directory (paid-tier scans only).
//
// Some directories AI cites turn our plain page reads away (clutch.co, themanifest.com, yelp.com, ...:
// sources.js checkReason 'blocked') or fill their lists in by script ('empty'). We never get round that
// (no browser disguise, no headless browser, no CAPTCHA solving, robots.txt obeyed). Instead we ask a
// search engine that has indexed the site: Gemini with Google Search grounding (scanner/engines/gemini.js),
// "find the profile page for <name> (<website>) on <directory>".
//
// The model's word is never enough. A directory counts as "listed" only when a URL on that directory's
// own domain names the business in its path or title (any spelling: nameVariants, or the website's
// name) AND it comes from the search itself: a grounding citation, or a URL in the reply on a domain
// the search actually cited. Anything else is "not_found" ("we searched Google and found no profile":
// never "you're not on it") or "error" ("couldn't check").
//
// Bounded: at most MAX_LISTING_SEARCHES lookups per scan, LISTING_SEARCH_CONCURRENCY at a time, only for
// the paid tiers (LISTING_SEARCH_TRIGGERS), each one priced and handed to onCall for scan_usage.
// Runtime-agnostic; `search` is injectable (tests pass a fake, nothing here calls an API by itself).

import { nameVariants, squashName, normalizeName } from './normalize.js';
import { LIST_SITE_RE, NOT_A_LIST_RE, isDirectory } from './sources.js';
import { directoryFor } from '../../shared/directories.js';
import { ask as geminiAsk, parseResponse as parseGemini } from '../engines/gemini.js';
import { resolveKeys, priceCall, round6 } from '../config.js';

/** Most search lookups in one scan (each is one Gemini call with Google Search). */
export const MAX_LISTING_SEARCHES = 8;
export const LISTING_SEARCH_CONCURRENCY = 4;
/** The scans that pay for this: the paid audit, its 30-day re-check, Be the Answer's monthly scans. Never a free report. */
export const LISTING_SEARCH_TRIGGERS = Object.freeze(['paid', 'recheck', 'monthly']);
const SEARCH_TIMEOUT_MS = 60_000;

const bare = (d) => String(d || '').toLowerCase().replace(/^www\./, '');
const hostOf = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const onDomain = (host, dir) => !!host && !!dir && (host === dir || host.endsWith(`.${dir}`));

/** The names a profile may use: every spelling of the typed name and the website's, plus the website's own name ("pr73"). */
export function listingNames(business, names = []) {
  const b = business || {};
  const spellings = [...new Set([b.name, ...names].filter(Boolean).flatMap((n) => nameVariants(n)))];
  const host = hostOf(b.website || '');
  const stem = host && !/(^|\.)(facebook|instagram|yelp|google|linkedin)\./.test(host) ? host.replace(/\.[a-z.]+$/i, '') : '';
  return { spellings, websiteHost: host && stem ? host : '', websiteStem: stem && squashName(stem).length >= 3 ? squashName(stem) : '' };
}

/** The prompt: one directory, every spelling, the website, and "URL or NONE". */
export function listingSearchPrompt({ directory, business, names = [] }) {
  const n = listingNames(business, names);
  const who = n.spellings.length > 1 ? `${n.spellings.map((s) => `"${s}"`).join(' or ')}` : `"${n.spellings[0] || (business && business.name) || ''}"`;
  const site = n.websiteHost ? ` (website ${n.websiteHost})` : '';
  const where = [business && business.town, business && business.state].filter(Boolean).join(', ');
  return `Search Google for the business ${who}${site}${where ? ` in ${where}` : ''} on ${bare(directory)}. `
    + `Find its own profile or listing page on ${bare(directory)} (not a page about a different business). `
    + 'Reply with only the full URL of that page, or the single word NONE if there is no such page.';
}

// Path segments squashed ("/profile/pr73-new-york" → ["profile", "pr73newyork"]).
const segments = (url) => {
  let p = '';
  try { const u = new URL(url); p = decodeURIComponent(u.pathname); } catch { return []; }
  return p.split('/').map(squashName).filter(Boolean);
};

/** Does this URL (on the directory) or its title name the business? */
export function namesBusiness(url, title, business, names = []) {
  const n = listingNames(business, names);
  const keys = [...new Set([...n.spellings.map(squashName), n.websiteStem].filter((k) => k && k.length >= 3))];
  // A path segment that is the name, or starts with it ("pr73-new-york"); 4+ letters to start a segment.
  if (segments(url).some((seg) => keys.some((k) => seg === k || (k.length >= 4 && seg.startsWith(k))))) return true;
  if (!title) return false;
  const t = ` ${normalizeName(title)} `;
  if (n.spellings.map(normalizeName).some((w) => w && squashName(w).length >= 3 && t.includes(` ${w} `))) return true;
  return !!n.websiteHost && String(title).toLowerCase().includes(n.websiteHost);
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'()\]]+/gi;
const trimUrl = (u) => String(u).replace(/[.,;:!?*_`]+$/, '');

/**
 * acceptListing({ directory, business, names, text, citations }) → { status: 'listed', url, via } | { status: 'not_found' }
 * citations: the search's grounding citations [{ url, title?, domain? }] (redirects resolved where possible).
 *   1. A citation on the directory's domain whose path or title names the business → listed (via 'citation').
 *   2. A URL in the reply on the directory's domain whose path names the business → listed (via 'answer'),
 *      only when the search itself cited that directory (a URL the model made up is never enough).
 *   Anything off the directory's domain never counts.
 */
export function acceptListing({ directory, business, names = [], text = '', citations = [] }) {
  const dir = bare(directory);
  const cites = (citations || []).filter((c) => c && c.url);
  const citeHost = (c) => (onDomain(hostOf(c.url), dir) ? hostOf(c.url) : bare(c.domain));
  for (const c of cites) {
    if (onDomain(hostOf(c.url), dir) && namesBusiness(c.url, c.title, business, names)) return { status: 'listed', url: c.url, via: 'citation' };
  }
  const searchedDir = cites.some((c) => onDomain(citeHost(c), dir));
  if (searchedDir) {
    for (const raw of String(text || '').match(URL_RE) || []) {
      const u = trimUrl(raw);
      if (onDomain(hostOf(u), dir) && namesBusiness(u, '', business, names)) return { status: 'listed', url: u, via: 'answer' };
    }
  }
  return { status: 'not_found' };
}

/** Is this cited domain one where a business has a profile to look for (a directory, not a blog or a wire)? */
export function searchable(domain) {
  const d = bare(domain);
  if (!d || NOT_A_LIST_RE.test(d)) return false;
  const known = directoryFor(d);
  if (known && known.profiles === false) return false;
  return !!known || isDirectory(d) || LIST_SITE_RE.test(d);
}

/**
 * searchListings({ sources, business, names, search, lostIds?, max?, concurrency?, onCall? })
 *   → { lookups, costUsd, calls: [{ domain, ok, status, costUsd, model, usage, searches, error }] }
 * Mutates `sources`: every source on a searched domain that we couldn't read (youListed null) gets
 *   searchCheck: { status: 'listed' | 'not_found' | 'error', engine, url? }
 *   and on 'listed' also youListed: true, listedBy: 'search', profileUrl.
 * search({ directory, prompt }) → { ok, text, citations, costUsd, model?, usage?, searches?, error? }.
 * One lookup per directory domain; the domains cited most in answers that didn't name the owner go first.
 */
export async function searchListings({ sources = [], business, names = [], search, lostIds = null, max = MAX_LISTING_SEARCHES, concurrency = LISTING_SEARCH_CONCURRENCY, onCall } = {}) {
  const out = { lookups: 0, costUsd: 0, calls: [] };
  if (typeof search !== 'function' || !business) return out;
  const own = hostOf((business && business.website) || '');
  const lost = (s) => (s.citedIn || []).filter((id) => !lostIds || lostIds.has(id)).length;
  const byDomain = new Map();
  for (const s of sources) {
    if (!s || s.youListed != null || !s.domain) continue;
    const d = bare(s.domain);
    if ((own && onDomain(d, own)) || !searchable(d) || !lost(s)) continue;
    const key = (directoryFor(d) && directoryFor(d).domain) || d;
    if (!byDomain.has(key)) byDomain.set(key, { domain: key, sources: [], weight: 0 });
    const g = byDomain.get(key);
    g.sources.push(s);
    g.weight += lost(s);
  }
  const todo = [...byDomain.values()].sort((a, b) => b.weight - a.weight || a.domain.localeCompare(b.domain)).slice(0, Math.max(0, max));
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const g = todo[next++];
      const prompt = listingSearchPrompt({ directory: g.domain, business, names });
      let r;
      try { r = await search({ directory: g.domain, prompt }); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
      r = r || { ok: false, error: 'no answer' };
      const costUsd = round6(r.costUsd);
      const verdict = r.ok ? acceptListing({ directory: g.domain, business, names, text: r.text, citations: r.citations }) : { status: 'error' };
      const check = { status: verdict.status, engine: r.engine || 'gemini', ...(verdict.url ? { url: verdict.url } : {}) };
      for (const s of g.sources) {
        s.searchCheck = { ...check };
        if (verdict.status === 'listed') Object.assign(s, { youListed: true, listedBy: 'search', profileUrl: verdict.url });
      }
      const call = { domain: g.domain, ok: !!r.ok, status: verdict.status, costUsd, model: r.model || null, usage: r.usage || null, searches: Number(r.searches) || 0, error: r.ok ? null : String(r.error || 'no answer').slice(0, 500) };
      out.calls.push(call);
      out.lookups++;
      out.costUsd = round6(out.costUsd + costUsd);
      if (typeof onCall === 'function') { try { await onCall(call); } catch { /* cost logging never breaks a build */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
  return out;
}

/**
 * The real lookup: Gemini + Google Search grounding, its citations' redirects followed to the real page.
 * → search(opts) for searchListings, or null when there is no Gemini key.
 */
export function geminiListingSearch({ env = {}, fetchImpl = fetch, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
  const keys = resolveKeys(env);
  if (!keys.geminiKey) return null;
  return async ({ prompt }) => {
    const r = await geminiAsk({ question: prompt, env, fetchImpl, timeoutMs, resolveRedirects: true });
    let usage = null;
    let searches = 0;
    if (r.raw && r.raw.candidates) {
      const p = parseGemini(r.raw);
      usage = { inputTokens: p.inputTokens, outputTokens: p.outputTokens };
      searches = p.searches;
    }
    // A reply of NONE is still a good answer (finish() only fails an empty one).
    return { ok: !!r.ok, text: r.text || '', citations: r.citations || [], costUsd: r.costUsd || (usage ? priceCall('gemini', { ...usage, searches }) : 0), model: r.model, usage, searches, error: r.error, engine: 'gemini' };
  };
}

/** The search for a scan with this trigger: the paid tiers only, and only with a Gemini key. Else null. */
export function listingSearchFor({ trigger, env = {}, fetchImpl = fetch } = {}) {
  if (!LISTING_SEARCH_TRIGGERS.includes(trigger)) return null;
  return geminiListingSearch({ env, fetchImpl });
}
