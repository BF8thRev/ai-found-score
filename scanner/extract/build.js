// buildReport: scan (raw engine results) → report JSON v2 → validateReport.
// Runtime-agnostic ES module (global fetch / crypto only; keys via `env`).
//
// Input `scan` shape (what the scanner hands over):
// {
//   id?, reportId?, generatedAt?,
//   questions: [{ id, intent, text }],
//   engines?: [engineId],                      // engines attempted, in column order
//   calls: [ {                                 // one per engine call = engine adapter result
//     engine, questionId, run, ok, text, citations:[{url,domain?,title?}],
//     askedAt, model, error?, api?
//   } ],
//   method?: { window?, engines?: { [id]: { api, model, loggedIn } } }  (optional overrides)
// }
// This is exactly what scanner/scan.js runScan() returns: pass it straight through.
// Recorded proposals (tests / re-runs) are keyed by answer id ("a1") or by
// `${engine}:${questionId}:${run}`.

import { computeTotals, pickHeadline, validateReport } from '../../shared/report-v2.js';
import { proposeForAnswer } from './propose.js';
import { verifyAnswer, factStatus, ownerFact, descriptorKey } from './verify.js';
import { groupEntities } from './entities.js';
import { normalizeName } from './normalize.js';
import { buildSources } from './sources.js';
import { buildIssues } from './issues.js';
import { runOwnerChecks } from '../owner-checks.js';

const ENGINE_API = {
  chatgpt: 'openai-responses+web_search',
  gemini: 'gemini+google_search',
  google_ai_mode: 'dataforseo-ai-mode',
  perplexity: 'sonar',
  claude: 'anthropic-messages+web_search',
};

export const answerKey = (r) => `${r.engine}:${r.questionId}:${r.run || 1}`;

function token() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

/** "5:01–5:10pm ET" from askedAt timestamps (America/New_York). */
export function formatWindow(times, timeZone = 'America/New_York') {
  const ds = times.map((t) => new Date(t)).filter((d) => !isNaN(d)).sort((a, b) => a - b);
  if (!ds.length) return null;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true });
  const part = (d) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    return { hm: `${p.hour}:${p.minute}`, ap: String(p.dayPeriod || '').toLowerCase() };
  };
  const a = part(ds[0]);
  const b = part(ds[ds.length - 1]);
  const tz = timeZone === 'America/New_York' ? 'ET' : timeZone;
  if (a.hm === b.hm && a.ap === b.ap) return `${a.hm}${a.ap} ${tz}`;
  return a.ap === b.ap ? `${a.hm}–${b.hm}${b.ap} ${tz}` : `${a.hm}${a.ap}–${b.hm}${b.ap} ${tz}`;
}

/** Most fact cards the report shows. */
export const MAX_FACTS = 8;
const STATUS_ORDER = { differs: 0, match: 1, 'not stated': 2 };

