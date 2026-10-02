// The paid report's action plan: every fix merged into a short, ordered checklist, biggest impact
// first, each step with why it matters, who does it, how, and the text to paste.
// Built at serve time from the report's own data (src/lib/lock.js reportBody), so reports already
// stored get it too. Nothing is fetched or guessed; drafts the owner must finish say so in [brackets].
//
// What it fixes over the raw issue list (Oct 2 2026 review of a paid PR agency report):
//   - one FAQ step instead of one per lost question + "answer the 3 questions" + "no FAQ schema";
//   - one Google step instead of "not on Maps" + "complete your profile";
//   - one contact step instead of "no phone/address" + "add LocalBusiness schema";
//   - office businesses (agencies, firms) get no storefront, walk-in or "open now" advice, and the
//     lists AI read (rankings, directories) come first for them;
//   - "your title doesn't say what you do" is re-checked with the trade's other names ("PR" and
//     "public relations" for a PR agency) before it is shown;
//   - FAQ answers use the business's own homepage description, not a one-line template.

import { kindClass, ACRONYMS } from '../scanner/questions.js';
import { tradeWords, mentionsAny } from '../scanner/owner-checks.js';
import { businessDetails, napBlock, GBP_DESCRIPTION_MAX } from '../scanner/extract/fixes.js';
import { isDirectoryName } from './report-v2.js';

export const IMPACT_LABELS = Object.freeze({ high: 'Biggest impact', medium: 'Next', low: 'Quick extra' });
export const WHO_LABELS = Object.freeze({ you: 'You can do this', web: 'For whoever runs your website', both: 'You, with your web person' });

