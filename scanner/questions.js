// scanner/questions.js — the 5 fixed questions per trade (BUILD_PLAN "Question sets").
//
// One question per buying intent, filled with the business's town/state/ZIP. They never
// change between scans so before-and-after results compare like for like.
// Plain homeowner wording, no brand names.
//
// Slots: {town} {state} {zip} {near}
//   {near} = business.nearbyTown || business.town. The demo asked the urgent and trust
//   questions about a neighbouring town (Deer Park) — set `nearbyTown` to reproduce that.

import { stateAbbr } from './config.js';

export const INTENTS = ['best', 'urgent', 'job', 'trust', 'price'];

/** The free report (AI Visibility Snapshot) asks only the first three: best, urgent, job.
 *  Owner decision (Sep 2026, site copy v2). Paid and admin scans still ask all five. */
export const FREE_QUESTION_COUNT = 3;

// Generic templates (the plan's "Template" column). A trade can override any of them.
export const TEMPLATES = {
  best: "What's the best {trade} in {town}, {state}?",
  urgent: '{urgent} near {near} {state}',
  job: 'Can you recommend {aTrade} in {town} {state}?',
  trust: '{Trade} with good reviews near {near}, {state}',
  price: 'Affordable {trade} near {town} {state}',
};

// Per trade: `trade` = the noun a homeowner types. Other keys are full templates for
// that intent (they win over TEMPLATES).
export const TRADES = {
  plumbing: {
    trade: 'plumber',
    urgent: 'I need an emergency plumber near {near} tonight',
    job: 'Who can replace a water heater in {town} {state}?',
    trust: 'Plumber with good reviews near {near}, {state}',
    price: 'Affordable plumber near {zip}',
  },
  hvac: {
    trade: 'heating and air conditioning company',
    urgent: 'Emergency AC repair near {near} {state}',
    job: 'Who can install a new furnace in {town} {state}?',
    trust: 'Heating and air conditioning company with good reviews near {near}, {state}',
    price: 'Affordable AC tune up near {town} {state}',
  },
  electrical: {
    trade: 'electrician',
    urgent: 'Emergency electrician near {near} {state}',
    job: 'Who can upgrade an electrical panel in {town} {state}?',
    trust: 'Electrician with good reviews near {near}, {state}',
    price: 'Affordable electrician near {town} {state}',
  },
  roofing: {
    trade: 'roofer',
    urgent: 'Roof leak repair today near {near} {state}',
    job: 'Who can replace a roof in {town} {state}?',
    trust: 'Roofer with good reviews near {near}, {state}',
    price: 'Affordable roof repair near {town} {state}',
  },
  landscaping: {
    trade: 'landscaper',
    urgent: 'Landscaper who can come this week near {near} {state}',
    job: 'Who does weekly lawn mowing in {town} {state}?',
    trust: 'Landscaper with good reviews near {near}, {state}',
    price: 'Cheapest lawn care near {town} {state}',
  },
  cleaning: {
    trade: 'house cleaning service',
    urgent: 'Same day house cleaning near {near} {state}',
    job: 'Who does move out cleaning in {town} {state}?',
    trust: 'House cleaner with good reviews near {near}, {state}',
    price: 'Affordable house cleaning near {town} {state}',
  },
  auto_repair: {
    trade: 'auto repair shop',
    urgent: 'Mechanic open on Saturday near {near} {state}',
    job: 'Who can replace brakes in {town} {state}?',
    trust: 'Mechanic with good reviews near {near}, {state}',
    price: 'Cheapest oil change near {town} {state}',
  },
  laundromat: {
    trade: 'laundromat',
    urgent: '24 hour laundromat near {near} {state}',
    job: 'Who does laundry pickup and delivery in {town} {state}?',
    trust: 'Laundromat with big washers for comforters near {near}, {state}',
    price: 'Cheapest wash and fold near {town} {state}',
  },
};

