// src/admin/scan-core.js — pure helpers shared by the scan Workflow, the admin API and the
// dashboard's "Run scan" form. No I/O, no bindings: safe to unit-test under node --test.

import { BILLING_ERROR_RE } from '../../scanner/engines/_common.js';
import { ENGINE_IDS, DEFAULT_RUNS, round6 } from '../../scanner/config.js';
import { normalizeTrade } from '../../scanner/questions.js';
import { scrubKeyFragments } from '../../scanner/store.js';

export const TRIGGERS = ['admin', 'request', 'recheck'];
export const MAX_RUNS = 3;
/** Longest answer text carried between Workflow steps (step results must stay well under 1 MiB). */
export const MAX_STEP_TEXT = 40_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Validate a scan request (admin API JSON body or the dashboard form, already mapped).
 * body: { business: { id?, name, trade, town, state?, zip?, phone?, website?, address? },
 *         engines?: string[], runs?: number, questions?: number (limit, 1..5), reportToken?,
 *         trigger?: 'admin'|'request'|'recheck', notes? }
 * → { ok: true, params } | { ok: false, error }
 * `knownEngines` is the engine registry's ids (so a new adapter needs no change here).
 */
export function parseScanRequest(body, { knownEngines = ENGINE_IDS } = {}) {
  const b = body?.business;
  if (!b || typeof b !== 'object') return { ok: false, error: 'business is required' };
  const business = {
    ...(UUID_RE.test(String(b.id || '')) ? { id: String(b.id).toLowerCase() } : {}),
    name: clean(b.name, 160),
    trade: normalizeTrade(clean(b.trade, 40)) || clean(b.trade, 40),
    town: clean(b.town, 60).replace(/,\s*[A-Za-z]{2}$/, ''),
    state: clean(b.state || 'NY', 20),
    zip: clean(b.zip, 10) || null,
    phone: clean(b.phone, 30) || null,
    website: clean(b.website, 200) || null,
    address: clean(b.address, 200) || null,
  };
  if (b.nearbyTown) business.nearbyTown = clean(b.nearbyTown, 60);
  if (!business.name || !business.trade || !business.town) {
    return { ok: false, error: 'business.name, business.trade and business.town are required' };
  }
  if (business.zip && !/^\d{5}$/.test(business.zip)) return { ok: false, error: 'zip must be 5 digits' };

  let engines = Array.isArray(body.engines) && body.engines.length ? body.engines.map((e) => String(e).trim()) : ENGINE_IDS;
  engines = [...new Set(engines)];
  const unknown = engines.filter((e) => !knownEngines.includes(e));
  if (unknown.length) return { ok: false, error: `unknown engine(s): ${unknown.join(', ')}` };

  const runsRaw = body.runs == null || body.runs === '' ? DEFAULT_RUNS : Math.floor(Number(body.runs));
  if (!Number.isFinite(runsRaw) || runsRaw < 1 || runsRaw > MAX_RUNS) return { ok: false, error: `runs must be 1-${MAX_RUNS}` };

  let questionLimit = null;
  if (body.questions != null && body.questions !== '') {
    questionLimit = Math.floor(Number(body.questions));
    if (!Number.isFinite(questionLimit) || questionLimit < 1 || questionLimit > 5) return { ok: false, error: 'questions must be 1-5' };
    if (questionLimit === 5) questionLimit = null;
  }
  const trigger = TRIGGERS.includes(body.trigger) ? body.trigger : 'admin';
  const reportToken = body.reportToken ? String(body.reportToken).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || null : null;
  return {
    ok: true,
    params: { business, engines, runs: runsRaw, questionLimit, trigger, reportToken, notes: clean(body.notes, 500) || null },
  };
}

/** Report token for a new scan (same alphabet as scanner/extract/build.js). */
export function newReportToken() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((x) => abc[x % abc.length]).join('');
}

/** Every engine × question × run job, run-major then question-major (one question's engines sit together). */
export function scanJobs(questions, engines, runs) {
  const jobs = [];
  for (let run = 1; run <= runs; run++)
    for (const q of questions)
      for (const engine of engines) jobs.push({ engine, questionId: q.id, run, key: `${engine}:${q.id}:${run}` });
  return jobs;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * What an engine step hands to later steps: answer text, citations, ok, error, cost.
 * Never the raw API response (that lives in scan_raw). Text and citations are capped.
 */
export function compactCall(call, question = {}) {
  const text = typeof call.text === 'string' ? call.text : null;
  return {
    engine: call.engine,
    questionId: call.questionId ?? question.id,
    intent: call.intent ?? question.intent ?? null,
    questionText: call.questionText ?? question.text ?? null,
    run: call.run || 1,
    ok: !!call.ok && !!(text && text.trim()),
    text: text && text.length > MAX_STEP_TEXT ? text.slice(0, MAX_STEP_TEXT) : text,
    truncated: !!(text && text.length > MAX_STEP_TEXT),
    citations: (call.citations || []).slice(0, 60).map((c) => ({
      url: String(c.url || '').slice(0, 2000),
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.title ? { title: String(c.title).slice(0, 300) } : {}),
      ...(c.uncited ? { uncited: true } : {}),
    })),
    error: call.error == null ? null : scrubKeyFragments(String(call.error)).slice(0, 500),
    costUsd: round6(call.costUsd),
    askedAt: call.askedAt || null,
    model: call.model || null,
  };
}