const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join('|')})\\b`, 'gi');
/** "Pr agency open now" → "PR agency open now". */
export function fixCase(s) {
  const t = String(s || '').replace(ACRONYM_RE, (m) => m.toUpperCase());
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const kindText = (s) => String(s || '').replace(ACRONYM_RE, (m) => m.toUpperCase());
// "a PR agency", "an SEO firm", "an HVAC company": an acronym takes the article of its first letter's sound.
const article = (w) => {
  const s = String(w || '');
  if (/^[A-Z]{2,}\b/.test(s)) return /^[AEFHILMNORSX]/.test(s) ? 'an' : 'a';
  return /^[aeiou]/i.test(s) ? 'an' : 'a';
};
const listJoin = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n, one, many) => (n === 1 ? one : many);
const ENGINE = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity', google_ai_mode: 'Google AI Mode' };

/** Sites that list businesses: a cited page here is a list the owner can get onto. */
const LIST_SITE_RE = /(^|\.)(yelp|angi|angieslist|bbb|homeadvisor|thumbtack|yellowpages|mapquest|porch|networx|manta|superpages|foursquare|buildzoom|houzz|birdeye|clutch|themanifest|goodfirms|upcity|designrush|expertise|sortlist|agencyspotter|odwyerpr|provokemedia|prweek|publicrelationsdatabase|communicationsmatch|aaaa|tripadvisor|nextdoor|avvo|justia|martindale|findlaw|lawyers|healthgrades|zocdoc|vitals|opentable|theknot|weddingwire)\.(com|org|net|co)$/i;
/** Never something to get "listed" on: social threads, job boards, press-release wires, encyclopedias. */
const NOT_A_LIST_RE = /(^|\.)(reddit|quora|facebook|instagram|linkedin|x|twitter|tiktok|youtube|wikipedia|glassdoor|indeed|4dayweek|ziprecruiter|publicnow|prnewswire|businesswire|globenewswire|einpresswire|google|apple|bing)\.(com|org|io|net)$/i;

const squash = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// A competitor's own website (5wpr.com for 5WPR, berlinrosen.com for BerlinRosen): nothing to get onto.
function isCompetitorSite(domain, entities) {
  if (LIST_SITE_RE.test(domain)) return false;
  const stem = squash(String(domain || '').replace(/\.[a-z.]+$/i, ''));
  if (stem.length < 3) return false;
  return entities.some((e) => [e.name, ...(e.aliases || [])].some((n) => {
    const s = squash(n);
    return s.length >= 3 && (stem === s || stem.startsWith(s) || s.startsWith(stem));
  }));
}

// The owner's own words for what they do: the homepage meta description, else the main heading.
function ownWords(report) {
  const m = report && report.siteCheck && report.siteCheck.meta;
  if (!m || typeof m !== 'object') return '';
  const pick = [m.description, m.h1].find((x) => typeof x === 'string' && x.trim().length >= 25);
  if (!pick) return '';
  let t = pick.replace(/\s+/g, ' ').trim();
  if (t.length > 240) t = t.slice(0, 240).replace(/\s+\S*$/, '') + '…';
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

// Does the homepage title, description or heading say what the business does? Re-checked here with
// the trade's other names, because stored reports used only the owner's exact words.
export function homepageSaysTrade(meta, trade) {
  if (!meta || typeof meta !== 'object') return null;
  const all = [meta.title, meta.description, meta.h1].filter((x) => typeof x === 'string').join(' \n ');
  if (!all.trim()) return typeof meta.mentionsTrade === 'boolean' ? meta.mentionsTrade : null;
  const words = tradeWords(trade);
  if (!words.length) return typeof meta.mentionsTrade === 'boolean' ? meta.mentionsTrade : null;
  return mentionsAny(all, words) || meta.mentionsTrade === true;
}

/**
 * buildActionPlan(report) → { kind, items: [{ id, impact, title, why, who, steps, copyText, sites?, from }] }
 * `kind`: 'professional' (an office: agency, firm), 'trade' (goes to the customer) or 'storefront'.
 * `from`: the stored issue kinds this step covers (every stored issue lands in exactly one step,
 * or is dropped on purpose: walk-in advice for an office).
 */
export function buildActionPlan(report) {
  const r = report || {};
  const b = r.business || {};
  const kind = kindClass(b.trade);
  const office = kind === 'professional';
  const d = businessDetails(b);
  const rawNoun = d.tradeNoun;
  d.tradeNoun = kindText(d.tradeNoun);
  const name = d.name || 'your business';
  const noun = kindText(d.tradeNoun || 'business');
  const where = [d.town, d.state].filter(Boolean).join(', ');
  const issues = (r.issues || []).filter((i) => i && i.title);
  const used = new Set();
  const take = (pred) => issues.filter((i, n) => !used.has(n) && pred(i) && used.add(n));
  const answers = (r.answers || []).filter(Boolean);
  const lostAnswers = answers.filter((a) => !a.namedYou && a.ownerMatch !== 'unsure');
  const entities = (r.entities || []).filter((e) => e && !e.isYou);
  const topRivals = entities.filter((e) => (e.named || 0) >= 2 && !isDirectoryName(e.name))
    .sort((x, y) => (y.named || 0) - (x.named || 0)).slice(0, 3).map((e) => e.name);
  const own = d.websiteHost.toLowerCase();
  const words = ownWords(r);
  const items = [];

  // 1. What AI gets wrong, and AI being blocked: always first, each its own step.
  for (const i of take((x) => x.kind === 'fact_differs' || x.kind === 'listing_differs' || x.kind === 'listing_mismatch')) {
    items.push({ id: `fact-${items.length}`, impact: 'high', title: i.title, why: `${i.description ? `${i.description} ` : ''}AI repeats what it reads, so customers get the wrong details until every source matches.`, who: 'you', steps: i.steps || [], copyText: i.copyText || [], from: [i.kind] });
  }
  for (const i of take((x) => x.kind === 'site_blocks_ai')) {
    items.push({ id: 'unblock', impact: 'high', title: i.title, why: `${i.description || ''} AI can’t recommend what it isn’t allowed to read.`.trim(), who: 'web', steps: i.steps || [], copyText: i.copyText || [], from: [i.kind] });
  }

  // 2. The lists AI read when it named someone else. Checked "not listed" first, then cited lists we
  //    couldn't read (the owner checks those). Competitors' own sites, job boards and wires are left out.
  const notListed = take((x) => x.kind === 'not_listed');
  const lostIds = new Set(lostAnswers.map((a) => a.id));
  const sites = [];
  for (const s of r.sources || []) {
    if (!s || !s.domain || s.youListed === true) continue;
    const dom = String(s.domain).toLowerCase().replace(/^www\./, '');
    if (dom === own || NOT_A_LIST_RE.test(dom) || isCompetitorSite(dom, entities)) continue;
    const lostIn = (s.citedIn || []).filter((id) => lostIds.has(id));
    if (!lostIn.length) continue;
    if (s.youListed !== false && !LIST_SITE_RE.test(dom) && !/rank|best|top|list|director|agencies|firms|companies/i.test(String(s.url || ''))) continue;
    if (sites.some((x) => x.domain === dom)) continue;
    const engines = [...new Set(lostIn.map((id) => (answers.find((a) => a.id === id) || {}).engine).filter(Boolean))].map((e) => ENGINE[e] || e);
    // A rival's profile page on a directory (aaaa.org/agency-profile/…/edelman-new-york): send the owner
    // to the site itself, not to the rival's page.
    const path = squash(String(s.url || '').replace(/^https?:\/\/[^/]+/i, ''));
    const rivalPage = entities.some((e) => { const n = squash(e.name); return n.length >= 4 && !isDirectoryName(e.name) && path.includes(n); });
    sites.push({ domain: dom, url: rivalPage || !s.url ? `https://${dom}/` : s.url, status: s.youListed === false ? 'missing' : 'check', engines, count: lostIn.length, topListed: s.topListed || null });
  }
  sites.sort((x, y) => (x.status === 'missing' ? 0 : 1) - (y.status === 'missing' ? 0 : 1) || y.count - x.count);
  if (sites.length) {
    const shown = sites.slice(0, 8);
    const missing = shown.filter((s) => s.status === 'missing').length;
    items.push({
      id: 'lists',
      impact: 'high',
      title: `Get on the ${shown.length} ${plural(shown.length, 'list', 'lists')} AI read when it picked other ${office ? 'firms' : 'businesses'}`,
      why: `When AI named ${topRivals.length ? listJoin(topRivals) : 'other businesses'} instead of you, it read ${plural(shown.length, 'this page', 'these pages')}. ${missing ? `You’re not on ${missing === shown.length ? (missing === 1 ? 'it' : 'any of them') : `${missing} of them`}. ` : ''}Being on the lists AI reads is the most direct way into its answer.`,
      who: 'you',
      steps: [
        `Open each page below and search it for ${name}.${shown.some((s) => s.status === 'check') ? ' Pages marked “Check” we couldn’t read, so look for yourself.' : ''}`,
        'If you’re listed, claim the listing (look for “claim this profile” or similar) and make every detail match the block below.',
        office
          ? 'If you’re not, look for “add your company”, “get listed” or “submit”. Industry lists and awards usually have an entry form or a yearly deadline: note it and put it in your calendar.'
          : 'If you’re not, look for “add your business” or “get listed” and create the listing with the details below.',
        'Use the same name, website and description everywhere, word for word.',
      ],
      copyText: listingCopy(d, noun, where, words),
      sites: shown,
      from: notListed.length ? ['not_listed'] : [],
    });
  } else if (notListed.length) {
    for (const i of notListed) items.push({ id: `list-${items.length}`, impact: 'high', title: i.title, why: `${i.description || ''} AI read this page when it named someone else.`.trim(), who: 'you', steps: i.steps || [], copyText: i.copyText || [], from: [i.kind] });
  }

  // 3. One FAQ step for every question AI didn't name them for (+ the baseline FAQ and FAQ schema).
  const lostQ = take((x) => x.kind === 'lost_question');
  const faqBase = take((x) => x.kind === 'baseline_faq');
  const faqSchema = take((x) => x.kind === 'site_no_faq_schema');
  const qs = (r.questions || []).filter((q) => q && q.text)
    // An office has no "open now": the question was a scan mistake for them (scanner/questions.js PROFESSIONAL).
    .filter((q) => !(office && (q.intent === 'urgent' || /\bopen now\b/i.test(q.text))));
  const lostQs = qs.filter((q) => lostAnswers.some((a) => a.questionId === q.id));
  if (qs.length && (lostQ.length || faqBase.length || faqSchema.length)) {
    const pairs = qs.map((q) => ({ q: fixCase(q.text), a: draftAnswer({ d, noun, where, words, intent: q.intent, office }) }));
    const named = new Set();
    for (const a of lostAnswers) for (const x of a.businessesNamed || []) if (x && !x.isYou && x.name) named.add(x.name);
    items.push({
      id: 'faq',
      impact: lostQs.length ? 'high' : 'medium',
      title: lostQs.length
        ? `Answer the ${lostQs.length} ${plural(lostQs.length, 'question', 'questions')} AI didn’t name you for, on your website`
        : 'Answer your customers’ questions on your website',
      why: lostQs.length
        ? `AI was asked ${listJoin(lostQs.map((q) => `“${fixCase(q.text)}”`))} and named ${named.size ? `${named.size} other ${plural(named.size, 'business', 'businesses')}` : 'others'}, not you. A page that answers those exact questions, in your words, gives AI something to quote.`
        : 'A page that answers the questions customers ask, in your words, gives AI something to quote.',
      who: 'both',
      steps: [
        'Add a “Questions” section to your website: a new page, or the bottom of your homepage.',
        'Paste the questions and answers below. Replace every part in [brackets] with something true and specific (a client, a result, a specialty), then delete the brackets.',
        'Ask whoever runs your website to add the FAQ code below to the same page, with your final answers in it word for word.',
        'Check it at search.google.com/test/rich-results: it should find an FAQ.',
      ],
      copyText: [
        { label: 'Questions and answers for your website (fill in the brackets)', text: pairs.map((p) => `${p.q}\n${p.a}`).join('\n\n') },
        { label: 'FAQ code for your web person (JSON-LD)', text: faqJsonLd(pairs), format: 'code' },
      ],
      from: [...new Set([...lostQ, ...faqBase, ...faqSchema].map((i) => i.kind))],
    });
  } else {
    for (const i of [...lostQ, ...faqBase, ...faqSchema]) items.push(passThrough(i, rawNoun, d.tradeNoun));
  }

  // 4. Homepage says what you do and where (re-checked), plus a page for the towns you serve.
  const meta = take((x) => x.kind === 'site_title_meta');
  const thin = take((x) => x.kind === 'site_thin_pages');
  const m = r.siteCheck && r.siteCheck.meta;
  const saysTrade = homepageSaysTrade(m, b.trade);
  const saysTown = m && typeof m.mentionsTown === 'boolean' ? m.mentionsTown : null;
  const missWhat = meta.length && saysTrade === false;
  const missWhere = meta.length && saysTown !== true;
  if (missWhat || missWhere || thin.length) {
    const gaps = [missWhat && 'what you do', missWhere && 'where you work'].filter(Boolean);
    const steps = [];
    const copy = [];
    if (gaps.length) {
      if (m && typeof m.title === 'string' && m.title) steps.push(`Your page title now: “${m.title}”.`);
      steps.push(missWhat
        ? `Change your page title and main heading so they say ${listJoin(gaps)}. Keep it under about 60 characters.`
        : `Add “${d.town || 'your town'}” to your page title and your main heading. Keep the title under about 60 characters.`);
      steps.push('In most site builders this is under “SEO title” and “meta description”; or send this step to whoever runs your website.');
      const title = missWhat
        ? `${fixCase(noun)} in ${d.town || where} | ${name}`
        : (m && typeof m.title === 'string' && m.title && `${m.title} | ${d.town}`.length <= 65 ? `${m.title} | ${d.town}` : `${fixCase(noun)} in ${d.town || where} | ${name}`);
      copy.push({ label: 'Suggested page title', text: title });
    }
    if (thin.length) {
      steps.push(`Add a page about ${office ? 'the clients and places you serve' : 'the towns you serve'}, starting with ${d.town || 'your main town'}, and link to it from your menu or footer.`);
    }
    items.push({
      id: 'homepage',
      impact: missWhat ? 'high' : 'medium',
      title: gaps.length ? `Make your homepage say ${listJoin(gaps)}` : `Add a page for ${d.town || 'the towns you serve'}`,
      why: gaps.length
        ? `AI matches a business to a search like “${kindText(noun)} in ${d.town || 'your town'}” by reading the top of its homepage. Yours doesn’t say ${listJoin(gaps)}.`
        : `A page about one place gives AI a page that answers “${kindText(noun)} in ${d.town || 'your town'}” directly.`,
      who: 'web',
      steps,
      copyText: copy,
      from: [...new Set([...meta, ...thin].map((i) => i.kind))],
    });
  }

  // 5. Google: one step for "not found" + "complete your profile".
  const gMissing = take((x) => x.kind === 'google_missing');
  const gBase = take((x) => x.kind === 'baseline_gbp');
  if (gMissing.length || gBase.length) {
    const missingG = gMissing.length > 0;
    const desc = profileDescription(d, noun, where, words);
    items.push({
      id: 'google',
      impact: missingG && !office ? 'high' : missingG ? 'medium' : 'low',
      title: missingG ? (office ? 'Create your Google Business Profile' : 'Get on Google Maps') : 'Make your Google Business Profile complete',
      why: missingG
        ? (office
          ? `We couldn’t find a Google profile for ${name}. Google and Gemini use it to confirm a firm is real and where it works.`
          : `We couldn’t find ${name} on Google Maps. AI assistants lean on Google Maps for local answers.`)
        : 'AI and Google read your profile for your services and contact details; it should say exactly what your website says.',
      who: 'you',
      steps: [
        `Search Google for “${[name, d.town].filter(Boolean).join(' ')}”. If a profile shows that you don’t manage, use “Claim this business” on it.`,
        'If there is none, create one at business.google.com with your exact name, website and phone.',
        office
          ? 'If clients don’t visit your office, choose to hide your address and set the area you serve instead.'
          : (d.hours ? `Set your hours to match your website: ${d.hours}.` : 'Add your opening hours, the same as on your website.'),
        `Choose the category closest to “${kindText(noun)}”, then add each service you offer by name.`,
        `Paste the description below (it’s under Google’s ${GBP_DESCRIPTION_MAX}-character limit) and fill in the brackets.`,
        office ? 'Add a few photos of your team and your work.' : 'Add a few recent photos of your storefront and your work.',
      ],
      copyText: [
        desc && { label: 'Google profile description (fill in the brackets)', text: desc },
        napBlock(d) && { label: 'Your details, written the same everywhere', text: napBlock(d) },
      ].filter(Boolean),
      from: [...new Set([...gMissing, ...gBase].map((i) => i.kind))],
    });
  }

  // 6. Contact details + business code on the website: one step.
  const nap = take((x) => x.kind === 'site_missing_nap');
  const schema = take((x) => x.kind === 'baseline_schema');
  if (nap.length || schema.length) {
    const code = (schema[0] && (schema[0].copyText || []).find((c) => c && c.format === 'code')) || null;
    items.push({
      id: 'contact',
      impact: 'medium',
      title: nap.length ? 'Put your phone, address and business code on your website' : 'Add or check the business code on your website',
      why: nap.length
        ? 'We couldn’t find your phone number or address on your homepage. AI checks your own website first when it decides whether details it read elsewhere are right.'
        : 'A small block of code states your name and contact details in a form AI tools read directly.',
      who: 'web',
      steps: [
        nap.length && `Put your phone number${office ? '' : ' and street address'} as plain text in the footer of every page${office ? ' (add your office address if clients can visit)' : ''}, written the same as on Google.`,
        nap.length && 'Make the phone number a tap-to-call link.',
        code && 'Ask whoever runs your website to add the code below to your homepage’s <head> section, with your phone and address filled in.',
        code && 'Check it at validator.schema.org: it should read your name and contact details.',
      ].filter(Boolean),
      copyText: code ? [{ ...code, label: 'Business code for your web person (JSON-LD)' }] : [],
      from: [...new Set([...nap, ...schema].map((i) => i.kind))],
    });
  }

  // 7. Everything else, as stored (reviews, https, speed, llms.txt, anything new).
  for (const i of take(() => true)) items.push(passThrough(i, rawNoun, d.tradeNoun));

  // Order: impact, then the order that matters most for this kind of business.
  const rank = office
    ? ['fact', 'unblock', 'lists', 'list', 'homepage', 'faq', 'google', 'contact']
    : ['fact', 'unblock', 'google', 'lists', 'list', 'faq', 'homepage', 'contact'];
  const pos = (it) => { const k = rank.findIndex((p) => it.id === p || it.id.startsWith(`${p}-`)); return k < 0 ? rank.length : k; };
  const imp = { high: 0, medium: 1, low: 2 };
  const ordered = items.map((it, n) => ({ it, n }))
    .sort((x, y) => imp[x.it.impact] - imp[y.it.impact] || pos(x.it) - pos(y.it) || x.n - y.n)
    .map((x) => x.it);
  return { kind, items: ordered };
}

