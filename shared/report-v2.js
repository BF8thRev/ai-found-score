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

/** The refund promise: "if we can't show you 3 things you can fix, money back". */
export const MIN_FIX_ITEMS = 3;

/** Fix items in a report: its issues (a locked report keeps them as untitled stand-ins, still counted). */
export function fixItems(report) {
  return ((report && report.issues) || []).filter((i) => i && (i.title || i.locked));
}

/** True when the $29 Fix steps tier may be offered for this report (≥ MIN_FIX_ITEMS fixes). */
export function snapshotOffered(report) {
  return fixItems(report).length >= MIN_FIX_ITEMS;
}

/** True when the $49 AI Visibility X-Ray may be offered (same refund promise: ≥ MIN_FIX_ITEMS fixes). */
export function xrayOffered(report) {
  return fixItems(report).length >= MIN_FIX_ITEMS;
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
  return String((report && report.business && report.business.website) || '')
    .replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
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
 */
export function buildGapSheet(report) {
  const answers = (report && report.answers) || [];
  const byId = new Map(answers.map((a) => [a && a.id, a]));
  const own = ownDomain(report);
  const sources = ((report && report.sources) || []).filter((s) => s && s.domain !== own);
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
    competitors.push({ id: e.id, name: e.name, named: named.length, first, answerIds: named, sources: gap });
  }
  competitors.sort((a, b) => b.named - a.named || b.first - a.first || String(a.name).localeCompare(String(b.name)));
  return {
    answers: answers.length,
    competitors,
    sourcesChecked: sources.filter((s) => s.youListed === true || s.youListed === false).length,
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
