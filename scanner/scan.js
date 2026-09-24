// scanner/scan.js — run one business through every engine × question × run.
//
// Runtime-agnostic (Worker or Node). Never throws for an engine failure: failed calls are
// returned (and stored) with ok:false so the report can say which engine didn't respond.

import { ENGINE_IDS, defaultScanEngines, DEFAULT_RUNS, DEFAULT_CONCURRENCY, DEFAULT_TIMEOUT_MS, round6 } from './config.js';
import { buildQuestions } from './questions.js';
import { ENGINES } from './engines/index.js';
import { supabaseStore } from './store.js';

function newScanId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback (very old runtimes): RFC 4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Run async jobs with at most `limit` in flight; results keep input order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object}   o
 * @param {object}   o.business   { id?, name, trade, town, state?, zip?, nearbyTown?, ... }
 * @param {object}   o.env        Worker env or process.env (keys, SUPABASE_*)
 * @param {string[]} [o.engines]  engine ids (default activeEngines(env): every engine with a key)
 * @param {number}   [o.runs]     runs per question per engine (default 2)
 * @param {Function} [o.fetchImpl]
 * @param {true|object} [o.store] true → Supabase scan_raw rows; or { saveCalls({scanId,businessId,calls}) }
 * @param {number}   [o.concurrency] parallel calls (default 4)
 * @param {number}   [o.timeoutMs]   per-call timeout (default 120s)
 * @param {Function} [o.onCall]      called with each finished call (progress)
 * @param {string}   [o.scanId]
 * @param {object[]} [o.questions]   override the built question list (e.g. a 1-question light test)
 * @returns {Promise<{scanId, business, questions, calls, costUsd, window:{start,end}, engines, runs, stored}>}
 */
export async function runScan({
  business,
  env = {},
  engines,
  runs = DEFAULT_RUNS,
  fetchImpl = fetch,
  store,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onCall,
  scanId = newScanId(),
  questions: questionsOverride,
} = {}) {
  const questions = Array.isArray(questionsOverride) && questionsOverride.length ? questionsOverride : buildQuestions(business);
  const engineIds = [...new Set(engines || defaultScanEngines(env))];
  const unknown = engineIds.filter((e) => !ENGINES[e]);
  if (unknown.length) throw new Error(`unknown engine(s): ${unknown.join(', ')} (use ${ENGINE_IDS.join(', ')})`);
  runs = Math.max(1, Math.floor(Number(runs) || DEFAULT_RUNS));

  // Order: run 1 of every question on every engine, then run 2 — so a run's calls sit close in time.
  const jobs = [];
  for (let run = 1; run <= runs; run++)
    for (const q of questions)
      for (const e of engineIds) jobs.push({ engine: e, question: q, run });

  const start = new Date().toISOString();
  const calls = await pool(jobs, concurrency, async ({ engine, question, run }) => {
    let res;
    try {
      res = await ENGINES[engine].ask({ question, business, env, fetchImpl, timeoutMs });
    } catch (e) {
      // Adapters shouldn't throw; guard anyway so one bug can't sink the scan.
      res = { engine, ok: false, text: null, citations: [], request: null, raw: null, costUsd: 0, error: `adapter threw: ${e?.message || e}`, askedAt: new Date().toISOString(), model: null };
    }
    const call = { ...res, questionId: question.id, intent: question.intent, questionText: question.text, run };
    if (onCall) try { onCall(call); } catch { /* progress only */ }
    return call;
  });
  const end = new Date().toISOString();

  const result = {
    scanId,
    business,
    questions,
    engines: engineIds,
    runs,
    calls,
    costUsd: round6(calls.reduce((s, c) => s + (Number(c.costUsd) || 0), 0)),
    window: { start, end },
    stored: null,
  };

  if (store) {
    const s = store === true ? supabaseStore(env, { fetchImpl }) : store;
    try {
      result.stored = await s.saveCalls({ scanId, businessId: business?.id ?? null, calls });
    } catch (e) {
      result.stored = { ok: false, count: 0, error: String(e?.message || e) };
    }
  }
  return result;
}

/** Ping every engine (or a subset) in parallel. */
export async function pingAll(env, { engines = ENGINE_IDS, fetchImpl = fetch } = {}) {
  return Promise.all(engines.map((e) => ENGINES[e].ping(env, { fetchImpl })));
}

/** Short per-engine summary of a scan result (for CLI / admin responses). */
export function summarizeScan(scan) {
  const byEngine = {};
  for (const c of scan.calls) {
    const s = (byEngine[c.engine] ||= { calls: 0, ok: 0, failed: 0, costUsd: 0, citations: 0, errors: [] });
    s.calls++;
    if (c.ok) s.ok++; else { s.failed++; if (s.errors.length < 3) s.errors.push(`${c.questionId}/r${c.run}: ${c.error}`); }
    s.costUsd = round6(s.costUsd + (Number(c.costUsd) || 0));
    s.citations += c.citations?.length || 0;
  }
  return { scanId: scan.scanId, costUsd: scan.costUsd, window: scan.window, byEngine, stored: scan.stored };
}
