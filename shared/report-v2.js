// Report JSON v2 — shared, pure helpers.
//
// Used by the scanner (publish gate), the Worker (serve gate) and tests.
// Runtime-agnostic ES module: no imports, no Node built-ins, no globals.
// See docs/BUILD_PLAN.md ("Report data model v2", "Guardrails enforced in code")
// and docs/CONTRACT_V2.md ("Shared report module").

export const ENGINE_ORDER = ['chatgpt', 'google_ai_mode', 'perplexity', 'gemini', 'claude'];

export const ENGINE_NAMES = {
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
  google_ai_mode: 'Google AI Mode',
  perplexity: 'Perplexity',
  claude: 'Claude',
};

export const BANNED_WORDS = ['disconnected', 'minutes', 'guarantee placement', 'more customers', 'rank'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word, case-insensitive. A letter/digit on either side blocks a match, so
// "rank" never hits "Frank" or "cranky". Simple inflections of single words are
// caught too ("ranks", "ranked", "ranking").
const BANNED_RES = BANNED_WORDS.map((w) => {
  const body = w.trim().split(/\s+/).map(escapeRe).join('\\s+');
  const suffix = /\s/.test(w.trim()) ? '' : '(?:s|ed|ing|ings)?';
  return { word: w, re: new RegExp(`(?<![\\p{L}\\p{N}])${body}${suffix}(?![\\p{L}\\p{N}])`, 'giu') };
});

/** lintText(str) → [{ word, match, index }] for every banned-word hit (URLs inside str are skipped). */
export function lintText(str) {
  if (typeof str !== 'string' || !str) return [];
  // URLs are data, not copy: blank them out (same length, so indexes still line up).
  str = str.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (u) => ' '.repeat(u.length));
  const hits = [];
  for (const { word, re } of BANNED_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str))) hits.push({ word, match: m[0], index: m.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

// Parts of the report that are verbatim data (AI output, names found in it,
// URLs, values read from pages), not our copy. They are skipped by the lint.
const LINT_SKIP_TOP = new Set(['answers', 'entities', 'business', 'baseline', 'id', 'generatedAt']);
const LINT_SKIP_KEYS = new Set([
  'text', 'url', 'urls', 'domain', 'aiSays', 'sourceSays', 'name', 'aliases', 'topListed', 'listed', 'quote', 'format',
  'fields', 'answerId', 'answerIds', 'citedIn', 'entityId', 'questionId', 'id', 'askedAt',
  'model', 'api', 'error', 'checkError', 'rule', 'kind', 'status', 'severity', 'field', 'intent', 'engine', 'ownerMatch', 'sourceFrom',
  // siteCheck.meta: the title, meta description and H1 as read from the owner's own homepage.
  'meta', 'placeUrl',
]);

function lintWalk(value, path, out, data = []) {
  // Copy-paste fix text is our copy (built from templates + the owner's details): lint its
  // label and text even though "text" is skipped elsewhere; the owner's details are masked.
  if (path.endsWith('.copyText') && Array.isArray(value)) {
    value.forEach((c, i) => {
      for (const k of ['label', 'text']) lintWalk(c && c[k], `${path}[${i}].${k}`, out, data);
    });
    return;
  }
  if (typeof value === 'string') {
    for (const h of lintText(maskData(value, data))) out.push({ path, ...h, match: value.substr(h.index, h.match.length) });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => lintWalk(v, `${path}[${i}]`, out, data));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (LINT_SKIP_KEYS.has(k)) continue;
      lintWalk(v, path ? `${path}.${k}` : k, out, data);
    }
  }
}

// Verbatim data that our templates interpolate into copy (issue descriptions quote what
// AI said and name competitors). Blanked out before linting so an AI quote like
// "within 30 minutes" can't block a report, while the template words around it are still linted.
function dataStrings(report) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= 2) out.add(v); };
  for (const f of report.aiFacts || []) { add(f && f.aiSays); add(f && f.sourceSays); }
  for (const e of report.entities || []) { add(e && e.name); (e && e.aliases || []).forEach(add); }
  for (const a of report.answers || []) for (const b of (a && a.businessesNamed) || []) add(b && b.name);
  for (const s of report.sources || []) { add(s && s.topListed); ((s && s.listed) || []).forEach(add); }
  for (const l of report.listings || []) for (const v of Object.values((l && l.fields) || {})) add(v);
  for (const d of report.ownerDescriptors || []) add(d && d.quote);
  // The owner's own details (name, address, website facts) fill the fix steps and copy text.
  const b = report.business || {};
  for (const k of ['name', 'address', 'town', 'phone', 'website', 'trade']) add(b[k]);
  for (const v of Object.values(b.facts || {})) add(v);
  // Longest first, so a name that contains a shorter one is masked whole.
  return [...out].sort((a, b) => b.length - a.length);
}

function maskData(str, data) {
  for (const d of data) if (str.includes(d)) str = str.split(d).join(' '.repeat(d.length));
  return str;
}

/** lintReport(report) → [{ path, word, match, index }] over our own copy only. */
export function lintReport(report) {
  const out = [];
  if (!report || typeof report !== 'object') return out;
  const data = dataStrings(report);
  for (const [k, v] of Object.entries(report)) {
    if (LINT_SKIP_TOP.has(k)) continue;
    // Questions are our copy: lint their text even though "text" is skipped elsewhere.
    if (k === 'questions' && Array.isArray(v)) {
      v.forEach((q, i) => { for (const h of lintText(q && q.text)) out.push({ path: `questions[${i}].text`, ...h }); });
      continue;
    }
    lintWalk(v, k, out, data);
  }
  return out;
}

/** computeTotals(report) → { answers, namedYou, firstYou } recomputed from report.answers. */
export function computeTotals(report) {
  const answers = Array.isArray(report && report.answers) ? report.answers : [];
  let namedYou = 0;
  let firstYou = 0;
  for (const a of answers) {
    if (a && a.namedYou === true) namedYou++;
    if (a && a.namedYou === true && a.namedYouFirst === true) firstYou++;
  }
  return { answers: answers.length, namedYou, firstYou };
}

const engineRank = (e) => {
  const i = ENGINE_ORDER.indexOf(e);
  return i === -1 ? ENGINE_ORDER.length : i;
};

function questionOrder(report) {
  const m = new Map();
  (report.questions || []).forEach((q, i) => m.set(q.id, i));
  return (qid) => (m.has(qid) ? m.get(qid) : 1e6);
}

/** Distinct non-owner businesses named in one answer. */
export function othersNamed(answer) {
  const seen = new Set();
  for (const b of answer.businessesNamed || []) {
    if (b.isYou || b.ownerMatch === 'unsure') continue;
    seen.add(b.entityId || `name:${b.name}`);
  }
  return seen.size;
}

/**
 * pickHeadline(report) → { answerId, rule } | null
 *   most_others_named_not_you: the answer that names the most other businesses
 *     and not the owner. Ties: engine order chatgpt, google_ai_mode, perplexity,
 *     gemini; then question order; then run.
 *   best_named_you: every answer names the owner, so lead with the best one:
 *     named first beats named, then most others named, then the same tie-breaks.
 * Answers with an `unsure` owner match are never used as "didn't name you".
 * Answers marked `headlineUnstable` (a re-ask of the same search flipped the owner's
 * named / not-named status) are skipped while any other answer is left.
 */
export function pickHeadline(report) {
  const all = (report && report.answers) || [];
  if (!all.length) return null;
  const stable = all.filter((a) => !a.headlineUnstable);
  const answers = stable.length ? stable : all;
  const qOrd = questionOrder(report);
  const tie = (a, b) =>
    engineRank(a.engine) - engineRank(b.engine) ||
    qOrd(a.questionId) - qOrd(b.questionId) ||
    (a.run || 0) - (b.run || 0);

  const notYou = answers.filter((a) => !a.namedYou && a.ownerMatch !== 'unsure');
  if (notYou.length) {
    const best = [...notYou].sort((a, b) => othersNamed(b) - othersNamed(a) || tie(a, b))[0];
    return { answerId: best.id, rule: 'most_others_named_not_you' };
  }
  const named = answers.filter((a) => a.namedYou);
  const pool = named.length ? named : answers;
  const best = [...pool].sort(
    (a, b) =>
      (b.namedYouFirst ? 1 : 0) - (a.namedYouFirst ? 1 : 0) || othersNamed(b) - othersNamed(a) || tie(a, b),
  )[0];
  return { answerId: best.id, rule: 'best_named_you' };
}

