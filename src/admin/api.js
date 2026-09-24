// src/admin/api.js — /api/admin/* handlers. Auth is checked by the caller (routes.js).
//
//   GET  /api/admin/ping          live key check per engine + extractor (paid pings logged to scan_usage)
//   POST /api/admin/scan          start a background scan (Workflow) → 202 { scanId, instanceId, statusUrl }
//        ?sync=1                  tiny inline test only: one engine, questions ≤ 2
//   GET  /api/admin/scan/:id      status + progress (calls done/total, cost so far, errors)

import { ENGINE_IDS, round6, defaultScanEngines } from '../../scanner/config.js';
import { ENGINES } from '../../scanner/engines/index.js';
import { runScan, summarizeScan } from '../../scanner/scan.js';
import { buildQuestions } from '../../scanner/questions.js';
import { buildReport } from '../../scanner/extract/build.js';
import { proposeForAnswer } from '../../scanner/extract/propose.js';
import { validateReport } from '../../shared/report-v2.js';
import {
  canStore, saveReport, getBaseline, upsertScan, usageRow, saveUsage, getScan, scanProgress, supabaseStore,
} from '../../scanner/store.js';
import { parseScanRequest, newReportToken, scanTotals, compactCall } from './scan-core.js';
import { dryRunEnabled, isLocalRequest } from './dry-run.js';
import { redact } from './redact.js';

export const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

/** Every engine the scanner knows: the config list plus anything in the registry. */
export const ALL_ENGINES = [...new Set([...ENGINE_IDS, ...Object.keys(ENGINES)])];

/**
 * No engines named → every engine with a key in `env` (activeEngines), or the static
 * ACTIVE_ENGINES when there's no env / no key at all. Any known engine can still be named.
 */