/**
 * Kinds that are offices, not storefronts or vans: agencies, firms, consultants, professionals.
 * "Open now near …" is a wasted question for them (Oct 1 2026: "Pr agency open now near New York
 * City NY" got a question back from ChatGPT). They get the PROFESSIONAL templates instead.
 */
export const PROFESSIONAL_RE = /agenc(?:y|ies)|\bfirm\b|consulting|consultants?\b|account|\bcpa\b|attorney|lawyer|\blaw\b|legal|insurance|real estate|realt|marketing|advertis|public relations|\bpr\b|communications|software|\bit\b|\bmsp\b|staffing|recruit|architect|engineer|financial|advisor|adviser|wealth|mortgage|broker|notary|bookkeep|\btax\b|payroll|\bseo\b|\bppc\b|branding/;

/** Templates for professional kinds; anything not listed falls back to TEMPLATES. */
export const PROFESSIONAL = {
  urgent: 'Top rated {trade} in {town}, {state}',
};

/** 'trade' (a TRADES key: home services), 'professional' (PROFESSIONAL_RE) or 'storefront' (the rest). */
export function kindClass(kind) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k) return 'storefront';
  if (normalizeTrade(k)) return 'trade';
  return PROFESSIONAL_RE.test(k) ? 'professional' : 'storefront';
}

