import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runScan, pingAll, summarizeScan, pool } from '../scan.js';
import { saveReport, getBaseline, rawRow } from '../store.js';
import { estimateScanCost, resolveKeys, priceCall, ENGINE_IDS, ACTIVE_ENGINES, TYPICAL_CALL, DEFAULT_RUNS, activeEngines, enginesConfigured } from '../config.js';
import { fixtureFetch, jsonResponse, DRY_RUN_ENV } from '../dry-run.js';

const business = { id: '0b8f2a6e-3c1d-4e5f-9a7b-1c2d3e4f5a6b', name: 'Fictional Wash', trade: 'laundromat', town: 'North Babylon', nearbyTown: 'Deer Park', state: 'NY', zip: '11703' };
const env = { ...DRY_RUN_ENV };

// Per-business budget for a full scan (5 questions × every engine × 2 runs). Was $0.50 with
// four engines; Claude (Sonnet 5 + web search, ~$0.07 a call) roughly doubles it.
const SCAN_BUDGET_USD = 1.25;
const N = ENGINE_IDS.length;

test(`cost: a default 5 × ${N} × ${DEFAULT_RUNS} scan plus extraction estimates under budget`, () => {
  assert.equal(DEFAULT_RUNS, 1);
  const est = estimateScanCost({ engines: ENGINE_IDS, questions: 5 });
  assert.ok(est.total < SCAN_BUDGET_USD, `estimate $${est.total}`);
  assert.equal(est.total, Math.round((est.engines + est.extract) * 1e6) / 1e6);
  assert.ok(est.extract > 0);
  assert.deepEqual(Object.keys(est.perEngine).sort(), [...ENGINE_IDS].sort());
  // 20% heavier input on every call still keeps the scan under budget.
  const calls = 5 * DEFAULT_RUNS;
  const heavy = [...ENGINE_IDS, 'extract'].reduce((s, e) => s + priceCall(e, { ...TYPICAL_CALL[e], inputTokens: (TYPICAL_CALL[e].inputTokens || 0) * 1.2 }) * calls * (e === 'extract' ? N : 1), 0);
  assert.ok(heavy < SCAN_BUDGET_USD, `heavier estimate $${heavy}`);
  // runs stays configurable and scales linearly.
  assert.ok(Math.abs(estimateScanCost({ runs: 2 }).total - 2 * est.total) < 1e-5);
});