/**
 * lostIntents(report) → intents (question order) the owner lost.
 * An intent is lost when the owner was named in half or fewer of that intent's
 * answers (named × 2 <= counted). Answers with an `unsure` owner match are left out of
 * both sides (never counted as a miss or a win). An intent with no counted answers is
 * neither lost nor won.
 */
export function intentResults(report) {
  const answers = (report && report.answers) || [];
  const questions = (report && report.questions) || [];
  const intentOf = (a) => a.intent || (questions.find((q) => q.id === a.questionId) || {}).intent;
  const ordered = questions.length ? questions.map((q) => q.intent) : answers.map(intentOf);
  const out = [];
  for (const intent of ordered) {
    if (!intent || out.some((x) => x.intent === intent)) continue;
    const counted = answers.filter((a) => intentOf(a) === intent && a.ownerMatch !== 'unsure');
    const named = counted.filter((a) => a.namedYou === true).length;
    out.push({ intent, answers: counted.length, named, lost: counted.length > 0 && named * 2 <= counted.length });
  }
  return out;
}

export function lostIntents(report) {
  return intentResults(report).filter((x) => x.lost).map((x) => x.intent);
}

/**
 * edgeState(report) → { state, flags, failedEngines }
 *   state: 'zero' | 'all_named' | 'nobody_twice' | 'no_fixes' | 'normal' (the one that leads the page)
 *   flags: every condition that holds, since several can hold at once
 *          (e.g. zero + nobody_twice: lead with zero and also hide section 3).
 */
export function edgeState(report) {
  const t = computeTotals(report);
  const entities = (report && report.entities) || [];
  const listings = (report && report.listings) || [];
  const sources = (report && report.sources) || [];
  const flags = {
    zero: t.answers > 0 && t.namedYou === 0,
    all_named: t.answers > 0 && t.namedYou === t.answers,
    nobody_twice: !entities.some((e) => (e.named || 0) >= 2),
    no_fixes:
      !listings.some((l) => l && l.status === 'mismatch') && !sources.some((s) => s && s.youListed === false),
  };
  const state = ['zero', 'all_named', 'nobody_twice', 'no_fixes'].find((k) => flags[k]) || 'normal';
  const failedEngines = [...(((report && report.method) || {}).enginesFailed || [])];
  return { state, flags, failedEngines };
}

/** The refund promise: "fewer than 3 problems specific to your business, your $49 back". */
export const MIN_FIX_ITEMS = 3;

/** Fix items in a report: its issues (a locked report keeps them as untitled stand-ins, still counted). */
export function fixItems(report) {
  return ((report && report.issues) || []).filter((i) => i && (i.title || i.locked));
}

/**
 * True for the general-advice fixes every business with a website gets (scanner/extract/fixes.js
 * baselineFixes: Google profile, schema, FAQ). A locked report drops `kind` and keeps `generic: true`
 * instead (src/lib/lock.js), so the count still works there.
 */
export function isGenericFix(issue) {
  return !!issue && (issue.generic === true || /^baseline_/.test(String(issue.kind || '')));
}

/** Fix items found for this business in particular: fixItems without the general advice. */
export function specificFixItems(report) {
  return fixItems(report).filter((i) => !isGenericFix(i));
}

/** True when the $29 Fix steps tier may be offered for this report (≥ MIN_FIX_ITEMS fixes). Retired. */
export function snapshotOffered(report) {
  return fixItems(report).length >= MIN_FIX_ITEMS;
}

/**
 * True when the $49 AI Visibility Audit may be offered: at least MIN_FIX_ITEMS fixes specific to
 * this business, not counting the general advice every report gets (the refund promise).
 */
export function xrayOffered(report) {
  return specificFixItems(report).length >= MIN_FIX_ITEMS;
}

// ---------------------------------------------------------------------------
// AI Visibility X-Ray ($49): the competitor gap sheet and the fix checklist.
// Built at serve time from the report's own data only (answers, entities, sources, issues);
// nothing is fetched or guessed. Withheld server-side until paid (src/lib/lock.js).
// ---------------------------------------------------------------------------