/** Words that read as nonsense in lower case: "pr agency" → "PR agency". Whole words only. */
export const ACRONYMS = ['pr', 'hvac', 'it', 'cpa', 'seo', 'ppc', 'ac', 'hr', 'cbd', 'rv', 'ev', 'tv', 'av', 'msp', 'saas', 'ui', 'ux', 'llc', 'pc', 'diy', 'emt', 'ems', 'iv', 'uv', 'led', 'cnc', '3d', 'b2b'];
const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join('|')})\\b`, 'g');
export function caseKind(kind) {
  return String(kind || '').replace(ACRONYM_RE, (m) => m.toUpperCase());
}

export const TRADE_ALIASES = {
  plumber: 'plumbing', plumbers: 'plumbing',
  'heating and cooling': 'hvac', 'heating & cooling': 'hvac', 'air conditioning': 'hvac', 'hvac contractor': 'hvac',
  electrician: 'electrical', electricians: 'electrical', electric: 'electrical',
  roofer: 'roofing', roofers: 'roofing', roof: 'roofing',
  landscaper: 'landscaping', landscapers: 'landscaping', 'lawn care': 'landscaping', lawn: 'landscaping',
  'house cleaning': 'cleaning', cleaner: 'cleaning', cleaners: 'cleaning', 'cleaning service': 'cleaning', maid: 'cleaning',
  'auto repair': 'auto_repair', 'auto-repair': 'auto_repair', mechanic: 'auto_repair', 'auto mechanic': 'auto_repair', 'car repair': 'auto_repair',
  laundry: 'laundromat', laundromats: 'laundromat', 'coin laundry': 'laundromat', 'laundry mat': 'laundromat',
};

/** Normalise a free-text trade to a TRADES key (or null if unknown). */
export function normalizeTrade(trade) {
  const t = String(trade || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const key = t.replace(/[\s-]+/g, '_');
  if (TRADES[key]) return key;
  if (TRADE_ALIASES[t]) return TRADE_ALIASES[t];
  return null;
}

/**
 * Any kind of business the owner typed: a TRADES key when we know it, else the plain words
 * ("bakery", "pest control") in lower case, else null. Letters, spaces, & ' - . only, 2-40 characters.
 */
export function tradeOrKind(trade) {
  const known = normalizeTrade(trade);
  if (known) return known;
  const t = String(trade || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/’/g, "'");
  return /^[a-z0-9][a-z0-9 &'.-]{1,39}$/.test(t) && /[a-z]/.test(t) ? caseKind(t) : null;
}

function fill(template, slots) {
  return template
    .replace(/\{(\w+)\}/g, (_, k) => (slots[k] != null ? String(slots[k]) : ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,?])/g, '$1')
    .trim();
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "a plumber", "an electrician", "a PR agency" (an acronym read letter by letter: "an HVAC…", "an IT…"). */
function article(noun) {
  const first = noun.split(' ')[0];
  const vowelSound = /^[AEIOU]/.test(first) || (/^[A-Z0-9]{2,}$/.test(first) && /^[AEFHILMNORSX]/.test(first));
  return /^[aeiou]/.test(noun) || vowelSound ? 'an' : 'a';
}

/**
 * Build the 5 questions for a business.
 * @param {{trade:string, town:string, state?:string, zip?:string, nearbyTown?:string}} business
 * @returns {{id:string, intent:string, text:string}[]}
 */
export function buildQuestions(business) {
  if (!business || !business.town) throw new Error('buildQuestions: business.town is required');
  const key = normalizeTrade(business.trade);
  // A kind we don't have tuned questions for: the owner's words (acronyms upper-cased), and the
  // professional templates when it is an office, not a storefront or a van.
  const plain = caseKind(String(business.trade || 'local business').trim().toLowerCase());
  const set = key ? TRADES[key] : { trade: plain, ...(kindClass(plain) === 'professional' ? PROFESSIONAL : {}) };
  const town = String(business.town).trim();
  const near = String(business.nearbyTown || '').trim() || town;
  const state = stateAbbr(business.state);
  const zip = String(business.zip || '').trim();
  const slots = { trade: set.trade, Trade: cap(set.trade), town, near, state, zip, urgent: `${cap(set.trade)} open now`, aTrade: `${article(set.trade)} ${set.trade}` };

  return INTENTS.map((intent, i) => {
    let tpl = set[intent] || TEMPLATES[intent];
    // A ZIP-only template needs a ZIP; fall back to town + state without one.
    if (tpl.includes('{zip}') && !zip) tpl = tpl.replace('{zip}', '{town} {state}');
    return { id: `q${i + 1}`, intent, text: fill(tpl, slots) };
  });
}

/** The questions the free report asks: the first FREE_QUESTION_COUNT of buildQuestions. */
export function freeQuestions(business) {
  return buildQuestions(business).slice(0, FREE_QUESTION_COUNT);
}

// ---------------------------------------------------------------------------
// Small-firm questions: the PAID audit only (Oct 2 2026).
//
// A small NYC PR agency read its paid report and saw AI name only the giant firms. The reviewer:
// "Test the questions I can win (boutique, by industry, by budget) and show the firms my size that
// got named." So every paid-tier scan (the paid audit, its 30-day re-check, Be the Answer months)
// adds two questions a business that size can win:
//   q6 'small'  the size question (a boutique PR agency for a small company; a family-owned plumber)
//   q7 'niche'  the specialty the business's own homepage names (title, description, main heading),
//               else a question small firms win anyway (an agency on a budget; a plumber for a small job)
// Free scans never ask them (cost): freeQuestions and buildQuestions are unchanged.
// ---------------------------------------------------------------------------

/** The two small-firm intents, after INTENTS. Their ids are q6 and q7, always. */
export const SMALL_FIRM_INTENTS = ['small', 'niche'];
/** Every intent a paid-tier scan asks, in order. */
export const PAID_INTENTS = [...INTENTS, ...SMALL_FIRM_INTENTS];
/** How many questions a paid-tier scan asks. */
export const PAID_QUESTION_COUNT = PAID_INTENTS.length;
/** True for the small-firm questions' intents. */
export const isSmallFirmIntent = (intent) => SMALL_FIRM_INTENTS.includes(intent);

// What an office (agency, firm, practice) can say it specializes in, read off its own homepage.
// Industries first (the reviewer's "by industry"), then distinct kinds of work. First match wins.
// Each phrase is how a buyer would write it in the question.
export const PRO_SPECIALTIES = [
  [/\btech(?:nology)? start-?ups?\b/i, 'tech startups'],
  [/\bstart-?ups?\b/i, 'startups'],
  [/\b(?:tech|technology|saas|software)\b/i, 'tech companies'],
  [/\b(?:health ?care|medical|life sciences|biotech|pharma(?:ceutical)?s?)\b/i, 'healthcare'],
  [/\bwellness\b/i, 'health and wellness'],
  [/\bconsumer (?:brands?|products?|goods)\b|\bcpg\b/i, 'consumer brands'],
  [/\bb2b\b/i, 'B2B companies'],
  [/\b(?:fashion|apparel)\b/i, 'fashion'],
  [/\b(?:beauty|cosmetics|skincare)\b/i, 'beauty brands'],
  [/\bfood (?:and|&) (?:beverage|drink)s?\b|\bf&b\b|\brestaurants?\b/i, 'food and beverage'],
  [/\b(?:hospitality|hotels?)\b/i, 'hospitality'],
  [/\breal estate\b/i, 'real estate'],
  [/\b(?:financial services|fintech|finance)\b/i, 'financial services'],
  [/\b(?:crypto(?:currency)?|blockchain|web3)\b/i, 'crypto'],
  [/\bnon-?profits?\b/i, 'nonprofits'],
  [/\b(?:entertainment|music|film)\b/i, 'entertainment'],
  [/\bsports?\b/i, 'sports'],
  [/\b(?:travel|tourism)\b/i, 'travel'],
  [/\bluxury\b/i, 'luxury brands'],
  [/\b(?:education|edtech)\b/i, 'education'],
  [/\b(?:energy|clean ?tech|sustainability)\b/i, 'energy and sustainability'],
  [/\bcannabis\b/i, 'cannabis'],
  [/\be-?commerce\b/i, 'e-commerce'],
  [/\bcrisis (?:communications?|management|pr)\b/i, 'crisis communications'],
  [/\binvestor relations\b/i, 'investor relations'],
  [/\binfluencer\b/i, 'influencer marketing'],
  [/\bthought leadership\b/i, 'thought leadership'],
  [/\bproduct launch(?:es)?\b/i, 'product launches'],
  [/\bintegrated (?:communications|marketing)\b/i, 'integrated communications'],
  [/\bpublic affairs\b/i, 'public affairs'],
  [/\bpersonal injury\b/i, 'personal injury'],
  [/\bestate planning\b/i, 'estate planning'],
  [/\b(?:divorce|family law)\b/i, 'family law'],
  [/\bimmigration\b/i, 'immigration'],
  [/\bbankruptcy\b/i, 'bankruptcy'],
  [/\bemployment law\b/i, 'employment law'],
  [/\bcriminal defen[cs]e\b/i, 'criminal defense'],
  [/\b(?:intellectual property|patents?|trademarks?)\b/i, 'intellectual property'],
];

// What a home-service business says it does beyond the usual job question, read off its homepage.
// Each phrase reads after "Who does …". A service the trade's own job question already asks is skipped.
export const TRADE_SERVICES = {
  plumbing: [
    [/\bboilers?\b/i, 'boiler repair'], [/\bdrains?\b/i, 'drain cleaning'], [/\bsewer\b/i, 'sewer line repair'],
    [/\btankless\b/i, 'tankless water heater installation'], [/\bleak detection\b/i, 'leak detection'],
    [/\bgas lines?\b/i, 'gas line repair'], [/\bsump pumps?\b/i, 'sump pump installation'],
    [/\bbackflow\b/i, 'backflow testing'], [/\bbathroom remodel/i, 'bathroom remodeling'], [/\brepip/i, 'repiping'],
  ],
  hvac: [
    [/\b(?:ductless|mini[- ]splits?)\b/i, 'ductless mini split installation'], [/\bheat pumps?\b/i, 'heat pump installation'],
    [/\bboilers?\b/i, 'boiler repair'], [/\bduct cleaning\b/i, 'duct cleaning'], [/\bindoor air\b/i, 'indoor air quality testing'],
  ],
  electrical: [
    [/\b(?:ev|electric vehicle) charg/i, 'EV charger installation'], [/\bgenerators?\b/i, 'generator installation'],
    [/\brewir/i, 'rewiring'], [/\blighting\b/i, 'lighting installation'],
  ],
  roofing: [
    [/\bgutters?\b/i, 'gutter installation'], [/\bsiding\b/i, 'siding installation'], [/\bskylights?\b/i, 'skylight installation'],
    [/\bflat roof/i, 'flat roof repair'], [/\bslate\b/i, 'slate roof repair'],
  ],
  landscaping: [
    [/\b(?:hardscap\w*|patios?|pavers?)\b/i, 'patio and paver installation'], [/\b(?:irrigation|sprinklers?)\b/i, 'sprinkler installation'],
    [/\btree (?:removal|service|trimming)\b/i, 'tree removal'], [/\bsnow\b/i, 'snow removal'], [/\blandscape design\b/i, 'landscape design'],
  ],
  cleaning: [
    [/\bdeep clean/i, 'deep cleaning'], [/\bcarpet\b/i, 'carpet cleaning'], [/\b(?:office|commercial) clean/i, 'office cleaning'],
    [/\bpost[- ]construction\b/i, 'post-construction cleaning'], [/\bwindow clean/i, 'window cleaning'],
  ],
  auto_repair: [
    [/\btransmissions?\b/i, 'transmission repair'], [/\bcollision\b|\bauto body\b/i, 'collision repair'], [/\balignments?\b/i, 'wheel alignment'],
    [/\binspections?\b/i, 'state inspections'], [/\b(?:european|bmw|mercedes|audi)\b/i, 'European car repair'],
  ],
  laundromat: [
    [/\bdry clean/i, 'dry cleaning'], [/\bcommercial laundry\b/i, 'commercial laundry service'], [/\b(?:tailor|alteration)/i, 'alterations'],
  ],
};

// Words that never make a specialty different from the trade itself ("financial services" for a financial advisor).
const SPECIALTY_FILLER = new Set(['and', 'companies', 'brands', 'services', 'service', 'firms', 'businesses', 'repair', 'installation']);

/** The homepage text a specialty may be read from: title, meta description and main heading. */
function homepageText(siteCheck) {
  const m = siteCheck && typeof siteCheck === 'object' && siteCheck.meta && typeof siteCheck.meta === 'object' ? siteCheck.meta : null;
  if (!m) return '';
  return [m.title, m.description, m.h1].filter((x) => typeof x === 'string').join(' \n ').replace(/&amp;/g, '&');
}

/**
 * The specialty a business's own homepage names (siteCheck.meta: title, description, main heading),
 * or null when none can be read reliably. Only phrases from PRO_SPECIALTIES (offices) or the trade's
 * TRADE_SERVICES list count: never a guess. A storefront has no list, so it is always null.
 * → { phrase, from: 'site' } | null
 */
export function readSpecialty(business, siteCheck) {
  const text = homepageText(siteCheck);
  if (!text.trim()) return null;
  const key = normalizeTrade(business && business.trade);
  const noun = key ? TRADES[key].trade : String((business && business.trade) || '');
  const kind = key ? 'trade' : kindClass(noun);
  const tradeWords = new Set(noun.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  let list = [];
  if (kind === 'professional') list = PRO_SPECIALTIES;
  else if (key && TRADE_SERVICES[key]) {
    // The job question already asks about it ("Who can replace a water heater…").
    const job = String(TRADES[key].job || '').toLowerCase();
    list = TRADE_SERVICES[key].filter(([, phrase]) => !phrase.toLowerCase().split(' ').filter((w) => w.length > 3 && !SPECIALTY_FILLER.has(w)).every((w) => job.includes(w)));
  }
  for (const [re, phrase] of list) {
    if (!re.test(text)) continue;
    const words = phrase.toLowerCase().split(/\s+/).filter((w) => !SPECIALTY_FILLER.has(w));
    // "real estate" for a real estate agent is the trade itself, not a specialty.
    if (words.length && words.every((w) => tradeWords.has(w))) continue;
    return { phrase, from: 'site' };
  }
  return null;
}

/** Office kinds whose clients are companies (agencies, consultants, accountants, IT, staffing). */
const B2B_RE = /agenc(?:y|ies)|consult|marketing|advertis|public relations|\bpr\b|communications|branding|\bseo\b|\bppc\b|software|\bit\b|\bmsp\b|staffing|recruit|account|\bcpa\b|bookkeep|payroll|\btax\b/;

/** "boutique" for agencies, firms, studios and consultancies; "independent" for other offices (an accountant). */
function sizeWord(noun) {
  return /\b(?:agenc(?:y|ies)|firm|studio|consultancy|practice|group)\b/i.test(noun) ? 'boutique' : 'independent';
}

/**
 * The two small-firm questions (q6 'small', q7 'niche') for a paid-tier scan.
 * opts.siteCheck: the homepage check from the business's stored report (scanner/owner-checks.js), for the specialty.
 * → [{ id: 'q6', intent: 'small', text }, { id: 'q7', intent: 'niche', text }]
 */
export function smallFirmQuestions(business, { siteCheck = null } = {}) {
  if (!business || !business.town) throw new Error('smallFirmQuestions: business.town is required');
  const key = normalizeTrade(business.trade);
  const noun = key ? TRADES[key].trade : caseKind(String(business.trade || 'local business').trim().toLowerCase());
  const kind = key ? 'trade' : kindClass(noun);
  const town = String(business.town).trim();
  const state = stateAbbr(business.state);
  const slots = { trade: noun, town, state, aTrade: `${article(noun)} ${noun}` };
  const specialty = readSpecialty(business, siteCheck);
  let small;
  let niche;
  if (kind === 'professional') {
    // Firms that sell to companies get the company wording; a realtor or a lawyer is hired by people.
    const b2b = B2B_RE.test(noun.toLowerCase());
    small = `What's a good ${sizeWord(noun)} {trade} in {town}, {state}${b2b ? ' for a small company' : ''}?`;
    niche = specialty
      ? `Which {trade} in {town}, {state} specializes in ${specialty.phrase}?`
      : b2b
        ? 'Is there {aTrade} in {town}, {state} that works with small businesses on a budget?'
        : 'Which {trade} in {town}, {state} gives clients personal attention?';
  } else {
    small = 'Can you recommend a local, family-owned {trade} in {town}, {state}?';
    niche = specialty
      ? `Who does ${specialty.phrase} in {town} {state}?`
      : kind === 'trade'
        ? "Who's a reliable {trade} in {town} {state} for a small job?"
        : 'Is there a hidden gem {trade} in {town}, {state}?';
  }
  return [
    { id: `q${INTENTS.length + 1}`, intent: 'small', text: fill(small, slots) },
    { id: `q${INTENTS.length + 2}`, intent: 'niche', text: fill(niche, slots) },
  ];
}

/**
 * A question list as a comparable key (ids and wording, order ignored). A before/after compares only
 * scans whose keys are equal: the same searches, run again.
 */
export function questionKey(questions) {
  return (Array.isArray(questions) ? questions : []).filter((q) => q && q.id)
    .map((q) => `${q.id}|${String(q.text || '').trim().replace(/\s+/g, ' ').toLowerCase()}`).sort().join('\n');
}

/** Every question a paid-tier scan asks: the 5 of buildQuestions, then the 2 small-firm ones. */
export function paidQuestions(business, opts = {}) {
  return [...buildQuestions(business), ...smallFirmQuestions(business, opts)];
}