/** Transient failures worth a Workflow retry (no answer, nothing billed). */
export function isTransientEngineError(call) {
  if (call.ok || (Number(call.costUsd) || 0) > 0) return false;
  if (BILLING_ERROR_RE.test(String(call.error || ''))) return false;
  return /HTTP (429|500|502|503|504|529)\b|network error|overloaded|rate.?limit/i.test(String(call.error || ''));
}

export function isTransientExtractError(error) {
  return /rate_limited|connection_error|api_error \(HTTP (5\d\d|529|n\/a)\)|overloaded/i.test(String(error || ''));
}

/** "5:01pm" style window bounds from askedAt values. */
export function callWindow(calls) {
  const ts = calls.map((c) => c.askedAt).filter(Boolean).sort();
  return { start: ts[0] || null, end: ts[ts.length - 1] || null };
}

/**
 * The `scans` row patch written when a scan finishes.
 * calls: compact calls; extractions: [{ ok, costUsd, error, key }]; build: build-step summary.
 */
export function scanTotals({ calls = [], extractions = [], build = null }) {
  const engineCost = round6(calls.reduce((s, c) => s + (Number(c.costUsd) || 0), 0));
  const extractCost = round6(extractions.reduce((s, x) => s + (Number(x.costUsd) || 0), 0) + (Number(build?.extraExtractCostUsd) || 0));
  const errors = [
    ...calls.filter((c) => !c.ok).map((c) => ({ kind: 'engine', engine: c.engine, questionId: c.questionId, run: c.run, error: c.error || 'no answer' })),
    ...extractions.filter((x) => !x.ok).map((x) => ({ kind: 'extract', ref: x.key, error: x.error || 'failed' })),
    ...((build?.errors || []).map((e) => ({ kind: 'report', error: e }))),
    ...(build?.storeError ? [{ kind: 'store', error: build.storeError }] : []),
  ].slice(0, 50);
  const okCalls = calls.filter((c) => c.ok).length;
  return {
    calls_total: calls.length,
    calls_ok: okCalls,
    engine_cost_usd: engineCost,
    extract_cost_usd: extractCost,
    total_cost_usd: round6(engineCost + extractCost),
    answers: build?.totals?.answers ?? null,
    named_you: build?.totals?.namedYou ?? null,
    first_you: build?.totals?.firstYou ?? null,
    report_valid: build ? !!build.valid : false,
    errors,
    status: okCalls === 0 ? 'failed' : 'done',
  };
}

// ---------------------------------------------------------------------------
// Pipeline pieces shared by the scan Workflow (src/scan-workflow.js) and the local runner
// (scanner/run.js), so both write the same rows with the same ids.
// ---------------------------------------------------------------------------

/** Engine calls / extractions started together (different providers, so rate limits stay low). */
export const ENGINE_BATCH = 5;
export const EXTRACT_BATCH = 5;
/** Extra attempts after a free, transient failure (429 / 5xx / network). A billed call is never repeated. */
export const ENGINE_RETRIES = 2;
export const EXTRACT_RETRIES = 3;

/** `engine:questionId:run`, the key of one answer (scan_usage.answer_ref, proposals, step names). */
export const answerRef = (c) => `${c.engine}:${c.questionId}:${c.run || 1}`;

/** Seed of a call's scan_raw id: stableUuid(rawIdSeed(scanId, job.key)). */
export const rawIdSeed = (scanId, key) => `${scanId}:${key}`;

/**
 * Seed of an extraction's scan_usage id. Attempt > 1 gets its own id: the proposals aren't
 * stored, so a retry after a landed write is a second billed call and must be recorded too.
 */
export const extractIdSeed = (scanId, key, attempt = 1) => `${scanId}:extract:${key}${attempt > 1 ? `:a${attempt}` : ''}`;

/** What an adapter "returned" when it threw (adapters shouldn't; one bug can't sink the scan). */
export function adapterThrew(engine, e) {
  return { engine, ok: false, text: null, citations: [], request: null, raw: null, costUsd: 0, error: `adapter threw: ${e?.message || e}`, askedAt: new Date().toISOString(), model: null };
}

/** A compact call rebuilt from a stored ok scan_raw row (reused instead of paying the engine again). */
export function callFromStoredRaw(prev, q) {
  return compactCall({
    engine: prev.engine, questionId: q.id, intent: q.intent, questionText: q.text, run: prev.run,
    ok: true, text: prev.answer_text, citations: prev.citations || [], error: null,
    costUsd: Number(prev.cost_usd) || 0, askedAt: prev.asked_at, model: prev.model,
  }, q);
}

/** The compact extraction result handed to the build step. `error` is already redacted. */
export function extractionResult(key, r, error) {
  return {
    key, ok: r.ok !== false, error,
    businesses: r.businesses || [], ownerFacts: r.ownerFacts || [],
    model: r.model || null, costUsd: round6(r.costUsd),
    inputTokens: r.usage?.input_tokens || 0, outputTokens: r.usage?.output_tokens || 0,
  };
}

/** Extraction results → buildReport's proposalsByAnswer (a failure stays a failure). */
export function proposalsFromExtractions(extractions) {
  return Object.fromEntries(extractions.map((x) => [x.key, x.ok
    ? { businesses: x.businesses, ownerFacts: x.ownerFacts, model: x.model }
    : { ok: false, error: x.error, model: x.model }]));
}

/** The publish gate: validateReport's verdict, plus "no answers at all" is never publishable. */
export function publishGate(report, validation) {
  const v = { ok: validation.ok, errors: [...validation.errors] };
  if (!report.answers?.length) {
    v.ok = false;
    v.errors.push('no successful answers (every engine failed)');
  }
  return v;
}
