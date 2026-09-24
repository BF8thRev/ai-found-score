#!/usr/bin/env node
// scanner/run.js — run a full scan from this PC and write it to Supabase exactly as the scan
// Workflow (src/scan-workflow.js) would: same tables, same row ids, same report gate. The live
// /admin dashboard and /report/<token> page then show it as if the Workflow had run.
//
// Why: on the Workers Free plan a full scan can't run inside the Worker (10 ms CPU and 50
// subrequests per invocation). Node on the owner's PC has no such limits and no hosting cost.
//
//   node scanner/run.js --business path.json [--engines chatgpt,claude,gemini] [--runs 1]
//                       [--token <reportToken>] [--notes "..."] [--resume <scanId> [--rebuild]]
//                       [--estimate] [--yes] [--dry-run]
//
// Keys: .dev.vars in the repo root (KEY=value, git-ignored) overlaid by process.env.
// --dry-run answers every call from the recorded fixtures and writes to an in-memory Supabase:
// no network, no keys, no cost.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import {
  ENGINE_IDS, ACTIVE_ENGINES, DEFAULT_RUNS, ENGINE_NAMES, estimateScanCost, enginesConfigured, resolveKeys, round6,
} from './config.js';
import { buildQuestions } from './questions.js';
import { ENGINES } from './engines/index.js';
import { pool } from './scan.js';
import { buildReport } from './extract/build.js';
import { proposeForAnswer } from './extract/propose.js';
import { validateReport } from '../shared/report-v2.js';
import {
  canStore, ensureBusiness, upsertScan, rawRow, saveRaw, usageRow, saveUsage, stableUuid, isUuid,
  saveReport, updateReport, findReportByScan, getBaseline, getRawById, getScan,
} from './store.js';
import {
  parseScanRequest, newReportToken, scanJobs, compactCall, isTransientEngineError, isTransientExtractError,
  scanTotals, callWindow, ENGINE_BATCH, EXTRACT_BATCH, ENGINE_RETRIES, EXTRACT_RETRIES, answerRef, rawIdSeed,
  extractIdSeed, adapterThrew, callFromStoredRaw, extractionResult, proposalsFromExtractions, publishGate,
} from '../src/admin/scan-core.js';
import { redact } from '../src/admin/redact.js';
import { loadEnv } from './env.js';

export const REPORT_BASE_URL = 'https://aifoundscore.com/report/';
const SAVE_RETRIES = 2;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

export const USAGE = `Usage: node scanner/run.js --business path.json [--engines ${ACTIVE_ENGINES.join(',')}] [--runs ${DEFAULT_RUNS}]
                          [--token <reportToken>] [--notes "..."] [--resume <scanId> [--rebuild]]
                          [--estimate] [--yes] [--dry-run]

  --business  JSON file: name, trade, address, town, state, zip, phone, website, nearbyTown?, id?
  --engines   comma list (default: ${ACTIVE_ENGINES.join(',')}; known: ${ENGINE_IDS.join(',')})
  --runs      runs per question per engine, 1-3 (default ${DEFAULT_RUNS})
  --token     report token to publish under (default: a fresh random one)
  --notes     note stored on the scans row (shown on /admin)
  --resume    continue a scan by id: calls already stored ok are reused, not paid again
  --rebuild   with --resume: re-extract every answer (paid, recorded in scan_usage) and replace
              the report already saved for that scan (it must still pass validation)
  --estimate  print the plan and cost estimate, then exit
  --yes       don't ask "Proceed? [y/N]"
  --dry-run   recorded fixtures + in-memory Supabase: no network, no keys, no cost`;

export function parseArgs(argv) {
  const a = { business: null, engines: null, runs: null, token: null, notes: null, resume: null, rebuild: false, estimate: false, yes: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === '--business' || k === '-b') a.business = next();
    else if (k === '--engines' || k === '-e') a.engines = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--runs' || k === '-r') a.runs = next();
    else if (k === '--token') a.token = next();
    else if (k === '--notes') a.notes = next();
    else if (k === '--resume') a.resume = next().trim().toLowerCase();
    else if (k === '--rebuild') a.rebuild = true;
    else if (k === '--estimate') a.estimate = true;
    else if (k === '--yes' || k === '-y') a.yes = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`unknown argument: ${k}\n\n${USAGE}`);
  }
  if (a.rebuild && !a.resume) throw new Error('--rebuild needs --resume <scanId>');
  return a;
}

