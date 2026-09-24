import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLocalScan, planScan, parseArgs, dryRunSetup, formatSummary } from '../run.js';
import { parseDotVars } from '../env.js';
import { stableUuid } from '../store.js';
import { validateReport } from '../../shared/report-v2.js';
import { parseScanRequest } from '../../src/admin/scan-core.js';
import { ACTIVE_ENGINES } from '../config.js';

const sample = JSON.parse(readFileSync(new URL('../examples/sample-business.json', import.meta.url), 'utf8'));
const business = parseScanRequest({ business: sample }).params.business;
const noSleep = async () => {};

/** A dry-run setup whose fetch can be intercepted per request; records every host hit. */
async function setup({ intercept } = {}) {
  const d = await dryRunSetup();
  const hits = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const host = new URL(u).hostname;
    let body = null;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { /* not json */ }
    const kind = host === 'api.anthropic.com' ? (body?.output_config ? 'extract' : 'claude') : host;
    hits.push(kind);
    const r = intercept && (await intercept({ url: u, init, host, kind, body }));
    return r || d.fetchImpl(url, init);
  };
  return { ...d, fetchImpl, hits };
}

const count = (hits, kind) => hits.filter((h) => h === kind).length;
const jobKeys = (engines) => ['q1', 'q2', 'q3', 'q4', 'q5'].flatMap((q) => engines.map((e) => `${e}:${q}:1`));
const run = (s, o = {}) => runLocalScan({
  business, engines: ACTIVE_ENGINES, runs: 1, reportToken: 'tok123abcd', env: s.env, fetchImpl: s.fetchImpl, sleep: noSleep, ...o,
});
const apiError = (status, type, message) => new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });

test('dry run end to end: scans, scan_raw, scan_usage, scan_results rows with the Workflow ids', async () => {
  const s = await setup();
  const scanId = globalThis.crypto.randomUUID();
  const sum = await run(s, { scanId, notes: 'test note' });
  const t = s.db.tables;

  assert.equal(t.businesses.length, 1);
  assert.equal(t.scans.length, 1);
  const scan = t.scans[0];
  assert.equal(scan.id, scanId);
  assert.equal(scan.status, 'done');
  assert.equal(scan.trigger, 'admin');
  assert.deepEqual(scan.engines, ACTIVE_ENGINES);
  // 15 searches + the headline re-ask.
  assert.equal(scan.calls_total, 16);
  assert.equal(scan.calls_ok, 16);
  assert.equal(scan.report_token, 'tok123abcd');
  assert.equal(scan.report_valid, true);
  assert.ok(scan.started_at && scan.finished_at);
  assert.match(scan.notes, /test note/);
  assert.equal(scan.business_id, t.businesses[0].id);

  // Same stableUuid ids as src/scan-workflow.js.
  const keys = jobKeys(ACTIVE_ENGINES);
  assert.equal(t.scan_raw.length, 16);
  const rawIds = new Set(t.scan_raw.map((r) => r.id));
  for (const k of keys) assert.ok(rawIds.has(await stableUuid(`${scanId}:${k}`)), `scan_raw id for ${k}`);
  assert.ok(t.scan_raw.every((r) => r.ok && r.scan_id === scanId));

  // The headline re-ask: stored as run 2 of the headline's search, with its own ids.
  const report = t.scan_results[0].report;
  const hc = report.method.headlineConfirm;
  assert.equal(report.method.headlineConfirmed, true);
  assert.equal(hc.result, 'same');
  const ref = `${hc.engine}:${hc.questionId}:1`;
  const confirmRow = t.scan_raw.find((r) => r.run === 2);
  assert.equal(confirmRow.id, await stableUuid(`${scanId}:${ref}:confirm`));
  assert.equal(confirmRow.engine, hc.engine);
  assert.equal(confirmRow.question_id, hc.questionId);
  assert.equal(sum.headlineConfirmed, true);

  assert.equal(t.scan_usage.length, 16);
  const usageIds = new Set(t.scan_usage.map((r) => r.id));
  for (const k of keys) assert.ok(usageIds.has(await stableUuid(`${scanId}:extract:${k}`)), `scan_usage id for ${k}`);
  assert.ok(usageIds.has(await stableUuid(`${scanId}:extract:${ref}:confirm`)), 'scan_usage row for the confirm extraction');
  assert.ok(t.scan_usage.some((r) => r.answer_ref === `${ref}:confirm`));
  assert.ok(t.scan_usage.every((r) => r.kind === 'extract' && r.provider === 'anthropic' && r.cost_usd > 0));

  assert.equal(t.scan_results.length, 1);
  const rep = t.scan_results[0];
  assert.equal(rep.report_token, 'tok123abcd');
  assert.equal(rep.scan_id, scanId);
  assert.equal(rep.version, 2);
  assert.ok(validateReport(rep.report).ok);
  assert.ok(!t.report_links, 'no report_links row is written');

  // Totals on the scans row match the stored rows.
  const rawCost = t.scan_raw.reduce((a, r) => a + r.cost_usd, 0);
  const useCost = t.scan_usage.reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(scan.engine_cost_usd - rawCost) < 1e-5);
  assert.ok(Math.abs(scan.extract_cost_usd - useCost) < 1e-5);
  assert.ok(Math.abs(scan.total_cost_usd - (rawCost + useCost)) < 1e-5);

  assert.equal(sum.reportSaved, true);
  assert.equal(sum.reportUrl, 'https://aifoundscore.com/report/tok123abcd');
  assert.equal(sum.answers, 15);
  assert.equal(sum.byEngine.claude.calls, 5);
  assert.match(formatSummary(sum), /Total\s+\$/);

  // Nothing but fixtures and the in-memory store was contacted.
  const allowed = new Set(['api.openai.com', 'claude', 'extract', 'generativelanguage.googleapis.com', 'vertexaisearch.cloud.google.com', 'dry-run.supabase.co']);
  const other = s.hits.filter((h) => !allowed.has(h));
  // Directory page checks go to the dry-run fetch, which answers 599 without any network.
  assert.ok(other.every((h) => !h.endsWith('.supabase.co')));
});

