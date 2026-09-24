// Cited sources: taken straight from each engine's citation data (never from a model),
// normalized to domain + URL. For the top cited directory pages, optionally fetch the
// page and look for the owner (name or phone) and who is listed first.
// Runtime-agnostic: injectable fetchImpl.

import { domainOf, normalizeUrl, normalizeName, phoneKey, digits } from './normalize.js';

export const DIRECTORY_DOMAINS = [
  'yellowpages.com', 'superpages.com', 'yelp.com', 'angi.com', 'angieslist.com', 'homeadvisor.com',
  'bbb.org', 'manta.com', 'mapquest.com', 'thumbtack.com', 'houzz.com', 'porch.com', 'nextdoor.com',
  'citysearch.com', 'chamberofcommerce.com', 'merchantcircle.com', 'foursquare.com', 'local.yahoo.com',
  'dexknows.com', 'hotfrog.com', 'brownbook.net', 'cylex.us.com', 'judysbook.com', 'birdeye.com',
];

export function isDirectory(domain) {
  return DIRECTORY_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
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

/** checkDirectoryPage(html, business) → { youListed, youPosition, topListed, listingsRead } */
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
  };
}

/**
 * buildSources({ answers, business, fetchImpl, maxFetch }) → sources[]
 * Directory pages are fetched in order of: cited in answers that didn't name the
 * owner, then total citations. Fetch failures leave the fields null (never guessed).
 */
export async function buildSources({ answers, business, fetchImpl, maxFetch = 5 }) {
  const sources = collectSources(answers);
  const lost = new Set(answers.filter((a) => !a.namedYou).map((a) => a.id));
  const lostCount = (s) => s.citedIn.filter((id) => lost.has(id)).length;
  const dirs = sources
    .filter((s) => isDirectory(s.domain))
    .sort((a, b) => lostCount(b) - lostCount(a) || b.citedIn.length - a.citedIn.length);
  const doFetch = fetchImpl || globalThis.fetch;
  if (doFetch && maxFetch > 0) {
    for (const s of dirs.slice(0, maxFetch)) {
      try {
        const res = await doFetch(s.url, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; AIFoundScore/2.0)' } });
        if (!res.ok) { s.checkError = `HTTP ${res.status}`; continue; }
        Object.assign(s, checkDirectoryPage(await res.text(), business), { checked: true });
      } catch (e) {
        s.checkError = String((e && e.message) || e);
      }
    }
  }
  return sources.sort((a, b) => b.citedIn.length - a.citedIn.length);
}
