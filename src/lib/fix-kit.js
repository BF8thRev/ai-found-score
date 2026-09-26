// src/lib/fix-kit.js — the Fix Kit: ready-to-install files built from the owner's confirmed details.
//
// Sold with the $149 Fix Kit ('fix_kit') and the $499 Be the Answer ('be_the_answer') plans. Fully
// automatic: the owner checks their details on /fix-kit/<token> (public/fix-kit.html), confirms them,
// and downloads a zip. Nobody at AI Found Score touches it. Routes: src/lib/fix-kit-route.js.
//
//   prefillDetails(report)          → the form's starting values, from the stored report: the business
//                                     the scan was run for, facts read off their website, the phone and
//                                     address their site shows (siteCheck.onSite), then their Google listing
//   validateDetails(input)          → { ok, details, errors: [{ field, message }] }: trimmed, capped, checked
//   buildFixKitFiles(details, report, opts) → [{ path, content }]: robots.txt, llms.txt,
//                                     schema-localbusiness.html, faq-page.html, google-business-profile.txt,
//                                     review-qr.svg (only with a review link) and README.txt
//   zipFiles(files, opts)           → Uint8Array: a STORE-only (uncompressed) ZIP, CRC-32, no dependencies
//
// Truthful by construction, like scanner/extract/fixes.js: every file is a fixed template filled ONLY
// with what the owner confirmed. No AI call, nothing guessed. A detail left blank is left out.
// Everything here is pure (no fetch, no Node APIs), so it runs in the Worker and in node --test.

import { AI_BOTS, formatPhone } from '../../scanner/owner-checks.js';
import { normalizeTrade, TRADES, buildQuestions } from '../../scanner/questions.js';
import { US_STATES } from '../../scanner/config.js';
import { SCHEMA_TYPES, GBP_DESCRIPTION_MAX, alwaysOpen } from '../../scanner/extract/fixes.js';
import { phoneKey } from '../../scanner/extract/normalize.js';
import { qrSvg } from './vendor/qrcode.js';

/** Tiers whose buyers get the Fix Kit (tier keys from TIER_BY_CENTS in src/lib/stripe.js). */
export const FIX_KIT_TIERS = Object.freeze(['fix_kit', 'be_the_answer']);