test('a transient engine failure is retried; the billed answer is stored once', async () => {
  // Two 429s: the adapter's own retry (2 s) uses the second, then the runner retries the call.
  let failed = 0;
  const retried = [];
  const s = await setup({ intercept: ({ kind, init }) => (kind === 'api.openai.com' && /best laundromat/.test(init.body) && failed++ < 2 ? apiError(429, 'rate_limit_error', 'slow down') : null) });
  const sum = await run(s, { log: (m) => { if (m.startsWith('  retry')) retried.push(m); } });
  assert.equal(retried.length, 1);
  const hc = s.db.tables.scan_results[0].report.method.headlineConfirm;
  assert.equal(count(s.hits, 'api.openai.com'), 7 + (hc.engine === 'chatgpt' ? 1 : 0));
  assert.equal(sum.callsOk, 16);
  assert.ok(s.db.tables.scan_raw.every((r) => r.ok));
  assert.equal(s.db.tables.scan_raw.filter((r) => r.run === 1).length, 15);
  assert.equal(s.db.tables.scan_raw.length, 16);
});

test('resume: calls already stored ok are not asked again; failed ones are re-asked and replaced', async () => {
  // First run: Gemini refuses (non-transient 400), then the process "dies" before extraction.
  const first = await setup({ intercept: ({ kind }) => (kind === 'generativelanguage.googleapis.com' ? apiError(400, 'INVALID_ARGUMENT', 'bad request') : null) });
  const scanId = globalThis.crypto.randomUUID();
  const log = (m) => { if (m.startsWith('Extracting')) throw new Error('simulated crash'); };
  await assert.rejects(run(first, { scanId, log }), /simulated crash/);
  const t = first.db.tables;
  assert.equal(t.scans[0].status, 'failed');
  assert.equal(t.scan_raw.length, 15);
  assert.equal(t.scan_raw.filter((r) => r.ok).length, 10);
  assert.equal(t.scan_usage, undefined);

  // Resume against the same store: only the 5 Gemini calls go out again.
  const second = await setup();
  second.db.tables.businesses = t.businesses;
  second.db.tables.scans = t.scans;
  second.db.tables.scan_raw = t.scan_raw;
  const sum = await run(second, { scanId, resume: true });
  const hc = second.db.tables.scan_results[0].report.method.headlineConfirm;
  const reask = (host, engine) => count(second.hits, host) - (hc.engine === engine ? 1 : 0);
  assert.equal(reask('api.openai.com', 'chatgpt'), 0);
  assert.equal(reask('claude', 'claude'), 0);
  assert.equal(reask('generativelanguage.googleapis.com', 'gemini'), 5);
  assert.equal(sum.callsReused, 10);
  const rows = second.db.tables.scan_raw;
  assert.equal(rows.length, 16, 'no duplicate scan_raw rows (15 + the headline re-ask)');
  assert.ok(rows.every((r) => r.ok), 'the failed Gemini rows were replaced');
  assert.equal(second.db.tables.scans.length, 1);
  assert.equal(second.db.tables.scans[0].status, 'done');
  assert.equal(second.db.tables.scans[0].calls_ok, 16);
  assert.equal(second.db.tables.scan_results.length, 1);
  assert.equal(second.db.tables.scan_usage.length, 16);
  // Engine cost counts the reused answers too (they were paid for on the first run).
  const rawCost = rows.reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(sum.engineCostUsd - rawCost) < 1e-5);
});