/** Business names compared loosely: case, punctuation, "&"/"and" and spacing don't matter. */
export function normalizeBizName(s) {
  return ` ${String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

// Same business: equal names, or one name contains the other as whole words ("Tidewater Plumbing"
// in "Tidewater Plumbing Co."). The shorter one must be at least two words, so a bare trade word
// like "Plumbing" never matches every plumber.
function sameBiz(a, b) {
  const x = normalizeBizName(a);
  const y = normalizeBizName(b);
  if (x.trim().length < 3 || y.trim().length < 3) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.trim().split(' ').length >= 2 && long.includes(short);
}

function ownDomain(report) {
  const w = String((report && report.business && report.business.website) || '').trim();
  if (!w) return '';
  try { return new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname.replace(/^www\./i, '').replace(/\.$/, '').toLowerCase(); } catch { return w.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase(); }
}

/**
 * AI Found Score: our own 0-100 measure of how visible a business is to AI, computed only from
 * this report's data (never guessed). Parts and weights (a part with no data is left out and the
 * rest are scaled to 100):
 *   named   50  share of answers that named the business
 *   first   25  share of answers that named it first
 *   facts   15  share of checked AI facts about it (hours, phone, price, address, services) that were right
 *   ownSite 10  whether any answer cited the business's own website
 * → { score, parts: [{ key, label, weight, value (0-1), detail }] } or null when there are no answers.
 */
export const SCORE_WEIGHTS = Object.freeze({ named: 50, first: 25, facts: 15, ownSite: 10 });

export function computeVisibilityScore(report) {
  const t = computeTotals(report);
  if (!t.answers) return null;
  const parts = [
    { key: 'named', label: 'Named in AI answers', weight: SCORE_WEIGHTS.named, value: t.namedYou / t.answers, detail: `${t.namedYou} of ${t.answers} answers` },
    { key: 'first', label: 'Named first', weight: SCORE_WEIGHTS.first, value: t.firstYou / t.answers, detail: `${t.firstYou} of ${t.answers} answers` },
  ];
  const facts = ((report && report.aiFacts) || []).filter((f) => f && (f.status === 'match' || f.status === 'differs'));
  if (facts.length) {
    const right = facts.filter((f) => f.status === 'match').length;
    parts.push({ key: 'facts', label: 'AI got your facts right', weight: SCORE_WEIGHTS.facts, value: right / facts.length, detail: `${right} of ${facts.length} facts checked` });
  }
  const own = ownDomain(report);
  if (own) {
    const cited = ((report && report.sources) || []).some((x) => x && String(x.domain || '').toLowerCase() === own && Array.isArray(x.citedIn) && x.citedIn.length);
    parts.push({ key: 'ownSite', label: 'AI cited your website', weight: SCORE_WEIGHTS.ownSite, value: cited ? 1 : 0, detail: cited ? 'Yes' : 'No' });
  }
  const total = parts.reduce((n, x) => n + x.weight, 0);
  const score = Math.round((100 * parts.reduce((n, x) => n + x.weight * x.value, 0)) / total);
  return { score, parts };
}

/**
 * buildGapSheet(report) → { answers, competitors: [...], sourcesChecked }
 *   competitors: every non-owner entity named in 2+ answers, proven by answer ids found in
 *   report.answers (recounted here, never taken from the stored counts):
 *   { id, name, named, first, answerIds, sources: [{ domain, url, position }] }
 *   sources = cited sites (report.sources) that list that competitor (topListed, or a listing
 *   name read on the page, `listed`) where the owner was checked and is NOT listed
 *   (youListed === false). The owner's own site never counts. [] when none were found.
 *   sourcesChecked = how many cited sites were read for listings at all (youListed not null).
 *   With report.reviews (Google ratings looked up at scan time, scanner/owner-checks.js): a
 *   competitor that was found on Google also carries reviews: { rating, count }, and the sheet
 *   carries youReviews: { rating, count } | null (the owner's own).
 */
export function buildGapSheet(report) {
  const answers = (report && report.answers) || [];
  const byId = new Map(answers.map((a) => [a && a.id, a]));
  const own = ownDomain(report);
  const sources = ((report && report.sources) || []).filter((s) => s && s.domain !== own);
  const rv = report && report.reviews && typeof report.reviews === 'object' ? report.reviews : null;
  const rvComps = rv && Array.isArray(rv.competitors) ? rv.competitors.filter((c) => c && typeof c.name === 'string') : [];
  const competitors = [];
  for (const e of (report && report.entities) || []) {
    if (!e || !e.id || e.isYou) continue;
    const named = [];
    let first = 0;
    for (const a of answers) {
      const list = ((a && a.businessesNamed) || []).filter((b) => b && typeof b.pos === 'number')
        .slice().sort((x, y) => x.pos - y.pos);
      if (!list.some((b) => b.entityId === e.id && !b.isYou)) continue;
      named.push(a.id);
      if (list[0] && list[0].entityId === e.id) first++;
    }
    // Proof: at least 2 stored answers name it (the same bar as "Who AI names").
    if (named.length < 2 || !named.every((id) => byId.has(id))) continue;
    const names = [e.name, ...(e.aliases || [])].filter(Boolean);
    const lists = (s) => [s.topListed, ...(Array.isArray(s.listed) ? s.listed : [])]
      .some((n) => n && names.some((m) => sameBiz(n, m)));
    const gap = sources
      .filter((s) => s.youListed === false && lists(s))
      .map((s) => {
        const idx = Array.isArray(s.listed) ? s.listed.findIndex((n) => names.some((m) => sameBiz(n, m))) : -1;
        const position = idx >= 0 ? idx + 1 : (s.topListed && names.some((m) => sameBiz(s.topListed, m)) ? 1 : null);
        return { domain: s.domain, url: s.url, position };
      });
    const r = rvComps.find((c) => names.some((m) => m === c.name || sameBiz(c.name, m)));
    competitors.push({
      id: e.id, name: e.name, named: named.length, first, answerIds: named, sources: gap,
      ...(r ? { reviews: { rating: typeof r.rating === 'number' ? r.rating : null, count: Number.isInteger(r.count) ? r.count : null } } : {}),
    });
  }
  competitors.sort((a, b) => b.named - a.named || b.first - a.first || String(a.name).localeCompare(String(b.name)));
  const you = rv && rv.you && typeof rv.you === 'object' ? rv.you : null;
  return {
    answers: answers.length,
    competitors,
    sourcesChecked: sources.filter((s) => s.youListed === true || s.youListed === false).length,
    ...(rv ? { youReviews: you ? { rating: typeof you.rating === 'number' ? you.rating : null, count: Number.isInteger(you.count) ? you.count : null } : null } : {}),
  };
}

/** buildFixChecklist(report) → [{ title, kind, severity }] — every fix title in order (baseline fixes included). */
export function buildFixChecklist(report) {
  return fixItems(report).map((i) => ({ title: i.title, kind: i.kind || null, severity: i.severity || null }));
}

/** The X-Ray sections for an unlocked v2 report. */
export function xraySections(report) {
  return { gapSheet: buildGapSheet(report), checklist: buildFixChecklist(report) };
}

// ---------------------------------------------------------------------------
// Competitor Breakdown ($25 add-on; included in Be the Answer). Built at serve time from the report's
// own data only, like the gap sheet: nothing fetched, nothing guessed. Never on a locked report.
// ---------------------------------------------------------------------------

/** How many competitors the breakdown covers. */
export const BREAKDOWN_COMPETITORS = 3;
const QUOTE_MAX_WORDS = 50;

const ABBREV = new Set(['co', 'inc', 'bros', 'st', 'dr', 'mr', 'mrs', 'ms', 'jr', 'sr', 'ltd', 'llc', 'corp', 'ave', 'rd', 'blvd', 'no', 'vs', 'mt', 'ft']);
const QUOTE_MIN_WORDS = 6;

// A sentence ends at a newline, or at . ! ? followed by a space (or the end) unless the word before
// the period is an abbreviation ("Co.", "Bros.").
function isSentenceEnd(t, i) {
  const c = t[i];
  if (c === '\n') return true;
  if (!'.!?'.includes(c) || (i + 1 < t.length && !/[\s[]/.test(t[i + 1]))) return false;
  if (c !== '.') return true;
  const word = (/([A-Za-z]+)$/.exec(t.slice(Math.max(0, i - 12), i)) || [])[1] || '';
  return !ABBREV.has(word.toLowerCase());
}

/** The sentence of `text` holding the name at [pos, pos + len), word for word, or null when too short or long. */
function sentenceAt(text, pos, len = 0) {
  const t = String(text || '');
  if (!t || pos < 0 || pos >= t.length) return null;
  let start = 0;
  for (let i = pos - 1; i >= 0; i--) if (isSentenceEnd(t, i)) { start = i + 1; break; }
  let end = t.length;
  for (let i = pos + len; i < t.length; i++) if (isSentenceEnd(t, i)) { end = t[i] === '\n' ? i : i + 1; break; }
  const out = t.slice(start, end).replace(/\*\*/g, '').replace(/^\s*(?:#{1,6}\s+)?(?:(?:\d+[.)]|[-*•>])\s+)*/, '').trim();
  const words = out.split(/\s+/).length;
  if (!out || words < QUOTE_MIN_WORDS || words > QUOTE_MAX_WORDS) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Match List: what the businesses AI names have that the owner doesn't, built ONLY from the report's own
// answers and the pages AI cited in them. Nothing is fetched. Every "yes" carries its evidence (a
// sentence an assistant wrote, word for word, or a page AI cited); a "no" only ever means "not seen in
// this scan", never "they don't have it".
// ---------------------------------------------------------------------------

const MATCH_STOP = new Set(['the', 'and', 'of', 'inc', 'co', 'llc', 'ltd', 'corp', 'company', 'plumbing', 'plumber', 'plumbers', 'heating',
  'cooling', 'hvac', 'home', 'homes', 'service', 'services', 'solutions', 'group', 'contractors', 'contracting', 'sewer', 'drain', 'drains',
  'ny', 'long', 'island', 'suffolk', 'nassau', 'branch', 'county', 'roofing', 'electric', 'electrical', 'air', 'pro', 'pros']);

/** The distinctive letters of a business name ("Rubber Duck Plumbing" → "rubberduck"), or '' when too short to trust. */
export function nameKey(name, extraStop = []) {
  const stop = new Set(extraStop.map((x) => String(x).toLowerCase()));
  const words = String(name || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9]+/).filter(Boolean)
    .filter((w) => !MATCH_STOP.has(w) && !stop.has(w));
  const key = words.join('');
  return key.length >= 5 ? key : '';
}

function domainRoot(domain) {
  const parts = String(domain || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
}

const COMMUNITY_RE = /(^|\.)(reddit|facebook|nextdoor|quora|youtube|instagram|tiktok|twitter|x|pinterest)\.com$/i;
const DIRECTORY_RE = /(^|\.)(yelp|angi|angieslist|bbb|homeadvisor|thumbtack|yellowpages|mapquest|porch|networx|manta|superpages|foursquare|buildzoom|houzz|birdeye)\.(com|org)$/i;
// A blog post, news item or dated archive is never "a page for the town", even when it names the town.
const NOT_A_PAGE_RE = /(?:^|\/)(?:blogs?|news|posts?|articles?|category|tags?|author|press)(?:\/|$)|\/(?:19|20)\d\d\//i;

const TOWN_FILLER = new Set(['ny', 'new', 'york', 'plumber', 'plumbers', 'plumbing', 'service', 'services', 'near', 'me', 'in', 'emergency', 'hvac',
  'heating', 'drain', 'and', 'of', 'the', 'contractor', 'contractors', 'company', 'best', 'local', '24', '7']);

// "smithtown-ny-plumber" and "plumber-smithtown-ny" are the town's page; "central-islip" is not "islip"; "smithtown-fire-news" is not a page.
function labelIsTown(label, town) {
  const toks = String(label).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tt = (town.tokens && town.tokens.length) ? town.tokens : [town.compact];
  if (!toks.length || toks.length > tt.length + 4) return false;
  for (let i = 0; i + tt.length <= toks.length; i++) {
    if (tt.every((w, k) => toks[i + k] === w)) return toks.filter((_, k) => k < i || k >= i + tt.length).every((w) => TOWN_FILLER.has(w));
  }
  return false;
}

/**
 * Is this URL a page for the owner's town? The town must be a whole path segment (or a subdomain), possibly with a
 * few plain words around it ("smithtown-ny", "smithtownny", "plumber-smithtown-ny"), never a piece of another place
 * name ("central-islip" is not "islip") and never a blog or news path. A listing page like /locations/ or
 * /service-areas/ with no town in it is NOT a page for the town.
 * town = { compact: 'smithtown', tokens: ['smithtown'], state: 'ny' } | null
 */
export function isTownPagePath(pathname, town, host = '') {
  if (!town || !town.compact) return false;
  const path = String(pathname || '').toLowerCase();
  if (NOT_A_PAGE_RE.test(path)) return false;
  const t = town.compact;
  const st = String(town.state || '').toLowerCase();
  const labels = String(host || '').toLowerCase().split('.').filter(Boolean);
  const sub = labels.length >= 3 ? labels[0] : '';
  return [...path.split('/').filter(Boolean), ...(sub ? [sub] : [])].some((seg) => {
    const c = seg.replace(/[^a-z0-9]/g, '');
    return c === t || c === `${t}newyork` || (st && c === `${t}${st}`) || labelIsTown(seg, town);
  });
}

/** 'community' | 'directory' | 'town-page' | 'site' | 'other' for a cited page; the owner/competitor checks happen in the caller. */
export function classifyCitation(url, town = null) {
  let u;
  try { u = new URL(String(url)); } catch { return { kind: 'other', domain: '' }; }
  if (!/^https?:$/.test(u.protocol)) return { kind: 'other', domain: '' };
  const domain = u.hostname.replace(/^www\./, '').replace(/\.$/, '').toLowerCase();
  if (COMMUNITY_RE.test(domain)) return { kind: 'community', domain };
  if (DIRECTORY_RE.test(domain)) return { kind: 'directory', domain };
  return { kind: isTownPagePath(u.pathname, town, domain) ? 'town-page' : 'site', domain };
}

// A domain belongs to a business only when the name is the WHOLE domain, or the domain adds only a plain word or
// state code around it ("rubberduckplumbinginc", "varsityhomeservice", "abcplumbingnyc"). "rubberduckpaper" does not.
const DOMAIN_FILLER = /^(?:inc|llc|co|corp|nyc|ny|li|and|plumbing|plumber|plumbers|heating|cooling|hvac|services?|home|homes|pro|pros|the|of)*$/;
function domainMatchesKey(root, key) {
  if (!key || !root) return false;
  if (root === key) return true;
  if (root.startsWith(key) && DOMAIN_FILLER.test(root.slice(key.length))) return true;
  if (root.endsWith(key) && DOMAIN_FILLER.test(root.slice(0, root.length - key.length))) return true;
  return false;
}

/** What an assistant can say about a business that a customer (and AI) cares about. Order = priority. */
export const MATCH_SIGNALS = Object.freeze([
  { key: 'townPage', label: 'A page just for {town}', action: 'Add a page for {town} that says what you do there, and link to it from your home page.' },
  { key: 'emergency', label: 'Says it does emergency or 24/7 work', action: 'Say plainly on your website and Google listing that you take emergency calls, and when.', re: /\b(?:24\s*\/\s*7|24[- ]hours?|around[- ]the[- ]clock|emergency (?:service|services|plumb\w*|repairs?|calls?|dispatch|response|work|help))\b/i },
  { key: 'pricing', label: 'Says how it prices (upfront, flat-rate, free estimates)', action: 'State how you price on your website: upfront prices, flat rates or free estimates, whichever is true for you.', re: /\b(?:up-?front|flat[- ]rate|transparent pric\w*|no (?:hidden|surprise) (?:fees|charges|costs)|free estimates?)\b/i },
  { key: 'licensed', label: 'States it is licensed, insured or certified', action: 'Put your license number, insurance and certifications on your website.', re: /\b(?:licensed|insured|bonded|certified|master plumber|master license)\b/i },
  { key: 'bbb', label: 'A Better Business Bureau profile', action: 'Claim or check your Better Business Bureau profile and keep it accurate.', re: /\b(?:BBB|Better Business Bureau)\b/ },
  { key: 'awards', label: 'Awards or “best of” wins', action: 'List any awards or “best of” wins you have earned on your website. Only real ones.', re: /\b(?:award[- ]winning|awards?|best of [A-Z][a-z]+|winner of)\b/i },
  { key: 'experience', label: 'Says how long it has been in business or who owns it', action: 'Say how long you have been in business and who owns it, on your home page.', re: /\b(?:\d{2,3}\+? years|decades|since (?:19|20)\d\d|family[- ](?:owned|operated)|locally owned|generations?)\b/i },
  { key: 'reviews', label: 'Described as highly reviewed', action: 'Ask every happy customer for a Google review, and send them the link right after the job.', re: /\b(?:highly[- ]reviewed|five[- ]star|5[- ]star|great reviews|positive reviews|excellent (?:reviews|reputation)|top[- ]rated)\b/i },
  { key: 'ratingHigher', label: 'A higher Google rating than yours', action: 'Ask every happy customer for a Google review, so your rating reflects the work you do.' },
  { key: 'reviewsCount', label: 'More Google reviews than you', action: 'Ask every happy customer for a Google review, and send them the link right after the job.' },
  { key: 'directories', label: 'Listed on sites AI read that don’t list you', action: 'Claim your profile on the sites AI reads (Yelp, Angi and similar), and match your name, phone and address to your website.' },
]);

const MAX_ANSWER_CHARS = 20000;
const MAX_MENTIONS = 200;
// A sentence that hedges, negates, questions, or is advice about hiring in general says nothing about one business.
const NEGATED_RE = /\b(?:not|no|non|never|nor|neither|without|lacks?|lacking|hardly|rarely|seldom|barely|few|little|fails?|failed|unable|cannot|only|except|unless|if|may|might|could|would|should|claims?|claimed|allegedly|reportedly|supposedly|possibly|probably|perhaps|least|expired|lapsed|revoked|suspended|used to|formerly|unclear|unknown|whether)\b|\w+n['’]t\b|\bun-?(?:licensed|insured|certified|bonded)\b/i;
const ADVICE_RE = /^\s*(?:always|look for|choose|pick|hire|ensure|check|ask|verify|beware|remember|note|make sure|be sure|you (?:should|can|may|will|need|must)|when |if )|\b(?:requires?|required|by law|state law|whoever you hire|any (?:plumber|contractor|company)|tips?)\b/i;
// Never quote a sentence about complaints or legal trouble under a positive label.
const RISKY_RE = /\b(?:complaints?|lawsuits?|sued|scam|fraud|fined|violations?|f rating|unresolved|warning|accused|busy|slow|rude|poor|bad|worst|terrible|overcharg\w*|no-?shows?|never (?:showed|called|came)|wait\w*|delays?|delayed|cancel\w*|disappoint\w*|unprofessional|mixed|negative)\b/i;
// "A is 24/7 while B is not", "unlike A, B is licensed": a comparison says nothing safe about either.
const COMPARE_RE = /\b(?:unlike|whereas|while|vs\.?|versus|compared (?:to|with)|than|instead of|rather than|but|however|outperform\w*|outrank\w*|outshine\w*|beats?|edges? out|tops|trails|lags?|ahead of|better|worse|cheaper|pricier|the same|as well)\b/i;
const FOLLOW_UP_RE = /^\s*(?:however|but|although|though|yet)\b/i;
const LIST_JOIN_RE = /^\s*(?:,\s*(?:and\s+|or\s+)?|\s+and\s+|\s+or\s+|\s*&\s*)$/i;
const BULLET_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;
const OBJECT_PREP_RE = /\b(?:with|from|by|to|for|like|near|against|behind|than|over|via|alongside)\s+$/i;

// "Rubber Duck works with Roto-Rooter and offers 24/7": Roto-Rooter is the object, so a descriptor after it is not about it
// (unless it is an appositive: "with Roto-Rooter, a licensed…").
function isObjectMention(text, b) {
  const before = text.slice(Math.max(0, b.pos - 20), b.pos).replace(/\*\*/g, '');
  if (!OBJECT_PREP_RE.test(before)) return false;
  const nl = String(b.name || '').length;
  return !/^\s*,\s*(?:an?|the)\b/i.test(text.slice(b.pos + nl, b.pos + nl + 12));
}

function lineStartOf(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function sentenceBounds(text, at, len) {
  let start = 0;
  for (let i = at - 1; i >= 0; i--) if (isSentenceEnd(text, i)) { start = i + 1; break; }
  let end = text.length;
  for (let i = at + len; i < text.length; i++) if (isSentenceEnd(text, i)) { end = text[i] === '\n' ? i : i + 1; break; }
  return { start, end };
}

const cleanSentence = (x) => x.replace(/\*\*/g, '').replace(/^\s*(?:#{1,6}\s+)?(?:(?:\d+[.)]|[-*•>])\s+)*/, '').trim();

// Businesses joined by ", " / " and " / " or " ("A, B and C") form one group: a descriptor after the group is about all of them.
function mentionGroups(text, list) {
  const gid = [];
  let g = 0;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) {
      const prev = list[i - 1];
      const gap = text.slice(prev.pos + String(prev.name || '').length, list[i].pos);
      if (!(gap.length <= 80 && !gap.includes('\n') && LIST_JOIN_RE.test(gap.replace(/\*\*/g, '')))) g++;
    }
    gid[i] = g;
  }
  return gid;
}

// The signals an assistant attached to one business across the answers that name it: { key → { text, engine } }.
// A signal counts ONLY when (a) the same sentence names that business and the words come right after its name (or
// before it, when it is the only business in the sentence), or (b) it sits in that business's own bullet lines
// directly under a heading line that is only its name. Standalone sentences (tips, other businesses' lines) never
// count, comparisons and hedges never count, and a bullet block ends at a blank line, a heading or another name.
function signalsFor(answers, isThis) {
  const found = new Map();
  for (const a of answers) {
    const text = String((a && a.text) || '');
    if (!text || text.length > MAX_ANSWER_CHARS) continue;
    const list = ((a && a.businessesNamed) || []).filter((b) => b && typeof b.pos === 'number').slice().sort((x, y) => x.pos - y.pos).slice(0, MAX_MENTIONS);
    const gid = mentionGroups(text, list);
    const idOf = (b) => String(b.entityId || b.name);
    const accept = (sig, key, sb) => {
      if (found.has(key)) return;
      const clause = text.slice(sb.start, sb.end);
      const forNeg = clause.replace(/\bno (?:hidden|surprise) (?:fees|charges|costs)\b/gi, '');
      if (NEGATED_RE.test(forNeg) || ADVICE_RE.test(cleanSentence(clause)) || RISKY_RE.test(clause) || /\?\s*$/.test(clause)) return;
      if (FOLLOW_UP_RE.test(text.slice(sb.end, sb.end + 40))) return;
      const quote = cleanSentence(clause);
      if (quote.length < 4 || quote.length > 400) return;
      found.set(key, { text: quote, engine: a.engine || null });
    };
    list.forEach((b, i) => {
      if (!isThis(b)) return;
      const nameLen = String(b.name || '').length;
      // (a) the sentence holding this name
      const sb = sentenceBounds(text, b.pos, nameLen);
      const inSentence = list.map((_x, k) => k).filter((k) => list[k].pos >= sb.start && list[k].pos < sb.end);
      const distinct = new Set(inSentence.map((k) => idOf(list[k])));
      const sentence = text.slice(sb.start, sb.end);
      if (!(distinct.size >= 2 && COMPARE_RE.test(sentence))) {
        for (const sig of MATCH_SIGNALS) {
          if (!sig.re || found.has(sig.key)) continue;
          const re = new RegExp(sig.re.source, sig.re.flags.includes('g') ? sig.re.flags : `${sig.re.flags}g`);
          for (const m of sentence.matchAll(re)) {
            const at = sb.start + m.index;
            let owner = -1;
            for (const k of inSentence) if (list[k].pos <= at && !isObjectMention(text, list[k])) owner = k;
            // a new capitalised subject between the name and the descriptor, without a recorded mention ("…; Varsity is licensed")
            if (owner >= 0 && /[;:]\s*[A-Z][a-z]+\b|,\s+(?:and\s+)?[A-Z][a-z]+\s+(?:is|has|offers|provides)\b/.test(text.slice(list[owner].pos + String(list[owner].name || '').length, at))) owner = -2;
            if (owner === -1 && distinct.size === 1) owner = inSentence[0];
            if (owner < 0 || gid[owner] !== gid[i]) continue;
            accept(sig, sig.key, sb);
            break;
          }
        }
      }
      // (b) bullet lines under a heading line that holds only this name
      const ls = lineStartOf(text, b.pos);
      const nl = text.indexOf('\n', b.pos);
      const le = nl === -1 ? text.length : nl;
      const residual = (text.slice(ls, b.pos) + text.slice(b.pos + nameLen, le)).replace(/[*#>:\-\d.)\s]/g, '');
      if (residual.length > 70 || nl === -1) return;
      if (new Set(list.filter((x) => x.pos >= ls && x.pos < le).map(idOf)).size > 1) return;
      let pos = le + 1;
      for (let n = 0; n < 12 && pos < text.length; n++) {
        const e2 = text.indexOf('\n', pos);
        const lineEnd = e2 === -1 ? text.length : e2;
        const line = text.slice(pos, lineEnd);
        if (!line.trim() || /^\s*(?:#{1,6}\s|---+|\*\*\*)/.test(line)) break;
        if (list.some((x) => x.pos >= pos && x.pos < lineEnd)) break;
        if (!BULLET_LINE_RE.test(line) && !/^\s+\S/.test(line)) {
          if (n === 0) { pos = lineEnd + 1; continue; } // one plain line ("A well-known name.") before the bullets is skipped, never credited
          break;
        }
        for (const sig of MATCH_SIGNALS) {
          if (!sig.re || found.has(sig.key)) continue;
          const re = new RegExp(sig.re.source, sig.re.flags.includes('g') ? sig.re.flags : `${sig.re.flags}g`);
          for (const m of line.matchAll(re)) {
            accept(sig, sig.key, sentenceBounds(text, pos + m.index, m[0].length));
            break;
          }
        }
        pos = lineEnd + 1;
      }
    });
  }
  return found;
}

/**
 * buildMatchList(report, competitors, youReviews) → null | { total, youCount, avgRivals, rows, first, pages, townPages, youTownPage }
 *   rows    one per signal at least one rival shows: { key, label, action, rivals: [{ has, evidence }], you, rivalCount }
 *   first   up to 5 rows the owner lacks, most rivals first: { key, label, action, rivalCount }
 *   pages   the pages AI cited, classified: { url, domain, kind, competitor, engine } (own-site pages matched by name)
 */
export function buildMatchList(report, competitors, youReviews) {
  if (!competitors.length) return null;
  const answers = ((report && report.answers) || []).filter(Boolean);
  const biz = (report && report.business) || {};
  const town = String(biz.town || biz.city || '').trim();
  const compact = town.toLowerCase().replace(/[^a-z0-9]/g, '');
  const townInfo = compact.length >= 4 ? { compact, tokens: town.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), state: String(biz.state || '').toLowerCase() } : null;
  const own = ownDomain(report);
  const keys = competitors.map((c) => nameKey(c.name, town.toLowerCase().split(/[^a-z]+/)));

  // Pages AI cited, deduped by address, attributed to a competitor only when the domain is that business's name.
  const seen = new Set();
  const pages = [];
  for (const a of answers) {
    for (const c of a.citations || []) {
      if (!c || typeof c.url !== 'string' || seen.has(c.url)) continue;
      const cls = classifyCitation(c.url, townInfo);
      if (!cls.domain) continue;
      seen.add(c.url);
      let competitor = null;
      const mine = !!(own && (cls.domain === own || cls.domain.endsWith('.' + own)));
      if (!mine && (cls.kind === 'site' || cls.kind === 'town-page')) {
        const root = domainRoot(cls.domain);
        const hits = keys.map((k, i) => (domainMatchesKey(root, k) ? i : -1)).filter((i) => i >= 0);
        if (hits.length === 1) competitor = competitors[hits[0]].name;
      }
      pages.push({ url: c.url, domain: cls.domain, kind: mine ? 'you' : cls.kind, competitor, engine: a.engine || null });
    }
  }
  const townPageOf = (c) => pages.find((p) => p.competitor === c.name && p.kind === 'town-page') || null;
  const youTownPage = pages.some((p) => p.kind === 'you' && isTownPagePath(new URL(p.url).pathname, townInfo, p.domain));

  const isYouMention = (b) => b.isYou === true || b.entityId === 'you';
  const yourSignals = signalsFor(answers, isYouMention);
  const rivalSignals = competitors.map((c) => signalsFor(answers, (b) => b.entityId === c.id && !b.isYou));

  const rows = [];
  for (const sig of MATCH_SIGNALS) {
    let rivals;
    let you = false;
    if (sig.key === 'townPage') {
      rivals = competitors.map((c) => { const p = townPageOf(c); return { has: !!p, evidence: p ? { url: p.url, domain: p.domain } : null }; });
      you = youTownPage;
    } else if (sig.key === 'reviewsCount') {
      // Only a real number from Google counts. No owner listing found is said as such, never as "your 0".
      const yc = youReviews && Number.isInteger(youReviews.count) ? youReviews.count : null;
      rivals = competitors.map((c) => {
        const r = c.reviews;
        const has = !!(r && Number.isInteger(r.count) && r.count > 0 && (yc === null || r.count > yc));
        if (!has) return { has: false, evidence: null };
        const stars = typeof r.rating === 'number' ? ` at ${r.rating} stars` : '';
        return { has, evidence: { text: yc === null ? `${r.count} Google reviews${stars}. We couldn't find yours.` : `${r.count} Google reviews${stars}, to your ${yc}.` } };
      });
    } else if (sig.key === 'ratingHigher') {
      const yr = youReviews && typeof youReviews.rating === 'number' ? youReviews.rating : null;
      rivals = competitors.map((c) => {
        const r = c.reviews;
        const has = !!(yr !== null && r && typeof r.rating === 'number' && r.rating > yr);
        return { has, evidence: has ? { text: `A ${r.rating} Google rating, to your ${yr}.` } : null };
      });
    } else if (sig.key === 'directories') {
      rivals = competitors.map((c) => ({ has: c.sources.length > 0, evidence: c.sources.length ? { domains: c.sources.slice(0, 3).map((x) => x.domain) } : null }));
    } else {
      rivals = rivalSignals.map((m, i) => {
        const e = m.get(sig.key);
        // A cited Better Business Bureau page that lists them is direct evidence of a BBB profile.
        const bbb = sig.key === 'bbb' && !e && (competitors[i].sources || []).some((x) => /(^|\.)bbb\.org$/i.test(String(x.domain || '')));
        return bbb ? { has: true, evidence: { domains: ['bbb.org'] } } : { has: !!e, evidence: e || null };
      });
      you = yourSignals.has(sig.key);
    }
    const rivalCount = rivals.filter((r) => r.has).length;
    if (!rivalCount) continue;
    rows.push({ key: sig.key, label: sig.label.replace('{town}', town || 'your town'), action: sig.action.replace(/\{town\}/g, town || 'your town'), rivals, you, rivalCount });
  }
  if (!rows.length) return null;
  const youCount = rows.filter((r) => r.you).length;
  const avgRivals = Math.round((competitors.reduce((n, _c, i) => n + rows.filter((r) => r.rivals[i].has).length, 0) / competitors.length) * 10) / 10;
  const order = new Map(MATCH_SIGNALS.map((x, i) => [x.key, i]));
  const first = rows.filter((r) => !r.you).slice()
    .sort((a, b) => b.rivalCount - a.rivalCount || order.get(a.key) - order.get(b.key)).slice(0, 5)
    .map((r) => ({ key: r.key, label: r.label, action: r.action, rivalCount: r.rivalCount }));
  const townPages = competitors.filter((c) => townPageOf(c)).length;
  return { total: rows.length, youCount, avgRivals, rows, first, pages: pages.slice(0, 16), townPages, youTownPage };
}

