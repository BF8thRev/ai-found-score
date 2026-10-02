// src/lib/fix-kit.js — the Fix Kit: ready-to-install files, built for the owner from their report.
//
// Comes with the $49 AI Visibility Audit ('xray') and the $499 Be the Answer ('be_the_answer'); the retired
// $149 standalone Fix Kit ('fix_kit') still opens it for anyone who bought it. Fully automatic: when the
// owner opens /fix-kit/<token> (public/fix-kit.html) the kit is ALREADY BUILT from what we know
// (prefillDetails). They check the key details, fill in what only they know, tick "I own or manage this
// business" and download a zip. Nobody at AI Found Score touches it. Routes: src/lib/fix-kit-route.js.
//
//   prefillDetails(report)          → starting details from the stored report: the business the scan was run
//                                     for, facts read off their website (siteCheck.onSite, meta description),
//                                     then their Google listing
//   validateDetails(input)          → { ok, details, errors: [{ field, message }] }: trimmed, capped, checked.
//                                     A phone is not required: a kit without one flags it and leaves it out.
//   buildKit(details, report, opts) → { jobs, done, faq, missing, files }: only the jobs that help THIS
//                                     business, in order (siteStatus: no robots.txt when AI can already read
//                                     the site, no llms.txt when it has one, business code optional when it
//                                     already has some), the FAQ (shared/faq.js) as faq-page.html + .txt,
//                                     google-business-profile.txt, review-qr.svg (with a review link), README.txt
//                                     Site builder known (siteCheck.platform, shared/platforms.js): each website
//                                     job also says where it goes on that builder, with its own guide, and a
//                                     job the builder can't take (or does itself) is marked optional and says so
//   zipFiles(files, opts)           → Uint8Array: a STORE-only (uncompressed) ZIP, CRC-32, no dependencies
//
// Truthful by construction, like scanner/extract/fixes.js: every file is a fixed template filled ONLY
// with what we read or the owner gave. No AI call, nothing guessed. A detail we don't have is left out
// (or, in a text file meant for the owner, a clearly marked [Missing: …]); code never holds a placeholder.
// Everything here is pure (no fetch, no Node APIs), so it runs in the Worker and in node --test.

import { AI_BOTS, formatPhone } from '../../scanner/owner-checks.js';
import { normalizeTrade, TRADES, caseKind, buildQuestions, kindClass } from '../../scanner/questions.js';
import { US_STATES } from '../../scanner/config.js';
import { SCHEMA_TYPES, GBP_DESCRIPTION_MAX, alwaysOpen, siteSpelling } from '../../scanner/extract/fixes.js';
import { phoneKey, squashName } from '../../scanner/extract/normalize.js';
import { qrSvg } from './vendor/qrcode.js';
import { buildFaq, faqPlainText, faqJsonLdScript, ownWords, aboutTheBusiness, ATTRIBUTES } from '../../shared/faq.js';
import { platformFor, platformJob, platformStep, guideLinks } from '../../shared/platforms.js';

/** Tiers whose buyers get the Fix Kit (tier keys from TIER_BY_CENTS in src/lib/stripe.js). */
export const FIX_KIT_TIERS = Object.freeze(['xray', 'fix_kit', 'be_the_answer']);

export const LIMITS = Object.freeze({
  name: 120, trade: 60, phone: 40, street: 160, town: 60, zip: 10, website: 300, hours: 300,
  description: GBP_DESCRIPTION_MAX, url: 500, listItem: 80, listMax: 15, price: 160, faqFact: 240,
});

/** schema.org type per trade: fixes.js's specific types, the other home trades as HomeAndConstructionBusiness. */
export const FIX_KIT_SCHEMA_TYPES = Object.freeze({
  ...SCHEMA_TYPES,
  landscaping: 'HomeAndConstructionBusiness',
  cleaning: 'HomeAndConstructionBusiness',
});

/** Google Business Profile categories to suggest (real GBP category names). First = primary. */
export const GBP_CATEGORIES = Object.freeze({
  plumbing: ['Plumber'],
  hvac: ['HVAC contractor', 'Air conditioning contractor', 'Heating contractor'],
  electrical: ['Electrician'],
  roofing: ['Roofing contractor'],
  landscaping: ['Landscaper', 'Lawn care service'],
  cleaning: ['House cleaning service'],
  auto_repair: ['Auto repair shop', 'Mechanic'],
  laundromat: ['Laundromat'],
});

/**
 * Offices (agencies, firms, consultants): Google Business Profile categories by the words in the kind of
 * business, real Google category names, first = primary. Checked in order; the first match wins.
 */
const OFFICE_CATEGORIES = [
  [/\bpr\b|public relations|communications/i, ['Public relations firm', 'Marketing agency', 'Consultant']],
  [/attorney|lawyer|\blaw\b|legal/i, ['Law firm', 'Lawyer']],
  [/software|\bsaas\b|\bit\b|\bmsp\b/i, ['Software company', 'Information technology company']],
  [/\bseo\b|\bppc\b|marketing|advertis|\bad\b agency|branding|creative agency|digital agency/i, ['Marketing agency', 'Advertising agency', 'Internet marketing service']],
  [/apprais/i, ['Real estate appraiser']],
  [/financial|\badvisor|\badviser|wealth/i, ['Financial planner', 'Financial consultant']],
  [/\bcpa\b|\baccountan|\baccounting|bookkeep|payroll|\btax\b/i, ['Accountant', 'Tax preparation service', 'Bookkeeping service']],
  [/insurance/i, ['Insurance agency']],
  [/real estate|realt/i, ['Real estate agency']],
  [/mortgage|\bloan/i, ['Mortgage broker', 'Mortgage lender']],
  [/staffing|recruit/i, ['Employment agency']],
  [/architect/i, ['Architect']],
  [/engineer/i, ['Engineering consultant']],
  [/notary/i, ['Notary public']],
  [/consult/i, ['Business management consultant', 'Consultant']],
];

/** Starting services per trade when the website listed none. The owner edits them before confirming. */
export const DEFAULT_SERVICES = Object.freeze({
  plumbing: ['Plumbing repair', 'Drain cleaning'],
  hvac: ['Heating repair', 'Air conditioning repair'],
  electrical: ['Electrical repair'],
  roofing: ['Roof repair'],
  landscaping: ['Lawn care'],
  cleaning: ['House cleaning'],
  auto_repair: ['Auto repair'],
  laundromat: ['Self-service laundry'],
});