// A stored fix as one step. Stored text wrote the trade in lower case ("a pr agency"): fixed here.
function passThrough(i, rawNoun = '', noun = '') {
  const fix = (t) => (rawNoun && noun && rawNoun !== noun ? String(t).split(rawNoun).join(noun) : t);
  i = { ...i, title: fix(i.title), description: i.description && fix(i.description), steps: (i.steps || []).map(fix), copyText: (i.copyText || []).map((c) => (c && typeof c.text === 'string' ? { ...c, text: fix(c.text) } : c)) };
  const impact = i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : 'low';
  const web = /^site_/.test(String(i.kind || ''));
  return { id: `${i.kind || 'fix'}-${String(i.title).slice(0, 24).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, impact, title: i.title, why: i.description || '', who: web ? 'web' : 'you', steps: i.steps || [], copyText: i.copyText || [], from: [i.kind || null] };
}

// A draft answer: the real details we have, the owner's own homepage words, and [brackets] for the
// specifics only they know. Never presented as finished.
function draftAnswer({ d, noun, where, words, intent, office }) {
  const lead = `${d.name || 'We'} ${d.name ? 'is' : 'are'} ${article(noun)} ${kindText(noun)}${where ? ` in ${where}` : ''}.`;
  const facts = [d.services && `Services: ${d.services}.`, !office && d.hours && `Hours: ${d.hours}.`, intent === 'price' && d.price && `Prices: ${d.price}.`].filter(Boolean);
  const proof = {
    best: office ? '[Name a specialty, a client you can mention, or a result: “We got X featured in Y.”]' : '[Say what you’re known for: a specialty, a guarantee, or how long you’ve served the area.]',
    job: office ? '[Name the kinds of clients and projects you take on, and one example.]' : '[Name the jobs you do most and one recent example.]',
    trust: '[Mention reviews, awards or how long you’ve been in business.]',
    price: '[Say how you price: a starting price, a typical range, or “free quote”.]',
    urgent: '[Say how fast you can help and how to reach you now.]',
  }[intent] || '[Add one specific reason to pick you.]';
  const contact = d.phone ? `Call ${d.phone}${d.websiteUrl ? ` or visit ${d.websiteUrl}` : ''}.` : d.websiteUrl ? `Visit ${d.websiteUrl}.` : '';
  return [lead, words, ...facts, proof, contact].filter(Boolean).join(' ');
}

function profileDescription(d, noun, where, words) {
  const parts = [
    `${d.name} is ${article(noun)} ${kindText(noun)}${where ? ` in ${where}` : ''}.`,
    words,
    d.services && `Services: ${d.services}.`,
    '[Add who you work with and one result you’re proud of.]',
  ].filter(Boolean);
  let out = '';
  for (const p of parts) { const next = out ? `${out} ${p}` : p; if (next.length > GBP_DESCRIPTION_MAX) break; out = next; }
  return d.name ? out : '';
}

function listingCopy(d, noun, where, words) {
  const out = [];
  const nap = napBlock(d);
  if (nap) out.push({ label: 'Your details, written the same everywhere', text: nap });
  const desc = profileDescription(d, noun, where, words);
  if (desc) out.push({ label: 'Short description for listings (fill in the brackets)', text: desc });
  return out;
}

function faqJsonLd(pairs) {
  const o = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map((p) => ({ '@type': 'Question', name: p.q, acceptedAnswer: { '@type': 'Answer', text: p.a } })),
  };
  return `<script type="application/ld+json">\n${JSON.stringify(o, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}
