// The FAQ we write for a business, reverse-engineered from what AI actually said in its scan.
//
// Used by the Fix Kit (src/lib/fix-kit.js: faq-page.html, faq-page.txt and the kit page) and by the
// paid report's action plan (shared/action-plan.js 'faq' step), so the two always say the same thing.
// Pure and deterministic: no fetch, no AI call, nothing invented.
//
//   buildFaq(report, details) → { items, attributes, needs, kind }
//     items: [{ id, question, answer, slot, complete, fromScan, lost }]
//       - the customer questions AI was asked in this scan (the ones it didn't name the business for
//         first), phrased as a customer asks them, then 2–4 more that the AI answers show customers
//         care about;
//       - each answer opens with one sentence that names the business, the trade and the place, then
//         short plain facts we have (services, hours, prices, towns, contact). Anything only the owner
//         knows (a client, a result, the year they started) is ONE [bracket] per answer with a concrete
//         example; `slot` says which, and the owner's own sentence (details.faqFacts[slot]) replaces it.
//       - complete: no bracket left. Only complete answers go in the FAQ code (faqJsonLd), so the code
//         never carries placeholder text and always says exactly what the page says.
//     attributes: [{ type, label, count }]: what AI mentioned when it recommended other businesses
//       ("specializes in…", "founded in…", "clients include…"), by type, most mentioned first. Only the
//       TYPE is used: a competitor's own facts never reach this business's answers.
//     needs: how many answers still need one detail from the owner.
//
// `details` is the Fix Kit's details shape (src/lib/fix-kit.js validateDetails): name, trade, phone,
// website, street, town, state, hours, price, services[], serviceTowns[], description, googleMapsUrl,
// faqFacts{}. Fields we don't have are left out of the answers, never guessed.

import { kindClass, ACRONYMS } from '../scanner/questions.js';

