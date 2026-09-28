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
// → { ok: true, url } | { ok: false, field: 'website' | 'business_name', reason, error }

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
  }
  return { ok: true, url: u.href };
}

/** The whole gate: the name first (no network), then the website when there is one. */
export async function checkSubmission({ name, website } = {}, deps = {}) {
  const n = checkName(name);
  if (!n.ok) return n;
  if (!String(website ?? '').trim()) return { ok: true, url: null };
  return checkWebsite(website, deps);
}

/** GET /api/site-check?website=&name= */
export async function handleSiteCheck(url, deps = {}) {
  const p = url.searchParams;
  const r = await checkSubmission({ name: p.get('name') ?? 'ok', website: String(p.get('website') || '').slice(0, 160) }, deps);
  return Response.json(r, { headers: { 'Cache-Control': 'no-store' } });
}
