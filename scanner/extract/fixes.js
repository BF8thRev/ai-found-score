// Fix steps: the paid ($29) part of every "What to fix" item.
//
// Deterministic and pure. Every step and every copy-paste block is a fixed template filled
// ONLY from report data (questions, answers' quotes, cited URLs) and the business's own real
// details (name, address, phone, website, and the hours/price/services facts from its website).
// A field we don't know is left out, never guessed. Steps describe what to look for on a site
// ("its 'claim this business' option or similar"), never a menu path we can't be sure of.
//
// Output shape per fix: { steps: [string], copyText: [{ label, text, format? }] }
//   format: 'code' for a code block (JSON-LD), absent for plain text.

import { normalizeTrade, TRADES, INTENTS } from '../questions.js';
import { US_STATES, stateAbbr } from '../config.js';
import { is24 } from './verify.js';

/** Google Business Profile descriptions are capped at 750 characters. */
export const GBP_DESCRIPTION_MAX = 750;

/** schema.org types for the trades we scan (all real schema.org types). Others: LocalBusiness. */
export const SCHEMA_TYPES = {
  plumbing: 'Plumber',
  hvac: 'HVACBusiness',
  electrical: 'Electrician',
  roofing: 'RoofingContractor',
  auto_repair: 'AutoRepair',
  laundromat: 'DryCleaningOrLaundry',
};

const FIELD_LABEL = { hours: 'hours', phone: 'phone number', price: 'prices', address: 'address', services: 'services' };

const clean = (v) => (v == null ? '' : String(v).trim().replace(/\s+/g, ' '));
const noEndPunct = (s) => clean(s).replace(/[.;,\s]+$/, '');
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

/**
 * The business's own details, normalized once. Only what is known; empty strings otherwise.
 * `business` is the scan's business input (parseScanRequest shape, with `facts`).
 */
export function businessDetails(business = {}) {
  const facts = business.facts || {};
  const key = normalizeTrade(business.trade);
  const tradeNoun = clean((key && TRADES[key] && TRADES[key].trade) || business.trade || '');
  const state = business.state ? stateAbbr(business.state) : '';
  const town = clean(business.town);
  const zip = clean(business.zip);
  const rawAddress = clean(business.address);
  // "1502 Deer Park Ave" → street; "1502 Deer Park Ave, North Babylon, NY 11703" → first part.
  const street = rawAddress ? clean(rawAddress.split(',')[0]) : '';
  const hasTown = town && rawAddress.toLowerCase().includes(town.toLowerCase());
  const tail = [town, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const fullAddress = rawAddress
    ? (hasTown ? rawAddress : [rawAddress, tail].filter(Boolean).join(', '))
    : '';
  const website = clean(business.website).replace(/\/+$/, '');
  return {
    name: clean(business.name),
    tradeKey: key,
    tradeNoun,
    street,
    town,
    state,
    zip,
    fullAddress,
    phone: clean(business.phone),
    website,
    websiteUrl: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : '',
    websiteHost: website.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0],
    hours: noEndPunct(facts.hours),
    price: noEndPunct(facts.price),
    services: noEndPunct(facts.services),
  };
}

/** "Name: …\nAddress: …" — the listing details, known fields only. */
export function napBlock(d) {
  return [
    d.name && `Business name: ${d.name}`,
    d.fullAddress && `Address: ${d.fullAddress}`,
    d.phone && `Phone: ${d.phone}`,
    d.website && `Website: ${d.website}`,
    d.hours && `Hours: ${d.hours}`,
    d.tradeNoun && `Category: ${d.tradeNoun}`,
  ].filter(Boolean).join('\n');
}

/**
 * A Google Business Profile description from real facts only (no phone or links: the profile
 * has its own fields for those). ≤ 750 characters, cut at a sentence.
 */
