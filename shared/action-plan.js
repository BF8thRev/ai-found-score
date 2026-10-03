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
//   - the FAQ is the Fix Kit's own (shared/faq.js), and lives only in the kit: the report says how many
//     answers need a detail from the owner and links to the kit (Oct 2 2026 owner review), as does the business code;
//   - website steps say where to click on the owner's own site builder (siteCheck.platform, shared/platforms.js:
//     "In Wix: …" with Wix's own guide linked), and keep the generic steps when we don't know it.

import { kindClass, ACRONYMS } from '../scanner/questions.js';
import { tradeWords, mentionsAny } from '../scanner/owner-checks.js';
import { businessDetails, napBlock, GBP_DESCRIPTION_MAX, siteSpelling, spellingLine } from '../scanner/extract/fixes.js';
import { LIST_SITE_RE, NOT_A_LIST_RE, LIST_PATH_RE, CHECK_REASON_TEXT } from '../scanner/extract/sources.js';
import { isDirectoryName } from './report-v2.js';
import { joinFor, JOIN_LABELS } from './directories.js';
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

/**
 * How to join a cited site: shared/directories.js when we checked it on the site's own pages; else, for a
 * page we read, our best read of it (sources.js joinHints, marked guess); an article is editorial.
 * → { type, label, url, guess? } | null
 */
export function joinInfo(domain, type, guess) {
  const known = joinFor(domain);
  if (known) return known;
  if (type === 'article') return { type: 'editorial — can’t apply', label: JOIN_LABELS['editorial — can’t apply'], url: null };
  if (guess && typeof guess === 'object') {
    const label = guess.verdict === 'looks_free' ? 'Looks free to join (our best read)' : guess.verdict === 'has_fee' ? 'Looks like it charges (our best read)' : null;
    const url = typeof guess.url === 'string' && /^https?:\/\//i.test(guess.url) ? guess.url : null;
    if (label || url) return { type: 'unknown', label, url, guess: true };
  }
  return null;
}

const squash = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