export const LIMITS = Object.freeze({
  name: 120, trade: 60, phone: 40, street: 160, town: 60, zip: 10, website: 300, hours: 300,
  description: GBP_DESCRIPTION_MAX, url: 500, listItem: 80, listMax: 15,
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
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
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
  const name = clean(b.name || g.name);
  const town = clean(b.town || b.city);
  const state = clean(b.state).toUpperCase();
  const address = b.address || onSite.address || g.address || '';
  const services = splitList(facts.services);
  const where = [town, state].filter(Boolean).join(', ');
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
    description: name ? `${name} is ${noun ? `${article(noun)} ${noun}` : 'a local business'}${where ? ` in ${where}` : ''}.` : '',
    googleMapsUrl: google && typeof google.url === 'string' && /^https:\/\//i.test(google.url) ? google.url : '',
    googleReviewUrl: '',
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
 * Required: name, phone, town, state. Lists: at most 15 items of 80 characters.
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
    services: [],
    serviceTowns: [],
    description: text('description'),
    googleMapsUrl: '',
    googleReviewUrl: '',
  };
  if (!d.name) err('name', 'Enter your business name.');
  if (!d.phone) err('phone', 'Enter your phone number.');
  else if (!phoneKey(d.phone) || d.phone.replace(/\D/g, '').length > 11) err('phone', 'Enter a 10-digit phone number.');
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
  if (!d.description && d.name) {
    const noun = tradeNoun(d.trade);
    d.description = `${d.name} is ${noun ? `${article(noun)} ${noun}` : 'a local business'} in ${[d.town, d.state].filter(Boolean).join(', ')}.`;
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

/** The report's question when it is a question; search phrases ("Plumber with good reviews near X") become one. */
function faqQuestion(d, q) {
  const text = clean(q.text);
  if (/^(who|what|where|which|how|is|are|can|do|does|should)\b/i.test(text)) return text[0].toUpperCase() + text.slice(1).replace(/[?.\s]*$/, '?');
  const noun = tradeNoun(d.trade) || 'business';
  const a = `${article(noun)} ${noun}`;
  const near = d.town;
  const byIntent = {
    urgent: `Who can I call today for ${a} near ${near}?`,
    trust: `Which ${noun} near ${near} has good reviews?`,
    price: `How much does ${a} in ${near} charge?`,
    best: `Who is a good ${noun} in ${near}?`,
    job: `Who can I hire for ${noun} work in ${near}?`,
  };
  return byIntent[q.intent] || `${text[0].toUpperCase()}${text.slice(1).replace(/[?.\s]*$/, '')}?`;
}

function leadSentence(d) {
  const noun = tradeNoun(d.trade);
  const others = d.serviceTowns.filter((t) => t.toLowerCase() !== d.town.toLowerCase());
  return `${d.name} is ${noun ? `${article(noun)} ${noun}` : 'a local business'} in ${where(d)}`
    + `${others.length ? `, serving ${joinAnd(others)}` : ''}.`;
}

export function robotsTxt(d) {
  const lines = [
    `# robots.txt${d.website ? ` for ${hostOf(d.website)}` : ''}, from your AI Found Score Fix Kit.`,
    '# It lets the crawlers that AI assistants and search engines use read your website.',
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
  out.push(tel ? `- [Phone: ${d.phone}](${tel})` : `- Phone: ${d.phone}`);
  if (d.street) out.push(`- Address: ${fullAddress(d)}`);
  if (d.website) out.push(`- [Website](${d.website})`);
  if (d.hours) out.push(`- Hours: ${d.hours}`);
  if (d.googleMapsUrl) out.push(`- [Google Maps listing](${d.googleMapsUrl})`);
  if (d.googleReviewUrl) out.push(`- [Google reviews](${d.googleReviewUrl})`);
  return out.join('\n') + '\n';
}

/** The LocalBusiness JSON-LD object (confirmed fields only). */
export function localBusinessSchema(d) {
  const o = { '@context': 'https://schema.org', '@type': FIX_KIT_SCHEMA_TYPES[tradeKey(d.trade)] || 'LocalBusiness', name: d.name };
  if (d.description) o.description = d.description;
  o.telephone = d.phone;
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
    '     Check it afterwards at https://search.google.com/test/rich-results -->',
    '<script type="application/ld+json">',
    ldJson(localBusinessSchema(d)),
    '</script>',
    '',
  ].join('\n');
}

/**
 * FAQ questions and answers. The questions are the ones the report asked the AI assistants (or the
 * scanner's questions for this trade and town); each answer states confirmed details only.
 */
export function faqItems(d, report) {
  let qs = (Array.isArray(report?.questions) ? report.questions : []).filter((q) => q && clean(q.text));
  if (!qs.length && d.town) qs = buildQuestions({ trade: d.trade, town: d.town, state: d.state, zip: d.zip });
  const lead = leadSentence(d);
  const call = `Call ${d.phone}.`;
  const services = d.services.length ? `Services: ${joinAnd(d.services)}.` : '';
  const hours = d.hours ? `Hours: ${d.hours.replace(/[.\s]+$/, '')}.` : '';
  const byIntent = {
    best: [lead, services, call],
    urgent: [lead, hours, call],
    job: [lead, services, call],
    trust: [lead, d.googleMapsUrl ? 'You can read our reviews on Google.' : '', call],
    price: [lead, `${call.slice(0, -1)} to ask about prices.`],
  };
  const items = qs.slice(0, 10).map((q) => {
    return { question: faqQuestion(d, q), answer: (byIntent[q.intent] || byIntent.best).filter(Boolean).join(' ') };
  });
  items.push({ question: 'What areas do you serve?', answer: `We serve ${townsText(d)}. ${call}` });
  if (d.hours) items.push({ question: 'What are your hours?', answer: `${hours} ${call}` });
  items.push({
    question: `How do I contact ${d.name}?`,
    answer: [call, d.street ? `We're at ${fullAddress(d)}.` : '', d.website ? `Website: ${d.website}` : ''].filter(Boolean).join(' '),
  });
  return items;
}

export function faqHtml(d, report) {
  const items = faqItems(d, report);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((it) => ({ '@type': 'Question', name: it.question, acceptedAnswer: { '@type': 'Answer', text: it.answer } })),
  };
  return [
    `<!-- ${inComment(d.name)}: questions and answers. Paste all of this into a page on your site called "FAQ"`,
    '     (or into the page you already have). Change the wording if you like, but keep it true.',
    '     If you change an answer, change it in the <script> part at the bottom too. -->',
    '<section class="faq">',
    '  <h2>Frequently asked questions</h2>',
    ...items.flatMap((it) => [`  <h3>${escHtml(it.question)}</h3>`, `  <p>${escHtml(it.answer)}</p>`]),
    '</section>',
    '<script type="application/ld+json">',
    ldJson(ld),
    '</script>',
    '',
  ].join('\n');
}

/** A GBP description: the owner's description, then services and towns while they fit in 750. */
export function gbpDescriptionText(d) {
  const parts = [
    d.description || leadSentence(d),
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

export function gbpTxt(d) {
  const key = tradeKey(d.trade);
  const cats = GBP_CATEGORIES[key] || [];
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
    cats[0] || 'Pick the category that best matches your main work.',
    '',
  ];
  if (cats.length > 1) {
    out.push('OTHER CATEGORIES TO CONSIDER (add only the ones that match work you do)', ...cats.slice(1).map((c) => `- ${c}`), '');
  }
  out.push(`DESCRIPTION (${desc.length} of ${GBP_DESCRIPTION_MAX} characters)`, desc, '');
  if (d.services.length) out.push('SERVICES', ...d.services.map((s) => `- ${s}`), '');
  out.push('SERVICE AREAS', ...d.serviceTowns.map((t) => `- ${townLabel(d, t)}`), '');
  out.push('PHONE', d.phone, '');
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

export function readmeTxt(d, files, { origin = 'https://aifoundscore.com', token = '', date = new Date() } = {}) {
  const has = (p) => files.some((f) => f.path === p);
  const site = d.website ? new URL(d.website).origin : 'https://yourwebsite.com';
  const out = [
    `YOUR FIX KIT: ${d.name}`,
    `Made ${date.toISOString().slice(0, 10)} by AI Found Score from the details you confirmed.`,
    '',
    'These files help AI assistants and Google read your business correctly.',
    'Give this folder to whoever looks after your website. Each file below says where it goes.',
    'Nothing changes on your website until someone puts these files in place.',
    '',
    '1. robots.txt',
    '   What it does: lets the crawlers used by ChatGPT, Claude, Perplexity, Gemini, Google and Bing read your site.',
    `   Where it goes: the top folder of your website, so it opens at ${site}/robots.txt`,
    '   Already have one? Don\'t replace it. Add our lines to it, and delete any "Disallow: /" line',
    '   under those crawler names. Some site builders have a robots.txt box in their SEO settings.',
    '',
    '2. llms.txt',
    '   What it does: a short, plain summary of your business written for AI assistants.',
    `   Where it goes: the top folder of your website, so it opens at ${site}/llms.txt`,
    '   If your site builder won\'t let you add files, skip this one.',
    '',
    '3. schema-localbusiness.html',
    '   What it does: your name, phone, address and service area in the code format Google and AI read.',
    '   Where it goes: paste all of it into the <head> section of your home page.',
    '   If your site already has LocalBusiness code, replace it. Don\'t add a second copy.',
    '   Check it: https://search.google.com/test/rich-results (enter your home page address).',
    '',
    '4. faq-page.html',
    '   What it does: answers the questions people ask AI about businesses like yours, using your details.',
    '   Where it goes: a page on your site called "FAQ". Paste all of it in, including the <script> part.',
    '',
    '5. google-business-profile.txt',
    '   What it does: the text for your Google Business Profile: description, categories, services and areas.',
    '   Where it goes: sign in at business.google.com and copy each part into the matching box.',
    '',
  ];
  if (has('review-qr.svg')) {
    out.push(
      '6. review-qr.svg',
      '   What it does: a QR code that opens your Google review page on a customer\'s phone.',
      '   Where it goes: print it on invoices, receipts or a card you leave after a job. It stays sharp at any size.',
      '   Scan it with your own phone first to check it opens the right page.',
      '',
    );
  }
  out.push(
    'YOUR DETAILS, AS YOU CONFIRMED THEM',
    `Name: ${d.name}`,
    `Phone: ${d.phone}`,
    ...(d.street ? [`Address: ${fullAddress(d)}`] : [`Town: ${where(d)}`]),
    ...(d.website ? [`Website: ${d.website}`] : []),
    ...(d.hours ? [`Hours: ${d.hours}`] : []),
    ...(d.services.length ? [`Services: ${d.services.join(', ')}`] : []),
    `Service area: ${d.serviceTowns.join(', ')}`,
    '',
    'Use these exact details everywhere: your website, Google, Yelp, Facebook, Bing and Apple Maps.',
    'When they match everywhere, AI assistants trust them more.',
    '',
    'Something wrong? Fix it, confirm again and download a new kit:',
    `${origin}/fix-kit/${encodeURIComponent(token)}`,
    'Questions: hello@aifoundscore.com',
    '',
  );
  return out.join('\n');
}

/**
 * Every file in the kit, from validated details. opts: { origin, token, date } for README.txt.
 * → [{ path, content }] (content is a string; zipFiles encodes it as UTF-8).
 */
export function buildFixKitFiles(details, report, opts = {}) {
  const d = details;
  const files = [
    { path: 'robots.txt', content: robotsTxt(d) },
    { path: 'llms.txt', content: llmsTxt(d) },
    { path: 'schema-localbusiness.html', content: schemaHtml(d) },
    { path: 'faq-page.html', content: faqHtml(d, report) },
    { path: 'google-business-profile.txt', content: gbpTxt(d) },
  ];
  if (d.googleReviewUrl) {
    files.push({ path: 'review-qr.svg', content: qrSvg(d.googleReviewUrl, { ecl: 'M', title: `Leave ${d.name} a Google review` }) });
  }
  files.unshift({ path: 'README.txt', content: readmeTxt(d, files, opts) });
  return files;
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