test('runScan: engines default to activeEngines(env) (every engine with a key)', async () => {
  const only = { OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' };
  const scan = await runScan({ business, env: only, fetchImpl: fixtureFetch() });
  assert.deepEqual(scan.engines, ['chatgpt', 'claude']);
  assert.equal(scan.calls.length, 5 * 2 * DEFAULT_RUNS);
  assert.deepEqual(activeEngines(env), ENGINE_IDS.filter((e) => enginesConfigured(env)[e]));
  assert.deepEqual(activeEngines({}), []);
  assert.deepEqual(activeEngines({ GEMINI_API_KEY: 'x', CLAUDE_API_KEY: 'y' }), ['gemini', 'claude'], 'ENGINE_IDS order, aliases accepted');
  assert.ok(ACTIVE_ENGINES.length > 0, 'static fallback kept');
});

test(`runScan: 5 questions × ${N} engines × ${DEFAULT_RUNS} run (default) on fixtures, cost under budget`, async () => {
  const f = fixtureFetch();
  const seen = [];
  const scan = await runScan({ business, env, engines: ENGINE_IDS, fetchImpl: f, onCall: (c) => seen.push(c.engine) });
  assert.match(scan.scanId, /^[0-9a-f-]{36}$/);
  assert.equal(scan.questions.length, 5);
  assert.equal(scan.runs, DEFAULT_RUNS);
  assert.equal(scan.calls.length, 5 * N * DEFAULT_RUNS);
  assert.equal(seen.length, 5 * N * DEFAULT_RUNS);
  assert.ok(scan.calls.every((c) => c.ok), scan.calls.filter((c) => !c.ok).map((c) => c.error).join('; '));
  for (const e of ENGINE_IDS) assert.equal(scan.calls.filter((c) => c.engine === e).length, 5 * DEFAULT_RUNS);
  for (const q of ['q1', 'q2', 'q3', 'q4', 'q5']) for (let run = 1; run <= DEFAULT_RUNS; run++) assert.equal(scan.calls.filter((c) => c.questionId === q && c.run === run).length, N);
  assert.ok(scan.calls.every((c) => c.citations.length > 0));
  assert.ok(scan.costUsd > 0 && scan.costUsd < SCAN_BUDGET_USD, `cost $${scan.costUsd}`);
  assert.ok(scan.window.start <= scan.window.end);
  const expected = scan.calls.reduce((s, c) => s + c.costUsd, 0);
  assert.ok(Math.abs(scan.costUsd - expected) < 1e-6);
  assert.equal(scan.stored, null);
});

test('runScan: engines/runs subset, question text reaches the engines', async () => {
  const f = fixtureFetch();
  const scan = await runScan({ business, env, engines: ['perplexity', 'gemini'], runs: 1, fetchImpl: f });
  assert.equal(scan.calls.length, 10);
  const inputs = f.calls.filter((c) => c.url.includes('perplexity')).map((c) => JSON.parse(c.init.body).input);
  assert.ok(inputs.includes('24 hour laundromat near Deer Park NY'));
});

test('runScan: one engine down → its calls fail, the rest succeed, nothing throws', async () => {
  const f = fixtureFetch(undefined, { openai: () => jsonResponse({ error: { message: 'Rate limit reached' } }, 429) });
  const scan = await runScan({ business, env, runs: 1, fetchImpl: f, timeoutMs: 2000 });
  const gpt = scan.calls.filter((c) => c.engine === 'chatgpt');
  assert.ok(gpt.every((c) => !c.ok && /HTTP 429/.test(c.error)));
  assert.ok(scan.calls.filter((c) => c.engine !== 'chatgpt').every((c) => c.ok));
  const s = summarizeScan(scan);
  assert.equal(s.byEngine.chatgpt.failed, 5);
  assert.equal(s.byEngine.gemini.ok, 5);
});

test('runScan: unknown engine id is rejected up front', async () => {
  await assert.rejects(runScan({ business, env, engines: ['copilot'], fetchImpl: fixtureFetch() }), /unknown engine/);
});

test('runScan store:true writes one scan_raw row per call (failed included) in one batch', async () => {
  const posts = [];
  const f = fixtureFetch(undefined, {
    perplexity: () => jsonResponse({ error: { message: 'invalid request body', type: 'invalid_request', code: 400 } }, 400),
    supabase: (u, init) => { posts.push({ u, init }); return new Response(null, { status: 201 }); },
  });
  const scan = await runScan({ business, env, engines: ENGINE_IDS, runs: 2, fetchImpl: f, store: true });
  assert.deepEqual(scan.stored, { ok: true, count: 5 * N * 2, error: null });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].u, 'https://dry-run.supabase.co/rest/v1/scan_raw');
  assert.equal(posts[0].init.headers.apikey, 'dry-run');
  const rows = JSON.parse(posts[0].init.body);
  assert.equal(rows.length, 5 * N * 2);
  const failed = rows.filter((r) => !r.ok);
  assert.equal(failed.length, 10);
  assert.ok(failed.every((r) => r.engine === 'perplexity' && /HTTP 400/.test(r.error) && r.response));
  const row = rows.find((r) => r.ok);
  for (const k of ['scan_id', 'business_id', 'engine', 'question_id', 'run', 'request', 'response', 'ok', 'error', 'cost_usd', 'asked_at']) assert.ok(k in row, k);
  assert.equal(row.scan_id, scan.scanId);
  assert.equal(row.business_id, business.id);
});

test('store: Supabase failure is reported, not thrown', async () => {
  const f = fixtureFetch(undefined, { supabase: () => new Response('{"message":"relation \\"scan_raw\\" does not exist"}', { status: 404 }) });
  const scan = await runScan({ business, env, engines: ['google_ai_mode'], runs: 1, fetchImpl: f, store: true });
  assert.equal(scan.stored.ok, false);
  assert.match(scan.stored.error, /404/);
  const noKey = await runScan({ business, env: { ...env, SUPABASE_SERVICE_KEY: '' }, engines: ['google_ai_mode'], runs: 1, fetchImpl: f, store: true });
  assert.match(noKey.stored.error, /SUPABASE_SERVICE_KEY/);
});