export function withActiveDefault(body, env) {
  if (!body || typeof body !== 'object' || (Array.isArray(body.engines) && body.engines.length)) return body;
  return { ...body, engines: defaultScanEngines(env) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------
export async function handleAdminPing(env) {
  const usage = [];
  const engineChecks = ALL_ENGINES.map(async (id) => {
    const t0 = Date.now();
    try {
      const engine = ENGINES[id];
      if (typeof engine?.ping !== 'function') return [id, { ok: false, error: 'no ping() in adapter', latencyMs: 0 }];
      const r = await engine.ping(env);
      const cost = Number(r?.detail?.costUsd) || 0; // perplexity's ping is a (tiny) paid call
      if (cost > 0) usage.push(usageRow({ kind: 'ping', provider: id, model: r?.detail?.model || null, costUsd: cost, ok: r?.ok === true }));
      return [id, {
        ok: r?.ok === true,
        status: r?.status ?? null,
        error: r?.ok ? null : redact(env, r?.error || 'failed'),
        latencyMs: r?.ms ?? Date.now() - t0,
      }];
    } catch (e) {
      return [id, { ok: false, error: redact(env, e?.message || e), latencyMs: Date.now() - t0 }];
    }
  });
  const extractorCheck = (async () => {
    const t0 = Date.now();
    try {
      const text = 'Try Sample Plumbing Co. on Main Street. It is open 8am to 6pm.';
      const r = await proposeForAnswer({
        answer: { id: 'ping', text },
        business: { name: 'Sample Plumbing Co.', town: 'Massapequa' },
        env,
      });
      const ok = r?.ok !== false;
      if (r?.usage) usage.push(usageRow({ kind: 'ping', provider: 'anthropic', model: r.model, usage: r.usage, costUsd: r.costUsd, ok, error: ok ? null : redact(env, r.error) }));
      return ['extractor', {
        ok,
        error: ok ? null : redact(env, r?.error ?? 'failed'),
        model: r?.model ?? null,
        businesses: (r?.businesses || []).length,
        costUsd: round6(r?.costUsd),
        latencyMs: Date.now() - t0,
      }];
    } catch (e) {
      return ['extractor', { ok: false, error: redact(env, e?.message || e), latencyMs: Date.now() - t0 }];
    }
  })();
  const out = Object.fromEntries(await Promise.all([...engineChecks, extractorCheck]));
  if (usage.length && canStore(env)) {
    const saved = await saveUsage(env, usage);
    if (!saved.ok) console.error('[admin/ping] scan_usage write failed', redact(env, saved.error));
  }
  return json(out);
}

// ---------------------------------------------------------------------------
// start a scan
// ---------------------------------------------------------------------------

/**
 * Validate + start a Workflow instance. Shared by the API and the dashboard form.
 * → { ok: true, scanId, instanceId, statusUrl, dryRun } | { ok: false, status, error }
 */
export async function startScan(env, url, body) {
  const parsed = parseScanRequest(withActiveDefault(body, env), { knownEngines: ALL_ENGINES });
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
  if (!env.SCAN_WORKFLOW) return { ok: false, status: 500, error: 'SCAN_WORKFLOW binding missing (wrangler.jsonc)' };
  const dryRun = dryRunEnabled(env) && isLocalRequest(url);
  const store = !dryRun && canStore(env);
  if (!dryRun && !store) return { ok: false, status: 503, error: 'SUPABASE_SERVICE_KEY not set: a background scan must store its results' };

  const scanId = crypto.randomUUID();
  const params = { ...parsed.params, scanId, reportToken: parsed.params.reportToken || newReportToken(), dryRun };
  const questions = buildQuestions(params.business).slice(0, params.questionLimit || undefined).length;
  if (store) {
    try {
      await upsertScan(env, {
        id: scanId, business_id: params.business.id, business_name: params.business.name, report_token: params.reportToken,
        status: 'queued', engines: params.engines, runs: params.runs, questions,
        calls_total: questions * params.engines.length * params.runs, trigger: params.trigger, notes: params.notes,
      });
    } catch (e) {
      return { ok: false, status: 503, error: `could not create the scans row (apply supabase/admin_v3.sql?): ${redact(env, e?.message || e)}` };
    }
  }
  try {
    const instance = await env.SCAN_WORKFLOW.create({ id: scanId, params });
    return { ok: true, scanId, instanceId: instance.id, statusUrl: `/api/admin/scan/${scanId}`, dryRun };
  } catch (e) {
    const error = redact(env, e?.message || e);
    if (store) await upsertScan(env, { id: scanId, status: 'failed', errors: [{ kind: 'workflow', error }] }).catch(() => {});
    return { ok: false, status: 500, error: `could not start the workflow: ${error}` };
  }
}

export async function handleAdminScanStart(request, url, env) {
  const body = await readJson(request);
  if (!body) return json({ error: 'JSON body required' }, 400);
  if (url.searchParams.get('sync') === '1') {
    // The inline path has no fixture fetch: in a local dry run it would make real, paid calls.
    if (dryRunEnabled(env) && isLocalRequest(url)) return json({ error: '?sync=1 is not available in a dry run; drop ?sync=1 (the background scan honours SCANNER_DRY_RUN).' }, 422);
    return handleSyncScan(body, env);
  }
  const r = await startScan(env, url, body);
  if (!r.ok) return json({ error: r.error }, r.status);
  return json({ scanId: r.scanId, instanceId: r.instanceId, statusUrl: r.statusUrl, dryRun: r.dryRun }, 202);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
export async function handleAdminScanStatus(id, env) {
  if (!UUID_RE.test(id)) return json({ error: 'Not found' }, 404);
  const out = { scanId: id, instanceId: id, instance: null, scan: null, progress: null };
  const tasks = [];
  if (env.SCAN_WORKFLOW) {
    tasks.push((async () => {
      try {
        const inst = await env.SCAN_WORKFLOW.get(id);
        const st = await inst.status();
        out.instance = {
          status: st.status,
          error: st.error ? redact(env, st.error.message || st.error) : null,
          output: st.output ?? null,
        };
      } catch (e) {
        out.instance = { status: 'unknown', error: redact(env, e?.message || e), output: null };
      }
    })());
  }
  if (canStore(env)) {
    tasks.push((async () => {
      try {
        const [row, progress] = await Promise.all([getScan(env, id), scanProgress(env, id)]);
        if (row) {
          out.scan = {
            status: row.status, businessName: row.business_name, engines: row.engines, runs: row.runs,
            questions: row.questions, startedAt: row.started_at, finishedAt: row.finished_at,
            reportToken: row.report_token, reportValid: row.report_valid,
            totalCostUsd: Number(row.total_cost_usd) || 0, errors: row.errors || [],
          };
        }
        out.progress = progress ? { ...progress, callsTotal: row?.calls_total ?? null } : null;
      } catch (e) {
        out.dbError = redact(env, e?.message || e);
      }
    })());
  }
  await Promise.all(tasks);
  // Without the DB (local dry run) the finished instance's output still carries the totals.
  const o = out.instance?.output;
  if (!out.progress && o) {
    out.progress = {
      callsDone: o.callsTotal, callsTotal: o.callsTotal, callsOk: o.callsOk, extractionsDone: o.extractions,
      engineCostUsd: o.engineCostUsd, extractCostUsd: o.extractCostUsd, costUsd: o.costUsd,
      errors: (o.errors || []).map((e) => `${e.kind}: ${e.error}`),
    };
  }
  const noInstance = !out.instance || /not.?found/i.test(String(out.instance.error || ''));
  if (noInstance && !out.scan) return json({ error: 'Not found' }, 404);
  // A valid report whose save failed (kind 'store' error) was never stored: no link to a 404.
  const storeFailed = (out.scan?.errors || []).some((e) => e?.kind === 'store');
  const saved = o ? !!o.reportSaved : (out.scan?.status === 'done' && out.scan?.reportValid && !storeFailed);
  const token = o?.reportToken || out.scan?.reportToken;
  out.reportUrl = saved && token ? `/report/${encodeURIComponent(token)}` : null;
  return json(out);
}

// ---------------------------------------------------------------------------
// ?sync=1 — tiny inline scan for a light test (one engine, ≤ 2 questions)
// ---------------------------------------------------------------------------
async function handleSyncScan(body, env) {
  const parsed = parseScanRequest(withActiveDefault(body, env), { knownEngines: ALL_ENGINES });
  if (!parsed.ok) return json({ error: parsed.error }, 422);
  const p = parsed.params;
  if (p.engines.length !== 1 || !p.questionLimit || p.questionLimit > 2 || p.runs !== 1) {
    return json({ error: '?sync=1 is for a tiny test only: engines=[one], questions<=2, runs=1. Drop ?sync=1 for a full background scan.' }, 422);
  }
  const store = canStore(env);
  const scanId = crypto.randomUUID();
  const reportToken = p.reportToken || newReportToken();
  const questions = buildQuestions(p.business).slice(0, p.questionLimit);
  const startedAt = new Date().toISOString();
  if (store) {
    await upsertScan(env, {
      id: scanId, business_id: p.business.id, business_name: p.business.name, report_token: reportToken, status: 'running',
      engines: p.engines, runs: 1, questions: questions.length, started_at: startedAt,
      calls_total: questions.length, trigger: p.trigger, notes: p.notes || 'sync test',
    }).catch((e) => console.error('[admin/scan sync] scans row failed', redact(env, e?.message || e)));
  }

  let scan;
  try {
    scan = await runScan({ business: p.business, env, engines: p.engines, runs: 1, questions, scanId, store: store ? supabaseStore(env) : undefined });
  } catch (e) {
    return json({ error: redact(env, e?.message || e) }, 500);
  }
  for (const c of scan.calls) c.error = c.error == null ? null : redact(env, c.error);

  const usage = [];
  let built;
  try {
    const baseline = store && p.business.id ? await getBaseline(env, p.business.id, { excludeScanId: scanId }).catch(() => null) : null;
    built = await buildReport({
      scan, business: p.business, baseline, env, id: reportToken,
      onExtract: (x) => { usage.push(usageRow({ scanId, kind: 'extract', provider: 'anthropic', model: x.model, usage: x.usage, costUsd: x.costUsd, ok: x.ok, error: x.error && redact(env, x.error), answerRef: x.key })); },
    });
  } catch (e) {
    return json({ error: redact(env, e?.message || e), scan: summarizeScan(scan) }, 500);
  }
  if (store) {
    const saved = await saveUsage(env, usage);
    if (!saved.ok) console.error('[admin/scan sync] scan_usage write failed', redact(env, saved.error));
  }

  const { report, rejected, extraction } = built;
  const validation = validateReport(report);
  if (!report.answers?.length) {
    validation.ok = false;
    validation.errors = [...validation.errors, 'no successful answers (every engine failed)'];
  }
  const stored = { report: false, raw: scan.stored ?? null, reason: store ? null : 'SUPABASE_SERVICE_KEY not set' };
  if (store && validation.ok) {
    try {
      await saveReport(env, { scanId, businessId: p.business.id, reportToken: report.id, report });
      stored.report = true;
    } catch (e) {
      stored.reason = redact(env, e?.message || e);
    }
  } else if (store) {
    stored.reason = 'validation failed; report not stored';
  }
  const calls = scan.calls.map((c) => compactCall(c));
  const totals = scanTotals({
    calls,
    extractions: usage.map((u) => ({ key: u.answer_ref, ok: u.ok, error: u.error, costUsd: u.cost_usd })),
    build: { valid: validation.ok, errors: validation.errors.slice(0, 20), totals: report.totals, storeError: stored.report ? null : stored.reason },
  });
  if (store) await upsertScan(env, { id: scanId, ...totals, finished_at: new Date().toISOString() }).catch(() => {});

  return json({
    scanId,
    reportId: report.id,
    totals: report.totals,
    costUsd: round6(scan.costUsd + (extraction?.costUsd || 0)),
    engineCostUsd: scan.costUsd,
    extractCostUsd: round6(extraction?.costUsd || 0),
    validation: { ok: validation.ok, errors: validation.errors.slice(0, 20).map((e) => redact(env, e)) },
    enginesFailed: report.method?.enginesFailed || [],
    rejectedProposals: (rejected || []).length,
    scan: summarizeScan(scan),
    stored,
  });
}