const clean = (v) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
// "a PR agency", "an HVAC company": an acronym takes the article of its first letter's sound.
const article = (w) => {
  const s = String(w || '');
  if (/^[A-Z]{2,}\b/.test(s)) return /^[AEFHILMNORSX]/.test(s) ? 'an' : 'a';
  return /^[aeiou]/i.test(s) ? 'an' : 'a';
};
const joinAnd = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Text for inside an HTML comment: escaped, and no "--" that could end it. */
const inComment = (s) => escHtml(s).replace(/-{2,}/g, '-');
/** JSON for inside a <script> tag: every `<` escaped (backslash-u003c) so a value can't close the tag early. */
const ldJson = (o) => JSON.stringify(o, null, 2).replace(/</g, '\\u003c');

/** The scanner's trade key for a trade as typed ("plumbing", "plumber") or as its noun ("house cleaning service"). */
export function tradeKey(trade) {
  const t = clean(trade).toLowerCase();
  return normalizeTrade(t) || Object.keys(TRADES).find((k) => TRADES[k].trade === t) || null;
}

/** The noun for the trade ("plumber"), from the scanner's trade list, else the text as given. */
export function tradeNoun(trade) {
  const key = tradeKey(trade);
  return clean((key && TRADES[key].trade) || trade || '').toLowerCase();
}

/** "Plumbing repair, drain cleaning; water heaters" (or one per line, or an array) → a clean list, no repeats. */
export function splitList(v) {
  const raw = Array.isArray(v) ? v : String(v || '').split(/\r?\n|[,;]/);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let s = clean(item).replace(/^[-*•]\s*/, '').replace(/[.]+$/, '');
    if (s) s = s[0].toUpperCase() + s.slice(1);
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out;
}

const firstPart = (address) => clean(String(address || '').split(',')[0]);
const zipIn = (address) => (/\b(\d{5})(?:-\d{4})?\b(?!\s+[A-Za-z])/.exec(String(address || '')) || [])[1] || '';

// ---------------------------------------------------------------------------
// prefill
// ---------------------------------------------------------------------------

/**
 * The details form's starting values, from a stored report (v2, or v1's business block).
 * Priority per field: what the owner gave the scan, then their website, then their Google listing.
 */
export function prefillDetails(report) {
  const r = report || {};
  const b = r.business || {};
  const facts = b.facts || {};
  const onSite = (r.siteCheck && r.siteCheck.onSite) || {};
  const google = (Array.isArray(r.listings) ? r.listings : []).find((l) => l && l.platform === 'Google') || null;
  const g = (google && google.fields) || {};
  const key = tradeKey(b.trade);
  const noun = tradeNoun(b.trade);
  // The website's spelling when it differs only in spacing and the site always writes it ("PR73", not "PR 73").
  const spelling = siteSpelling(r);
  const name = clean((spelling && spelling.use) || b.name || g.name);
  const town = clean(b.town || b.city);
  const state = clean(b.state).toUpperCase();
  const address = b.address || onSite.address || g.address || '';
  const services = splitList(facts.services);
  const where = [town, state].filter(Boolean).join(', ');
  const lead = name ? `${name} is ${noun ? `${article(caseKind(noun))} ${caseKind(noun)}` : 'a local business'}${where ? ` in ${where}` : ''}.` : '';
  // Their own homepage description after our one line, when the site has one (never the H1: a slogan).
  const words = lead ? ownWords({ description: lead }, { siteCheck: { meta: { description: (r.siteCheck && r.siteCheck.meta && r.siteCheck.meta.description) || '' } } }, lead) : '';
  return {
    name,
    trade: noun,
    phone: clean(b.phone || onSite.phone || g.phone),
    street: firstPart(address),
    town,
    state,
    zip: clean(b.zip) || zipIn(address),
    website: clean(b.website),
    hours: clean(facts.hours || g.hours),
    services: services.length ? services.slice(0, LIMITS.listMax) : [...(DEFAULT_SERVICES[key] || [])],
    serviceTowns: town ? [town] : [],
    price: clean(facts.price).slice(0, LIMITS.price),
    description: `${lead}${words ? ` ${words}` : ''}`.slice(0, LIMITS.description),
    googleMapsUrl: google && typeof google.url === 'string' && /^https:\/\//i.test(google.url) ? google.url : '',
    googleReviewUrl: '',
    faqFacts: {},
  };
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

/** "example.com/" → "https://example.com"; null when it isn't a web address. */
export function normalizeUrl(v, { httpsOnly = false } = {}) {
  const s = clean(v);
  if (!s || /\s/.test(s)) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== 'https:' && (httpsOnly || u.protocol !== 'http:')) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname) || u.username || u.password) return null;
  return u.toString().replace(/\/$/, '');
}

/**
 * Check and tidy the form. → { ok, details, errors: [{ field, message }] }.
 * Required: name, town, state. The phone is checked when given; a kit without one flags it as missing.
 * Lists: at most 15 items of 80 characters. faqFacts: the owner's sentence per FAQ detail type.
 */
