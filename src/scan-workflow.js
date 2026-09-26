// src/scan-workflow.js — one business scan as a Cloudflare Workflow (runs 7–18 minutes, so it
// can't live inside one HTTP request).
//
// Steps (names are deterministic: they are the Workflow's cache keys):
//   setup                        find/insert the business, mark the `scans` row running
//   call <engine> <q> r<run>     one engine answer; writes its scan_raw row (with cost) right away,
//                                returns only compact data (text, citations, ok, error, cost)
//   record failed <...>          only when a call step gave up: stores the failure row
//   extract <engine:q:run>       one Claude extractor call; writes its scan_usage row (tokens, cost)
//   pick headline                runs = 1 only: the answer the report would lead with (no fetches)
//   confirm ask <ref>:confirm    asks that search once more on the same engine; scan_raw row, run = 2
//   confirm extract <ref>:confirm  extracts the re-ask; scan_usage row (answer_ref <ref>:confirm)
//   build report                 buildReport (+ headline confirmation) → validateReport → save scan_results (only if valid)
//   finalize                     scan totals into `scans`
//   mark failed                  only if something above threw
//
// Params (event.payload): { scanId, business, engines, runs, questionLimit, reportToken,
//                           trigger, notes, dryRun }
// Output: the finalize summary (also readable through instance.status().output).

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { buildQuestions } from '../scanner/questions.js';
import { notifyScanDone } from './lib/notify.js';
import { ENGINES } from '../scanner/engines/index.js';
import { round6, defaultScanEngines } from '../scanner/config.js';
import { buildReport } from '../scanner/extract/build.js';
import { proposeForAnswer } from '../scanner/extract/propose.js';
import { validateReport } from '../shared/report-v2.js';
import {
  canStore, ensureBusiness, upsertScan, rawRow, saveRaw, usageRow, saveUsage, stableUuid,
  saveReport, findReportByScan, getBaseline, getBaselineByToken, getRawById, sumUsageCost,
} from '../scanner/store.js';
import {
  scanJobs, chunk, compactCall, isTransientEngineError, isTransientExtractError, scanTotals, callWindow,
  ENGINE_BATCH, EXTRACT_BATCH, ENGINE_RETRIES, EXTRACT_RETRIES, answerRef, rawIdSeed, extractIdSeed,
  adapterThrew, callFromStoredRaw, extractionResult, proposalsFromExtractions, publishGate,
  shouldConfirmHeadline, headlineTarget, confirmHeadline, confirmationForBuild, confirmRef, CONFIRM_RUN,
} from './admin/scan-core.js';
import { dryRunEnabled, dryRunEnv, dryRunFetch } from './admin/dry-run.js';
import { redact } from './admin/redact.js';