// ---------------------------------------------------------------------------
// plan: which engines run (a missing key drops the engine BEFORE the scan starts), the estimate
// ---------------------------------------------------------------------------

/**
 * planScan({ business, engines, runs, env }) → { engines, skipped, questions, estimate, keys }
 * engines: the requested engines that have keys (these are called); skipped: requested but no key.
 * keys: { supabase, extractor } presence (never values).
 */
export function planScan({ business, engines, runs, env }) {
  const configured = enginesConfigured(env);
  const run = engines.filter((e) => configured[e]);
  const skipped = engines.filter((e) => !configured[e]);
  const questions = buildQuestions(business);
  const estimate = estimateScanCost({ engines: run, questions: questions.length, runs });
  const k = resolveKeys(env);
  return { engines: run, skipped, questions, estimate, keys: { supabase: canStore(env), extractor: !!k.anthropicKey } };
}

// ---------------------------------------------------------------------------
// the pipeline (mirrors src/scan-workflow.js step for step)
// ---------------------------------------------------------------------------

/**
 * Run one scan and store it. Supabase is required (the point is the dashboard + report page).
 * @param {object}   o
 * @param {object}   o.business        normalized business (parseScanRequest)
 * @param {string[]} o.engines         engines to call (all have keys)
 * @param {string[]} [o.skippedEngines] requested but not run (no key): listed in the report's
 *                                      method.enginesFailed, never called, not counted as calls
 * @param {number}   o.runs
 * @param {string}   o.reportToken
 * @param {string}   [o.scanId]        a new uuid, or the scan to resume
 * @param {boolean}  [o.resume]        reuse scan_raw rows already stored ok for this scanId
 * @param {boolean}  [o.rebuild]       replace the report already saved for this scan (else it is kept)
 * @param {string}   [o.notes]
 * @param {object}   o.env
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.log]           progress lines
 * @param {number}   [o.retryDelayMs]  first back-off after a free transient failure (Workflow: 20 s)
 * @param {Function} [o.sleep]
 * @returns {Promise<object>} summary (see bottom)
 */
