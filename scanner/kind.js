// scanner/kind.js — what kind of business it is, without asking the owner.
//
// The homepage form no longer asks "What do you do?". /api/questions works it out:
//   1. the business name  ("Glenn Wayne Bakery" → bakery, "Otter Plumbing" → plumbing)
//   2. the owner's website: its schema.org type (Bakery, Plumber, ...), then its title,
//      description and first heading run through the same words
// Only when both come up empty does the form ask, with one free-text box.
//
// A result is a TRADES key (scanner/questions.js: its own tuned questions) or the plain words
// for any other business ("bakery", "dentist"), which get the generic questions.

import { siteUrl, readMeta } from './owner-checks.js';

// First match wins (plumbing before heating: "Plumbing & Heating" is a plumber), on lower case text.
// Car wash and dry cleaning come first: they are their own business, not auto repair or house cleaning.
export const KIND_WORDS = [
  ['car wash', /car ?wash|auto spa/],
  ['dry cleaner', /dry ?clean/],
  ['laundromat', /laund|wash (?:&|and) (?:dry|fold)|washateria|coin wash|wash ?house/],
  ['auto_repair', /\bauto\b|auto (?:repair|service|body|care)|automotive|motors?\b|mechanic|collision|\btires?\b|transmission|brakes?\b|car care|muffler|\blube\b/],
  ['plumbing', /plumb|drain|sewer|rooter|\bpipes?\b/],
  ['hvac', /hvac|heating|cooling|air cond|\bair\b|furnace|climate control|comfort (?:systems|air|heat)/],
  ['electrical', /electric|wiring/],
  ['roofing', /roof|gutter|siding/],
  ['landscaping', /landscap|lawn|garden|\btrees?\b|\byard\b|\bmow|irrigation|sprinkler|hardscap/],
  ['cleaning', /clean|\bmaids?\b|janitor|housekeep/],
  ['bakery', /\bbak(?:e|ery|eries|ing|ed)\b|bakery|pastr|patisserie|cupcake|donut|doughnut|bagel/],
  ['pizzeria', /pizz/],
  ['cafe', /\bcaf[eé]\b|coffee|espresso/],
  ['deli', /\bdeli\b|delicatessen/],
  ['restaurant', /restaurant|bistro|\bgrill\b|\bdiner\b|tavern|trattoria|eatery|steakhouse|sushi|taqueria/],
  ['bar', /\bpub\b|\bbar\b|brewery|taproom/],
  ['dentist', /dental|dentist|orthodont/],
  ['chiropractor', /chiropract/],
  ['veterinarian', /\bvets?\b|veterinar|animal hospital/],
  ['pet groomer', /groom/],
  ['barber shop', /barber/],
  ['nail salon', /\bnails?\b/],
  ['hair salon', /salon|\bhair\b|beauty/],
  ['spa', /\bspa\b|massage/],
  ['gym', /\bgym\b|fitness|crossfit|yoga|pilates/],
  ['florist', /floral|florist|\bflowers?\b/],
  ['pest control', /\bpest|extermin|termite/],
  ['painter', /\bpaint(?:er|ers|ing)\b/],
  ['moving company', /\bmoving\b|\bmovers?\b|relocation/],
  ['locksmith', /locksmith/],
  ['law firm', /\blaw\b|legal|attorney|lawyer/],
  ['accountant', /accounting|accountant|\bcpa\b|\btax(?:es)?\b|bookkeep/],
  ['insurance agency', /insuranc/],
  ['real estate agent', /realt|real estate/],
  ['pharmacy', /pharmac/],
  ['daycare', /daycare|day care|preschool|child ?care/],
  ['contractor', /contracting|contractors?\b|construction|remodel|renovat|\bbuilders?\b/],
];

/** Words (a name, a page title) → a TRADES key or plain business words, else null. */
export function guessKind(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  for (const [kind, re] of KIND_WORDS) if (re.test(t)) return kind;
  return null;
}

// schema.org LocalBusiness subtypes → the same results. Generic types (LocalBusiness, Organization,
// Store, ...) say nothing and are skipped.
export const SCHEMA_KINDS = {
  Plumber: 'plumbing', HVACBusiness: 'hvac', Electrician: 'electrical', RoofingContractor: 'roofing',
  HousePainter: 'painter', Locksmith: 'locksmith', MovingCompany: 'moving company', GeneralContractor: 'contractor',
  AutoRepair: 'auto_repair', AutoBodyShop: 'auto_repair', AutoWash: 'car wash', DryCleaningOrLaundry: 'laundromat',
  Bakery: 'bakery', CafeOrCoffeeShop: 'cafe', Restaurant: 'restaurant', FastFoodRestaurant: 'restaurant',
  BarOrPub: 'bar', Brewery: 'bar', Dentist: 'dentist', VeterinaryCare: 'veterinarian', HairSalon: 'hair salon',
  BeautySalon: 'hair salon', NailSalon: 'nail salon', DaySpa: 'spa', HealthClub: 'gym', ExerciseGym: 'gym',
  Florist: 'florist', LegalService: 'law firm', Attorney: 'law firm', AccountingService: 'accountant',
  InsuranceAgency: 'insurance agency', RealEstateAgent: 'real estate agent', Pharmacy: 'pharmacy', ChildCare: 'daycare',
};

/** Home page HTML → a kind from its schema.org type, else its title, description and first heading. */
export function kindFromPage(html) {
  const h = String(html || '');
  for (const m of h.matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
    let types;
    try { types = [].concat(JSON.parse(m[1])); } catch { continue; }
    for (const t of types) if (SCHEMA_KINDS[String(t)]) return SCHEMA_KINDS[String(t)];
  }
  const meta = readMeta(h);
  return guessKind(meta.title) || guessKind(meta.h1) || guessKind(meta.description);
}

/** Only a public web address: never an IP, localhost or a bare internal name. */
export function publicSite(website) {
  const u = siteUrl(website);
  if (!u || !/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (/^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[')) return null;
  return u;
}

export const SITE_TIMEOUT_MS = 4000;
const SITE_MAX_CHARS = 400_000;

/**
 * The kind of business, from the name, else the website. Never throws.
 * → { kind: string | null, from: 'name' | 'website' | null }
 */
export async function inferKind({ name, website } = {}, { fetchImpl = (...a) => fetch(...a), timeoutMs = SITE_TIMEOUT_MS } = {}) {
  const byName = guessKind(name);
  if (byName) return { kind: byName, from: 'name' };
  const u = publicSite(website);
  if (!u) return { kind: null, from: null };
  try {
    const res = await fetchImpl(u.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AIFoundScore/1.0; +https://aifoundscore.com)', Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { kind: null, from: null };
    const kind = kindFromPage((await res.text()).slice(0, SITE_MAX_CHARS));
    return kind ? { kind, from: 'website' } : { kind: null, from: null };
  } catch {
    return { kind: null, from: null };
  }
}
