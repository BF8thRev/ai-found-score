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
//   - FAQ answers use the business's own homepage description, not a one-line template;
//   - the FAQ is the Fix Kit's own (shared/faq.js): the same questions and answers in the report and the kit;
//   - website steps say where to click on the owner's own site builder (siteCheck.platform, shared/platforms.js:
//     "In Wix: …" with Wix's own guide linked), and keep the generic steps when we don't know it.

import { kindClass, ACRONYMS } from '../scanner/questions.js';
import { tradeWords, mentionsAny } from '../scanner/owner-checks.js';
import { businessDetails, napBlock, GBP_DESCRIPTION_MAX } from '../scanner/extract/fixes.js';
import { isDirectoryName } from './report-v2.js';
import { faqPlainText, faqJsonLdScript } from './faq.js';
import { reportFaq } from '../src/lib/fix-kit.js';
import { platformFor, platformJob, platformStep, guideLinks } from './platforms.js';

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
const LIST_SITE_RE = /(^|\.)(yelp|angi|angieslist|bbb|homeadvisor|thumbtack|yellowpages|mapquest|porch|networx|manta|superpages|foursquare|buildzoom|houzz|birdeye|clutch|themanifest|goodfirms|upcity|designrush|expertise|sortlist|agencyspotter|odwyerpr|provokemedia|prweek|publicrelationsdatabase|communicationsmatch|tripadvisor|nextdoor|avvo|justia|martindale|findlaw|lawyers|healthgrades|zocdoc|vitals|opentable|theknot|weddingwire)\.(com|org|net|co)$/i;
/** Never something to get "listed" on: social threads, job boards, press-release wires, encyclopedias. */
const NOT_A_LIST_RE = /(^|\.)(aaaa|ana|iabc|prsa|reddit|quora|facebook|instagram|linkedin|x|twitter|tiktok|youtube|wikipedia|glassdoor|indeed|4dayweek|ziprecruiter|publicnow|prnewswire|businesswire|globenewswire|einpresswire|google|apple|bing)\.(com|org|io|net)$/i;

// A short, stable id from text: a saved tick stays on its step even when other steps come and go.
function hashId(prefix, text) {
  let h = 5381;
  for (const ch of String(text || '')) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `${prefix}-${h.toString(36)}`;
}

/** Industry lists and awards: entered by submission, not by claiming a profile. */
const AWARD_SITE_RE = /(^|\.)(odwyerpr|provokemedia|prweek|holmesreport|prnewsonline|adweek|adage)\.(com|org)$/i;
/**
 * How a cited page is joined: 'directory' (claim or add a profile), 'award' (an industry list or award,
 * entered by submission) or 'article' (a "best of" post or blog: ask the writer).
 */