export function gbpDescription(d) {
  const where = [d.town, d.state].filter(Boolean).join(', ');
  const lead = d.name
    ? `${d.name} is ${d.tradeNoun ? `${article(d.tradeNoun)} ${d.tradeNoun}` : 'a local business'}${where ? ` in ${where}` : ''}${d.street ? ` at ${d.street}` : ''}.`
    : '';
  const parts = [
    lead,
    d.hours && `Hours: ${d.hours}.`,
    d.services && `Services: ${d.services}.`,
    d.price && `Prices: ${d.price}.`,
  ].filter(Boolean);
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > GBP_DESCRIPTION_MAX) break;
    out = next;
  }
  return out;
}

/** Fact sentences in the order that best answers each intent. */
const INTENT_FACTS = {
  best: ['services', 'hours', 'price'],
  urgent: ['hours', 'services'],
  job: ['services', 'hours', 'price'],
  trust: ['services', 'hours'],
  price: ['price', 'services'],
};
/** The fact an answer to this intent can't do without. */
const INTENT_KEY_FACT = { urgent: 'hours', job: 'services', price: 'price' };
const FACT_SENTENCE = { hours: (v) => `Hours: ${v}.`, services: (v) => `Services: ${v}.`, price: (v) => `Prices: ${v}.` };

/** A website FAQ answer to one of our questions, built from real details only. */
export function faqAnswer(d, intent) {
  const town = [d.town, d.state].filter(Boolean).join(', ');
  const where = d.fullAddress ? ` at ${d.fullAddress}` : town ? ` in ${town}` : '';
  const lead = d.name
    ? `${d.name} is ${d.tradeNoun ? `${article(d.tradeNoun)} ${d.tradeNoun}` : 'a local business'}${where}.`
    : '';
  const facts = (INTENT_FACTS[intent] || INTENT_FACTS.best).map((f) => d[f] && FACT_SENTENCE[f](d[f])).filter(Boolean);
  const call = d.phone ? `Call ${d.phone}.` : '';
  return [lead, ...facts, call].filter(Boolean).join(' ');
}

/** The fact this intent needs that the business's website facts don't state, or null. */
export function missingKeyFact(d, intent) {
  const f = INTENT_KEY_FACT[intent];
  return f && !d[f] ? f : null;
}

/**
 * True only when the owner's hours say the business itself is always open ("Open 24 Hours
 * Monday - Sunday", "24/7"): no clock times, and no "24/7 emergency line" style qualifier.
 */
export function alwaysOpen(hours) {
  const h = String(hours || '');
  if (!is24(h)) return false;
  if (/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i.test(h)) return false;
  return !/emergenc|\bline\b|\bphone\b|\bcalls?\b|\bservice\b|except|closed/i.test(h);
}

/**
 * LocalBusiness JSON-LD from real fields only. openingHours is set only when the owner's hours
 * say the business is always open (alwaysOpen: the one hours format we can convert without guessing).
 */