const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join('|')})\\b`, 'gi');
const kindText = (s) => String(s || '').replace(ACRONYM_RE, (m) => m.toUpperCase());
const clean = (v) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const article = (w) => {
  const s = String(w || '');
  if (/^[A-Z]{2,}\b/.test(s)) return /^[AEFHILMNORSX]/.test(s) ? 'an' : 'a';
  return /^[aeiou]/i.test(s) ? 'an' : 'a';
};
const joinAnd = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const sentence = (s) => { const t = clean(s); return !t ? '' : /[.!?…]$/.test(t) ? t : `${t}.`; };
/** "Plumbing repair" → "plumbing repair"; "HVAC repair" stays. */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const hostOf = (url) => { try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.replace(/^www\./i, ''); } catch { return ''; } };

function hashId(text) {
  let h = 5381;
  for (const ch of String(text || '')) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `q-${h.toString(36)}`;
}

// ---------------------------------------------------------------------------
// What AI cited when it recommended someone else: attribute TYPES, by keyword.
// ---------------------------------------------------------------------------
export const ATTRIBUTES = Object.freeze([
  { type: 'specialty', label: 'what they specialize in', re: /\b(speciali[sz]\w*|focus(?:es|ed|ing)? on|known for|expert(?:ise|s)? in|niche|best known|go-to for)\b/i },
  { type: 'clients', label: 'the clients or industries they work with', re: /\b(clients? (?:include|includes|like|such as|range)|client list|works? with|working with|industr(?:y|ies)|brands|startups?|nonprofits?|homeowners|landlords|property managers|commercial|residential|b2b|consumer|enterprise)\b/i },
  { type: 'experience', label: 'how long they’ve been in business', re: /\b(founded|established|since (?:19|20)\d\d|in business|\d+\+? years|decades?|long[- ](?:running|standing|established)|generations?|veteran)\b/i },
  { type: 'team', label: 'their team and who does the work', re: /\b(boutique|senior|small team|hands[- ]on|family[- ](?:owned|run)|independent|team of|personal attention|owner[- ](?:operated|run)|full[- ]service|in[- ]house|staff)\b/i },
  { type: 'results', label: 'results and awards', re: /\b(results?|awards?|award[- ]winning|recogni[sz]ed|featured in|campaigns?|case stud(?:y|ies)|track record|coverage|placements?|portfolio)\b/i },
  { type: 'reviews', label: 'reviews and reputation', re: /\b(reviews?|reviewed|rated|ratings?|well[- ](?:regarded|known|rated)|reputation|reputable|recommended|trusted|testimonials?)\b/i },
  { type: 'price', label: 'prices', re: /(\b(pric(?:e|es|ed|ing)|affordable|cost|costs|fees?|budget|upfront|up-front|flat[- ]rate|free (?:estimates?|quotes?|consultations?)|retainers?|transparent pricing|clear pricing)\b|\$\d)/i },
  { type: 'speed', label: 'how fast they respond', re: /(\b(same[- ]day|emergency|after[- ]hours|responsive|fast|quick(?:ly)?|on call|tonight|right away|turnaround)\b|24\/7)/i },
  { type: 'licensed', label: 'licenses and insurance', re: /\b(licen[sc](?:e|ed|es|ing)|insured|certified|bonded|accredited)\b/i },
]);

// The owner's bracket for each type: what to write, with a concrete example. `office` for agencies and
// firms, `other` for everyone else.
const SLOTS = {
  specialty: { office: ['What you specialize in', 'We focus on healthcare and financial services companies, and most of our work is media relations.'], other: ['What you do most', 'Most of our work is repairs and replacements for homes in the area.'] },
  clients: { office: ['Who you work with', 'Clients include early-stage startups and national consumer brands.'], other: ['Who you work for', 'We work for homeowners, landlords and small businesses.'] },
  experience: { office: ['When you started', 'We were founded in 2012.'], other: ['How long you’ve been in business', 'We have served the area since 2008.'] },
  team: { office: ['Who does the work', 'We are a team of 8, and every client works directly with a senior partner.'], other: ['Who does the work', 'We are family-owned, with a team of 6.'] },
  results: { office: ['One result you can share', 'In 2025 we placed a client in The Wall Street Journal.'], other: ['A recent job you’re proud of', 'Last month we finished a same-day repair for a local school.'] },
  reviews: { office: ['What clients say', 'Clients give us 4.9 stars from 25 reviews on Clutch.'], other: ['What customers say', 'We have a 4.8 rating from 120 Google reviews.'] },
  price: { office: ['How you price', 'Monthly retainers start at $4,000; project work is quoted up front.'], other: ['How you price', 'Service calls are $89, and quotes on bigger jobs are free.'] },
  speed: { office: ['How soon you can start', 'We can start a new project within two weeks.'], other: ['How fast you can get there', 'We answer emergency calls 24/7 and are usually on site within the hour.'] },
  licensed: { office: ['Your credentials', 'Our team is accredited in public relations (APR).'], other: ['Your license and insurance', 'We are licensed and insured, license #12345.'] },
};

/** The slot prompt and example for a type, for this kind of business. */
export function slotFor(type, office) {
  const s = SLOTS[type];
  if (!s) return null;
  const [prompt, example] = s[office ? 'office' : 'other'];
  return { type, prompt, example };
}

/** The answers where AI named other businesses and not this one: what it said about them. */
function winningAnswers(report) {
  return (Array.isArray(report?.answers) ? report.answers : [])
    .filter((a) => a && !a.namedYou && typeof a.text === 'string' && (a.businessesNamed || []).some((b) => b && !b.isYou));
}

/**
 * attributeTypes(report) → [{ type, label, count }]: how many winning answers mention each attribute
 * type, most first (ties in ATTRIBUTES order). Types never mentioned are left out.
 */
export function attributeTypes(report) {
  const texts = winningAnswers(report).map((a) => a.text.replace(/\*\*/g, ''));
  const out = [];
  ATTRIBUTES.forEach((t, n) => {
    const count = texts.filter((x) => t.re.test(x)).length;
    if (count) out.push({ type: t.type, label: t.label, count, n });
  });
  return out.sort((a, b) => b.count - a.count || a.n - b.n).map(({ n, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Questions, as customers ask them
// ---------------------------------------------------------------------------
const QUESTION_START = /^(who|what|what's|where|which|how|is|are|can|could|do|does|should|when|why|will|would)\b/i;

/** A scan question as a customer asks it: real questions stay as asked; search phrases become one. */
export function customerQuestion(q, { noun, town, state = '', office }) {
  let text = kindText(clean(q.text));
  // "in Massapequa NY" → "in Massapequa, NY"
  if (town && state) text = text.split(`${town} ${state}`).join(`${town}, ${state}`);
  if (QUESTION_START.test(text)) return cap(text).replace(/[?.\s]*$/, '?');
  const n = noun || 'business';
  const a = `${article(n)} ${n}`;
  const near = town || 'here';
  const byIntent = {
    urgent: office ? `Who is a highly rated ${n} in ${near}?`
      : /emergenc/i.test(text) ? `Who can I call for an emergency ${n} near ${near}${/tonight/i.test(text) ? ' tonight' : ''}?`
        : `Who can I call today for ${a} near ${near}?`,
    trust: `Which ${n} near ${near} has good reviews?`,
    price: `How much does ${a} in ${near} charge?`,
    best: `Who is a good ${n} in ${near}?`,
    job: `Who can I hire for ${office ? 'help from' : 'work from'} ${a} in ${near}?`,
  };
  return byIntent[q.intent] || `${cap(text).replace(/[?.\s]*$/, '')}?`;
}

// Which owner detail each scan question's answer asks for, best first. The first one AI mentioned
// for other businesses wins; a type is asked once across the whole FAQ.
const PREFS = {
  office: { best: ['specialty', 'results', 'clients', 'team'], job: ['clients', 'specialty', 'results', 'team'], trust: ['reviews', 'results', 'experience'], price: ['price'], urgent: ['reviews', 'results', 'experience'], small: ['team', 'clients', 'experience'], niche: ['specialty', 'clients', 'results'] },
  other: { best: ['specialty', 'reviews', 'experience', 'team'], job: ['specialty', 'clients', 'results'], trust: ['reviews', 'licensed', 'experience'], price: ['price'], urgent: ['speed'], small: ['team', 'experience', 'reviews'], niche: ['specialty', 'experience', 'results'] },
};
// small / niche: the paid audit's small-firm questions (scanner/questions.js smallFirmQuestions).
// Extra questions, when the scan's own questions didn't use these types (most mentioned first).
const EXTRA_DEFAULTS = { office: ['clients', 'experience', 'results', 'team', 'specialty'], other: ['experience', 'price', 'licensed', 'reviews', 'specialty'] };

function extraQuestion(type, name, office) {
  const q = {
    specialty: office ? `What does ${name} specialize in?` : `What kind of work does ${name} do most?`,
    clients: office ? `What kinds of clients does ${name} work with?` : `Who does ${name} work for?`,
    experience: `How long has ${name} been in business?`,
    team: office ? `Who will work on my account at ${name}?` : `Who will do the work at ${name}?`,
    results: office ? `What results has ${name} gotten for clients?` : `What jobs has ${name} done recently?`,
    reviews: office ? `What do clients say about ${name}?` : `What do customers say about ${name}?`,
    price: `How much does ${name} charge?`,
    speed: office ? `How soon can ${name} start?` : `How fast can ${name} get to me?`,
    licensed: `Is ${name} licensed and insured?`,
  };
  return q[type];
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------
const STOP = new Set(['what', 'whats', 'best', 'good', 'near', 'with', 'from', 'that', 'this', 'your', 'need', 'call', 'today', 'tonight', 'reviews', 'affordable', 'recommend', 'someone', 'hire', 'help', 'work', 'have', 'does', 'agency', 'company', 'service', 'services']);
const stem = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ing|ers|er|es|s)$/, '');

/** Services that share a word with the question ("replace a water heater" → water heater installation). */
function servicesFor(question, services) {
  const words = new Set(question.split(/\s+/).map(stem).filter((w) => w.length >= 4 && !STOP.has(w)));
  const hit = services.filter((s) => s.split(/\s+/).map(stem).some((w) => words.has(w)));
  return hit.length ? hit.slice(0, 3) : services.slice(0, 3);
}

// "you" / "your" in lower case anywhere, or capitalised only as a sentence's first word: "Thank You Roofing" is a name.
const SECOND_PERSON = /(?:^|[.!?]\s+)(?:You|Your|You're|You’re)\b|\b(?:you|your|yours|you're|you’re|you’ll|you’ve)\b/;

/**
 * Site copy talks to the visitor ("…media relations to help you build trust"). In a listing or an FAQ answer
 * about the business that reads wrong. Keep the sentences that never say "you"; when the first sentence does,
 * keep what comes before its "you" clause ("…specializes in public relations & media relations"). Nothing is
 * reworded; '' when nothing usable is left.
 */
export function aboutTheBusiness(text) {
  const t = clean(text);
  if (!SECOND_PERSON.test(t)) return t;
  const sentences = t.split(/(?<=[.!?])\s+/);
  const kept = [];
  for (const x of sentences) { if (SECOND_PERSON.test(x)) break; kept.push(x); }
  if (kept.length) return kept.join(' ');
  const first = sentences[0];
  const m = SECOND_PERSON.exec(first);
  const head = first.slice(0, m.index);
  // Back up to where that clause starts: after the last comma, " to ", " so ", " and ", " that " or " which ".
  const cut = Math.max(head.lastIndexOf(','), ...[' to ', ' so ', ' and ', ' that ', ' which ', ' while ', ' – ', ' — ', ' - '].map((w) => head.lastIndexOf(w)));
  const before = clean((cut > 0 ? head.slice(0, cut) : '').replace(/[,;:\s–—-]+$/, ''));
  return before.length >= 20 && !SECOND_PERSON.test(before) ? sentence(before) : '';
}

/** The owner's words about what they do: their description beyond our one-line default, else their homepage description. */
export function ownWords(details, report, lead) {
  const desc = clean(details.description);
  const base = clean(lead).replace(/[.\s]+$/, '');
  let rest = desc;
  if (base && desc.toLowerCase().startsWith(base.toLowerCase())) rest = clean(desc.slice(base.length).replace(/^[.,;:\s]+/, ''));
  else if (/^.{0,160}\bis an? [^.]+ in [^.]+\.\s*$/.test(desc)) rest = ''; // just a "X is a Y in Z." line
  if (rest.length < 20) {
    const m = report && report.siteCheck && report.siteCheck.meta;
    rest = m && typeof m.description === 'string' ? aboutTheBusiness(m.description) : '';
  }
  if (rest.length < 20) return '';
  if (rest.length > 240) rest = rest.slice(0, 240).replace(/\s+\S*$/, '') + '…';
  return sentence(rest);
}

/** Owner-supplied facts for the brackets: { type: "their sentence." }, cleaned, no brackets. */
function factsOf(details) {
  const f = details && details.faqFacts && typeof details.faqFacts === 'object' ? details.faqFacts : {};
  const out = {};
  for (const [k, v] of Object.entries(f)) {
    const t = clean(v).replace(/[[\]]/g, '');
    if (SLOTS[k] && t) out[k] = sentence(t);
  }
  return out;
}

/** "[What you specialize in, e.g. “We focus on …”]" */
export const bracket = (slot) => `[${slot.prompt}, e.g. “${slot.example}”]`;

/**
 * buildFaq(report, details) → { kind, items, attributes, needs }. See the top of this file.
 */
export function buildFaq(report, details) {
  const r = report || {};
  const d = details || {};
  const kind = kindClass(d.trade || r.business?.trade);
  const office = kind === 'professional';
  const name = clean(d.name) || clean(r.business?.name) || 'We';
  const noun = kindText(clean(d.trade) || 'local business').toLowerCase().replace(ACRONYM_RE, (m) => m.toUpperCase());
  const town = clean(d.town);
  const where = [town, clean(d.state)].filter(Boolean).join(', ');
  const services = (Array.isArray(d.services) ? d.services : []).map(clean).filter(Boolean);
  const towns = (Array.isArray(d.serviceTowns) ? d.serviceTowns : []).map(clean).filter(Boolean);
  const hours = clean(d.hours).replace(/[.\s]+$/, '');
  const price = clean(d.price).replace(/[.\s]+$/, '');
  const host = d.website ? hostOf(d.website) : '';
  const phone = clean(d.phone);
  const facts = factsOf(d);
  const attributes = attributeTypes(r);
  const detected = attributes.map((a) => a.type);
  const prefs = PREFS[office ? 'office' : 'other'];
  const used = new Set();

  const baseLead = `${name} is ${article(noun)} ${noun}${where ? ` in ${where}` : ''}`;
  const lead = (list) => `${baseLead}${list && list.length ? ` that offers ${joinAnd(list.map(lowerFirst))}` : ''}.`;
  const servicesLine = (list) => `${office ? 'We offer' : 'Services include'} ${joinAnd(list.slice(0, 4).map(lowerFirst))}.`;
  const contact = phone && host ? `Call ${phone} or visit ${host}.` : phone ? `Call ${phone}.` : host ? `Visit ${host}.` : '';
  const words = ownWords(d, r, `${baseLead}.`);
  let wordsUsed = false;

  // One owner detail per answer: their sentence when they gave it, else a [bracket] with an example.
  const slotPart = (type) => {
    if (!type) return { text: '', slot: null, complete: true };
    const slot = slotFor(type, office);
    if (facts[type]) return { text: facts[type], slot: { ...slot, filled: true }, complete: true };
    return { text: bracket(slot), slot: { ...slot, filled: false }, complete: false };
  };
  const pickType = (list, known = []) => {
    const avail = list.filter((t) => !used.has(t) && !known.includes(t));
    const t = avail.find((x) => detected.includes(x)) || avail[0] || null;
    if (t) used.add(t);
    return t;
  };

  // The scan's own questions: the ones AI didn't name them for first, then the rest.
  const answers = (Array.isArray(r.answers) ? r.answers : []).filter(Boolean);
  const lostIds = new Set(answers.filter((a) => !a.namedYou && a.ownerMatch !== 'unsure').map((a) => a.questionId));
  const qs = (Array.isArray(r.questions) ? r.questions : []).filter((q) => q && clean(q.text))
    // An office has no "open now": that question was a scan mistake for them (scanner/questions.js PROFESSIONAL).
    .filter((q) => !(office && /\bopen now\b/i.test(q.text)));
  const ordered = [...qs.filter((q) => lostIds.has(q.id)), ...qs.filter((q) => !lostIds.has(q.id))];

  const items = [];
  const seenQ = new Set();
  const push = (it) => {
    const key = it.question.toLowerCase();
    if (seenQ.has(key)) return;
    seenQ.add(key);
    items.push({ id: hashId(it.question), ...it, answer: it.parts.filter(Boolean).join(' '), parts: undefined });
  };

  for (const q of ordered) {
    const question = customerQuestion(q, { noun, town, state: clean(d.state), office });
    const intent = PREFS.other[q.intent] ? q.intent : 'best';
    const known = [];
    // A price we already have answers the price question: no bracket, and no second price question.
    if (intent === 'price' && price) { known.push('price'); used.add('price'); }
    const type = pickType(prefs[intent] || prefs.best, known);
    const s = slotPart(type);
    const parts = [];
    if (intent === 'urgent' && !office) {
      const fast = services.filter((x) => /24\/7|emergenc|same[- ]day|after[- ]hours/i.test(x));
      parts.push(lead(fast.slice(0, 2)));
      if (hours) parts.push(`Hours: ${hours}.`);
    } else if (intent === 'price') {
      parts.push(lead(servicesFor(question, services).slice(0, 2)));
      if (price) parts.push(`Prices: ${price}.`);
    } else if (intent === 'trust') {
      parts.push(lead([]));
      if (d.googleMapsUrl) parts.push(`You can read ${office ? 'client' : 'customer'} reviews on our Google profile.`);
      else if (services.length) parts.push(servicesLine(services));
    } else {
      parts.push(lead(intent === 'job' ? servicesFor(question, services) : services.slice(0, 3)));
    }
    if (!wordsUsed && words) { parts.push(words); wordsUsed = true; }
    parts.push(s.text, contact);
    push({ question, parts, slot: s.slot, complete: s.complete, fromScan: true, lost: lostIds.has(q.id), intent: q.intent || null });
  }

  // 2–4 more: the detail types AI mentioned most that the scan questions didn't cover, then where and how.
  const extraTypes = [];
  const extraPool = [...detected, ...EXTRA_DEFAULTS[office ? 'office' : 'other']];
  for (const t of extraPool) {
    if (extraTypes.length >= 2) break;
    if (used.has(t) || extraTypes.includes(t) || !SLOTS[t]) continue;
    extraTypes.push(t);
  }
  for (const t of extraTypes) {
    used.add(t);
    const question = extraQuestion(t, name, office);
    const parts = [lead(t === 'specialty' ? services.slice(0, 3) : [])];
    if (t !== 'specialty' && services.length) parts.push(servicesLine(services));
    let s;
    if (t === 'price' && price) {
      parts.push(`Prices: ${price}.`);
      s = { text: '', slot: null, complete: true };
    } else {
      s = slotPart(t);
    }
    if (!wordsUsed && words) { parts.push(words); wordsUsed = true; }
    parts.push(s.text, contact);
    push({ question, parts, slot: s.slot, complete: s.complete, fromScan: false, lost: false, intent: t });
  }
  // Where: facts we have, complete as it is.
  if (where) {
    const others = towns.filter((t) => t.toLowerCase() !== town.toLowerCase());
    const parts = office
      ? [`${name} is ${article(noun)} ${noun} based in ${where}.`, d.street ? `Our office is at ${[d.street, where].join(', ')}${d.zip ? ` ${d.zip}` : ''}.` : '', others.length ? `We also work with clients in ${joinAnd(others)}.` : '', contact]
      : [`${baseLead}.`, `We serve ${joinAnd(towns.length ? towns : [town])}${d.state ? `, ${d.state}` : ''}.`, contact];
    push({ question: office ? `Where is ${name} based?` : `What areas does ${name} serve?`, parts, slot: null, complete: true, fromScan: false, lost: false, intent: 'area' });
  }
  // How to start: only when there is a way to reach them.
  if (contact) {
    const parts = [
      `To get started with ${name}, ${article(noun)} ${noun}${where ? ` in ${where}` : ''}, ${phone && host ? `call ${phone} or visit ${host}` : phone ? `call ${phone}` : `visit ${host}`}.`,
      !office && hours ? `Hours: ${hours}.` : '',
      services.length ? servicesLine(services) : '',
    ];
    push({ question: `How do I get started with ${name}?`, parts, slot: null, complete: true, fromScan: false, lost: false, intent: 'start' });
  }

  return { kind, items, attributes, needs: items.filter((i) => !i.complete).length };
}

/** "Question\nAnswer\n\nQuestion\nAnswer": for a site builder's text box. */
export function faqPlainText(items) {
  return items.map((i) => `${i.question}\n${i.answer}`).join('\n\n');
}

/**
 * The FAQPage JSON-LD object: complete answers only, word for word as on the page. An answer still
 * waiting for the owner's detail is left out until it is done, so the code never carries a [bracket].
 */
export function faqJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.filter((i) => i.complete).map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })),
  };
}

/** <script type="application/ld+json"> … </script>, with every `<` escaped so a value can't close the tag. */
export function faqJsonLdScript(items) {
  return `<script type="application/ld+json">\n${JSON.stringify(faqJsonLd(items), null, 2).replace(/</g, '\\u003c')}\n</script>`;
}
