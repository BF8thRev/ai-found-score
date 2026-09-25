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
  job: 'Who can {job} in {town} {state}?',
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

const TRADE_ALIASES = {
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

function fill(template, slots) {
  return template
    .replace(/\{(\w+)\}/g, (_, k) => (slots[k] != null ? String(slots[k]) : ''))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,?])/g, '$1')
    .trim();
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * Build the 5 questions for a business.
 * @param {{trade:string, town:string, state?:string, zip?:string, nearbyTown?:string}} business
 * @returns {{id:string, intent:string, text:string}[]}
 */
export function buildQuestions(business) {
  if (!business || !business.town) throw new Error('buildQuestions: business.town is required');
  const key = normalizeTrade(business.trade);
  const set = key ? TRADES[key] : { trade: String(business.trade || 'local business').trim().toLowerCase() };
  const town = String(business.town).trim();
  const near = String(business.nearbyTown || '').trim() || town;
  const state = stateAbbr(business.state);
  const zip = String(business.zip || '').trim();
  const slots = { trade: set.trade, Trade: cap(set.trade), town, near, state, zip, urgent: `${cap(set.trade)} open now`, job: `help with a ${set.trade} job` };

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