export function validateDetails(input) {
  const i = input && typeof input === 'object' ? input : {};
  const errors = [];
  const err = (field, message) => errors.push({ field, message });
  const text = (field) => {
    const s = clean(i[field]);
    if (s.length > LIMITS[field]) err(field, `Keep this under ${LIMITS[field]} characters.`);
    return s.slice(0, LIMITS[field]);
  };
  const d = {
    name: text('name'),
    trade: text('trade'),
    phone: text('phone'),
    street: text('street'),
    town: text('town'),
    state: clean(i.state).toUpperCase(),
    zip: clean(i.zip),
    website: '',
    hours: text('hours'),
    price: text('price'),
    services: [],
    serviceTowns: [],
    description: text('description'),
    googleMapsUrl: '',
    googleReviewUrl: '',
    faqFacts: {},
  };
  if (!d.name) err('name', 'Enter your business name.');
  // A phone is not required: without one it is flagged "Missing" on the kit page and left out of the files.
  if (!d.phone) { /* left out */ } else if (!phoneKey(d.phone) || d.phone.replace(/\D/g, '').length > 11) err('phone', 'Enter a 10-digit phone number.');
  else d.phone = formatPhone(d.phone);
  if (!d.town) err('town', 'Enter your town.');
  if (!d.state) err('state', 'Enter your state.');
  else if (!Object.hasOwn(US_STATES, d.state)) err('state', 'Use the 2-letter state code, like NY.');
  if (d.zip && !/^\d{5}(-\d{4})?$/.test(d.zip)) err('zip', 'ZIP must be 5 digits.');

  const website = clean(i.website);
  if (website) {
    const u = normalizeUrl(website);
    if (!u || u.length > LIMITS.website) err('website', 'Enter your website address, like yourbusiness.com.');
    else d.website = u;
  }
  for (const field of ['googleMapsUrl', 'googleReviewUrl']) {
    const raw = clean(i[field]);
    if (!raw) continue;
    const u = normalizeUrl(raw, { httpsOnly: true });
    if (!u || u.length > LIMITS.url) err(field, 'Paste the full link, starting with https://');
    else d[field] = u;
  }
  for (const [field, label] of [['services', 'services'], ['serviceTowns', 'towns']]) {
    const list = splitList(i[field]);
    if (list.length > LIMITS.listMax) err(field, `List up to ${LIMITS.listMax} ${label}.`);
    if (list.some((s) => s.length > LIMITS.listItem)) err(field, `Keep each one under ${LIMITS.listItem} characters.`);
    d[field] = list.slice(0, LIMITS.listMax).map((s) => s.slice(0, LIMITS.listItem));
  }
  if (!d.serviceTowns.length && d.town) d.serviceTowns = [d.town];
  // The owner's own sentences for the FAQ's [brackets], one per detail type.
  const facts = i.faqFacts && typeof i.faqFacts === 'object' && !Array.isArray(i.faqFacts) ? i.faqFacts : {};
  for (const { type } of ATTRIBUTES) {
    const v = clean(facts[type]).replace(/[[\]]/g, '');
    if (!v) continue;
    if (v.length > LIMITS.faqFact) err(`faqFacts.${type}`, `Keep this under ${LIMITS.faqFact} characters.`);
    d.faqFacts[type] = v.slice(0, LIMITS.faqFact);
  }
  if (!d.description && d.name) {
    const noun = tradeNoun(d.trade);
    d.description = `${d.name} is ${noun ? `${article(caseKind(noun))} ${caseKind(noun)}` : 'a local business'} in ${[d.town, d.state].filter(Boolean).join(', ')}.`;
  }
  return { ok: errors.length === 0, details: d, errors };
}

// ---------------------------------------------------------------------------
// opening hours → schema.org openingHours (only when every part reads cleanly)
// ---------------------------------------------------------------------------
const DAY = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' };
const DAY_RE = '(mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?';
const TIME_RE = '(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?';
const DASH = '\\s*(?:-|–|—|to|through|thru)\\s*';
const SEG_RE = new RegExp(`^${DAY_RE}(?:${DASH}${DAY_RE})?\\s*:?\\s*(?:${TIME_RE}${DASH}${TIME_RE}|(closed)|(24 hours|open 24 hours))$`, 'i');