// A competitor's own website (5wpr.com for 5WPR, berlinrosen.com for BerlinRosen): nothing to get onto.
export function isCompetitorSite(domain, entities) {
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
 * buildActionPlan(report) → { kind, items: [{ id, impact, title, why, who, needs, steps, copyText, sites?, kitNote?, kit?, time?, cost?, week?, platform?, from }], kitOnly?, platform? }
 * `needs`: { access, task, time }, the page's "Needs:" line (needsFor). `who` stays for the Fix Kit and old readers.
 * `platform` on a step: { name, guides: [{ label, url }] }, the site builder's own help pages for the steps
 * written for it; on the plan: { id, name }, the builder the owner's site is made with (unknown: absent).
 * `kind`: 'professional' (an office: agency, firm), 'trade' (goes to the customer) or 'storefront'.
 * `time`, `cost`: a rough, conservative estimate for the step; `week`: one the owner can finish this
 * week (the page's "Do these 3 this week"). `kitNote`: the Fix Kit already has this step's file.
 * `kit`: the step's work is a file already written in the Fix Kit, so the report links there instead of
 * pasting it: { file: 'questions', questions, fromScan, needs } (the Questions page and its code) or
 * { file: 'code', placeholders } (the business code). Text the owner pastes on other sites stays in copyText.
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
  // "PR73" on the website, "PR 73" in the request: one name in every block below, and a plain ask to pick one.
  const spelling = siteSpelling(r);
  if (spelling) d.name = spelling.use;
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
  //    couldn't read (the owner checks those, with the reason), then directories that already list
  //    them (check the details). Competitors' own sites, job boards and wires are left out.
  const notListed = take((x) => x.kind === 'not_listed');
  const lostIds = new Set(lostAnswers.map((a) => a.id));
  const sites = [];
  const httpsUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const searchRan = !!(r.method && r.method.listingSearch);
  for (const s of r.sources || []) {
    if (!s || !s.domain) continue;
    const dom = String(s.domain).toLowerCase().replace(/^www\./, '');
    if (dom === own || NOT_A_LIST_RE.test(dom) || isCompetitorSite(dom, entities)) continue;
    const lostIn = (s.citedIn || []).filter((id) => lostIds.has(id));
    if (!lostIn.length) continue;
    if (s.youListed !== false && !LIST_SITE_RE.test(dom) && !LIST_PATH_RE.test(String(s.url || ''))) continue;
    const type = siteType(dom, s.url, { trade: b.trade });
    // Already on a list or article: nothing to do there. Already on a directory: check the profile.
    if (s.youListed === true && type !== 'directory') continue;
    if (sites.some((x) => x.domain === dom)) continue;
    const engines = [...new Set(lostIn.map((id) => (answers.find((a) => a.id === id) || {}).engine).filter(Boolean))].map((e) => ENGINE[e] || e);
    // A rival's profile page on a directory (aaaa.org/agency-profile/…/edelman-new-york): send the owner
    // to the site itself, not to the rival's page.
    const path = squash(String(s.url || '').replace(/^https?:\/\/[^/]+/i, ''));
    const rivalPage = entities.some((e) => { const n = squash(e.name); return n.length >= 4 && !isDirectoryName(e.name) && path.includes(n); });
    // listed (we read it, or Google showed their profile there) / missing (we read the page: not on it) /
    // not_found (we couldn't read it; a Google search found no profile: never "you're not on it") / check.
    const sc = s.searchCheck && typeof s.searchCheck === 'object' ? s.searchCheck : null;
    const status = s.youListed === true ? 'listed' : s.youListed === false ? 'missing' : sc && sc.status === 'not_found' ? 'not_found' : 'check';
    const reason = status === 'check' && (sc && sc.status === 'error' ? 'the Google search for it didn’t answer' : CHECK_REASON_TEXT[s.checkReason]);
    // Reports made before the search check: a directory we couldn't read is searched on the next scan.
    const nextScan = status === 'check' && !searchRan && type === 'directory';
    const join = joinInfo(dom, type, s.joinGuess);
    const signUp = httpsUrl(s.addUrl) || (join && httpsUrl(join.url));
    sites.push({
      domain: dom, url: rivalPage || !s.url ? `https://${dom}/` : s.url, type, status, engines, count: lostIn.length, topListed: s.topListed || null,
      ...(status === 'listed' && httpsUrl(s.profileUrl) ? { profileUrl: s.profileUrl } : {}),
      ...(status === 'listed' && s.listedBy === 'search' ? { foundBy: 'search' } : {}),
      ...(status !== 'listed' && signUp ? { addUrl: signUp } : {}),
      ...(join && join.label ? { join: { label: join.label, type: join.type, ...(join.guess ? { guess: true } : {}) } } : {}),
      ...(reason ? { reason } : {}),
      ...(nextScan ? { nextScan: true } : {}),
    });
  }
  const order = { missing: 0, not_found: 1, check: 2, listed: 3 };
  sites.sort((x, y) => order[x.status] - order[y.status] || y.count - x.count);
  // Directories (a free profile, this week) and industry lists/awards (entries, often yearly, fees,
  // size rules) are different jobs: two steps.
  const shown = sites.filter((x) => x.type !== 'award').slice(0, 8);
  const awards = sites.filter((x) => x.type === 'award').slice(0, 4);
  const rivalsText = topRivals.length ? listJoin(topRivals) : `other ${office ? 'firms' : 'businesses'}`;
  if (shown.length) {
    const missing = shown.filter((s) => s.status === 'missing').length;
    const listed = shown.filter((s) => s.status === 'listed').length;
    const todo = shown.length - listed;
    const unread = shown.filter((s) => s.status === 'check').length;
    const waiting = shown.filter((s) => s.status === 'check' && s.nextScan).length;
    const notFound = shown.filter((s) => s.status === 'not_found').length;
    // What joining costs, from shared/directories.js: only the sentences that apply to these sites.
    const dirs = shown.filter((x) => x.type === 'directory' && x.status !== 'listed');
    const jt = (x) => (x.join && !x.join.guess ? x.join.type : 'unknown');
    const freeOnes = dirs.filter((x) => ['free profile', 'free basic, paid upgrades'].includes(jt(x)));
    const paidOnes = dirs.filter((x) => jt(x) === 'paid only');
    const unknownOnes = dirs.filter((x) => jt(x) === 'unknown');
    const costLine = [
      freeOnes.length ? ` ${freeOnes.length === dirs.length ? (dirs.length === 1 ? 'It has' : 'Each of these has') : `${listJoin(freeOnes.map((x) => x.domain))} ${freeOnes.length === 1 ? 'has' : 'have'}`} a free basic profile; you don’t need the paid upgrades.` : '',
      paidOnes.length ? ` ${listJoin(paidOnes.map((x) => x.domain))} ${paidOnes.length === 1 ? 'charges' : 'charge'} to be listed at all: decide whether it’s worth it for you.` : '',
      unknownOnes.length ? ` We couldn’t confirm what ${listJoin(unknownOnes.map((x) => x.domain))} ${unknownOnes.length === 1 ? 'charges' : 'charge'}: check before you sign up.` : '',
    ].join('');
    // Both spellings when the website and the request differ: a list may use either.
    const lookFor = spelling ? `“${spelling.site}” or “${spelling.typed}”` : name;
    const listWord = (n) => (shown.some((x) => x.type === 'directory' || x.type === 'unsure') ? plural(n, 'list', 'lists') : plural(n, 'page', 'pages'));
    items.push({
      id: 'lists',
      impact: 'high',
      title: todo
        ? `Get on the ${todo} ${listWord(todo)} AI read when it picked other ${office ? 'firms' : 'businesses'}`
        : `Check your ${plural(listed, 'profile', 'profiles')} on the ${listWord(listed)} AI read`,
      why: `When AI named ${rivalsText} instead of you, it read ${plural(shown.length, 'this page', 'these pages')}. ${missing ? `You’re not on ${missing === shown.length ? (missing === 1 ? 'it' : 'any of them') : `${missing} of them`}. ` : ''}${listed ? `You’re already on ${listed === shown.length ? (listed === 1 ? 'it' : 'all of them') : `${listed} of them`}: check the details match. ` : ''}Being on the pages AI reads gives it a reason to include you.`,
      who: 'you',
      steps: [
        ...(missing ? [`Pages marked “You’re not on it”: we read the page and didn’t find ${lookFor} or a link to your website.${shown.some((s) => s.status === 'missing' && s.addUrl) ? ` Use the “Add your ${office ? 'company' : 'business'}” link next to it.` : ''}`] : []),
        ...(notFound ? [`Sites marked “No profile found”: the site turns automated reads away, so we searched Google for ${lookFor} on ${notFound === 1 ? 'it' : 'each one'} and found no profile. Google may have missed it: search the site once yourself, and if you’re not there, ${shown.some((s) => s.status === 'not_found' && s.addUrl) ? `use the “Add your ${office ? 'company' : 'business'}” link next to it` : 'look for “add your company” or “get listed”'}.`] : []),
        ...(waiting ? [`Sites marked “Pending check”: ${shown.some((s) => s.nextScan && s.reason) ? `we couldn’t read ${waiting === 1 ? 'it' : 'them'} (the reason is next to ${waiting === 1 ? 'it' : 'each'})` : `we haven’t checked ${waiting === 1 ? 'it' : 'them'} for your name yet`}. Your next scan searches Google for your profile there for you; until then, open each one and search it for ${lookFor}.`] : []),
        ...(unread > waiting ? [`Sites marked “Couldn’t check”: we couldn’t check ${unread - waiting === 1 ? 'it' : 'them'} ourselves${shown.some((s) => s.status === 'check' && !s.nextScan && s.reason) ? ' (the reason is next to each)' : ''}, so open each one and search it for ${lookFor}.`] : []),
        ...(listed ? [`Sites marked “You’re listed”: open your profile${shown.some((s) => s.foundBy === 'search') ? ' (the link next to it is the one Google showed us)' : ''} and make every detail match the block below.`] : []),
        ...(dirs.length
          ? [`Directories: if you’re listed, claim the profile (look for “claim this profile” or similar) and make every detail match the block below; if you’re not, use “add your ${office ? 'company' : 'business'}” or “get listed”.${costLine} Then ask two or three happy ${office ? 'clients' : 'customers'} to leave a review there.`]
          : []),
        ...(shown.some((x) => x.type === 'unsure')
          ? [`Pages marked “Other”: if it lists ${office ? 'firms' : 'businesses'} you can join, add yours; if it’s an article, contact the writer as below.`]
          : []),
        ...(shown.some((x) => x.type === 'article' || x.type === 'unsure')
          ? [`Articles and “best of” posts: find the writer or the site’s contact page and send a short note: who you are, what makes you a fit, and one ${office ? 'client result' : 'happy customer'}. Ask to be considered when they update it.`]
          : []),
        spelling ? `${spellingLine(spelling)} Then use the same name, website and description everywhere, word for word.` : 'Use the same name, website and description everywhere, word for word.',
      ],
      copyText: listingCopy(d, noun, where, words),
      sites: shown,
      ...(shown.some((x) => x.type === 'directory')
        ? { time: 'Under half an hour per site', cost: paidOnes.length || unknownOnes.length ? (freeOnes.length ? 'No cost for the free ones; some may charge' : 'Some may charge') : 'No cost for a basic profile', week: true }
        : { time: 'Under half an hour per site', cost: 'No cost', week: true }),
      from: notListed.length ? ['not_listed'] : [],
    });
  }
  if (awards.length) {
    items.push({
      id: 'awards',
      impact: 'medium',
      title: `Later, not this week: enter ${awards.length === 1 ? 'the industry list' : `the ${awards.length} industry lists`} AI read when the next round opens`,
      why: `AI also read ${listJoin(awards.map((s) => s.domain))} when it named ${rivalsText} instead of you. Industry lists and awards like ${plural(awards.length, 'this', 'these')} take entries, often once a year and sometimes with a fee or a size rule, so this is for the next round, not a job for this week.`,
      who: 'you',
      steps: [
        ...(awards.some((s) => s.addUrl) ? [`Use the “How to enter” link next to ${awards.length === 1 ? 'it' : 'each'}: it’s the list’s own entry page.`] : []),
        ...(awards.some((s) => !s.addUrl) ? [`Open ${awards.some((s) => s.addUrl) ? 'the others' : awards.length === 1 ? 'the page below' : 'each page below'} and find how to enter: look for “submit”, “enter”, “nominate” or “methodology”.`] : []),
        awards.every((s) => s.join && s.join.type === 'submission/award with fee')
          ? `Check that you qualify (some need a minimum size or audited fee income). ${awards.length === 1 ? 'It charges' : 'Each of these charges'} to enter.`
          : 'Check that you qualify (some need a minimum size or fee income) and what it costs to enter.',
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
    // The Questions page and its code are written in the Fix Kit (the same questions and answers,
    // shared/faq.js): the report says so and links there instead of pasting the page and the code here.
    const where = [fq && told(fq), fq && fq.schema === true ? null : hc && (hc.can === false ? told(hc) : `For the code, ${told(hc, { page: true }).replace(/^In /, 'in ')}`)].filter(Boolean);
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
        ...(faq.needs
          ? [`Open your Fix Kit and fill in the ${faq.needs === 1 ? 'one detail' : `${faq.needs} details`} it asks for, one true sentence each. The kit puts each one into the page and its code.`]
          : ['Open your Fix Kit and read the page through: every answer is already complete.']),
        'Send the Questions page and its code to whoever runs your website: a new page, or the bottom of your homepage. The kit’s guide says where each part goes.',
        ...where,
        'Check the page at validator.schema.org once it’s live: it should read each question and answer.',
      ],
      copyText: [],
      kit: { file: 'questions', questions: faq.items.length, fromScan: faq.items.filter((x) => x && x.fromScan).length, needs: faq.needs || 0 },
      time: 'About an hour for you, then about half an hour for your web person',
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
        ...(spelling && !missingG ? [spellingLine(spelling)] : []),
        ...(spelling && missingG ? [`Search for “${[spelling.use === spelling.site ? spelling.typed : spelling.site, d.town].filter(Boolean).join(' ')}” too: Google may list you under either spelling. ${spellingLine(spelling)}`] : []),
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
    // The kit's code leaves out what we don't know until the owner adds it on the kit page (src/lib/fix-kit.js).
    const codeMissing = code ? [!d.phone && 'phone number', !office && !d.street && 'street address'].filter(Boolean) : [];
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
        code && !(hc && hc.can === false) && `Send the business code in your Fix Kit to whoever runs your website, to add to your homepage’s <head> section${codeMissing.length ? `. Add your ${listJoin(codeMissing)} on the Fix Kit page first: the kit puts ${codeMissing.length === 1 ? 'it' : 'them'} into the code` : ''}.`,
        hc && told(hc),
        code && !(hc && hc.can === false) && 'Check it at validator.schema.org: it should read your name and contact details.',
      ].filter(Boolean),
      // The code itself is in the Fix Kit (the report points there instead of pasting it).
      copyText: [],
      ...(code ? { kit: { file: 'code', missing: codeMissing } } : {}),
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
  // "Needs: access · the one thing you do · time" on every step (owner, Oct 2 2026: "Just say what you need").
  for (const it of items) it.needs = needsFor(it, { pf, faqNeeds: it.kit && it.kit.file === 'questions' ? it.kit.needs : 0 });
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

// What a step needs, in three short parts (the page shows "Needs: access · task · time", then the cost).
// Owner, Oct 2 2026: "Don't have it say 'you with your web person'. Just say what you need: access to the
// website, upload one file, ~10 minutes." The times are the step's own `time` estimate, only written
// shorter ("About half an hour" → "~30 min"); a step with no estimate says "time varies", never a guess.
const SHORT_TIME = [
  [/^About an hour for you, then about half an hour for your web person$/, '~1 hr, then ~30 min on the site'],
  [/^About half an hour, then a few days for Google to verify you$/, '~30 min, then a few days for Google to verify you'],
  [/^About half an hour to find the dates$/, '~30 min'],
  [/^Under half an hour to set up, then seconds per customer$/, 'under 30 min to set up'],
  [/^Under half an hour to ask$/, 'under 30 min to ask'],
  [/^Under half an hour per site$/, 'under 30 min per site'],
  [/^Under half an hour( for your web person)?$/, 'under 30 min'],
  [/^About half an hour( for your web person)?$/, '~30 min'],
  [/^About an hour( for your web person)?$/, '~1 hr'],
  [/^A few hours for your web person, depending on the site$/, 'a few hours, depending on the site'],
];
export function shortTime(t) {
  const s = typeof t === 'string' ? t.trim() : '';
  if (!s) return 'time varies';
  for (const [re, out] of SHORT_TIME) if (re.test(s)) return out;
  return s.replace(/ for your web person/g, '');
}
// The sign-in a wrong listing is fixed with, from the step's title ("Bing shows an old phone number…").
const LISTING_SIGNIN = [
  [/^google\b/i, 'Google Business Profile sign-in'], [/^bing\b/i, 'Bing Places sign-in'], [/^facebook\b/i, 'Facebook page admin access'],
  [/^yelp\b/i, 'Yelp for Business sign-in'], [/^apple\b/i, 'Apple Business Connect sign-in'],
];
const FIELD_WORDS = [['phone number', /phone/i], ['address', /address/i], ['hours', /hours/i], ['name', /\bname\b/i]];
function needsFor(it, { pf = null, faqNeeds = 0 } = {}) {
  const site = pf ? `${pf.name} sign-in` : 'website access';
  const host = 'website hosting access';
  const id = String(it.id || '');
  const kinds = it.from || [];
  const has = (k) => kinds.includes(k);
  const time = shortTime(it.time);
  const title = String(it.title || '');
  const fields = FIELD_WORDS.filter(([, re]) => re.test(title)).map(([w]) => w);
  const fieldText = fields.length ? `Change the ${fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}` : fields[0]}` : 'Correct the details';
  if (id.startsWith('fact')) {
    const signin = (LISTING_SIGNIN.find(([re]) => re.test(title)) || [])[1];
    return has('fact_differs')
      ? { access: 'your listing sign-ins', task: `${fieldText.replace('Change the', 'Fix your')} everywhere`, time }
      : { access: signin || 'that listing’s sign-in', task: fieldText, time };
  }
  if (id.startsWith('unblock')) return { access: pf ? site : host, task: 'Let AI read your site (one setting or file)', time };
  if (id.startsWith('lists')) {
    const n = (it.sites || []).filter((s) => s.status !== 'listed').length;
    return { access: 'an email to sign up with', task: n ? `Add your ${plural(n, 'listing', 'listings')} (${n} ${plural(n, 'site', 'sites')})` : 'Check your profiles match', time };
  }
  if (id.startsWith('awards')) return { access: 'nothing', task: 'Find the entry dates', time };
  if (has('listed_low')) return { access: 'a sign-in on that review site', task: 'Claim your page and ask for reviews', time };
  if (id.startsWith('list-') || id === 'list') return { access: 'an email to sign up with', task: 'Add your listing (1 site)', time };
  if (id.startsWith('faq') || has('lost_question') || has('baseline_faq')) {
    return { access: site, task: faqNeeds ? `Fill in ${faqNeeds} ${plural(faqNeeds, 'detail', 'details')}, then add one page` : 'Add one page from your Fix Kit', time };
  }
  if (id.startsWith('homepage')) {
    const t = has('site_title_meta') && it.copyText && it.copyText.length;
    const p = has('site_thin_pages');
    return { access: site, task: t && p ? 'Change your page title and add one page' : t ? 'Change your page title and heading' : 'Add one page', time };
  }
  if (id.startsWith('google')) return { access: 'a Google account', task: has('google_missing') ? 'Create your profile and paste in the text' : 'Fill in your profile and paste in the text', time };
  if (id.startsWith('contact')) {
    const code = !!it.kit;
    const nap = has('site_missing_nap');
    return { access: site, task: code && nap ? 'Add your details to the footer and one code block' : code ? 'Add one code block from your Fix Kit' : 'Add your details to the footer', time };
  }
  if (has('few_reviews')) return { access: 'your Google review link', task: 'Send it to recent customers', time };
  if (has('site_no_https')) return { access: host, task: 'Turn on a secure (https) certificate', time };
  if (has('site_http_no_redirect')) return { access: host, task: 'Turn on “Force HTTPS”', time };
  if (has('site_slow')) return { access: site, task: 'Shrink big photos, remove what the homepage doesn’t need', time };
  if (has('site_no_faq_schema')) return { access: site, task: 'Add one code block', time };
  if (kinds.some((k) => /^site_/.test(String(k || '')))) return { access: site, task: 'Follow the steps below', time };
  return { access: 'nothing', task: 'Follow the steps below', time };
}

// Rough time and cost for the stored fixes that pass through as they are. Conservative; a kind not
// listed shows none rather than a guess.
const EFFORT = {
  few_reviews: { time: 'Under half an hour to ask', cost: 'No cost', week: true },
  site_http_no_redirect: { time: 'Under half an hour for your web person', cost: 'No cost', week: true },
  site_no_https: { time: 'About an hour for your web person', cost: 'Often no cost; some hosts charge', week: false },
  site_slow: { time: 'A few hours for your web person, depending on the site', cost: 'Varies', week: false },
  lost_question: { time: 'About an hour for you, then about half an hour for your web person', cost: 'No cost', week: true },
  baseline_faq: { time: 'About an hour for you, then about half an hour for your web person', cost: 'No cost', week: true },
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