test('an invalid report is not saved (a failed extraction blocks publishing)', async () => {
  let n = 0;
  const s = await setup({ intercept: ({ kind }) => (kind === 'extract' && n++ === 3 ? apiError(400, 'invalid_request_error', 'nope') : null) });
  const sum = await run(s);
  assert.equal(sum.reportValid, false);
  assert.equal(sum.reportSaved, false);
  assert.equal(sum.reportUrl, null);
  assert.ok(sum.validationErrors.some((e) => /extraction failed/.test(e)));
  assert.equal((s.db.tables.scan_results || []).length, 0);
  const scan = s.db.tables.scans[0];
  assert.equal(scan.report_valid, false);
  assert.equal(scan.status, 'done');
  assert.ok(scan.errors.some((e) => e.kind === 'extract'));
  assert.equal(s.db.tables.scan_usage.length, 15, 'the failed extraction is still recorded');
});

test('missing-key engines are dropped before the scan and listed on the report as not answering', async () => {
  const s = await setup();
  const env = { ...s.env };
  delete env.GEMINI_API_KEY;
  const plan = planScan({ business, engines: ACTIVE_ENGINES, runs: 1, env });
  assert.deepEqual(plan.engines, ['chatgpt', 'claude']);
  assert.deepEqual(plan.skipped, ['gemini']);
  assert.deepEqual(Object.keys(plan.estimate.perEngine), ['chatgpt', 'claude']);

  const sum = await run({ ...s, env }, { engines: plan.engines, skippedEngines: plan.skipped });
  assert.equal(count(s.hits, 'generativelanguage.googleapis.com'), 0);
  const scan = s.db.tables.scans[0];
  assert.deepEqual(scan.engines, ['chatgpt', 'claude']);
  assert.equal(scan.calls_total, 11, '10 searches + the headline re-ask');
  assert.equal(scan.calls_ok, 11);
  assert.ok(!scan.errors.some((e) => e.engine === 'gemini'), 'not counted as failed calls');
  assert.match(scan.notes, /not run \(no API key\): gemini/);
  assert.equal(sum.reportSaved, true);
  assert.deepEqual(sum.enginesSkipped, ['gemini']);
  const report = s.db.tables.scan_results[0].report;
  assert.deepEqual(report.method.enginesFailed, ['gemini']);
  assert.ok(!report.answers.some((a) => a.engine === 'gemini'));
  assert.ok(validateReport(report).ok);
});

test('args and .dev.vars parsing', () => {
  const a = parseArgs(['--business', 'b.json', '--engines', 'chatgpt, claude', '--runs', '2', '--token', 't', '--notes', 'hi there', '--yes', '--dry-run', '--estimate']);
  assert.deepEqual(a.engines, ['chatgpt', 'claude']);
  assert.equal(a.runs, '2');
  assert.ok(a.yes && a.dryRun && a.estimate);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--business']), /needs a value/);
  assert.deepEqual(parseDotVars('# c\nOPENAI_API_KEY=sk-x \nexport A="q v"\nB=\'s\'\nnot a line'), { OPENAI_API_KEY: 'sk-x', A: 'q v', B: 's' });
});