test('store: non-uuid business id is stored as null', () => {
  assert.equal(rawRow({ scanId: 'x', businessId: 'mega-wash', call: { engine: 'gemini', questionId: 'q1', run: 1, ok: true } }).business_id, null);
});

test('saveReport writes report jsonb with version 2', async () => {
  let sent;
  const f = async (u, init) => { sent = { u, init }; return jsonResponse([{ id: 'row1', ...JSON.parse(init.body) }], 201); };
  const report = { version: 2, generatedAt: '2026-09-24T17:01:00-04:00', totals: { answers: 40, namedYou: 8, firstYou: 4 } };
  const saved = await saveReport(env, { scanId: '11111111-2222-4333-8444-555555555555', businessId: business.id, reportToken: 'k7m2qx', report }, { fetchImpl: f });
  assert.equal(sent.u, 'https://dry-run.supabase.co/rest/v1/scan_results');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.version, 2);
  assert.equal(body.report_token, 'k7m2qx');
  assert.deepEqual(body.report, report);
  assert.equal(body.named_by_ai, true);
  assert.equal(saved.id, 'row1');
});

test('getBaseline returns the previous v2 scan totals, skipping the current scan', async () => {
  let url;
  const rows = [
    { scan_id: 'cur', scanned_at: '2026-10-24T00:00:00Z', generatedAt: '2026-10-24T00:00:00Z', totals: { answers: 40, namedYou: 20, firstYou: 9 } },
    { scan_id: 'old', scanned_at: '2026-09-24T21:01:00Z', generatedAt: '2026-09-24T17:01:00-04:00', totals: { answers: 40, namedYou: 8, firstYou: 4 } },
  ];
  const f = async (u) => { url = u; return jsonResponse(rows); };
  const b = await getBaseline(env, business.id, { excludeScanId: 'cur', fetchImpl: f });
  assert.deepEqual(b, { generatedAt: '2026-09-24T17:01:00-04:00', totals: { answers: 40, namedYou: 8, firstYou: 4 } });
  assert.match(url, /version=eq\.2/);
  assert.match(url, new RegExp(`business_id=eq\\.${business.id}`));
  assert.equal(await getBaseline(env, business.id, { fetchImpl: async () => jsonResponse([]) }), null);
  assert.equal(await getBaseline(env, 'not-a-uuid', { fetchImpl: f }), null);
});

test('pingAll pings every engine', async () => {
  const res = await pingAll(env, { fetchImpl: fixtureFetch() });
  assert.deepEqual(res.map((r) => r.engine), ENGINE_IDS);
  assert.ok(res.every((r) => r.ok));
});

test('pool keeps order and caps concurrency', async () => {
  let live = 0, max = 0;
  const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 5)); live--; return x * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
  assert.ok(max <= 3);
});

test('resolveKeys: alternates, trimming, defaults', () => {
  const k = resolveKeys({ GOOGLE_API_KEY: ' g \n', PPLX_API_KEY: 'p', SUPABASE_SERVICE_ROLE_KEY: 's', SUPABASE_URL: 'https://x.supabase.co/', OPENAI_MODEL: 'gpt-5.5' });
  assert.equal(k.geminiKey, 'g');
  assert.equal(k.perplexityKey, 'p');
  assert.equal(k.supabaseServiceKey, 's');
  assert.equal(k.supabaseUrl, 'https://x.supabase.co');
  assert.equal(k.openaiModel, 'gpt-5.5');
  assert.equal(k.geminiModel, 'gemini-3.8-flash');
  assert.equal(k.perplexityModel, 'fast');
  assert.equal(k.openaiKey, null);
  assert.equal(k.geminiResolveRedirects, true);
  assert.equal(resolveKeys({ GEMINI_RESOLVE_REDIRECTS: '0' }).geminiResolveRedirects, false);
});

test('library code is runtime-agnostic: no node: imports or process.env outside the CLI/dry-run', () => {
  const dir = fileURLToPath(new URL('..', import.meta.url));
  const files = ['config.js', 'questions.js', 'scan.js', 'store.js', ...readdirSync(`${dir}/engines`).map((f) => `engines/${f}`)];
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /from ['"]node:|require\(|process\.env/, f);
  }
});