export async function runLocalScan({
  business, engines, skippedEngines = [], runs, reportToken, scanId = globalThis.crypto.randomUUID(),
  resume = false, rebuild = false, notes = null, env, fetchImpl = globalThis.fetch, log = () => {}, retryDelayMs = 20_000, sleep = defaultSleep,
}) {
  if (!canStore(env)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required: a local scan writes everything to Supabase');
  if (!isUuid(scanId)) throw new Error('scanId must be a uuid');
  if (!engines.length) throw new Error('no engine to run (every requested engine is missing its key)');
  if (!reportToken) throw new Error('reportToken is required');
  const opts = { fetchImpl };
  const safe = (v) => redact(env, v?.message || v);
  const warnings = [];
  const warn = (m) => { warnings.push(m); log(`  warning: ${m}`); };
  const backoff = (attempt) => retryDelayMs * 2 ** (attempt - 1);

  try {
    // ---- setup (Workflow step "setup") -------------------------------------------------
    const previous = resume ? await getScan(env, scanId, opts) : null;
    // ensureBusiness returns the input business (facts, aliases, town...) with the stored row's
    // id and gaps filled; never the bare DB row, which has no facts.
    business = await ensureBusiness(env, { ...business }, opts);
    const questions = buildQuestions(business).map(({ id, intent, text }) => ({ id, intent, text }));
    const fullQuestions = Object.fromEntries(buildQuestions(business).map((q) => [q.id, q]));
    const callsTotal = questions.length * engines.length * runs;
    const noteText = [
      notes,
      skippedEngines.length ? `not run (no API key): ${skippedEngines.join(', ')}` : null,
      'run from PC (scanner/run.js)',
    ].filter(Boolean).join(' | ').slice(0, 500);
    await upsertScan(env, {
      id: scanId, business_id: business.id, business_name: business.name, report_token: reportToken,
      status: 'running', engines, runs, questions: questions.length,
      started_at: previous?.started_at || new Date().toISOString(), finished_at: null,
      calls_total: callsTotal, trigger: 'admin', notes: noteText,
    }, opts);
    log(`Scan ${scanId}${previous ? ' (resumed)' : ''}: ${business.name} (business ${business.id})`);

    // ---- engine calls (Workflow steps "call <engine> <q> r<run>") ------------------------
    let done = 0;
    let reused = 0;
    const jobs = scanJobs(questions, engines, runs);
    const progress = (c, how) => {
      done++;
      log(`  [${String(done).padStart(2)}/${jobs.length}] ${c.ok ? 'ok  ' : 'FAIL'} ${c.engine.padEnd(14)} ${c.questionId} r${c.run}  $${(c.costUsd || 0).toFixed(4)}${how ? `  (${how})` : ''}${c.ok ? '' : `  ${c.error}`}`);
    };
    const calls = await pool(jobs, ENGINE_BATCH, async (job) => {
      const q = fullQuestions[job.questionId];
      const id = await stableUuid(rawIdSeed(scanId, job.key));
      let replace = false;
      if (resume) {
        const prev = await getRawById(env, id, opts);
        if (prev && prev.ok) {
          reused++;
          const c = callFromStoredRaw({ ...prev, engine: job.engine, run: job.run }, q);
          progress(c, 'stored, not re-asked');
          return { ...c, reused: true };
        }
        // A failed row from last time is overwritten by this attempt.
        if (prev) replace = true;
      }
      for (let attempt = 1; ; attempt++) {
        let res;
        try {
          res = await ENGINES[job.engine].ask({ question: q, business, env, fetchImpl });
        } catch (e) {
          res = adapterThrew(job.engine, e);
        }
        const call = { ...res, engine: job.engine, questionId: q.id, intent: q.intent, questionText: q.text, run: job.run };
        call.error = call.error == null ? null : safe(call.error);
        // Free, transient failure: retry (nothing is written yet, nothing was billed).
        if (isTransientEngineError(call) && attempt <= ENGINE_RETRIES) {
          log(`  retry ${job.key} in ${Math.round(backoff(attempt) / 1000)}s: ${call.error}`);
          await sleep(backoff(attempt));
          continue;
        }
        const saved = await saveRaw(env, [rawRow({ scanId, businessId: business.id, call, id })], { fetchImpl, replace });
        if (!saved.ok) warn(`scan_raw write failed for ${job.key}: ${safe(saved.error)}`);
        const c = compactCall(call, q);
        progress(c);
        return c;
      }
    });

    // ---- extraction (Workflow steps "extract <engine:q:run>") ----------------------------
    // Proposals aren't stored, so a resumed scan extracts every answer again; those calls are
    // billed again, so they get their own scan_usage ids (the first run's rows stay as they are).
    const resumeSeed = resume ? `:resume-${Date.now().toString(36)}` : '';
    const answered = calls.filter((c) => c.ok);
    if (answered.length) log(`Extracting ${answered.length} answer(s)...`);
    const extractions = await pool(answered, EXTRACT_BATCH, async (c) => {
      const key = answerRef(c);
      for (let attempt = 1; ; attempt++) {
        let r;
        try {
          r = await proposeForAnswer({ answer: { id: key, text: c.text }, business, env, fetchImpl, maxRetries: 0 });
        } catch (e) {
          // Same as a Workflow step that threw a non-transient error: a failed extraction, no cost.
          return { key, ok: false, error: safe(e), businesses: [], ownerFacts: [], model: null, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        }
        const error = r.ok === false ? safe(r.error) : null;
        if (r.ok === false && !r.usage && isTransientExtractError(r.error) && attempt <= EXTRACT_RETRIES) {
          log(`  retry extract ${key} in ${Math.round(backoff(attempt) / 1000)}s: ${error}`);
          await sleep(backoff(attempt));
          continue;
        }
        const id = await stableUuid(extractIdSeed(scanId, key, attempt) + resumeSeed);
        const saved = await saveUsage(env, [usageRow({ id, scanId, kind: 'extract', provider: 'anthropic', model: r.model, usage: r.usage, costUsd: r.costUsd, ok: r.ok !== false, error, answerRef: key })], opts);
        if (!saved.ok) warn(`scan_usage write failed for ${key}: ${safe(saved.error)}`);
        if (r.ok === false) log(`  extract FAIL ${key}: ${error}`);
        return extractionResult(key, r, error);
      }
    });

    // ---- build + validate + save (Workflow step "build report") -------------------------
    const proposalsByAnswer = proposalsFromExtractions(extractions);
    // Engines requested but not run (no key) are listed as not answering: method.enginesFailed.
    const scan = { scanId, questions, engines: [...engines, ...skippedEngines], runs, calls, window: callWindow(calls) };
    const baseline = business.id ? await getBaseline(env, business.id, { excludeScanId: scanId, fetchImpl }).catch(() => null) : null;
    let extraExtractCostUsd = 0;
    const onExtract = async (x) => {
      extraExtractCostUsd += x.costUsd || 0;
      const id = await stableUuid(extractIdSeed(scanId, x.key) + resumeSeed);
      await saveUsage(env, [usageRow({ id, scanId, kind: 'extract', provider: 'anthropic', model: x.model, usage: x.usage, costUsd: x.costUsd, ok: x.ok, error: x.error && safe(x.error), answerRef: x.key })], opts);
    };
    const { report, rejected } = await buildReport({
      scan, business, baseline, env, fetchImpl, id: reportToken, proposalsByAnswer, onExtract,
    });
    const validation = publishGate(report, validateReport(report));
    let saved = false;
    let replaced = false;
    let storeError = null;
    let savedToken = report.id;
    if (validation.ok) {
      for (let attempt = 1; attempt <= SAVE_RETRIES + 1; attempt++) {
        try {
          const existing = await findReportByScan(env, scanId, opts);
          if (existing && rebuild) {
            // Replace in place: same row, same token, so the live link shows the rebuilt report.
            savedToken = existing.report_token || savedToken;
            await updateReport(env, existing.id, { report: { ...report, id: savedToken } }, opts);
            replaced = true;
          } else if (existing) savedToken = existing.report_token || savedToken;
          else await saveReport(env, { scanId, businessId: business.id, reportToken: report.id, report }, opts);
          saved = true;
          storeError = null;
          break;
        } catch (e) {
          storeError = safe(e);
          if (attempt <= SAVE_RETRIES) await sleep(backoff(attempt));
        }
      }
    }
    const build = {
      reportToken: savedToken,
      valid: validation.ok,
      errors: validation.errors.slice(0, 20).map((e) => safe(e)),
      totals: report.totals,
      headline: report.headline?.answerId || null,
      enginesFailed: report.method?.enginesFailed || [],
      rejected: (rejected || []).length,
      saved,
      storeError,
      extraExtractCostUsd: round6(extraExtractCostUsd),
    };

    // ---- finalize (Workflow step "finalize") -----------------------------------------------
    const totals = scanTotals({ calls, extractions, build });
    const finishedAt = new Date().toISOString();
    await upsertScan(env, { id: scanId, ...totals, finished_at: finishedAt }, opts);

    const byEngine = {};
    for (const e of engines) byEngine[e] = { calls: 0, ok: 0, costUsd: 0 };
    for (const c of calls) {
      const s = byEngine[c.engine];
      s.calls++;
      if (c.ok) s.ok++;
      s.costUsd = round6(s.costUsd + (Number(c.costUsd) || 0));
    }
    return {
      scanId,
      businessId: business.id,
      status: totals.status,
      reportToken: build.reportToken,
      reportUrl: saved ? `${REPORT_BASE_URL}${encodeURIComponent(build.reportToken)}` : null,
      reportSaved: saved,
      reportReplaced: replaced,
      reportValid: build.valid,
      validationErrors: build.errors,
      storeError,
      answers: report.totals?.answers ?? 0,
      namedYou: report.totals?.namedYou ?? 0,
      firstYou: report.totals?.firstYou ?? 0,
      enginesRun: engines,
      enginesSkipped: skippedEngines,
      enginesFailed: build.enginesFailed,
      callsTotal: totals.calls_total,
      callsOk: totals.calls_ok,
      callsReused: reused,
      extractions: extractions.length,
      byEngine,
      engineCostUsd: totals.engine_cost_usd,
      extractCostUsd: totals.extract_cost_usd,
      costUsd: totals.total_cost_usd,
      // What this run spent: engine calls made now (reused answers were paid earlier) + extraction.
      runCostUsd: round6(calls.filter((c) => !c.reused).reduce((a, c) => a + (Number(c.costUsd) || 0), 0) + totals.extract_cost_usd),
      errors: totals.errors,
      warnings,
      finishedAt,
    };
  } catch (e) {
    // Workflow step "mark failed".
    const message = safe(e);
    await upsertScan(env, {
      id: scanId, status: 'failed', finished_at: new Date().toISOString(),
      errors: [{ kind: 'workflow', error: message }],
    }, opts).catch(() => {});
    throw new Error(`${message} (scan ${scanId} marked failed; rerun with --resume ${scanId} to continue)`);
  }
}

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const engineName = (e) => ENGINE_NAMES[e] || e;

export function formatPlan({ business, plan, requested, runs, env, dryRun, resume, rebuild = false, scanId, reportToken, envFile }) {
  const configured = enginesConfigured(env);
  const lines = [];
  lines.push(`Business: ${business.name} (${business.trade}, ${business.town}${business.state ? `, ${business.state}` : ''})`);
  lines.push(dryRun ? 'Keys: dry run (fixture answers, in-memory Supabase; nothing leaves this PC)' : `Keys: ${envFile ? `.dev.vars (${envFile}) + environment` : 'environment only (no .dev.vars found)'}`);
  for (const e of requested) lines.push(`  ${configured[e] ? 'key found ' : 'NO KEY    '} ${engineName(e)}${configured[e] ? '' : '  -> not run (listed on the report as not answering)'}`);
  lines.push(`  ${plan.keys.extractor ? 'key found ' : 'NO KEY    '} extractor (ANTHROPIC_API_KEY)`);
  lines.push(`  ${plan.keys.supabase ? 'key found ' : 'NO KEY    '} Supabase (SUPABASE_URL + SUPABASE_SERVICE_KEY)`);
  lines.push(`Scan: ${plan.questions.length} questions x ${plan.engines.length} engine(s) x ${runs} run(s) = ${plan.questions.length * plan.engines.length * runs} calls${resume ? ` (resuming ${scanId})` : ''}`);
  for (const q of plan.questions) lines.push(`  ${q.id} [${q.intent}] ${q.text}`);
  const est = plan.estimate;
  const parts = [...Object.entries(est.perEngine).map(([e, c]) => `${engineName(e)} ${usd(c)}`), `extraction ${usd(est.extract)}`];
  lines.push(`Estimated cost: ${usd(est.total)} = ${parts.join(' + ')}`);
  if (resume) lines.push('  (resume: calls already stored ok are reused and not paid again; every answer is extracted again)');
  if (rebuild) lines.push('  (rebuild: the report already saved for this scan is replaced if the new one passes validation)');
  lines.push(`Report token: ${reportToken}`);
  return lines.join('\n');
}

export function formatSummary(s, { dryRun = false } = {}) {
  const L = [];
  L.push('');
  L.push(`Scan ${s.scanId}: ${s.status}${dryRun ? ' (dry run)' : ''}`);
  L.push(`  Answers: ${s.answers}   named you: ${s.namedYou}   named you first: ${s.firstYou}`);
  L.push(`  Calls: ${s.callsOk}/${s.callsTotal} ok${s.callsReused ? ` (${s.callsReused} reused from the earlier run)` : ''}, extractions: ${s.extractions}`);
  for (const [e, b] of Object.entries(s.byEngine)) L.push(`  ${engineName(e).padEnd(15)} ${b.ok}/${b.calls} ok   ${usd(b.costUsd)}`);
  if (s.enginesSkipped.length) L.push(`  Not run (no key): ${s.enginesSkipped.map(engineName).join(', ')}`);
  L.push(`  Extraction      ${usd(s.extractCostUsd)}`);
  L.push(`  Total           ${usd(s.costUsd)}`);
  L.push(`  This run        ${usd(s.runCostUsd)}`);
  if (s.reportSaved) L.push(`Report${s.reportReplaced ? ' (replaced)' : ''}: ${dryRun ? '(would be) ' : ''}${s.reportUrl}`);
  else L.push(`Report NOT saved${s.reportValid ? ` (store error: ${s.storeError})` : ' (failed validation)'}.`);
  if (s.validationErrors.length) {
    L.push('Validation errors:');
    for (const e of s.validationErrors) L.push(`  - ${e}`);
  }
  const callErrors = s.errors.filter((e) => e.kind !== 'report');
  if (callErrors.length) {
    L.push('Errors:');
    for (const e of callErrors.slice(0, 10)) L.push(`  - ${e.kind} ${e.engine ? `${e.engine} ${e.questionId} r${e.run}` : e.ref || ''}: ${e.error}`);
  }
  for (const w of s.warnings) L.push(`Warning: ${w}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Env + fetch for --dry-run: fixture engines/extractor and an in-memory Supabase. */
export async function dryRunSetup() {
  const { DRY_RUN_ENV } = await import('./dry-run.js');
  const { dryRunFetch } = await import('../src/admin/dry-run.js');
  const { memorySupabase } = await import('./memory-supabase.js');
  const db = memorySupabase();
  const engineFetch = dryRunFetch({ delayMs: 0 });
  const fetchImpl = (url, init) => (new URL(String(url)).hostname.endsWith('.supabase.co') ? db.handle(url, init) : engineFetch(url, init));
  return { env: { ...DRY_RUN_ENV, GEMINI_RESOLVE_REDIRECTS: '1' }, fetchImpl, db };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return void console.log(USAGE);
  if (!args.business) throw new Error(`--business is required\n\n${USAGE}`);
  if (args.resume && !isUuid(args.resume)) throw new Error('--resume needs a scan id (uuid)');

  let env;
  let envFile = null;
  let fetchImpl = globalThis.fetch;
  let db = null;
  if (args.dryRun) ({ env, fetchImpl, db } = await dryRunSetup());
  else ({ env, file: envFile } = loadEnv());

  const raw = JSON.parse(readFileSync(resolve(args.business), 'utf8'));
  // On --resume, the stored scans row supplies engines / runs / token / business id unless given.
  let previous = null;
  if (args.resume && !args.dryRun && canStore(env)) {
    previous = await getScan(env, args.resume, { fetchImpl });
    if (!previous) throw new Error(`--resume: no scans row with id ${args.resume}`);
  }
  const parsed = parseScanRequest({
    business: { ...raw, id: raw.id || previous?.business_id || undefined },
    engines: args.engines || previous?.engines || ACTIVE_ENGINES,
    runs: args.runs ?? previous?.runs ?? DEFAULT_RUNS,
    reportToken: args.token || previous?.report_token || undefined,
    notes: args.notes,
    trigger: 'admin',
  }, { knownEngines: ENGINE_IDS });
  if (!parsed.ok) throw new Error(parsed.error);
  const p = parsed.params;
  const reportToken = p.reportToken || newReportToken();
  const scanId = args.resume || globalThis.crypto.randomUUID();
  const plan = planScan({ business: p.business, engines: p.engines, runs: p.runs, env });

  console.error(formatPlan({ business: p.business, plan, requested: p.engines, runs: p.runs, env, dryRun: args.dryRun, resume: !!args.resume, rebuild: args.rebuild, scanId, reportToken, envFile }));
  const blockers = [
    !plan.engines.length && 'no requested engine has a key',
    !plan.keys.extractor && 'ANTHROPIC_API_KEY is missing: answers could not be extracted, so no report could publish',
    !plan.keys.supabase && 'SUPABASE_URL / SUPABASE_SERVICE_KEY missing: nothing could be stored',
  ].filter(Boolean);
  if (args.estimate) return void (blockers.length && console.error(`\nCannot run yet: ${blockers.join('; ')}`));
  if (blockers.length) {
    process.exitCode = 1;
    return void console.error(`\nCannot run: ${blockers.join('; ')}`);
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      process.exitCode = 1;
      return void console.error('\nNot an interactive terminal: pass --yes to run.');
    }
    if (!(await confirm(`\nProceed${args.dryRun ? ' (dry run)' : ` and spend about $${plan.estimate.total.toFixed(2)}`}? [y/N] `))) {
      return void console.error('Cancelled. Nothing was called or written.');
    }
  }

  const summary = await runLocalScan({
    business: p.business, engines: plan.engines, skippedEngines: plan.skipped, runs: p.runs, reportToken,
    scanId, resume: !!args.resume, rebuild: args.rebuild, notes: p.notes, env, fetchImpl, log: (m) => console.error(m),
    ...(args.dryRun ? { retryDelayMs: 0 } : {}),
  });
  console.log(formatSummary(summary, { dryRun: args.dryRun }));
  if (db) {
    console.log('\nDry run: rows that would be written to Supabase');
    for (const [t, rows] of Object.entries(db.tables)) console.log(`  ${t.padEnd(13)} ${rows.length} row(s)`);
    const s = db.tables.scans?.[0];
    if (s) console.log(`  scans row: status=${s.status} engines=${s.engines.join(',')} runs=${s.runs} calls=${s.calls_ok}/${s.calls_total} total=$${s.total_cost_usd} report_valid=${s.report_valid}`);
  }
  if (!summary.reportSaved) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e?.message || e);
    process.exitCode = 1;
  });
}
