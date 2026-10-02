// Text helpers shared by the extractor. Pure, runtime-agnostic.

const LEGAL = new Set(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'ltd', 'pllc', 'pc', 'the', 'and']);

// Generic trade words dropped for the "core name" used only to group variants
// ("Park Avenue Laundromat" / "Park Avenue Laundry"). Never used for owner matching.
const GENERIC = new Set([
  'laundromat', 'laundromats', 'laundry', 'laundries', 'cleaners', 'cleaning', 'service', 'services',
  'company', 'shop', 'plumbing', 'plumber', 'plumbers', 'heating', 'cooling', 'hvac', 'electric',
  'electrical', 'electrician', 'roofing', 'landscaping', 'auto', 'repair', 'center',
]);

/** "Mega Wash & Dry, LLC" → "mega wash dry" */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}/]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !LEGAL.has(w))
    .join(' ');
}

/** normalizeName minus generic trade words; '' when nothing distinctive is left. */
export function coreName(s) {
  const words = normalizeName(s).split(' ').filter((w) => w && !GENERIC.has(w));
  const core = words.join(' ');
  return core.replace(/[^\p{L}\p{N}]/gu, '').length >= 3 ? core : '';
}

export function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

/** Last 10 digits of a US phone, or '' */
export function phoneKey(s) {
  const d = digits(s);
  return d.length >= 10 ? d.slice(-10) : '';
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g;
export function findPhones(text) {
  return [...String(text || '').matchAll(PHONE_RE)].map((m) => ({ key: phoneKey(m[0]), index: m.index }));
}

const STREET_WORDS = {
  avenue: 'ave', ave: 'ave', street: 'st', st: 'st', road: 'rd', rd: 'rd', boulevard: 'blvd', blvd: 'blvd',
  drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln', highway: 'hwy', hwy: 'hwy', turnpike: 'tpke', tpke: 'tpke',
  place: 'pl', pl: 'pl', court: 'ct', ct: 'ct', parkway: 'pkwy', pkwy: 'pkwy', route: 'rte', rte: 'rte',
};

/** "1502 Deer Park Avenue" → "1502 deer park ave" (number + street name + suffix), or '' */
export function streetKey(s) {
  const m = String(s || '')
    .toLowerCase()
    .match(/\b(\d{1,6})\s+((?:[a-z0-9]+\s+){0,4}?)(avenue|ave|street|st|road|rd|boulevard|blvd|drive|dr|lane|ln|highway|hwy|turnpike|tpke|place|pl|court|ct|parkway|pkwy|route|rte)\b/);
  if (!m) return '';
  return `${m[1]} ${m[2].trim()} ${STREET_WORDS[m[3]]}`.replace(/\s+/g, ' ').trim();
}

/** Every street address in a text, with its index. */
export function findStreets(text) {
  const out = [];
  const re = /\b\d{1,6}\s+(?:[A-Za-z0-9]+\s+){0,4}?(?:Avenue|Ave|Street|St|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Highway|Hwy|Turnpike|Tpke|Place|Pl|Court|Ct|Parkway|Pkwy|Route|Rte)\b\.?/gi;
  for (const m of String(text || '').matchAll(re)) {
    const key = streetKey(m[0]);
    if (key) out.push({ key, index: m.index, raw: m[0] });
  }
  return out;
}

/** "https://www.megawashanddry.com/x" → "megawashanddry.com" */
export function domainOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const m = String(url || '').toLowerCase().match(/^(?:[a-z]+:\/\/)?(?:www\.)?([^/?#\s]+)/);
    return m ? m[1] : '';
  }
}

/** Strip hash and tracking params; keep everything else as given. */
export function normalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|srsltid$)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return String(url || '');
  }
}

// ---------------------------------------------------------------------------
// One business, several spellings ("PR 73" / "PR73", "Smith & Sons" / "Smith and Sons")
// ---------------------------------------------------------------------------

/** "PR 73" and "PR73" → "pr73"; "&" counts as "and". The same letters and digits, spacing and punctuation ignored. */
export function squashName(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The ways a business name is commonly written: as given first, then with the space between letters
 * and digits closed or opened ("PR 73" ↔ "PR73"), then "&" ↔ "and". Same letters only, never a guess
 * at another name. Case-insensitive duplicates dropped.
 */
export function nameVariants(name) {
  const n = collapse(name);
  if (!n) return [];
  const out = [n];
  const joined = n.replace(/(\p{L})\s+(?=\p{N})|(\p{N})\s+(?=\p{L})/gu, '$1$2');
  const split = n.replace(/(\p{L})(?=\p{N})|(\p{N})(?=\p{L})/gu, '$1$2 ');
  out.push(joined, split);
  for (const v of [...out]) {
    if (/\s&\s/.test(v)) out.push(v.replace(/\s&\s/g, ' and '));
    if (/\sand\s/i.test(v)) out.push(v.replace(/\sand\s/gi, ' & '));
  }
  const seen = new Set();
  return out.map(collapse).filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()));
}

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How many times `name` appears in `text` as written (case-insensitive, whole words, any run of spaces). */
export function countSpelling(text, name) {
  const body = collapse(name).split(' ').map(escRe).join('\\s+');
  if (!body) return 0;
  return (String(text || '').match(new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu')) || []).length;
}

/**
 * The business name as the owner's website writes it, compared with the name the owner typed.
 * candidates: [{ name, from }] read off the site (og:site_name, schema name, title segments), in
 * order of trust; text: the site's words to count spellings in.
 * → { name, from, related, differs, consistent } | null
 *   related: the same letters as the typed name (only a spacing or "&"/"and" difference);
 *   differs: related, but written differently (case alone doesn't count);
 *   consistent: the site writes its spelling and never the typed one.
 * An unrelated brand (the title's last segment, og:site_name) comes back with related false: a
 * search term, never a name to put in the owner's copy.
 */
export function spellingOnSite(candidates, typed, text = '') {
  const list = (candidates || []).map((c) => c && { name: collapse(c.name), from: c.from })
    .filter((c) => c && c.name && c.name.length <= 60 && squashName(c.name).length >= 2);
  if (!list.length) return null;
  const want = squashName(typed);
  const same = want ? list.find((c) => squashName(c.name) === want) : null;
  if (!same) {
    const brand = list.find((c) => c.from !== 'title') || list[0];
    return { name: brand.name, from: brand.from, related: false, differs: false, consistent: false };
  }
  const differs = same.name.toLowerCase() !== collapse(typed).toLowerCase();
  const all = `${list.map((c) => c.name).join(' \n ')} \n ${text}`;
  const consistent = differs && countSpelling(all, same.name) > 0 && countSpelling(all, typed) === 0;
  return { name: same.name, from: same.from, related: true, differs, consistent };
}

/** A page title's parts: "Integrated Communications | PR73" → ["Integrated Communications", "PR73"]. */
export function titleParts(title) {
  return collapse(title).split(/\s+[|–—-]\s+|\s*\|\s*|\s+[·•:]\s+/).map(collapse).filter(Boolean);
}