/**
 * buildCompetitorBreakdown(report) → { you: { named, first, answers, reviews }, competitors: [...] }
 *   The top BREAKDOWN_COMPETITORS businesses from the gap sheet, each with:
 *   { name, named, first, quote: { text, engine, question } | null, reviews, sources, winsQuestions, edges }
 *   quote          one sentence an assistant wrote about them, word for word
 *   winsQuestions  customer questions where an answer named them and no answer named you
 *   edges          up to 3 plain lines: what they have that you don't (reviews, rating, named first,
 *                  cited sites that list them and not you, questions they win)
 */
export function buildCompetitorBreakdown(report) {
  const gap = buildGapSheet(report);
  const answers = (report && report.answers) || [];
  const byId = new Map(answers.map((a) => [a && a.id, a]));
  const qById = new Map(((report && report.questions) || []).map((q) => [q && q.id, q]));
  const t = computeTotals(report);
  const youReviews = gap.youReviews || null;
  const youNamedQ = new Set(answers.filter((a) => a && a.namedYou).map((a) => a.questionId));
  const competitors = gap.competitors.slice(0, BREAKDOWN_COMPETITORS).map((c) => {
    let quote = null;
    for (const id of c.answerIds) {
      const a = byId.get(id);
      const b = ((a && a.businessesNamed) || []).find((x) => x && x.entityId === c.id && typeof x.pos === 'number');
      const text = b && sentenceAt(a.text, b.pos, String(b.name || '').length);
      if (text) { quote = { text, engine: a.engine || null, question: (qById.get(a.questionId) || {}).text || null }; break; }
    }
    const winsQuestions = [...new Set(c.answerIds.map((id) => (byId.get(id) || {}).questionId))]
      .filter((q) => q && !youNamedQ.has(q)).map((q) => (qById.get(q) || {}).text).filter(Boolean);
    const edges = [];
    const r = c.reviews || null;
    if (r && youReviews && Number.isInteger(r.count) && Number.isInteger(youReviews.count) && r.count > youReviews.count) {
      edges.push(`${r.count} Google reviews to your ${youReviews.count}.`);
    } else if (r && !youReviews && Number.isInteger(r.count) && r.count > 0) {
      edges.push(`${r.count} Google reviews. We couldn't find yours on Google.`);
    }
    if (r && youReviews && typeof r.rating === 'number' && typeof youReviews.rating === 'number' && r.rating > youReviews.rating) {
      edges.push(`A ${r.rating} Google rating to your ${youReviews.rating}.`);
    }
    if (c.first > t.firstYou) edges.push(`Named first in ${c.first} of ${t.answers} answers. You were named first in ${t.firstYou}.`);
    if (c.sources.length) edges.push(`Listed on ${c.sources.length} ${c.sources.length === 1 ? 'site' : 'sites'} AI cited that ${c.sources.length === 1 ? "doesn't" : "don't"} list you: ${c.sources.slice(0, 3).map((x) => x.domain).join(', ')}.`);
    if (winsQuestions.length) edges.push(`Named for “${winsQuestions[0]}”, where no answer named you.`);
    return {
      id: c.id, name: c.name, named: c.named, first: c.first, quote, reviews: r, sources: c.sources, winsQuestions, edges: edges.slice(0, 5),
    };
  });
  const match = buildMatchList(report, competitors.map((c) => ({ ...c, answerIds: [] })), youReviews);
  // A rival's own Smithtown page is the most concrete gap AI shows: lead each rival's list with it.
  if (match) {
    const town = String((report && report.business && (report.business.town || report.business.city)) || 'your town');
    competitors.forEach((c) => {
      const p = match.pages.find((x) => x.competitor === c.name && x.kind === 'town-page');
      if (p && !match.youTownPage) c.edges = [`AI cited their page for ${town} (${p.domain}). It cited none from your site.`, ...c.edges].slice(0, 5);
      c.pages = match.pages.filter((x) => x.competitor === c.name);
      c.says = MATCH_SIGNALS.filter((sg) => sg.re).map((sg) => { const row = match.rows.find((rw) => rw.key === sg.key); const cell = row && row.rivals[competitors.indexOf(c)]; return cell && cell.has && cell.evidence && cell.evidence.text ? { key: sg.key, label: sg.label, text: cell.evidence.text, engine: cell.evidence.engine } : null; }).filter(Boolean);
    });
  }
  return { you: { named: t.namedYou, first: t.firstYou, answers: t.answers, reviews: youReviews }, competitors, match };
}