// Batch sizes and retry counts live in scan-core.js (shared with scanner/run.js, the local runner).
// Attempts are counted by ctx.attempt (1-indexed). A step retries only by throwing, and it throws
// only for failures that cost nothing (429 / 5xx / network): a billed call is never repeated.
const STEP_DB = { retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' };
const STEP_ENGINE = { retries: { limit: ENGINE_RETRIES, delay: '20 seconds', backoff: 'exponential' }, timeout: '6 minutes' };
const STEP_EXTRACT = { retries: { limit: EXTRACT_RETRIES, delay: '20 seconds', backoff: 'exponential' }, timeout: '5 minutes' };
const STEP_BUILD = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' };

export class ScanWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const p = { ...(event.payload || {}) };
    // No engines named → every engine with a key (startScan normally fills this in).
    if (!Array.isArray(p.engines) || !p.engines.length) p.engines = defaultScanEngines(this.env);
    const scanId = p.scanId;
    // Dry run needs BOTH the param (set only for localhost requests) and SCANNER_DRY_RUN=1.
    const dry = !!p.dryRun && dryRunEnabled(this.env);
    const env = dry ? dryRunEnv(this.env) : this.env;
    const fetchImpl = dry ? dryRunFetch() : (...a) => fetch(...a);
    const store = !dry && canStore(env);
    const safe = (v) => redact(this.env, v?.message || v);

    try {
      // ---- setup -------------------------------------------------------------------------
      const setup = await step.do('setup', STEP_DB, async () => {
        let business = { ...p.business };
        if (store) business = await ensureBusiness(env, business, { fetchImpl });
        const questions = buildQuestions(business).slice(0, p.questionLimit || undefined);
        const callsTotal = questions.length * p.engines.length * p.runs;
        const startedAt = new Date().toISOString();
        if (store) {
          await upsertScan(env, {
            id: scanId, business_id: business.id, business_name: business.name, report_token: p.reportToken,
            status: 'running', engines: p.engines, runs: p.runs, questions: questions.length,
            started_at: startedAt, calls_total: callsTotal, trigger: p.trigger || 'admin', notes: p.notes || null,
          }, { fetchImpl });
        }
        return { business, questions: questions.map(({ id, intent, text }) => ({ id, intent, text })), startedAt, callsTotal };
      });
      const { business, questions } = setup;
      const qById = Object.fromEntries(questions.map((q) => [q.id, q]));
      // buildQuestions is deterministic; the adapters get the full question objects.
      const fullQuestions = Object.fromEntries(buildQuestions(business).map((q) => [q.id, q]));

      // ---- engine calls ------------------------------------------------------------------
      const calls = [];
      for (const batch of chunk(scanJobs(questions, p.engines, p.runs), ENGINE_BATCH)) {
        const done = await Promise.all(batch.map((job) => {
          const name = `call ${job.engine} ${job.questionId} r${job.run}`;
          return step.do(name, STEP_ENGINE, async (ctx) => {
            const q = fullQuestions[job.questionId] || qById[job.questionId];
            // A retry after this step's scan_raw write already landed: reuse the stored answer
            // instead of paying the engine again.
            if (store && (ctx?.attempt || 1) > 1) {
              const prev = await getRawById(env, await stableUuid(rawIdSeed(scanId, job.key)), { fetchImpl });
              if (prev && prev.ok) return callFromStoredRaw({ ...prev, engine: job.engine, run: job.run }, q);
            }
            let res;
            try {
              res = await ENGINES[job.engine].ask({ question: q, business, env, fetchImpl });
            } catch (e) {
              res = adapterThrew(job.engine, e);
            }
            const call = { ...res, engine: job.engine, questionId: q.id, intent: q.intent, questionText: q.text, run: job.run };
            call.error = call.error == null ? null : safe(call.error);
            const attempt = ctx?.attempt || 1;
            // Free, transient failure: retry the step (nothing is written yet).
            if (isTransientEngineError(call) && attempt <= ENGINE_RETRIES) throw new Error(`transient: ${call.error}`);
            if (store) {
              const id = await stableUuid(rawIdSeed(scanId, job.key));
              const saved = await saveRaw(env, [rawRow({ scanId, businessId: business.id, call, id })], { fetchImpl });
              if (!saved.ok) console.error('[scan-workflow] scan_raw write failed', scanId, job.key, safe(saved.error));
            }
            return compactCall(call, q);
          }).catch(async (e) => {
            // The step gave up (retries exhausted). Record the failure once; no answer, no cost.
            const q = qById[job.questionId];
            const failed = compactCall({ engine: job.engine, questionId: job.questionId, run: job.run, ok: false, text: null, citations: [], costUsd: 0, error: safe(e), askedAt: null }, q);
            return step.do(`record failed ${job.key}`, STEP_DB, async () => {
              if (store) {
                const id = await stableUuid(rawIdSeed(scanId, job.key));
                await saveRaw(env, [rawRow({ scanId, businessId: business.id, call: { ...failed, askedAt: new Date().toISOString(), raw: null, request: null }, id })], { fetchImpl });
              }
              return failed;
            });
          });
        }));
        calls.push(...done);
      }

      // ---- extraction (one Claude call per answer) ---------------------------------------
      const answered = calls.filter((c) => c.ok);
      const extractions = [];
      for (const batch of chunk(answered, EXTRACT_BATCH)) {
        const done = await Promise.all(batch.map((c) => {
          const key = answerRef(c);
          return step.do(`extract ${key}`, STEP_EXTRACT, async (ctx) => {
            const r = await proposeForAnswer({ answer: { id: key, text: c.text }, business, env, fetchImpl, maxRetries: 0 });
            const error = r.ok === false ? safe(r.error) : null;
            const attempt = ctx?.attempt || 1;
            if (r.ok === false && !r.usage && isTransientExtractError(r.error) && attempt <= EXTRACT_RETRIES) {
              throw new Error(`transient: ${error}`);
            }
            if (store) {
              // The proposals aren't stored, so a retry after a landed write must call again; seed the
              // id with the attempt so that second (billed) call is recorded too, not deduplicated away.
              const id = await stableUuid(extractIdSeed(scanId, key, attempt));
              const saved = await saveUsage(env, [usageRow({ id, scanId, kind: 'extract', provider: 'anthropic', model: r.model, usage: r.usage, costUsd: r.costUsd, ok: r.ok !== false, error, answerRef: key })], { fetchImpl });
              if (!saved.ok) console.error('[scan-workflow] scan_usage write failed', scanId, key, safe(saved.error));
            }
            return extractionResult(key, r, error);
          }).catch((e) => ({ key, ok: false, error: safe(e), businesses: [], ownerFacts: [], model: null, costUsd: 0, inputTokens: 0, outputTokens: 0 }));
        }));
        extractions.push(...done);
      }

      // ---- headline confirmation (runs = 1) ------------------------------------------------
      // One run per engine can't show variation, so the search the report leads with is asked
      // once more on the same engine. Skipped when the report couldn't publish anyway.
      let confirmation = null;
      if (shouldConfirmHeadline(p.runs)) {
        const target = await step.do('pick headline', STEP_BUILD, async () => {
          const scan = { scanId, questions, engines: p.engines, runs: p.runs, calls, window: callWindow(calls) };
          const pre = await buildReport({ scan, business, env, fetchImpl, id: p.reportToken, proposalsByAnswer: proposalsFromExtractions(extractions), maxFetch: 0 });
          return publishGate(pre.report, validateReport(pre.report)).ok ? headlineTarget(pre.report) : null;
        });
        if (target) {
          const cref = confirmRef(target.ref);
          const q = fullQuestions[target.questionId] || qById[target.questionId];
          const rawId = await stableUuid(rawIdSeed(scanId, cref));
          confirmation = await confirmHeadline({
            target, business,
            ask: () => step.do(`confirm ask ${cref}`, STEP_ENGINE, async (ctx) => {
              if (store && (ctx?.attempt || 1) > 1) {
                const prev = await getRawById(env, rawId, { fetchImpl });
                if (prev && prev.ok) return callFromStoredRaw({ ...prev, engine: target.engine, run: CONFIRM_RUN }, q);
              }
              let res;
              try {
                res = await ENGINES[target.engine].ask({ question: q, business, env, fetchImpl });
              } catch (e) {
                res = adapterThrew(target.engine, e);
              }
              const call = { ...res, engine: target.engine, questionId: q.id, intent: q.intent, questionText: q.text, run: CONFIRM_RUN };
              call.error = call.error == null ? null : safe(call.error);
              if (isTransientEngineError(call) && (ctx?.attempt || 1) <= ENGINE_RETRIES) throw new Error(`transient: ${call.error}`);
              if (store) {
                const saved = await saveRaw(env, [rawRow({ scanId, businessId: business.id, call, id: rawId })], { fetchImpl });
                if (!saved.ok) console.error('[scan-workflow] scan_raw write failed', scanId, cref, safe(saved.error));
              }
              return compactCall(call, q);
            }).catch((e) => ({ ok: false, text: null, citations: [], costUsd: 0, error: safe(e) })),
            extract: (c) => step.do(`confirm extract ${cref}`, STEP_EXTRACT, async (ctx) => {
              const r = await proposeForAnswer({ answer: { id: cref, text: c.text }, business, env, fetchImpl, maxRetries: 0 });
              const error = r.ok === false ? safe(r.error) : null;
              const attempt = ctx?.attempt || 1;
              if (r.ok === false && !r.usage && isTransientExtractError(r.error) && attempt <= EXTRACT_RETRIES) throw new Error(`transient: ${error}`);
              if (store) {
                const id = await stableUuid(extractIdSeed(scanId, cref, attempt));
                const saved = await saveUsage(env, [usageRow({ id, scanId, kind: 'extract', provider: 'anthropic', model: r.model, usage: r.usage, costUsd: r.costUsd, ok: r.ok !== false, error, answerRef: cref })], { fetchImpl });
                if (!saved.ok) console.error('[scan-workflow] scan_usage write failed', scanId, cref, safe(saved.error));
              }
              return extractionResult(cref, r, error);
            }).catch((e) => ({ key: cref, ok: false, error: safe(e), businesses: [], ownerFacts: [], ownerDescriptors: [], costUsd: 0 })),
          });
        }
      }

      // ---- build + validate + save --------------------------------------------------------
      const build = await step.do('build report', STEP_BUILD, async (ctx) => {
        const proposalsByAnswer = proposalsFromExtractions(extractions);
        const scan = { scanId, questions, engines: p.engines, runs: p.runs, calls, window: callWindow(calls) };
        let baseline = null;
        if (store && business.id) {
          baseline = await getBaseline(env, business.id, { excludeScanId: scanId, fetchImpl }).catch(() => null);
        }
        // Request tokens have no business id: a rescan of the same link (the 30-day re-check) compares
        // against the last report under that token that asked the same questions.
        if (store && !baseline && p.reportToken) {
          baseline = await getBaselineByToken(env, p.reportToken, { excludeScanId: scanId, questionCount: questions.length, fetchImpl }).catch(() => null);
        }
        // Any answer without a recorded proposal would be extracted here; record that spend too.
        let extraExtractCostUsd = 0;
        const onExtract = async (x) => {
          extraExtractCostUsd += x.costUsd || 0;
          if (store) {
            const id = await stableUuid(extractIdSeed(scanId, x.key));
            await saveUsage(env, [usageRow({ id, scanId, kind: 'extract', provider: 'anthropic', model: x.model, usage: x.usage, costUsd: x.costUsd, ok: x.ok, error: x.error && safe(x.error), answerRef: x.key })], { fetchImpl });
          }
        };
        const { report, rejected } = await buildReport({
          scan, business, baseline, env, fetchImpl, id: p.reportToken, proposalsByAnswer, onExtract,
          headlineConfirmation: confirmationForBuild(confirmation),
        });
        // The publish gate: re-check regardless of what the builder says.
        const validation = publishGate(report, validateReport(report));
        let saved = false;
        let storeError = null;
        if (store && validation.ok) {
          try {
            const existing = await findReportByScan(env, scanId, { fetchImpl });
            if (!existing) await saveReport(env, { scanId, businessId: business.id, reportToken: report.id, report }, { fetchImpl });
            saved = true;
          } catch (e) {
            storeError = safe(e);
            // Retry the step; on the last attempt keep going so the scan totals still land.
            if ((ctx?.attempt || 1) <= STEP_BUILD.retries.limit) throw new Error(`report save failed: ${storeError}`);
          }
        }
        return {
          reportToken: report.id,
          valid: validation.ok,
          errors: validation.errors.slice(0, 20).map((e) => safe(e)),
          totals: report.totals,
          headline: report.headline?.answerId || null,
          enginesFailed: report.method?.enginesFailed || [],
          rejected: (rejected || []).length,
          saved,
          storeError,
          extraExtractCostUsd: round6(extraExtractCostUsd),
          headlineConfirmed: report.method?.headlineConfirmed ?? null,
        };
      });

      // ---- finalize ----------------------------------------------------------------------
      const fin = await step.do('finalize', STEP_DB, async () => {
        // extract_cost_usd = every scan_usage row of this scan (retried steps included).
        const usageCostUsd = store ? await sumUsageCost(env, scanId, { fetchImpl }) : null;
        const totals = scanTotals({ calls, extractions, build, confirmation, usageCostUsd });
        const finishedAt = new Date().toISOString();
        if (store) await upsertScan(env, { id: scanId, ...totals, finished_at: finishedAt }, { fetchImpl });
        return {
          scanId,
          dryRun: dry,
          stored: store,
          status: totals.status,
          reportToken: build.reportToken,
          reportSaved: build.saved,
          reportValid: build.valid,
          validationErrors: build.errors,
          totals: build.totals,
          callsTotal: totals.calls_total,
          callsOk: totals.calls_ok,
          extractions: extractions.length,
          headlineConfirmed: build.headlineConfirmed,
          engineCostUsd: totals.engine_cost_usd,
          extractCostUsd: totals.extract_cost_usd,
          costUsd: totals.total_cost_usd,
          errors: totals.errors.slice(0, 10),
          finishedAt,
        };
      });

      // ---- email whoever is waiting (src/lib/notify.js; nothing until RESEND_API_KEY is set) ----
      if (store && !dry && build.saved && build.valid) {
        await step.do('email', STEP_DB, async () => notifyScanDone(env, { trigger: p.trigger, token: build.reportToken, scanId }, { fetchImpl }))
          .catch((e) => console.error('[email] scan-done step failed', safe(e)));
      }
      return fin;
    } catch (e) {
      const message = safe(e);
      await step.do('mark failed', STEP_DB, async () => {
        if (store) {
          await upsertScan(env, {
            id: scanId, status: 'failed', finished_at: new Date().toISOString(),
            errors: [{ kind: 'workflow', error: message }],
          }, { fetchImpl });
        }
        return { ok: true };
      }).catch(() => {});
      throw new Error(message);
    }
  }
}