function toClock(h, m, ampm, isClose) {
  let hour = Number(h);
  const min = m == null ? 0 : Number(m);
  if (min > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    const pm = /^p/i.test(ampm);
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
    if (isClose && hour === 0 && min === 0) return '23:59';
  } else if (m == null || hour > 23) {
    return null; // "8-6" could mean anything: only 24-hour times with minutes count without am/pm
  }
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Free-text hours → schema.org openingHours strings, e.g.
 * "Mon–Fri 8am–6pm, Sat 9am–2pm, Sun closed" → ["Mo-Fr 08:00-18:00", "Sa 09:00-14:00"].
 * Returns null unless every part is read without guessing (then the schema leaves hours out).
 */
export function parseOpeningHours(hours) {
  const h = clean(hours);
  if (!h) return null;
  if (alwaysOpen(h)) return ['Mo-Su 00:00-23:59'];
  const out = [];
  for (const part of h.split(/[,;]|\n/).map((s) => s.trim()).filter(Boolean)) {
    const m = SEG_RE.exec(part);
    if (!m) return null;
    const from = DAY[m[1].slice(0, 3).toLowerCase()];
    const to = m[2] ? DAY[m[2].slice(0, 3).toLowerCase()] : null;
    const days = to && to !== from ? `${from}-${to}` : from;
    if (m[9]) continue; // closed
    if (m[10]) { out.push(`${days} 00:00-23:59`); continue; }
    // "9-5pm": the am/pm on the closing time alone is not enough to be sure of the opening time.
    if (!!m[5] !== !!m[8]) return null;
    const open = toClock(m[3], m[4], m[5], false);
    const close = toClock(m[6], m[7], m[8], true);
    if (!open || !close || close <= open) return null;
    out.push(`${days} ${open}-${close}`);
  }
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// the files
// ---------------------------------------------------------------------------
const where = (d) => [d.town, d.state].filter(Boolean).join(', ');
const fullAddress = (d) => [d.street, d.town, [d.state, d.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const telHref = (phone) => { const k = phoneKey(phone); return k ? `tel:+1${k}` : ''; };
const townLabel = (d, t) => (d.state && !/,\s*[A-Z]{2}$/.test(t) ? `${t}, ${d.state}` : t);

/** "Harborview Plumbing is a plumber in Massapequa, NY." */
/** "Massapequa, Seaford and Wantagh, NY" (one state), else each town with its own state. */
function townsText(d) {
  const plain = d.serviceTowns.every((t) => !/,\s*[A-Z]{2}$/.test(t));
  return plain && d.state ? `${joinAnd(d.serviceTowns)}, ${d.state}` : joinAnd(d.serviceTowns.map((t) => townLabel(d, t)));
}

function leadSentence(d) {
  const noun = caseKind(tradeNoun(d.trade));
  const others = d.serviceTowns.filter((t) => t.toLowerCase() !== d.town.toLowerCase());
  return `${d.name} is ${noun ? `${article(noun)} ${noun}` : 'a local business'} in ${where(d)}`
    + `${others.length ? `, serving ${joinAnd(others)}` : ''}.`;
}

export function robotsTxt(d, { blocked = [] } = {}) {
  const who = blocked.map((b) => b && (b.who || b.agent)).filter(Boolean);
  const lines = [
    `# robots.txt${d.website ? ` for ${hostOf(d.website)}` : ''}, from your AI Found Score Fix Kit.`,
    '# It lets the crawlers that AI assistants and search engines use read your website.',
    ...(who.length ? [`# Your robots.txt blocks ${joinAnd(who)} today. These lines let them back in.`] : []),
    '#',
    '# Already have a robots.txt? Do not replace it. Add the lines below to it, and delete any',
    '# "Disallow: /" line under these crawler names. Keep the rest of your file as it is.',
    '',
  ];
  for (const b of AI_BOTS) lines.push(`# ${b.who}`, `User-agent: ${b.agent}`, 'Allow: /', '');
  if (d.website) {
    lines.push('# Your sitemap. Change this line if your sitemap lives at a different address.');
    lines.push(`Sitemap: ${new URL(d.website).origin}/sitemap.xml`, '');
  }
  return lines.join('\n');
}

export function llmsTxt(d) {
  const out = [`# ${d.name}`, '', `> ${d.description || leadSentence(d)}`, ''];
  if (d.services.length) out.push('## Services', '', ...d.services.map((s) => `- ${s}`), '');
  out.push('## Service area', '', ...d.serviceTowns.map((t) => `- ${townLabel(d, t)}`), '');
  out.push('## Contact', '');
  const tel = telHref(d.phone);
  if (d.phone) out.push(tel ? `- [Phone: ${d.phone}](${tel})` : `- Phone: ${d.phone}`);
  if (d.street) out.push(`- Address: ${fullAddress(d)}`);
  if (d.website) out.push(`- [Website](${d.website})`);
  if (d.hours) out.push(`- Hours: ${d.hours}`);
  if (d.googleMapsUrl) out.push(`- [Google Maps listing](${d.googleMapsUrl})`);
  if (d.googleReviewUrl) out.push(`- [Google reviews](${d.googleReviewUrl})`);
  return out.join('\n') + '\n';
}

/** The LocalBusiness JSON-LD object (known fields only: a missing phone is left out, never a placeholder). */
export function localBusinessSchema(d) {
  const o = { '@context': 'https://schema.org', '@type': FIX_KIT_SCHEMA_TYPES[tradeKey(d.trade)] || 'LocalBusiness', name: d.name };
  if (d.description) o.description = d.description;
  if (d.phone) o.telephone = d.phone;
  const addr = { '@type': 'PostalAddress' };
  if (d.street) addr.streetAddress = d.street;
  addr.addressLocality = d.town;
  addr.addressRegion = d.state;
  if (d.zip) addr.postalCode = d.zip;
  addr.addressCountry = 'US';
  o.address = addr;
  if (d.website) o.url = d.website;
  o.areaServed = d.serviceTowns.map((t) => ({ '@type': 'City', name: townLabel(d, t) }));
  const hours = parseOpeningHours(d.hours);
  if (hours) o.openingHours = hours.length === 1 ? hours[0] : hours;
  const sameAs = [d.googleMapsUrl].filter(Boolean);
  if (sameAs.length) o.sameAs = sameAs;
  return o;
}

export function schemaHtml(d) {
  return [
    `<!-- ${inComment(d.name)}: business details for Google and AI assistants (schema.org ${localBusinessSchema(d)['@type']}).`,
    '     Paste all of this into the <head> section of your home page.',
    '     If your site already has LocalBusiness code, replace it instead of adding a second copy.',
    ...(d.phone ? [] : ['     Your phone number is not in it yet: add it on your Fix Kit page and download the kit again.']),
    '     Check it afterwards at https://search.google.com/test/rich-results -->',
    '<script type="application/ld+json">',
    ldJson(localBusinessSchema(d)),
    '</script>',
    '',
  ].join('\n');
}

/**
 * The FAQ (shared/faq.js buildFaq): the report's own questions, answered in the style AI quotes.
 * A report without questions (an old one) uses the scanner's questions for the trade and town.
 */
export function kitFaq(d, report) {
  const r = report || {};
  const has = Array.isArray(r.questions) && r.questions.some((q) => q && clean(q.text));
  const qs = has || !d.town ? r.questions : buildQuestions({ trade: d.trade, town: d.town, state: d.state, zip: d.zip });
  return buildFaq({ ...r, questions: qs || [] }, d);
}

/** The FAQ the report's action plan shows: the same one the kit is built with before the owner edits anything. */
export function reportFaq(report) {
  return kitFaq(validateDetails(prefillDetails(report)).details, report);
}

export function faqItems(d, report) {
  return kitFaq(d, report).items;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function faqHtml(d, report, faq = kitFaq(d, report)) {
  const open = faq.items.filter((i) => !i.complete).length;
  return [
    `<!-- ${inComment(d.name)}: a Questions section AI assistants can quote. Paste all of it into a page on your`,
    '     site called "FAQ" or "Questions", or at the bottom of your home page.',
    ...(open
      ? [
        `     ${plural(open, 'answer still has', 'answers still have')} a part in [brackets]. Fill it in on your Fix Kit page and download`,
        '     again, or replace it here with something true and delete the brackets. Until then, the code at',
        '     the bottom leaves those answers out, so it never says anything the page does not.',
      ]
      : ['     The code at the bottom says exactly what the questions and answers say. If you change an answer, change it there too.']),
    ' -->',
    '<section class="faq" id="faq">',
    '  <h2>Frequently asked questions</h2>',
    ...faq.items.flatMap((it) => [
      ...(it.complete ? [] : ['  <!-- Fill in the [bracket] below before this goes live. -->']),
      '  <div class="faq-item">',
      `    <h3>${escHtml(it.question)}</h3>`,
      `    <p>${escHtml(it.answer)}</p>`,
      '  </div>',
    ]),
    '</section>',
    faqJsonLdScript(faq.items),
    '',
  ].join('\n');
}

/** The same questions and answers as plain text, for a Wix, Squarespace or WordPress text block. */
export function faqTxt(d, report, faq = kitFaq(d, report)) {
  const open = faq.items.filter((i) => !i.complete).length;
  return [
    `QUESTIONS AND ANSWERS: ${d.name}`,
    '',
    'Paste these into a text block on a page called "FAQ" or "Questions" (Wix, Squarespace, WordPress, any site builder).',
    'Make each question a heading if your site builder lets you.',
    ...(open ? [`${plural(open, 'answer has', 'answers have')} a part in [brackets]: replace it with something true and delete the brackets before you publish.`] : []),
    'Then ask whoever runs your website to add the code from faq-page.html, so AI reads the same answers.',
    '',
    faqPlainText(faq.items),
    '',
  ].join('\n');
}

/** A GBP description: the owner's description, then services and towns while they fit in 750. */
export function gbpDescriptionText(d) {
  const parts = [
    aboutTheBusiness(d.description) || leadSentence(d),
    d.services.length ? `Services: ${joinAnd(d.services)}.` : '',
    d.serviceTowns.length ? `We serve ${townsText(d)}.` : '',
  ].filter(Boolean);
  let out = '';
  for (const p of parts) {
    const next = out ? `${out} ${p}` : p;
    if (next.length > GBP_DESCRIPTION_MAX) break;
    out = next;
  }
  return out || parts[0].slice(0, GBP_DESCRIPTION_MAX);
}

/** Google Business Profile categories for this business: a trade's list, an office's by its words, else []. */
export function gbpCategories(d) {
  const key = tradeKey(d.trade);
  if (key && GBP_CATEGORIES[key]) return [...GBP_CATEGORIES[key]];
  const kind = clean(d.trade);
  const hit = kind && OFFICE_CATEGORIES.find(([re]) => re.test(kind));
  return hit ? [...hit[1]] : [];
}

export function gbpTxt(d) {
  const cats = gbpCategories(d);
  const kind = caseKind(clean(d.trade));
  const desc = gbpDescriptionText(d);
  const out = [
    `GOOGLE BUSINESS PROFILE: ${d.name}`,
    '',
    'Sign in at business.google.com and choose to edit your profile.',
    'Copy each part below into the box with the same name. Leave anything else as it is unless it is wrong.',
    '',
    'BUSINESS NAME',
    d.name,
    '(Use your real business name only. Adding towns or services to the name breaks Google\'s rules.)',
    '',
    'PRIMARY CATEGORY (our suggestion)',
    cats[0] || (kind ? `Type "${kind}" into the category box and pick the closest match Google offers.` : 'Pick the category that best matches your main work.'),
    ...(cats[0] ? ['(Google words its categories its own way: if you don\'t see this exact name, pick the closest one.)'] : []),
    '',
  ];
  if (cats.length > 1) {
    out.push('OTHER CATEGORIES TO CONSIDER (add only the ones that match work you do)', ...cats.slice(1).map((c) => `- ${c}`), '');
  }
  out.push(`DESCRIPTION (${desc.length} of ${GBP_DESCRIPTION_MAX} characters)`, desc, '');
  if (d.services.length) out.push('SERVICES', ...d.services.map((s) => `- ${s}`), '');
  out.push('SERVICE AREAS', ...d.serviceTowns.map((t) => `- ${townLabel(d, t)}`), '');
  out.push('PHONE', d.phone || '[Missing: add your phone number here and on your Fix Kit page]', '');
  if (d.street) out.push('ADDRESS', fullAddress(d), '');
  if (d.website) out.push('WEBSITE', d.website, '');
  if (d.hours) out.push('HOURS (enter them in the Hours section, day by day)', d.hours, '');
  return out.join('\n');
}

/** "Harborview Plumbing & Heating" → "harborview-plumbing-heating". */
export function slugify(s) {
  return clean(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'business';
}

export const zipName = (d) => `${slugify(d.name)}-fix-kit.zip`;

// ---------------------------------------------------------------------------
// the kit: only the jobs that help this business, in order
// ---------------------------------------------------------------------------

/** schema.org types that say nothing about the business itself (a page, a search box, an article). */
const PAGE_SCHEMA_RE = /^(WebSite|WebPage|BreadcrumbList|FAQPage|ImageObject|SiteNavigationElement|SearchAction|Article|BlogPosting|NewsArticle|Person|ItemList|ListItem|CollectionPage|AboutPage|ContactPage|Offer|Product|Review|AggregateRating|VideoObject|Thing|WPHeader|WPFooter|ReadAction|EntryPoint)$/;

/**
 * What the report's website check found (report.siteCheck): whether AI is blocked, and which of the
 * kit's website files the site already has. `checked` false (no check, or the site didn't load): we
 * can't tell, so nothing is skipped.
 */
export function siteStatus(report) {
  const sc = report && report.siteCheck;
  const checked = !!(sc && typeof sc === 'object' && sc.reachable === true);
  const robots = (checked && sc.robots) || {};
  const types = checked && sc.schema && sc.schema.found && Array.isArray(sc.schema.types) ? sc.schema.types.filter((t) => typeof t === 'string') : [];
  return {
    checked,
    robotsFound: robots.found === true,
    blocked: Array.isArray(robots.blocked) ? robots.blocked.filter(Boolean) : [],
    businessSchema: types.filter((t) => !PAGE_SCHEMA_RE.test(t)),
    llmsTxt: checked && sc.llmsTxt === true,
    faqSchema: checked && sc.faqSchema === true,
  };
}

/** Details the files need that we don't have: flagged "Missing — add it" on the kit page, left out of the files. */
export function missingDetails(d) {
  const out = [];
  if (!d.phone) out.push({ field: 'phone', label: 'Phone number', note: 'We don’t have it: it wasn’t on your website or Google listing where we looked. It’s left out of your files until you add it.' });
  if (!d.website) out.push({ field: 'website', label: 'Website', note: 'Add it so your files can point people to your site.' });
  if (!d.services.length) out.push({ field: 'services', label: 'Services', note: 'We couldn’t read them off your website. List the work you do so AI can match you to it.' });
  return out;
}

/**
 * Details we have but the owner should look at before the kit goes out → [{ field, label, note }]:
 * the name written two ways (the website's spelling vs the report request's), while the kit still uses
 * one of the two. Shown on the kit page's "Check these details" list and in README.txt.
 */
export function detailNotes(d, report) {
  const out = [];
  const sp = siteSpelling(report);
  if (sp && d && d.name && squashName(d.name) === squashName(sp.typed)) {
    out.push({
      field: 'name', label: 'Business name',
      note: `Your website writes “${sp.site}” and your report request said “${sp.typed}” — pick one and use it everywhere. ${sp.consistent && d.name === sp.site ? `We used “${sp.site}”, as your website does.` : `These files say “${d.name}”.`} If you use the other one, change it on your Fix Kit page.`,
    });
  }
  return out;
}

/** Two short messages that ask a customer for a Google review, and what Google allows. Text only. */
export function reviewsTxt(d) {
  const office = kindClass(d.trade) === 'professional';
  const who = office ? 'client' : 'customer';
  const link = d.googleReviewUrl || '[Missing: your Google review link. In your Google Business Profile look for "Ask for reviews" (Google may word it differently), copy the link, and add it on your Fix Kit page.]';
  return [
    `ASK FOR REVIEWS: ${d.name}`,
    '',
    `Reviews are public, and AI assistants and Google can read them. Ask every ${who} ${office ? 'when a project wraps up' : 'after the job is done'}, while it is fresh.`,
    'Google does not allow paying for reviews or offering a reward for them, so just ask. Only text people who have agreed to be messaged.',
    '',
    'TEXT MESSAGE',
    `Hi [first name], thank you for choosing ${d.name}. If you have a minute, a short Google review helps other people find us: ${link}`,
    '',
    'EMAIL',
    'Subject: How did we do?',
    '',
    'Hi [first name],',
    '',
    `Thank you for working with ${d.name}. If you were happy with the work, would you leave us a short review on Google? It takes about a minute: ${link}`,
    '',
    'Thank you,',
    '[Your name]',
    d.name,
    ...(d.googleReviewUrl ? ['', 'Print review-qr.svg on invoices, receipts or a card you leave behind. Scan it with your own phone first to check it opens the right page.'] : []),
    '',
  ].join('\n');
}

/** "https://www.pr73.com" or "your website address": where a file should show up. */
const siteOrigin = (d) => { try { return d.website ? new URL(d.website).origin : ''; } catch { return ''; } };

/**
 * check-it-worked.txt: how to tell each file is live, what to expect, and how to see whether AI changed.
 * It promises nothing about what AI will say. The free re-check 30 days after the audit asks the same questions again.
 */
export function checkTxt(d, report, jobs = [], { token = '', origin = 'https://aifoundscore.com' } = {}) {
  const site = siteOrigin(d);
  const at = (path) => (site ? `${site}${path}` : `your website address followed by ${path}`);
  // A job the kit says to skip (the builder can't take it, or makes it itself) has nothing to check.
  const ids = new Set(jobs.filter((j) => !j.skip).map((j) => j.id));
  const steps = [];
  if (ids.has('robots')) steps.push(`robots.txt: open ${at('/robots.txt')}. You should see lines that start with "User-agent:" for the AI crawlers.`);
  if (ids.has('faq')) steps.push('Questions page: open your FAQ page and read it through. Then paste its address into https://validator.schema.org and press Run test. It should list FAQPage with no errors. Only the answers with no [bracket] left are in the code. (Google shows FAQ boxes in search only for some sites, so do not expect one.)');
  if (ids.has('schema')) steps.push('Business code: paste your home page address into the same test. It should list your business type with your name and address and no errors. If it finds nothing, the code is not on the page yet.');
  if (ids.has('llms')) steps.push(`llms.txt: open ${at('/llms.txt')}. You should see your business name at the top.`);
  if (ids.has('google')) steps.push('Google profile: search Google for your business name. A new description or category can take a few days to show.');
  if (ids.has('qr')) steps.push(d.googleReviewUrl ? 'Review link: scan the QR code with your phone, or send yourself the text message from ask-for-reviews.txt. It should open your Google review page.' : 'Review link: add your Google review link on your Fix Kit page and download again, then send yourself the text message from ask-for-reviews.txt. It should open your Google review page.');
  const qs = (Array.isArray(report && report.questions) ? report.questions : []).map((q) => clean(q && q.text)).filter(Boolean).slice(0, 7);
  return [
    `CHECK IT WORKED: ${d.name}`,
    '',
    'WHAT TO EXPECT',
    '- These files give AI assistants and Google correct facts about your business to read. We cannot promise any assistant will name you: each one decides for itself, and its answers change from one asking to the next.',
    '- Changes show up at different speeds. Google can take a few days. AI assistants refresh on their own schedule, so look again in about a month.',
    '- Your next scan asks AI the same questions again and shows what changed. The audit includes a free re-check 30 days after you buy.',
    '',
    'STEP 1: CHECK EACH FILE IS LIVE (under half an hour, once your web person is done)',
    ...(steps.length ? steps.map((x, n) => `${n + 1}. ${x}`) : ['Nothing on your website to check: everything it needed is already in place.']),
    '',
    'STEP 2: SEE WHAT AI SAYS (in about a month)',
    ...(qs.length
      ? ['Ask these same questions, word for word, in ChatGPT, Gemini and Claude, and note who each one names:', ...qs.map((q) => `- ${q}`)]
      : ['Ask ChatGPT, Gemini and Claude the questions customers ask about businesses like yours, and note who each one names.']),
    'One answer proves little, because AI answers vary. Look for a pattern across several tries. Your next scan does this for you with the same questions.',
    '',
    ...(token ? [`Your Fix Kit page (change a detail and download again): ${origin}/fix-kit/${encodeURIComponent(token)}`, ''] : []),
    'Questions: hello@aifoundscore.com',
    '',
  ].join('\n');
}

/**
 * buildKit(details, report, opts) → { jobs, done, faq, missing, files, platform? }
 *   jobs: [{ id, title, tech, what, where, who, optional, note?, platform?, files: [path] }] — only what is
 *         left to do for this business, most useful first. platform: { name, steps: [line], guides: [{ label, url }] }
 *         when the site builder is known; the kit's `platform` is then { id, name }.
 *   done: [{ id, title, note }] — what the website check found already in place (nothing to do).
 *   faq:  shared/faq.js buildFaq result; missing: missingDetails(d); notes: detailNotes(d, report); files: [{ path, content }], README first.
 * opts: { origin, token, date } for README.txt.
 */
export function buildKit(details, report, opts = {}) {
  const d = details;
  const site = siteStatus(report);
  const faq = kitFaq(d, report);
  const jobs = [];
  const done = [];
  const files = [];
  const add = (path, content) => { files.push({ path, content }); return path; };
  const blockedWho = site.blocked.map((b) => b.who || b.agent).filter(Boolean);
  // The site builder, when known: "In Wix: …" for each website job, with the builder's own guide.
  const pf = platformFor(report);
  const onBuilder = (jobIds, { page = false } = {}) => {
    if (!pf) return {};
    const entries = jobIds.map((j) => [j, platformJob(pf, j)]).filter(([, e]) => e);
    if (!entries.length) return {};
    const steps = entries
      // The FAQ block that writes its own code: the code step is not needed.
      .filter(([j]) => !(j === 'headCode' && jobIds.includes('faq') && platformJob(pf, 'faq')?.schema === true))
      .map(([j, e]) => (j === 'headCode' && jobIds.includes('faq') && e.can !== false
        ? `For the code from faq-page.html, ${platformStep(pf, e, { page }).replace(/^In /, 'in ')}`
        : platformStep(pf, e, { page })));
    return { platform: { name: pf.name, steps, guides: guideLinks(pf, entries.map(([j]) => j)) } };
  };

  if (!site.checked || site.blocked.length) {
    jobs.push({
      id: 'robots',
      // Blocked: the first job (nothing else works until AI can read the site). Unchecked: after the others.
      order: site.blocked.length ? 0 : 5,
      title: 'Let AI read your website',
      tech: 'robots.txt',
      what: site.blocked.length
        ? `Your website tells ${joinAnd(blockedWho)} to stay out. This file lets them back in.`
        : 'We couldn’t load your website to check it, so this file is here in case: it lets AI assistants read your site.',
      where: 'The top folder of your website. If you already have a robots.txt, add these lines to it instead of replacing it.',
      who: 'web',
      time: 'Under half an hour for your web person',
      optional: false,
      files: [add('robots.txt', robotsTxt(d, { blocked: site.blocked }))],
      ...onBuilder(['aiCrawlers', 'robots']),
    });
  } else {
    done.push({
      id: 'robots',
      title: 'AI can read your website',
      note: site.robotsFound
        ? 'Your robots.txt already lets AI read your site. Nothing to do.'
        : 'Nothing on your website blocks AI from reading it. Nothing to do.',
    });
  }

  const lost = faq.items.filter((i) => i.lost).length;
  jobs.push({
    id: 'faq',
    title: 'A Questions page AI can quote',
    tech: 'FAQ page with FAQPage code (schema.org)',
    what: `${plural(faq.items.length, 'question', 'questions')} customers ask${lost ? `, starting with the ${lost === 1 ? 'one' : lost} AI didn’t name you for` : ''}, each answered with your details in the plain style AI repeats.`,
    where: 'A page on your website called “FAQ” or “Questions”. On Wix or Squarespace, paste faq-page.txt into a text block; your web person adds the code from faq-page.html.',
    who: 'both',
    time: 'About an hour for you, then about half an hour for your web person',
    optional: false,
    ...(site.faqSchema ? { note: 'Your website already has some FAQ code. Add these questions to that page rather than making a second one.' } : {}),
    files: [add('faq-page.html', faqHtml(d, report, faq)), add('faq-page.txt', faqTxt(d, report, faq))],
    ...onBuilder(['faq', 'headCode'], { page: true }),
  });

  jobs.push({
    id: 'google',
    title: 'Your Google Business Profile text',
    tech: 'Google Business Profile',
    what: 'Your description, categories, services and service area, ready to paste.',
    where: 'Sign in at business.google.com and copy each part into the box with the same name.',
    who: 'you',
    time: 'Under half an hour for you',
    optional: false,
    files: [add('google-business-profile.txt', gbpTxt(d))],
  });

  const hasSchema = site.businessSchema.length > 0;
  jobs.push({
    id: 'schema',
    title: 'Your business details in the format Google and AI read',
    tech: 'LocalBusiness schema (JSON-LD)',
    what: 'Your name, phone, address and service area as a small block of code search engines and AI read directly.',
    where: 'Pasted into a hidden part of your home page (the <head> section) by whoever runs your website.',
    who: 'web',
    time: 'Under half an hour for your web person',
    optional: hasSchema,
    ...(hasSchema ? { note: `Your website already has business code (${site.businessSchema.slice(0, 2).join(', ')}). Use ours only if yours is missing your phone, address or hours.` } : {}),
    files: [add('schema-localbusiness.html', schemaHtml(d))],
    ...onBuilder(['headCode']),
  });

  if (site.llmsTxt) {
    done.push({ id: 'llms', title: 'Your summary for AI tools', note: 'You already have an llms.txt file. Nothing to do.' });
  } else {
    jobs.push({
      id: 'llms',
      title: 'A short summary for AI tools',
      tech: 'llms.txt',
      what: 'A plain summary of your business written for AI assistants. Newer and optional: helpful, not essential.',
      where: 'The top folder of your website. If your site builder won’t let you add files, skip it.',
      who: 'web',
      time: 'Under half an hour for your web person',
      optional: true,
      files: [add('llms.txt', llmsTxt(d))],
      ...onBuilder(['llms']),
    });
  }

  // Reviews: when AI named others for their reviews, or the owner gave their review link.
  const reviewsMatter = faq.attributes.some((a) => a.type === 'reviews');
  if (d.googleReviewUrl || reviewsMatter) {
    // A firm's clients finish projects, not jobs (buyer review, Oct 2).
    const after = kindClass(d.trade) === 'professional' ? 'when a project wraps up' : 'after each job';
    jobs.push({
      id: 'qr',
      title: 'Ask happy customers for a Google review',
      tech: d.googleReviewUrl ? 'Message templates and a QR code (SVG)' : 'Message templates',
      what: d.googleReviewUrl
        ? `Two short messages to send ${after}, and a QR code that opens your Google review page on a phone.`
        : `Two short messages to send ${after}. Add your Google review link on this page and the kit adds a QR code you can print.`,
      where: d.googleReviewUrl
        ? `Send a message ${after}. Print the QR code on invoices, receipts or a card you leave behind.`
        : `Send a message ${after}.`,
      who: 'you',
      time: 'Under half an hour to set up, then seconds per customer',
      optional: false,
      files: [
        add('ask-for-reviews.txt', reviewsTxt(d)),
        ...(d.googleReviewUrl ? [add('review-qr.svg', qrSvg(d.googleReviewUrl, { ecl: 'M', title: `Leave ${d.name} a Google review` }))] : []),
      ],
    });
  }

  // On a builder that can't take a job's file, or makes the file itself: say so, and make it optional.
  if (pf) {
    for (const j of jobs) {
      const own = { schema: platformJob(pf, 'headCode'), llms: platformJob(pf, 'llms'), robots: platformJob(pf, 'robots') }[j.id];
      if (!own) continue;
      if (own.can === false) {
        j.optional = true;
        j.skip = true;
        delete j.time;
        // Said once, in "Where it goes", not again as a step.
        if (j.platform) j.platform.steps = j.platform.steps.filter((x) => x !== platformStep(pf, own));
        j.where = j.id === 'robots' && platformJob(pf, 'aiCrawlers')
          ? `${pf.name} doesn’t let you edit robots.txt, so this file can’t be used there. Use ${pf.name}’s setting below instead.`
          : `${pf.name} can’t take this file, so skip it. ${own.steps}`;
      } else if (own.auto === true) {
        j.optional = true;
        j.skip = true;
        delete j.time;
        j.where = `${pf.name} makes this file for you, so you don’t need ours. Use ours only if you’d rather write your own.`;
      }
    }
  }

  // Required jobs first (in the order above), the optional ones after.
  const rank = (j) => (j.optional ? 10 : j.order ?? ({ faq: 1, google: 2, schema: 3 }[j.id] || 6));
  const ordered = jobs.map((j, n) => ({ j, n })).sort((a, b) => rank(a.j) - rank(b.j) || a.n - b.n).map(({ j }) => { const { order, ...rest } = j; return rest; });
  // The builder's plan warning ("custom code needs a paid plan") once, on the first job that has it.
  if (pf) {
    const warned = new Set();
    const warnings = Object.values(pf.jobs).map((e) => e && e.plan).filter(Boolean);
    for (const j of ordered) {
      if (!j.platform) continue;
      j.platform.steps = j.platform.steps.map((step) => {
        const w = warnings.find((x) => step.endsWith(` ${x}`));
        if (!w) return step;
        if (!warned.has(w)) { warned.add(w); return step; }
        return step.slice(0, -(w.length + 1));
      });
    }
  }
  const missing = missingDetails(d);
  const notes = detailNotes(d, report);
  const platform = pf ? { id: pf.id, name: pf.name } : null;
  const readme = { path: 'README.txt', content: readmeTxt(d, { jobs: ordered, done, faq, missing, notes, platform }, opts) };
  const check = { path: 'check-it-worked.txt', content: checkTxt(d, report, ordered, opts) };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = [readme, ...ordered.flatMap((j) => j.files.map((p) => byPath.get(p))), check];
  return { jobs: ordered, done, faq, missing, notes, files: out, check, ...(platform ? { platform } : {}) };
}

/**
 * The kit's jobs in two groups: what the owner can do alone today (their Google profile, review messages), and
 * what goes on the website (needs whoever runs it). A job the builder can't take is left out of "yours".
 * (Buyer reviews: most owners have no web person, and the README never said what to do first.)
 */
export function splitJobs(jobs = []) {
  const mine = jobs.filter((j) => j.who === 'you');
  return { mine, web: jobs.filter((j) => j.who !== 'you') };
}

export function readmeTxt(d, kit, { origin = 'https://aifoundscore.com', token = '', date = new Date() } = {}) {
  const { jobs = [], done = [], faq = { items: [], needs: 0 }, missing = [], notes = [], platform = null } = kit || {};
  const out = [
    `YOUR FIX KIT: ${d.name}`,
    `Made ${date.toISOString().slice(0, 10)} by AI Found Score, from your website, your report and the details you checked.`,
    '',
    'These files help AI assistants and Google describe your business correctly.',
    'Give this folder to whoever looks after your website. Each job below says what it does and where it goes.',
    'Nothing changes on your website until someone puts these files in place.',
    'The files give AI and Google correct facts to read. We can’t promise any assistant will name you: check-it-worked.txt says what to expect and how to tell.',
    '',
    ...(platform ? [`Your website is built on ${platform.name}. Where a job can be done in ${platform.name}, it says exactly where to click, with ${platform.name}’s own guide.`, ''] : []),
  ];
  if (missing.length || notes.length || faq.needs) {
    out.push('BEFORE YOU SEND IT ON');
    for (const n of notes) out.push(`- Check: ${n.label}. ${n.note}`);
    for (const m of missing) out.push(`- Missing: ${m.label}. ${m.note}`);
    if (faq.needs) out.push(`- ${plural(faq.needs, 'answer', 'answers')} in your Questions page ${faq.needs === 1 ? 'needs' : 'need'} one detail from you (the part in [brackets]). Fill ${faq.needs === 1 ? 'it' : 'them'} in on your Fix Kit page and download again.`);
    out.push('');
  }
  const { mine, web } = splitJobs(jobs);
  const section = (title, intro, list) => {
    if (!list.length) return;
    out.push(title, ...intro, '');
    list.forEach((j, n) => {
      out.push(
        `${n + 1}. ${j.title}${j.optional ? ' (optional)' : ''}`,
        `   ${j.files.length > 1 ? 'Files' : 'File'}: ${j.files.join(', ')}`,
        `   What it does: ${j.what}`,
        ...(j.time ? [`   Time: ${j.time}. No cost from us.`] : []),
        `   Where it goes: ${j.where}`,
        ...(j.platform ? j.platform.steps.map((x) => `   ${x}`) : []),
        ...(j.platform ? j.platform.guides.map((g) => `   ${g.label}: ${g.url}`) : []),
        ...(j.note ? [`   Note: ${j.note}`] : []),
        '',
      );
    });
  };
  section('START HERE: JOBS YOU CAN DO YOURSELF, TODAY', ['No website skills needed. If you only do one thing, do number 1.'], mine);
  section('JOBS FOR WHOEVER RUNS YOUR WEBSITE', ['These go on your website. Give them this folder. Nobody does that for you? Ask us on your Fix Kit page (the “Do it for me” box) and we will write back with what we would do and what it would cost. Asking is free.'], web);
  if (done.length) {
    out.push('ALREADY DONE ON YOUR WEBSITE');
    for (const x of done) out.push(`- ${x.title}: ${x.note}`);
    out.push('');
  }
  out.push(
    'YOUR DETAILS, AS YOU CHECKED THEM',
    `Name: ${d.name}`,
    `Phone: ${d.phone || 'Missing (add it on your Fix Kit page)'}`,
    ...(d.street ? [`Address: ${fullAddress(d)}`] : [`Town: ${where(d)}`]),
    ...(d.website ? [`Website: ${d.website}`] : []),
    ...(d.hours ? [`Hours: ${d.hours}`] : []),
    ...(d.services.length ? [`Services: ${d.services.join(', ')}`] : []),
    `Service area: ${d.serviceTowns.join(', ')}`,
    '',
    'Use these exact details everywhere: your website, Google, Yelp, Facebook, Bing and Apple Maps.',
    'When they match everywhere, AI assistants trust them more.',
    '',
    'Something wrong? Fix it on your Fix Kit page and download a new kit:',
    `${origin}/fix-kit/${encodeURIComponent(token)}`,
    'Questions: hello@aifoundscore.com',
    '',
  );
  return out.join('\n');
}

/** Every file in the kit (buildKit), README first. → [{ path, content }] */
export function buildFixKitFiles(details, report, opts = {}) {
  return buildKit(details, report, opts).files;
}

// ---------------------------------------------------------------------------
// ZIP (STORE only)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (the ZIP / PNG one) of a byte array. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time (local fields of `date`, 2-second resolution, 1980 at the earliest). */
function dosDateTime(date) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * [{ path, content: string | Uint8Array }] → a ZIP archive (no compression, UTF-8 names).
 * opts: { date } for the entries' timestamps (default now).
 */
export function zipFiles(files, { date = new Date() } = {}) {
  const enc = new TextEncoder();
  const { time, date: day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(String(f.path));
    const data = typeof f.content === 'string' ? enc.encode(f.content) : f.content;
    const crc = crc32(data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 10, true);       // version needed: 1.0 (stored)
    lv.setUint16(6, 0x0800, true);   // flags: UTF-8 names
    lv.setUint16(8, 0, true);        // method: stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);       // version made by
    cv.setUint16(6, 10, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: 0
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + end.length);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, p); p += part.length; }
  return out;
}