const tokens = (s) => new Set(normalizeName(String(s || '').replace(/\//g, ' ')).split(' ').filter(Boolean));

/**
 * How specific a quote is: how many of the owner's own words for the field it states
 * ("1502 Deer Park Ave in North Babylon, NY" beats "1502 Deer Park Ave"). Without owner facts,
 * how many numbers it carries.
 */
export function factSpecificity(f) {
  const a = tokens(f.aiSays);
  if (f.sourceSays) {
    const b = tokens(f.sourceSays);
    return [...a].filter((w) => b.has(w)).length;
  }
  return [...a].filter((w) => /\d/.test(w)).length;
}

/**
 * pickFacts(facts, engineOf) → the facts the report keeps, in page order.
 * One fact per (field, engine): differs beats match beats not stated, then the most specific
 * quote (factSpecificity), then the shorter quote, then first seen. Then differs first, then
 * match, capped at MAX_FACTS. `not stated` facts are kept only when nothing else was checkable.
 */
export function pickFacts(facts, engineOf = new Map(), max = MAX_FACTS) {
  const best = new Map();
  facts.forEach((f, i) => {
    const key = `${f.field}|${engineOf.get(f.answerId) || f.answerId}`;
    const cur = best.get(key);
    const spec = factSpecificity(f);
    const better = !cur
      || (STATUS_ORDER[f.status] - STATUS_ORDER[cur.f.status]
        || cur.spec - spec
        || f.aiSays.length - cur.f.aiSays.length) < 0;
    if (better) best.set(key, { f, i, spec });
  });
  const kept = [...best.values()].sort((a, b) => STATUS_ORDER[a.f.status] - STATUS_ORDER[b.f.status] || a.i - b.i);
  const checked = kept.filter((x) => x.f.status !== 'not stated');
  return (checked.length ? checked : kept).slice(0, max).map((x) => x.f);
}

/** Most "how AI describes you" phrases the report keeps. */
export const MAX_DESCRIPTORS = 6;

/**
 * pickDescriptors(raw, engineOf) → [{ answerId, quote }] (≤ MAX_DESCRIPTORS).
 * raw: verified descriptors in answer order. Deduped (case/space-insensitive, and a phrase
 * contained in one already kept is dropped), then taken round-robin across engines so one
 * assistant's wording doesn't fill the list.
 */
export function pickDescriptors(raw, engineOf = new Map(), max = MAX_DESCRIPTORS) {
  const kept = [];
  for (const d of raw) {
    const k = descriptorKey(d.quote);
    if (!k || kept.some((x) => x.k.includes(k) || k.includes(x.k))) continue;
    kept.push({ ...d, k });
  }
  const byEngine = new Map();
  for (const d of kept) {
    const e = engineOf.get(d.answerId) || '';
    if (!byEngine.has(e)) byEngine.set(e, []);
    byEngine.get(e).push(d);
  }
  const out = [];
  const lists = [...byEngine.values()];
  for (let i = 0; out.length < max && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < max) out.push({ answerId: l[i].answerId, quote: l[i].quote });
  }
  return out;
}

/**
 * applyHeadlineConfirmation(report, confirmation) → report (mutated)
 * confirmation = { ref: 'engine:qid:run' of the headline answer, ok, agreed: true|false|null, error? }
 *   agreed true  → method.headlineConfirmed = true
 *   agreed false → the re-asked answer's owner status flipped: that answer gets
 *                  headlineUnstable: true, the next candidate becomes the headline,
 *                  method.headlineConfirmed = false
 *   agreed null  → the re-ask failed or was unsure: headline kept, headlineConfirmed = false
 * No confirmation (runs > 1, or not attempted) leaves the report unchanged.
 */
export function applyHeadlineConfirmation(report, c) {
  if (!c || !report || !Array.isArray(report.answers)) return report;
  const a = report.answers.find((x) => answerKey(x) === c.ref);
  report.method = report.method || {};
  if (!a) {
    report.method.headlineConfirmed = false;
    return report;
  }
  report.method.headlineConfirm = {
    answerId: a.id, engine: a.engine, questionId: a.questionId, run: 2,
    result: c.agreed === true ? 'same' : c.agreed === false ? 'changed' : 'inconclusive',
  };
  if (c.agreed === false) {
    a.headlineUnstable = true;
    report.headline = pickHeadline(report);
  }
  report.method.headlineConfirmed = c.agreed === true;
  return report;
}

/**
 * buildReport({ scan, business, listings?, issues?, baseline?, proposalsByAnswer?, env, fetchImpl, id?, now?, maxFetch?, headlineConfirmation? })
 *   → Promise<{ report, validation, rejected, extraction }>
 * `rejected` lists every model proposal the code threw out (for the scan log).
 * `extraction` = { calls, costUsd, inputTokens, outputTokens, failures[] } for the scan cost total.
 * Any extraction failure makes validation.ok false (the report must not publish).
 * `onExtract(call)` (optional, may be async) is called once per paid extractor call with
 * { answerId, key, engine, questionId, run, ok, error, model, usage, costUsd } so the caller
 * can record per-call usage (scan_usage). Recorded proposals (source 'recorded') cost nothing
 * and are not reported.
 */
export async function buildReport({
  scan, business, listings = [], issues = [], baseline = null, proposalsByAnswer = {},
  env = {}, fetchImpl, id, now, maxFetch = 5, onExtract, headlineConfirmation = null,
}) {
  // The owner's website (robots.txt, schema, phone and address) and Google listing (scanner/owner-checks.js).
  // Skipped on a pre-build (maxFetch 0) and when the caller already supplies listings.
  let siteCheck = null;
  if (maxFetch !== 0 && !listings.length && business && (business.website || business.name)) {
    const oc = await runOwnerChecks(business, env, { fetchImpl: fetchImpl || fetch });
    siteCheck = oc.siteCheck;
    listings = oc.listings;
    issues = [...issues, ...oc.issues];
    // What the owner told us wins; the website fills the gaps.
    const facts = { ...oc.facts, ...(business.facts || {}) };
    if (Object.keys(facts).length) business = { ...business, facts };
  }
  const questions = (scan.questions || []).map((q) => ({ id: q.id, intent: q.intent, text: q.text }));
  const qById = new Map(questions.map((q) => [q.id, q]));
  const qIndex = (qid) => questions.findIndex((q) => q.id === qid);
  if (!Array.isArray(scan.calls)) {
    throw new Error('buildReport: scan.calls must be an array (pass the runScan() result as-is)');
  }
  const results = scan.calls;

  // Engine columns: as attempted, else first appearance.
  const engines = [...new Set([...(scan.engines || []), ...results.map((r) => r.engine)])];
  const okBy = (e) => results.filter((r) => r.engine === e && r.ok !== false && typeof r.text === 'string' && r.text.trim());
  const enginesFailed = engines.filter((e) => okBy(e).length === 0);
  const failedCalls = results
    .filter((r) => !enginesFailed.includes(r.engine) && !(r.ok !== false && typeof r.text === 'string' && r.text.trim()))
    .map((r) => ({ engine: r.engine, questionId: r.questionId, run: r.run || 1, error: r.error || 'no answer' }));

  const good = engines
    .filter((e) => !enginesFailed.includes(e))
    .flatMap((e) => okBy(e).sort((a, b) => qIndex(a.questionId) - qIndex(b.questionId) || (a.run || 1) - (b.run || 1)));

  // Answers + verified extraction.
  const answers = [];
  const factsRaw = [];
  const descriptorsRaw = [];
  const rejected = [];
  const extraction = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, failures: [] };
  for (const r of good) {
    const aid = `a${answers.length + 1}`;
    const q = qById.get(r.questionId) || {};
    const base = {
      id: aid, questionId: r.questionId, intent: q.intent || null, engine: r.engine, run: r.run || 1,
      askedAt: r.askedAt || null, text: r.text, citations: [],
    };
    // Only what the answer actually cites. Adapters flag a fallback list of every search
    // result (no citation markers in the answer) as `uncited`; those are not citations.
    base.citations = (r.citations || [])
      .filter((c) => !(c && c.uncited === true))
      .map((c) => {
        const url = typeof c === 'string' ? c : c && c.url;
        if (!url) return null;
        let domain = c && c.domain;
        try { domain = domain || new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
        return { domain: String(domain).toLowerCase().replace(/^www\./, ''), url };
      })
      .filter(Boolean);
    const recorded = proposalsByAnswer[aid] || proposalsByAnswer[answerKey(r)];
    const proposal = await proposeForAnswer({ answer: base, business, env, fetchImpl, proposals: recorded });
    if (proposal.source === 'model') {
      extraction.calls++;
      extraction.costUsd += proposal.costUsd || 0;
      extraction.inputTokens += (proposal.usage && proposal.usage.input_tokens) || 0;
      extraction.outputTokens += (proposal.usage && proposal.usage.output_tokens) || 0;
      // Per-call usage hook (the caller records one scan_usage row per paid extractor call).
      if (typeof onExtract === 'function') {
        try {
          await onExtract({
            answerId: aid, key: answerKey(r), engine: r.engine, questionId: r.questionId, run: r.run || 1,
            ok: proposal.ok !== false, error: proposal.error || null, model: proposal.model || null,
            usage: proposal.usage || null, costUsd: proposal.costUsd || 0,
          });
        } catch { /* cost logging must never break a report build */ }
      }
    }
    // A failed extraction yields no proposals (never invented). The answer would then
    // look like "didn't name you", so the report is blocked from publishing below.
    if (proposal.ok === false) extraction.failures.push({ answerId: aid, engine: r.engine, questionId: r.questionId, run: r.run || 1, error: proposal.error });
    const v = verifyAnswer({ answer: base, proposal, business });
    for (const x of v.rejected.businesses) rejected.push({ answerId: aid, kind: 'business', ...x });
    for (const x of v.rejected.facts) rejected.push({ answerId: aid, kind: 'fact', ...x });
    for (const x of v.rejected.descriptors || []) rejected.push({ answerId: aid, kind: 'descriptor', ...x });
    const ans = {
      ...base,
      businessesNamed: v.businessesNamed,
      namedYou: v.namedYou,
      namedYouFirst: v.namedYouFirst,
    };
    if (v.ownerMatch === 'unsure' && !v.namedYou) ans.ownerMatch = 'unsure';
    answers.push(ans);
    // Facts only count when this answer is confirmed to be talking about the owner.
    if (v.namedYou) for (const f of v.facts) factsRaw.push({ answerId: aid, ...f });
    if (v.namedYou) for (const d of v.descriptors || []) descriptorsRaw.push({ answerId: aid, quote: d.quote });
  }

  // Entities.
  const { entities, entityIdOf } = groupEntities(answers, { ownerName: business.name });
  for (const a of answers) {
    a.businessesNamed = a.businessesNamed.map((b, i) => {
      const eid = entityIdOf.get(`${a.id}#${i}`);
      return eid ? { ...b, entityId: eid } : b;
    });
  }

  // Sources (citations from the APIs only) + directory page checks.
  const sources = await buildSources({ answers, business, fetchImpl, maxFetch });

  // AI facts vs the owner's own website/listings.
  const engineOf = new Map(answers.map((a) => [a.id, a.engine]));
  const aiFacts = pickFacts(factsRaw.map((f) => {
    const fromSite = business.facts && business.facts[f.field] != null && business.facts[f.field] !== '';
    const sourceSays = ownerFact(f.field, business, listings);
    return {
      answerId: f.answerId, field: f.field, aiSays: f.aiSays, sourceSays,
      sourceFrom: sourceSays == null ? null : fromSite || ['phone', 'address'].includes(f.field) ? 'website' : 'listing',
      status: factStatus(f.field, f.aiSays, sourceSays),
    };
  }), engineOf);

  // Method (always present).
  const methodEngines = {};
  for (const e of engines) {
    const given = (scan.method && scan.method.engines && scan.method.engines[e]) || {};
    const r = results.find((x) => x.engine === e) || {};
    methodEngines[e] = { api: given.api || r.api || ENGINE_API[e] || e, model: given.model || r.model || null, loggedIn: given.loggedIn === true };
  }
  const runs = Math.max(1, ...results.map((r) => r.run || 1));

  const report = {
    id: id || scan.reportId || token(),
    version: 2,
    generatedAt: scan.generatedAt || (now ? new Date(now) : new Date()).toISOString(),
    business: {
      name: business.name, trade: business.trade || null, address: business.address || null,
      town: business.town || null, state: business.state || null, zip: business.zip || null,
      phone: business.phone || null, website: business.website || null,
      // The owner's own website facts (what aiFacts and the fix steps are built from).
      ...(business.facts && Object.keys(business.facts).length ? { facts: { ...business.facts } } : {}),
    },
    questions,
    answers,
    entities,
    totals: null,
    headline: null,
    sources,
    aiFacts,
    ownerDescriptors: pickDescriptors(descriptorsRaw, engineOf),
    listings,
    ...(siteCheck ? { siteCheck } : {}),
    issues: [],
    method: {
      engines: methodEngines,
      enginesFailed,
      window: (scan.method && scan.method.window) || formatWindow(results.map((r) => r.askedAt).filter(Boolean)),
      runs,
      ...(failedCalls.length ? { failedCalls } : {}),
      // Present only on a scan that must not publish; validateReport rejects any entry here,
      // so the Worker's own re-validation catches it too.
      ...(extraction.failures.length ? { extractionFailed: extraction.failures.map((f) => ({ answerId: f.answerId, error: f.error })) } : {}),
    },
    baseline: baseline ? { generatedAt: baseline.generatedAt || null, totals: baseline.totals || baseline } : null,
    locked: true,
  };
  report.totals = computeTotals(report);
  report.headline = pickHeadline(report);
  // A re-ask of the headline search (scan-core confirmHeadline) may move the headline.
  applyHeadlineConfirmation(report, headlineConfirmation);
  report.issues = buildIssues({ report, extra: issues, business });

  const validation = validateReport(report);
  return { report, validation, rejected, extraction };
}