/** Most "how AI describes you" phrases a report may carry. */
export const MAX_OWNER_DESCRIPTORS = 6;

/**
 * validateReport(report) → { ok, errors: string[] }
 * The publish/serve gate. Each error names the exact field and what is wrong.
 */
export function validateReport(report) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!report || typeof report !== 'object') return { ok: false, errors: ['report is not an object'] };
  if (report.version !== 2) err(`version must be 2 (got ${JSON.stringify(report.version)})`);

  const answers = Array.isArray(report.answers) ? report.answers : null;
  if (!answers) err('answers must be an array');
  else if (!answers.length) err('answers is empty: no engine returned a usable answer, so there is nothing to publish');
  const byId = new Map();
  const qIds = new Set((report.questions || []).map((q) => q.id));
  if (!Array.isArray(report.questions)) err('questions must be an array');

  (answers || []).forEach((a, i) => {
    const at = `answers[${i}]${a && a.id ? ` (${a.id})` : ''}`;
    if (!a || typeof a !== 'object') return err(`${at} is not an object`);
    if (!a.id) err(`${at} has no id`);
    else if (byId.has(a.id)) err(`${at} duplicate answer id "${a.id}"`);
    else byId.set(a.id, a);
    if (typeof a.text !== 'string') err(`${at}.text must be a string`);
    if (!Number.isInteger(a.run) || a.run < 1) err(`${at}.run must be a positive integer (got ${JSON.stringify(a.run)})`);
    if (!qIds.has(a.questionId)) err(`${at}.questionId "${a.questionId}" is not in questions`);
    const text = typeof a.text === 'string' ? a.text : '';
    let youCount = 0;
    let earliest = null;
    (a.businessesNamed || []).forEach((b, j) => {
      const bt = `${at}.businessesNamed[${j}] "${b && b.name}"`;
      if (!b || typeof b.name !== 'string' || !b.name) return err(`${bt} has no name`);
      if (!Number.isInteger(b.pos) || b.pos < 0) return err(`${bt}.pos must be a non-negative integer (got ${b.pos})`);
      const slice = text.slice(b.pos, b.pos + b.name.length);
      // A locked answer (src/lib/lock.js) has had its text removed; its names were checked before locking.
      if (slice !== b.name && !a.locked) err(`${bt} is not in the answer text at pos ${b.pos} (text there: ${JSON.stringify(slice)})`);
      if (b.isYou) youCount++;
      if (b.ownerMatch !== 'unsure' && (!earliest || b.pos < earliest.pos)) earliest = b;
    });
    if (a.namedYou && youCount === 0) err(`${at}.namedYou is true but no businessesNamed entry is the owner`);
    if (!a.namedYou && youCount > 0) err(`${at}.namedYou is false but a businessesNamed entry is the owner`);
    if (a.namedYouFirst && !a.namedYou) err(`${at}.namedYouFirst is true but namedYou is false`);
    if (a.namedYouFirst && earliest && !earliest.isYou)
      err(`${at}.namedYouFirst is true but the earliest business named is "${earliest.name}"`);
    if (a.namedYou && !a.namedYouFirst && earliest && earliest.isYou)
      err(`${at}.namedYouFirst is false but the owner is the earliest business named`);
    (a.citations || []).forEach((c, j) => {
      if (!c || typeof c.url !== 'string' || !c.domain) err(`${at}.citations[${j}] needs url and domain`);
    });
  });

  // Every number traces to data.
  const t = computeTotals(report);
  const st = report.totals || {};
  if (!report.totals) err('totals missing');
  for (const k of ['answers', 'namedYou', 'firstYou']) {
    if (st[k] !== t[k]) err(`totals.${k} is ${JSON.stringify(st[k])} but the answers show ${t[k]}`);
  }

  // The before/after strip prints these numbers: they must be plain counts.
  if (report.baseline != null) {
    const bt = report.baseline.totals;
    if (!bt || typeof bt !== 'object') err('baseline.totals missing (baseline must be null or { generatedAt, totals })');
    else for (const k of ['answers', 'namedYou', 'firstYou']) {
      if (!Number.isInteger(bt[k]) || bt[k] < 0) err(`baseline.totals.${k} must be a non-negative integer (got ${JSON.stringify(bt[k])})`);
    }
  }

  // Every competitor name has proof.
  const entityIds = new Set();
  (report.entities || []).forEach((e, i) => {
    const et = `entities[${i}] "${e && e.name}"`;
    if (!e || !e.id) return err(`${et} has no id`);
    entityIds.add(e.id);
    const names = [e.name, ...(e.aliases || [])].filter(Boolean);
    const ids = Array.isArray(e.answerIds) ? e.answerIds : [];
    const proving = [];
    for (const aid of ids) {
      const a = byId.get(aid);
      if (!a) { err(`${et}.answerIds has "${aid}", which is not an answer`); continue; }
      // A locked answer's text was removed after this check passed on the stored report.
      const hit = a.locked || names.some((n) => (a.text || '').includes(n));
      if (!hit) err(`${et}: answer ${aid} does not contain "${names.join('" or "')}" as written`);
      else proving.push(aid);
    }
    // Recount from answers.businessesNamed.
    const namedIn = [];
    let firstIn = 0;
    for (const a of answers || []) {
      const mine = (a.businessesNamed || []).filter((b) => b.entityId === e.id);
      if (!mine.length) continue;
      namedIn.push(a.id);
      const firstB = (a.businessesNamed || [])
        .filter((b) => b.ownerMatch !== 'unsure')
        .reduce((m, b) => (!m || b.pos < m.pos ? b : m), null);
      if (firstB && firstB.entityId === e.id) firstIn++;
    }
    if (e.named !== namedIn.length) err(`${et}.named is ${e.named} but ${namedIn.length} answers name it`);
    if (e.first !== firstIn) err(`${et}.first is ${e.first} but it is named first in ${firstIn} answers`);
    if (ids.length !== e.named) err(`${et}.named is ${e.named} but ${ids.length} answerIds are attached`);
    const missing = namedIn.filter((x) => !ids.includes(x));
    if (missing.length) err(`${et}.answerIds is missing ${missing.join(', ')}`);
    if ((e.named || 0) >= 2 && proving.length < 2)
      err(`${et} is shown (named ${e.named}) but only ${proving.length} stored answer(s) prove it; 2 are required`);
  });
  // The owner is one entity (isYou) and every mention of it says isYou; competitors never do.
  const entityById = new Map((report.entities || []).filter((e) => e && e.id).map((e) => [e.id, e]));
  const ownerEntities = (report.entities || []).filter((e) => e && e.isYou);
  if (ownerEntities.length > 1) err(`entities has ${ownerEntities.length} owner (isYou) entities; at most 1 is allowed`);
  (answers || []).forEach((a) => {
    (a.businessesNamed || []).forEach((b) => {
      if (b.entityId && !entityIds.has(b.entityId))
        err(`answer ${a.id}: businessesNamed "${b.name}" points to unknown entity "${b.entityId}"`);
      const e = b.entityId && entityById.get(b.entityId);
      if (e && !!e.isYou !== !!b.isYou)
        err(`answer ${a.id}: businessesNamed "${b.name}" isYou=${!!b.isYou} but entity ${e.id} "${e.name}" isYou=${!!e.isYou}`);
      if (b.isYou && b.ownerMatch === 'unsure') err(`answer ${a.id}: businessesNamed "${b.name}" is both isYou and unsure`);
    });
  });

  // Every quote is exact.
  (report.aiFacts || []).forEach((f, i) => {
    const ft = `aiFacts[${i}] (${f && f.field})`;
    const a = f && byId.get(f.answerId);
    if (!a) return err(`${ft}.answerId "${f && f.answerId}" is not an answer`);
    if (typeof f.aiSays !== 'string' || !f.aiSays) return err(`${ft}.aiSays is empty`);
    if (!a.locked && !(a.text || '').includes(f.aiSays)) err(`${ft}.aiSays ${JSON.stringify(f.aiSays)} is not a literal quote from answer ${a.id}`);
    if (!['match', 'differs', 'not stated'].includes(f.status)) err(`${ft}.status "${f.status}" is not match | differs | not stated`);
  });

  // "How AI describes you": literal quotes from answers that name the owner, capped.
  if (report.ownerDescriptors != null && !Array.isArray(report.ownerDescriptors)) err('ownerDescriptors must be an array');
  const descs = Array.isArray(report.ownerDescriptors) ? report.ownerDescriptors : [];
  if (descs.length > MAX_OWNER_DESCRIPTORS) err(`ownerDescriptors has ${descs.length} entries; at most ${MAX_OWNER_DESCRIPTORS}`);
  descs.forEach((d, i) => {
    const dt = `ownerDescriptors[${i}]`;
    const a = d && byId.get(d.answerId);
    if (!a) return err(`${dt}.answerId "${d && d.answerId}" is not an answer`);
    if (typeof d.quote !== 'string' || !d.quote.trim()) return err(`${dt}.quote is empty`);
    if (!a.locked && !(a.text || '').includes(d.quote)) err(`${dt}.quote ${JSON.stringify(d.quote)} is not a literal quote from answer ${a.id}`);
    if (!a.namedYou) err(`${dt} comes from answer ${a.id}, which does not name the owner`);
  });

  // Fix steps and copy-paste text: plain strings, nothing else.
  (report.issues || []).forEach((it, i) => {
    const t = `issues[${i}]`;
    if (it && it.locked) return; // locked (src/lib/lock.js): only its severity is left, checked on the stored report
    if (!it || typeof it.title !== 'string' || !it.title) return err(`${t}.title is empty`);
    if (it.steps != null && !(Array.isArray(it.steps) && it.steps.every((s) => typeof s === 'string' && s.trim())))
      err(`${t}.steps must be an array of non-empty strings`);
    if (it.copyText != null && !(Array.isArray(it.copyText) && it.copyText.every((c) => c && typeof c.label === 'string' && c.label && typeof c.text === 'string' && c.text.trim())))
      err(`${t}.copyText must be an array of { label, text }`);
  });

  // Google reviews (optional; paid gap sheet). Every competitor is a business the answers named.
  if (report.reviews != null) {
    const rv = report.reviews;
    const isRating = (x) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 5);
    const isCount = (x) => Number.isInteger(x) && x >= 0;
    if (typeof rv !== 'object' || Array.isArray(rv)) err('reviews must be an object { you, competitors }');
    else {
      if (rv.you != null) {
        if (typeof rv.you !== 'object') err('reviews.you must be null or { rating, count }');
        else {
          if (!isRating(rv.you.rating)) err(`reviews.you.rating must be null or a number from 0 to 5 (got ${JSON.stringify(rv.you.rating)})`);
          if (!isCount(rv.you.count)) err(`reviews.you.count must be a non-negative integer (got ${JSON.stringify(rv.you.count)})`);
        }
      }
      if (!Array.isArray(rv.competitors)) err('reviews.competitors must be an array');
      else {
        const known = new Set();
        for (const e of report.entities || []) {
          if (e && !e.isYou) for (const n of [e.name, ...(e.aliases || [])]) if (n) known.add(n);
        }
        rv.competitors.forEach((c, i) => {
          const ct = `reviews.competitors[${i}]`;
          if (!c || typeof c !== 'object') return err(`${ct} is not an object`);
          if (typeof c.name !== 'string' || !c.name) return err(`${ct}.name is empty`);
          if (!known.has(c.name)) err(`${ct}.name "${c.name}" is not a competitor named in the answers`);
          if (!isRating(c.rating)) err(`${ct}.rating must be null or a number from 0 to 5 (got ${JSON.stringify(c.rating)})`);
          if (!isCount(c.count)) err(`${ct}.count must be a non-negative integer (got ${JSON.stringify(c.count)})`);
          if (c.placeUrl != null && typeof c.placeUrl !== 'string') err(`${ct}.placeUrl must be a string`);
        });
      }
    }
  }

  (report.sources || []).forEach((s, i) => {
    if (s.youPosition != null && (!Number.isInteger(s.youPosition) || s.youPosition < 1))
      err(`sources[${i}].youPosition must be null or a positive integer (got ${JSON.stringify(s.youPosition)})`);
    for (const aid of s.citedIn || []) if (!byId.has(aid)) err(`sources[${i}].citedIn has "${aid}", which is not an answer`);
  });

  if (report.headline) {
    if (!byId.has(report.headline.answerId)) err(`headline.answerId "${report.headline.answerId}" is not an answer`);
    const expect = pickHeadline(report);
    if (expect && (expect.answerId !== report.headline.answerId || expect.rule !== report.headline.rule))
      err(`headline is ${report.headline.answerId}/${report.headline.rule} but the rule picks ${expect.answerId}/${expect.rule}`);
  } else if ((answers || []).length) err('headline missing');

  // Method always shown.
  const m = report.method;
  if (!m || typeof m !== 'object') err('method missing');
  else {
    if (!m.engines || !Object.keys(m.engines).length) err('method.engines missing');
    if (!m.window) err('method.window missing');
    if (!Number.isInteger(m.runs) || m.runs < 1) err('method.runs must be a positive integer');
    if (!Array.isArray(m.enginesFailed)) err('method.enginesFailed must be an array');
    // A failed extraction leaves an answer looking like "didn't name you": never publish it.
    for (const f of Array.isArray(m.extractionFailed) ? m.extractionFailed : []) {
      const a = byId.get(f && f.answerId);
      err(`answer ${f && f.answerId}${a ? ` (${a.engine} ${a.questionId})` : ''}: extraction failed (${(f && f.error) || 'unknown error'}); its counts can't be trusted`);
    }
    for (const a of answers || []) {
      if (m.engines && !m.engines[a.engine]) err(`answer ${a.id} engine "${a.engine}" is not in method.engines`);
      if ((m.enginesFailed || []).includes(a.engine)) err(`answer ${a.id} is from failed engine "${a.engine}"`);
    }
  }

  // No invented claims.
  for (const h of lintReport(report)) err(`banned word "${h.word}" in ${h.path}: ${JSON.stringify(h.match)}`);

  return { ok: errors.length === 0, errors };
}