export function localBusinessJsonLd(d) {
  const o = { '@context': 'https://schema.org', '@type': SCHEMA_TYPES[d.tradeKey] || 'LocalBusiness' };
  if (d.name) o.name = d.name;
  const addr = { '@type': 'PostalAddress' };
  if (d.street) addr.streetAddress = d.street;
  if (d.town) addr.addressLocality = d.town;
  if (d.state) addr.addressRegion = d.state;
  if (d.zip) addr.postalCode = d.zip;
  if (d.state && US_STATES[d.state]) addr.addressCountry = 'US';
  if (Object.keys(addr).length > 1) o.address = addr;
  if (d.phone) o.telephone = d.phone;
  if (d.websiteUrl) o.url = d.websiteUrl;
  if (d.hours && alwaysOpen(d.hours)) o.openingHours = 'Mo-Su 00:00-23:59';
  if (d.price && d.price.length <= 100) o.priceRange = d.price;
  // `<` as \u003c: a name or price containing "</script>" can't end the owner's script tag early.
  return `<script type="application/ld+json">\n${JSON.stringify(o, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}

const q = (s) => `"${s}"`;

// ---------------------------------------------------------------------------
// Per-issue fixes
// ---------------------------------------------------------------------------

/** A fact the AI stated that differs from the owner's website/listing. */
export function fixFactDiffers(d, s) {
  const label = FIELD_LABEL[s.field] || s.field;
  const steps = [
    `Confirm your correct ${label}. If your ${s.sourceName} is out of date, update it first, then use that wording everywhere.`,
    `Search Google for ${q([d.name, d.town].filter(Boolean).join(' '))}. If your Business Profile appears and you manage it, edit your ${label} so it reads exactly like the text below.`,
    `Make the same change on every other listing you control (for example Yelp, Facebook, Apple Maps and Bing Places), so no site still shows the old ${label}.`,
    `Search your own website and social pages for the wording the AI used (${q(s.aiSays)}) and replace it wherever it appears.`,
  ];
  const copyText = [{ label: `Your ${label}, as your ${s.sourceName} states it`, text: s.sourceSays }];
  if (['phone', 'address', 'hours'].includes(s.field)) {
    const nap = napBlock(d);
    if (nap) copyText.push({ label: 'Your listing details, written the same way everywhere', text: nap });
  }
  return { steps, copyText };
}

/** A site the AI cited, in answers that didn't name the owner, that doesn't list the owner. */
export function fixNotListed(d, s) {
  const steps = [
    `Open the page ${s.engines} cited: ${s.url}${s.topListed ? ` (${s.topListed} is listed first there)` : ''}.`,
    `Search ${s.domain} for ${q(d.name)}. If you're already listed, use the site's "claim this business" option (or similarly named) to take control of the listing, then check every field against the details below.`,
    `If you're not listed, look for the site's "add a business" or "list your business" option and create the listing with the details below, written exactly the same way.`,
    `Choose the category closest to ${q(d.tradeNoun || 'your trade')}${d.town ? ` and the town ${d.town}` : ''}, so your listing fits pages like the one the AI cited.`,
    'Some sites review new listings before they show. Check back in a week or two and confirm yours is live.',
  ];
  const copyText = [];
  const nap = napBlock(d);
  if (nap) copyText.push({ label: `Your listing details for ${s.domain}`, text: nap });
  const desc = gbpDescription(d);
  if (desc) copyText.push({ label: 'Short description (if the site asks for one)', text: desc });
  return { steps, copyText };
}

/** A question the owner wasn't named for. */
export function fixLostQuestion(d, s) {
  const missing = missingKeyFact(d, s.intent);
  const steps = [
    `Add a short question-and-answer section to your website (an FAQ, or the bottom of your homepage) that answers ${q(s.question)} using the text below.`,
    `Edit the answer so everything in it is true today${missing ? `, and add your ${FIELD_LABEL[missing]} (your website facts we have don't state them)` : ''}. Keep your name, address and phone written exactly as they are.`,
    'Put the same facts in your Google Business Profile (description and services), so your website and your profile say the same thing.',
  ];
  if (s.intent === 'price') steps.push('If you post prices, show them as text on the page, not only inside a photo or PDF, so they can be read.');
  if (s.intent === 'urgent') steps.push('Make sure your hours match on your website, Google and every listing you control.');
  if (s.intent === 'trust') steps.push('When happy customers thank you, ask them for a Google review. Don\'t offer anything in return: Google\'s rules don\'t allow it.');
  const answer = faqAnswer(d, s.intent);
  const copyText = answer ? [{ label: 'Website FAQ: question and answer', text: `${s.question}\n${answer}` }] : [];
  return { steps, copyText };
}

// ---------------------------------------------------------------------------
// Baseline fixes: available to every business, each only when it applies.
// ---------------------------------------------------------------------------

/**
 * baselineFixes({ business, questions }) → issues (kind, severity 'low', title, description, steps, copyText).
 * Google Business Profile: always (needs a name). Website schema and FAQ: only with a website.
 */
export function baselineFixes({ business, questions = [] }) {
  const d = businessDetails(business);
  const out = [];
  if (!d.name) return out;

  const gbpSteps = [
    `Search Google for ${q([d.name, d.town].filter(Boolean).join(' '))}. If your Business Profile shows and you manage it, sign in with the Google account that owns it. If it doesn't show, or someone else manages it, go to business.google.com to create or claim it.`,
    'Check that your name, address, phone and website match the details below exactly, letter for letter.',
    d.hours ? `Set your hours to match your website: ${d.hours}.` : 'Add your opening hours, the same as on your website.',
    `Choose the primary category closest to ${q(d.tradeNoun || 'your trade')}, then add each service you offer by name.`,
    `Paste the description below into your profile's description field (it fits the ${GBP_DESCRIPTION_MAX}-character limit).`,
    'Add a few recent photos of your storefront and your work.',
  ];
  const gbpCopy = [];
  const desc = gbpDescription(d);
  if (desc) gbpCopy.push({ label: 'Google Business Profile description', text: desc });
  const nap = napBlock(d);
  if (nap) gbpCopy.push({ label: 'Your listing details', text: nap });
  out.push({
    kind: 'baseline_gbp',
    severity: 'low',
    title: 'Make your Google Business Profile complete and consistent',
    description: 'Your Google Business Profile is one of the places AI assistants and Google read your hours, phone and services. Check that it is complete and says exactly what your website says.',
    steps: gbpSteps,
    copyText: gbpCopy,
  });

  if (!d.website) return out;

  out.push({
    kind: 'baseline_schema',
    severity: 'low',
    title: 'Add or check LocalBusiness schema on your website',
    description: 'Schema is a small block of code that states your name, address, phone and hours in a format search engines and AI tools can read directly. We can\'t see whether your site already has it, so check first.',
    steps: [
      `Test your homepage (${d.website}) in Google's Rich Results Test (search.google.com/test/rich-results) or the Schema Markup Validator (validator.schema.org).`,
      `If it already shows a LocalBusiness item (or ${SCHEMA_TYPES[d.tradeKey] || 'a more specific business type'}), compare it with the code below and correct anything that differs.`,
      'If it shows none, add the code below to your homepage\'s <head> section. Most site builders have a "custom code" or "header code" setting; if someone manages your site, send them this block.',
      'Run the test again and confirm it reads your name, address and phone.',
    ],
    copyText: [{ label: `${SCHEMA_TYPES[d.tradeKey] || 'LocalBusiness'} schema (JSON-LD)`, text: localBusinessJsonLd(d), format: 'code' }],
  });

  const qs = questions.filter((x) => x && x.text);
  if (qs.length) {
    const block = qs.map((x) => `${x.text}\n${faqAnswer(d, INTENTS.includes(x.intent) ? x.intent : 'best')}`).join('\n\n');
    const missing = [...new Set(qs.map((x) => missingKeyFact(d, x.intent)).filter(Boolean))].map((f) => FIELD_LABEL[f]);
    out.push({
      kind: 'baseline_faq',
      severity: 'low',
      title: `Answer the ${qs.length} ${qs.length === 1 ? 'question' : 'questions'} we asked AI on your website`,
      description: 'These are the searches we ran for your report. A page that answers them in plain words, with your real details, gives anyone reading your site (and any AI tool) a direct answer.',
      steps: [
        'Add a "Questions" section to your website: a new page, or the bottom of your homepage.',
        `Use the questions and answers below. Edit each answer so it is true and specific to you before you publish${missing.length ? `, and add your ${missing.join(' and ')}, which your website facts we have don't state` : ''}.`,
        'Keep your name, address and phone written exactly the same way as on your Google Business Profile.',
      ],
      copyText: [{ label: 'Website questions and answers', text: block }],
    });
  }
  return out;
}
