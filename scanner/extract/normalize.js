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
