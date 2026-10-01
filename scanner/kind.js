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
  ['med spa', /med ?spa|medspa|botox|aesthetic/],
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
  // Offices and professionals (scanner/questions.js PROFESSIONAL_RE gives them their own questions).
  ['PR agency', /public relations|\bpr\b|press relations|publicist/],
  ['marketing agency', /marketing|advertising|\bad agency|branding|\bseo\b|\bppc\b|social media/],
  ['communications agency', /communications/],
  ['web design agency', /web design|web development|website design|web agency/],
  ['IT company', /\bit (?:services|support|solutions|company|consult)|managed (?:it|service provider)|\bmsp\b|tech support|computer repair/],
  ['software company', /software|\bsaas\b|app development/],
  ['consulting firm', /consulting|consultants?\b/],
  ['staffing agency', /staffing|recruit/],
  ['architect', /architect/],
  ['financial advisor', /financial (?:advis|plann)|wealth management|investment advis/],
  ['mortgage broker', /mortgage/],
  ['print shop', /\bprint(?:ing|er|ers|s)?\b|signs? (?:&|and) (?:banners|graphics)/],
  ['photographer', /photograph/],
  ['tutoring center', /tutoring|tutors?\b|test prep|learning center/],
  ['physical therapist', /physical therap|\bpt clinic/],
  ['optometrist', /optometr|eye care|eye doctor|optical/],
  ['dermatologist', /dermatolog|skin care clinic/],
  ['urgent care', /urgent care|walk-?in clinic/],
  ['funeral home', /funeral|cremation/],
  ['storage facility', /self[- ]storage|storage units?/],
  ['towing company', /towing|tow truck|roadside/],
  ['auto glass shop', /auto glass|windshield/],
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

/** Content of a <meta property="og:…"> / name="…" tag, or ''. */
export function metaContent(html, key) {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!new RegExp(`\\b(?:property|name)\\s*=\\s*["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s/>]`, 'i').test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (c) return decodeEntities(c[1] ?? c[2]).replace(/\s+/g, ' ').trim();
  }
  return '';
}

const decodeEntities = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;|&rsquo;/g, '’').replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/**
 * Home page HTML → a kind from its schema.org type, else its title, first heading, description and
 * og:description: the lines the business wrote about itself. Never the page's body text ("call for a
 * free consultation" is not a consulting firm). A guess the form shows for the owner to change.
 */
export function kindFromPage(html) {
  const h = String(html || '');
  for (const m of h.matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
    let types;
    try { types = [].concat(JSON.parse(m[1])); } catch { continue; }
    for (const t of types) if (SCHEMA_KINDS[String(t)]) return SCHEMA_KINDS[String(t)];
  }
  const meta = readMeta(h);
  return guessKind(meta.title) || guessKind(meta.h1) || guessKind(meta.description) || guessKind(metaContent(h, 'og:description'));
}

// schema.org types whose "name" is not the business.
const NOT_A_BUSINESS = new Set(['WebSite', 'WebPage', 'Product', 'Person', 'Article', 'BlogPosting', 'BreadcrumbList', 'ListItem', 'ImageObject', 'Offer', 'Review', 'Event', 'Service', 'FAQPage', 'Question', 'Answer', 'SearchAction', 'PostalAddress', 'VideoObject', 'ItemList', 'CollectionPage', 'ContactPoint', 'OpeningHoursSpecification', 'AggregateRating', 'Rating', 'Brand', 'SiteNavigationElement', 'WPHeader', 'WPFooter', 'Menu', 'MenuItem']);
const TITLE_NOISE = /^(?:home|homepage|welcome|welcome to .*|official (?:web)?site|main page|index)$/i;

/**
 * The business's name from its home page, or ''. schema.org name (any Organization or business
 * type), else og:site_name, else the part of <title> that isn't "Home" or a slogan. A prefill the
 * owner checks, never a fact.
 */
export function findName(html) {
  const h = String(html || '');
  for (const m of h.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const found = schemaName(data);
    if (found) return cleanName(found);
  }
  const site = metaContent(h, 'og:site_name');
  if (cleanName(site)) return cleanName(site);
  const title = readMeta(h).title;
  if (!title) return '';
  const parts = title.split(/\s*(?:\||–|—|::|•|·|›|»|\s-\s)\s*/).map((t) => t.replace(/^welcome to\s+/i, '').trim()).filter((t) => t && !TITLE_NOISE.test(t) && t.length <= 60);
  if (!parts.length) return '';
  // "Name | tagline" is the usual order, so the first part wins unless it reads as a list of
  // services ("Cakes, Cookies & Pastries"), a place ("Bohemia NY") or a sentence (7+ words).
  const notAName = (t) => /,/.test(t) || /\b[A-Z]{2}$/.test(t) || t.split(' ').length > 6;
  return cleanName(parts.find((t) => !notAName(t)) || parts[0]);
}

function schemaName(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return '';
  if (Array.isArray(node)) { for (const n of node) { const r = schemaName(n, depth + 1); if (r) return r; } return ''; }
  const types = [].concat(node['@type'] || []).map(String);
  if (typeof node.name === 'string' && cleanName(node.name) && types.length && !types.some((t) => NOT_A_BUSINESS.has(t))) return node.name;
  for (const k of ['@graph', 'publisher', 'provider', 'mainEntity', 'about']) { const r = schemaName(node[k], depth + 1); if (r) return r; }
  return '';
}

const cleanName = (n) => decodeEntities(n).replace(/\s+/g, ' ').trim().replace(/^(?:home|welcome)$/i, '').slice(0, 80);

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