export function siteType(domain, url = '', { trade = '' } = {}) {
  const dom = String(domain || '').toLowerCase();
  if (AWARD_SITE_RE.test(dom)) return 'award';
  if (LIST_SITE_RE.test(dom)) return 'directory';
  let path = '';
  try { path = new URL(String(url)).pathname.toLowerCase(); } catch { path = ''; }
  if (/(^|\/)(awards?|rankings?)(\/|-|$)/.test(path)) return 'award';
  // A post: a dated or blog path, or a "best/top N" headline.
  if (/(^|\/)(blog|news|posts?|articles?|stories)(\/|$)|\/(19|20)\d\d\/|(^|[/-])(best|top)(-\d+)?-|(^|[/-])(guides?|tips|how-to|costs?|prices?|vs|reviews?)([/-]|$)/.test(path)) return 'article';
  // A listings page: directory words, or the trade itself in the path (/massapequa-ny/plumbers).
  const tradeWord = squash(String(trade).split(/\s+/).pop() || '').replace(/(ing|er|ers|s)$/, '');
  if (/(^|[/-])(director(y|ies)|listings?|find|near|businesses|companies|agencies|firms|pros|contractors|services)([/-]|$)/.test(path)
    || (tradeWord.length >= 3 && squash(path).includes(tradeWord))) return 'directory';
  return 'unsure';
}

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
 * buildActionPlan(report) → { kind, items: [{ id, impact, title, why, who, steps, copyText, sites?, kitNote?, time?, cost?, week?, platform?, from }], kitOnly?, platform? }
 * `platform` on a step: { name, guides: [{ label, url }] }, the site builder's own help pages for the steps
 * written for it; on the plan: { id, name }, the builder the owner's site is made with (unknown: absent).
 * `kind`: 'professional' (an office: agency, firm), 'trade' (goes to the customer) or 'storefront'.
 * `time`, `cost`: a rough, conservative estimate for the step; `week`: one the owner can finish this
 * week (the page's "Do these 3 this week"). `kitNote`: the Fix Kit already has this step's file.
 * `kitOnly`: stored issue kinds handled only by a Fix Kit file (llms.txt), with no step of their own.
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
  // The site builder, when we know it: its own click-paths replace "in most site builders".
  const pf = platformFor(r);
  const job = (j) => platformJob(pf, j);
  const withGuides = (jobs) => { const guides = pf ? guideLinks(pf, jobs) : []; return guides.length ? { platform: { name: pf.name, guides } } : {}; };
  const told = (e, opts) => (e.can === false ? `In ${pf.name}: ${e.steps}` : platformStep(pf, e, opts));

  // 1. What AI gets wrong, and AI being blocked: always first, each its own step.
  for (const i of take((x) => x.kind === 'fact_differs' || x.kind === 'listing_differs' || x.kind === 'listing_mismatch')) {
    items.push({ id: hashId('fact', i.title), impact: 'high', title: i.title, why: `${i.description ? `${i.description} ` : ''}AI repeats what it reads, so customers get the wrong details until every source matches.`, who: 'you', steps: i.steps || [], copyText: i.copyText || [], time: 'About half an hour', cost: 'No cost', week: true, from: [i.kind] });
  }
  for (const i of take((x) => x.kind === 'site_blocks_ai')) {
    // On a known builder: its AI-crawler setting first, then where its robots.txt is edited (or that it can't be).
    const own = ['aiCrawlers', 'robots'].map((j) => job(j) && told(job(j))).filter(Boolean);
    items.push({ id: 'unblock', impact: 'high', title: i.title, why: `${i.description || ''} AI can’t recommend what it isn’t allowed to read.`.trim(), who: 'web', steps: [...own, ...(i.steps || [])], copyText: i.copyText || [], time: 'Under half an hour for your web person', cost: 'No cost', week: true, ...withGuides(['aiCrawlers', 'robots']), from: [i.kind] });
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
    const type = siteType(dom, s.url, { trade: b.trade });
    sites.push({ domain: dom, url: rivalPage || !s.url ? `https://${dom}/` : s.url, type, status: s.youListed === false ? 'missing' : 'check', engines, count: lostIn.length, topListed: s.topListed || null });
  }
  sites.sort((x, y) => (x.status === 'missing' ? 0 : 1) - (y.status === 'missing' ? 0 : 1) || y.count - x.count);
  // Directories (a free profile, this week) and industry lists/awards (entries, often yearly, fees,
  // size rules) are different jobs: two steps.
  const shown = sites.filter((x) => x.type !== 'award').slice(0, 8);
  const awards = sites.filter((x) => x.type === 'award').slice(0, 4);
  const rivalsText = topRivals.length ? listJoin(topRivals) : `other ${office ? 'firms' : 'businesses'}`;
  if (shown.length) {
    const missing = shown.filter((s) => s.status === 'missing').length;
    items.push({
      id: 'lists',
      impact: 'high',
      title: `Get on the ${shown.length} ${shown.some((x) => x.type === 'directory' || x.type === 'unsure') ? plural(shown.length, 'list', 'lists') : plural(shown.length, 'page', 'pages')} AI read when it picked other ${office ? 'firms' : 'businesses'}`,
      why: `When AI named ${rivalsText} instead of you, it read ${plural(shown.length, 'this page', 'these pages')}. ${missing ? `You’re not on ${missing === shown.length ? (missing === 1 ? 'it' : 'any of them') : `${missing} of them`}. ` : ''}Being on the pages AI reads gives it a reason to include you.`,
      who: 'you',
      steps: [
        `Open each page below and search it for ${name}.${shown.some((s) => s.status === 'check') ? ' Pages marked “Not checked yet” we couldn’t read, so look for yourself.' : ''}`,
        ...(shown.some((x) => x.type === 'directory')
          ? [`Directories: if you’re listed, claim the profile (look for “claim this profile” or similar) and make every detail match the block below; if you’re not, use “add your ${office ? 'company' : 'business'}” or “get listed”. A basic profile costs nothing; you don’t need the paid upgrades. Then ask two or three happy ${office ? 'clients' : 'customers'} to leave a review there.`]
          : []),
        ...(shown.some((x) => x.type === 'unsure')
          ? [`Pages marked “Other”: if it lists ${office ? 'firms' : 'businesses'} you can join, add yours; if it’s an article, contact the writer as below.`]
          : []),
        ...(shown.some((x) => x.type === 'article' || x.type === 'unsure')
          ? [`Articles and “best of” posts: find the writer or the site’s contact page and send a short note: who you are, what makes you a fit, and one ${office ? 'client result' : 'happy customer'}. Ask to be considered when they update it.`]
          : []),
        'Use the same name, website and description everywhere, word for word.',
      ],
      copyText: listingCopy(d, noun, where, words),
      sites: shown,
      ...(shown.some((x) => x.type === 'directory')
        ? { time: 'Under half an hour per site', cost: 'No cost for a basic profile', week: true }
        : { time: 'Under half an hour per site', cost: 'No cost', week: true }),
      from: notListed.length ? ['not_listed'] : [],
    });
  }
  if (awards.length) {
    items.push({
      id: 'awards',
      impact: 'medium',
      title: `Put the entry dates for ${awards.length === 1 ? 'the industry list' : `the ${awards.length} industry lists`} AI read in your calendar`,
      why: `AI also read ${listJoin(awards.map((s) => s.domain))} when it named ${rivalsText} instead of you. Industry lists and awards like ${plural(awards.length, 'this', 'these')} take entries, often once a year and sometimes with a fee or a size rule, so this is for the next round, not a job for this week.`,
      who: 'you',
      steps: [
        'Open each page below and find how to enter: look for “submit”, “enter”, “nominate” or “methodology”.',
        'Check that you qualify (some need a minimum size or fee income) and what it costs to enter.',
        'Put the next deadline in your calendar, with a reminder two weeks before.',
        `When you enter, use the same name, website and description as everywhere else.`,
      ],
      copyText: [],
      sites: awards,
      time: 'About half an hour to find the dates',
      cost: 'Some charge to enter',
      week: false,
      from: !shown.length && notListed.length ? ['not_listed'] : [],
    });
  }
  if (!shown.length && !awards.length && notListed.length) {
    for (const i of notListed) items.push({ id: hashId('list', i.title), impact: 'high', title: i.title, why: `${i.description || ''} AI read this page when it named someone else.`.trim(), who: 'you', steps: i.steps || [], copyText: i.copyText || [], time: 'Under half an hour', cost: 'No cost for a basic profile', week: true, from: [i.kind] });
  }

  // 3. One FAQ step for every question AI didn't name them for (+ the baseline FAQ and FAQ schema).
  const lostQ = take((x) => x.kind === 'lost_question');
  const faqBase = take((x) => x.kind === 'baseline_faq');
  const faqSchema = take((x) => x.kind === 'site_no_faq_schema');
  const qs = (r.questions || []).filter((q) => q && q.text)
    // An office has no "open now": the question was a scan mistake for them (scanner/questions.js PROFESSIONAL).
    .filter((q) => !(office && /\bopen now\b/i.test(q.text)));
  const lostQs = qs.filter((q) => lostAnswers.some((a) => a.questionId === q.id));
  if (qs.length && (lostQ.length || faqBase.length || faqSchema.length)) {
    // The same questions and answers as the Fix Kit's Questions page (shared/faq.js, built from the
    // details the kit starts with), so the report and the kit never disagree.
    const faq = reportFaq(r);
    // The rivals named most in the answers to these questions (directories left out). Names, not a
    // count: AI writes one firm several ways ("5WPR", "5W Public Relations"), so a count overstates.
    const lostQIds = new Set(lostQs.map((q) => q.id));
    const hits = new Map();
    for (const a of lostAnswers) {
      if (!lostQIds.has(a.questionId)) continue;
      for (const x of a.businessesNamed || []) {
        const e = x && !x.isYou && entities.find((y) => y.id === x.entityId);
        if (e && !isDirectoryName(e.name)) hits.set(e.name, (hits.get(e.name) || 0) + 1);
      }
    }
    const rivals = [...hits].sort((x, y) => y[1] - x[1]).slice(0, 3).map((x) => x[0]);
    const rivalText = !rivals.length ? 'other businesses' : hits.size > rivals.length ? `${rivals.join(', ')} and others` : listJoin(rivals);
    const fq = job('faq');
    const hc = job('headCode');
    // The FAQ code: skipped when the builder's FAQ block writes it; else where it goes on this builder.
    const codeSteps = fq && fq.schema === true
      ? []
      : [
        'Ask whoever runs your website to add the FAQ code below to the same page. The code must say exactly what the page says, so it holds only the finished answers: add each of the others to it once it’s filled in.',
        ...(hc ? [hc.can === false ? told(hc) : `For the code, ${told(hc, { page: true }).replace(/^In /, 'in ')}`] : []),
        'Check the page at validator.schema.org: it should read each question and answer.',
      ];
    items.push({
      id: 'faq',
      impact: lostQs.length ? 'high' : 'medium',
      title: lostQs.length
        ? `Answer the ${lostQs.length} ${plural(lostQs.length, 'question', 'questions')} AI didn’t name you for, on your website`
        : 'Answer your customers’ questions on your website',
      why: lostQs.length
        ? `AI was asked ${listJoin(lostQs.map((q) => `“${fixCase(q.text)}”`))} and named ${rivalText}, not you. A page that answers those exact questions, in your words, gives AI something to quote.`
        : 'A page that answers the questions customers ask, in your words, gives AI something to quote.',
      who: 'both',
      steps: [
        'Add a “Questions” section to your website: a new page, or the bottom of your homepage.',
        ...(fq ? [told(fq)] : []),
        ...(faq.needs
          ? [`Paste the questions and answers below. ${faq.needs === 1 ? 'One answer has' : `${faq.needs} answers have`} a part in [brackets] that only you know (a specialty, a client, a result): write one true sentence in its place, then delete the brackets.`]
          : ['Paste the questions and answers below.']),
        ...codeSteps,
      ],
      copyText: [
        { label: faq.needs ? 'Questions and answers for your website (fill in the brackets)' : 'Questions and answers for your website', text: faqPlainText(faq.items) },
        { label: 'FAQ code: the finished answers only (JSON-LD)', text: faqJsonLdScript(faq.items), format: 'code' },
      ],
      kitNote: 'Done for you: your Questions page and its code are ready in your Fix Kit. The kit asks you for each [bracket] detail and puts it into the page and the code for you.',
      time: 'About an hour for you, then 1–2 hours for your web person',
      cost: 'No cost',
      week: true,
      ...withGuides(fq && fq.schema === true ? ['faq'] : ['faq', 'headCode']),
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
    // An office says where it's based; "where you work" reads like a van's service area.
    const whereText = office ? (d.town ? `that you’re in ${d.town}` : 'where you’re based') : 'where you work';
    const gaps = [missWhat && 'what you do', missWhere && whereText].filter(Boolean);
    const steps = [];
    const copy = [];
    if (gaps.length) {
      steps.push(missWhat
        ? `Change your page title and main heading so they say ${listJoin(gaps)}. Keep it under about 60 characters.`
        : `Add ${d.town ? `“${d.town}”` : 'the town you work in'} to your page title and your main heading. Keep the title under about 60 characters.`);
      const t = job('title');
      steps.push(t ? told(t) : 'In most site builders this is under “SEO title” and “meta description”; or send this step to whoever runs your website.');
      const place = d.town || where;
      const base = place ? `${fixCase(noun)} in ${place} | ${name}` : `${fixCase(noun)} | ${name}`;
      const title = !missWhat && place && m && typeof m.title === 'string' && m.title && `${m.title} | ${place}`.length <= 65
        ? `${m.title} | ${place}`
        : base;
      copy.push({ label: 'Suggested page title', text: title });
    }
    if (thin.length) {
      steps.push(`Add a page about ${office ? 'the clients and places you serve' : 'the towns you serve'}, starting with ${d.town || 'your main town'}, and link to it from your menu or footer.`);
    }
    items.push({
      id: 'homepage',
      impact: missWhat ? 'high' : 'medium',
      title: gaps.length ? `Make your homepage say ${listJoin(gaps)}` : office ? 'Add a page about the clients and places you serve' : `Add a page for ${d.town || 'the towns you serve'}`,
      why: gaps.length
        ? `AI matches a business to a search like “${kindText(noun)} in ${d.town || 'your town'}” by reading the top of its homepage. Yours doesn’t say ${listJoin(gaps)}.${m && typeof m.title === 'string' && m.title ? ` Your page title now: “${m.title}”.` : ''}`
        : `A page about one place gives AI a page that answers “${kindText(noun)} in ${d.town || 'your town'}” directly.`,
      who: 'web',
      steps,
      copyText: copy,
      time: 'About half an hour for your web person',
      cost: 'No cost',
      week: true,
      ...(gaps.length ? withGuides(['title']) : {}),
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
      // A local business lives on Google Maps; an office firm less so.
      impact: missingG ? (office ? 'medium' : 'high') : (office ? 'low' : 'medium'),
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
          : kind === 'trade'
            ? `If customers don’t come to you, hide your address and set the towns you serve${d.town ? `, starting with ${d.town}` : ''}.`
            : (d.hours ? `Set your hours to match your website: ${d.hours}.` : 'Add your opening hours, the same as on your website.'),
        ...(kind === 'trade' ? [d.hours ? `Set your hours to match your website: ${d.hours}.` : 'Add your hours, the same as on your website.'] : []),
        `Choose the category closest to “${kindText(noun)}”, then add each service you offer by name.`,
        `Paste the description below (it’s under Google’s ${GBP_DESCRIPTION_MAX}-character limit) and fill in the brackets.`,
        office ? 'Add a few photos of your team and your work.' : kind === 'trade' ? 'Add a few recent photos of your jobs, your vans and your team.' : 'Add a few recent photos of your storefront and your work.',
      ],
      copyText: [
        desc && { label: 'Google profile description (fill in the brackets)', text: desc },
        napBlock(d) && { label: 'Your details, written the same everywhere', text: napBlock(d) },
      ].filter(Boolean),
      kitNote: 'Done for you: your Google profile text is ready in your Fix Kit. Check it and paste it in.',
      time: missingG ? 'About half an hour, then a few days for Google to verify you' : 'About half an hour',
      cost: 'No cost',
      week: true,
      from: [...new Set([...gMissing, ...gBase].map((i) => i.kind))],
    });
  }

  // 6. Contact details + business code on the website: one step.
  const nap = take((x) => x.kind === 'site_missing_nap');
  const schema = take((x) => x.kind === 'baseline_schema');
  if (nap.length || schema.length) {
    const code = (schema[0] && (schema[0].copyText || []).find((c) => c && c.format === 'code')) || null;
    // The stored code leaves out what we don't know; show where the phone (and street) go instead of
    // asking for them to be "filled in" to a block that has no place for them.
    const codeText = code ? withPlaceholders(String(code.text), { phone: d.phone, street: d.street, wantStreet: !office }) : '';
    const ft = nap.length ? job('footer') : null;
    const hc = code ? job('headCode') : null;
    items.push({
      id: 'contact',
      impact: 'medium',
      title: nap.length ? (office ? 'Put your phone number and business code on your website' : 'Put your phone, address and business code on your website') : 'Add or check the business code on your website',
      why: nap.length
        ? 'We couldn’t find your phone number or address on your homepage. AI checks your own website first when it decides whether details it read elsewhere are right.'
        : 'A small block of code states your name and contact details in a form AI tools read directly.',
      who: 'web',
      steps: [
        nap.length && `Put your phone number${office ? '' : ' and street address'} as plain text in the footer of every page${office ? ' (add your office address if clients can visit)' : ''}, written the same as on Google.`,
        nap.length && 'Make the phone number a tap-to-call link.',
        ft && told(ft),
        code && !(hc && hc.can === false) && `Ask whoever runs your website to add the code below to your homepage’s <head> section${/\[your /.test(codeText) ? ', after replacing each part in [brackets] with your real details' : ''}.`,
        hc && told(hc),
        code && !(hc && hc.can === false) && 'Check it at validator.schema.org: it should read your name and contact details.',
      ].filter(Boolean),
      copyText: code ? [{ ...code, text: codeText, label: 'Business code for your web person (JSON-LD)' }] : [],
      ...(code ? { kitNote: 'Done for you: this code is ready in your Fix Kit. Send it to whoever runs your website.' } : {}),
      ...withGuides([ft && 'footer', hc && 'headCode'].filter(Boolean)),
      time: 'About half an hour for your web person',
      cost: 'No cost',
      week: true,
      from: [...new Set([...nap, ...schema].map((i) => i.kind))],
    });
  }

  // 7. llms.txt is a file in the Fix Kit, not a step of its own: the kit card names it.
  const kitOnly = take((x) => x.kind === 'site_no_llms_txt').map((i) => i.kind);

  // 8. Everything else, as stored (reviews, https, speed, anything new).
  for (const i of take(() => true)) items.push(passThrough(i, rawNoun, d.tradeNoun));
  // An office never gets the "open now" question back through the fallback either.
  if (office) for (let n = items.length - 1; n >= 0; n--) if (items[n].from.includes('lost_question') && /\bopen now\b/i.test(items[n].title)) items.splice(n, 1);
  // Ids key the saved ticks: never two steps with one id.
  const seen = new Map();
  for (const it of items) { const k = seen.get(it.id) || 0; seen.set(it.id, k + 1); if (k) it.id = `${it.id}-${k + 1}`; }

  // Order: impact, then the order that matters most for this kind of business.
  const rank = office
    ? ['fact', 'unblock', 'lists', 'list', 'homepage', 'faq', 'awards', 'google', 'contact']
    : ['fact', 'unblock', 'google', 'few_reviews', 'lists', 'list', 'faq', 'homepage', 'awards', 'contact'];
  const pos = (it) => { const k = rank.findIndex((p) => it.id === p || it.id.startsWith(`${p}-`)); return k < 0 ? rank.length : k; };
  const imp = { high: 0, medium: 1, low: 2 };
  const ordered = items.map((it, n) => ({ it, n }))
    .sort((x, y) => imp[x.it.impact] - imp[y.it.impact] || pos(x.it) - pos(y.it) || x.n - y.n)
    .map((x) => x.it);
  return { kind, items: ordered, ...(kitOnly.length ? { kitOnly } : {}), ...(pf ? { platform: { id: pf.id, name: pf.name } } : {}) };
}

// A stored fix as one step. Stored text wrote the trade in lower case ("a pr agency"): fixed here.
function passThrough(i, rawNoun = '', noun = '') {
  const fix = (t) => (rawNoun && noun && rawNoun !== noun ? String(t).split(rawNoun).join(noun) : t);
  i = { ...i, title: fix(i.title), description: i.description && fix(i.description), steps: (i.steps || []).map(fix), copyText: (i.copyText || []).map((c) => (c && typeof c.text === 'string' ? { ...c, text: fix(c.text) } : c)) };
  const impact = i.severity === 'high' ? 'high' : i.severity === 'medium' ? 'medium' : 'low';
  const web = /^site_/.test(String(i.kind || ''));
  return { id: hashId(i.kind || 'fix', i.title), impact, title: i.title, why: i.description || '', who: web ? 'web' : 'you', steps: i.steps || [], copyText: i.copyText || [], ...(EFFORT[i.kind] || {}), from: [i.kind || null] };
}

// Rough time and cost for the stored fixes that pass through as they are. Conservative; a kind not
// listed shows none rather than a guess.
const EFFORT = {
  few_reviews: { time: 'Under half an hour to ask', cost: 'No cost', week: true },
  site_http_no_redirect: { time: 'Under half an hour for your web person', cost: 'No cost', week: true },
  site_no_https: { time: 'About an hour for your web person', cost: 'Often no cost; some hosts charge', week: false },
  site_slow: { time: 'A few hours for your web person, depending on the site', cost: 'Varies', week: false },
  lost_question: { time: 'About an hour for you, then 1–2 hours for your web person', cost: 'No cost', week: true },
  baseline_faq: { time: 'About an hour for you, then 1–2 hours for your web person', cost: 'No cost', week: true },
  site_no_faq_schema: { time: 'About half an hour for your web person', cost: 'No cost', week: true },
};

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

// LocalBusiness JSON-LD with a [placeholder] for the phone (and street) we don't know, so the web
// person sees where they go. Code we can't parse is returned as is.
function withPlaceholders(text, { phone = '', street = '', wantStreet = true } = {}) {
  const m = text.match(/^(\s*<script[^>]*>)([\s\S]*?)(<\/script>\s*)$/i);
  let o;
  try { o = JSON.parse(m ? m[2] : text); } catch { return text; }
  if (!o || typeof o !== 'object') return text;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = v;
    if (k === 'name' && !o.telephone) out.telephone = phone || '[your phone number]';
  }
  if (wantStreet && out.address && typeof out.address === 'object' && !out.address.streetAddress) {
    const { '@type': type, ...rest } = out.address;
    out.address = { '@type': type, streetAddress: street || '[your street address]', ...rest };
  }
  const json = JSON.stringify(out, null, 2).replace(/</g, '\\u003c');
  return m ? `${m[1].trim()}\n${json}\n</script>` : json;
}
