// Automatic scans for free-report requests: tokens, dedupe, caps (with races), the queue,
// AUTO_SCAN off, the report page's in-progress states, and /admin "Run now".
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startRequestScan, pendingReportStatus, runQueuedScan, statusFromRows, capDecision, requestKey,
  newRequestToken, requestScanId, autoScanOn, autoScanLimits, estimateRequestScanUsd, REQUEST_TOKEN_RE,
  DRY_RUN_REQUESTS,
} from '../auto-scan.js';
import { handleReportRequest } from '../report-request.js';
import { REQUEST_ACTION } from '../turnstile.js';

// ---------------------------------------------------------------------------
// A fake Supabase `scans` table (PostgREST subset used by auto-scan.js / store.js)
// ---------------------------------------------------------------------------
function fakeDb(seed = [], reportSeed = []) {
  const rows = seed.map((r) => ({ ...r }));
  const reports = reportSeed.map((r) => ({ ...r })); // scan_results
  let clock = Date.parse('2026-09-24T12:00:00Z');
  const tick = () => new Date(clock++).toISOString();
  const match = (r, params) => {
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      const [op, ...rest] = v.split('.');
      const val = rest.join('.');
      const cur = r[k] == null ? '' : String(r[k]);
      if (op === 'eq' && cur !== val) return false;
      if (op === 'neq' && cur === val) return false;
      if (op === 'gte' && !(cur >= val)) return false;
      if (op === 'in' && !val.replace(/[()]/g, '').split(',').includes(cur)) return false;
    }
    return true;
  };
  const f = async (input, init = {}) => {
    await new Promise((r) => setTimeout(r, 1)); // let concurrent requests interleave
    const u = new URL(String(input));
    const method = init.method || 'GET';
    const params = [...u.searchParams.entries()];
    if (u.pathname.endsWith('/rest/v1/scan_results')) {
      if (method === 'POST') { const body = JSON.parse(init.body); reports.push(body); return Response.json([body], { status: 201 }); }
      return Response.json(reports.filter((r) => match(r, params)).map((r) => ({ ...r })));
    }
    assert.ok(u.pathname.endsWith('/rest/v1/scans'), `unexpected table ${u.pathname}`);
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const cur = rows.find((r) => r.id === body.id);
      if (cur) Object.assign(cur, body);
      else rows.push({ status: 'queued', created_at: tick(), total_cost_usd: 0, est_cost_usd: 0, ...body });
      return new Response(null, { status: 201 });
    }
    if (method === 'DELETE') {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i], params)) rows.splice(i, 1);
      return new Response(null, { status: 204 });
    }
    const out = rows.filter((r) => match(r, params))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    if ((u.searchParams.get('order') || '').startsWith('created_at.desc')) out.reverse();
    return Response.json(out.map((r) => ({ ...r })));
  };
  return { rows, reports, fetch: f, tick };
}

function fakeWorkflow() {
  const created = [];
  return { created, create: async ({ id, params }) => { created.push({ id, params }); return { id }; }, get: async () => ({ status: async () => ({ status: 'running' }) }) };
}

const baseEnv = (extra = {}) => ({
  SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc-test',
  OPENAI_API_KEY: 'k1', GEMINI_API_KEY: 'k2', AUTO_SCAN: 'on', SCAN_WORKFLOW: fakeWorkflow(), ...extra,
});
let n = 0;
const req = (over = {}) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  businessName: 'Otter Plumbing', trade: 'plumbing', town: 'Massapequa', state: 'NY', zip: '11758', website: null, phone: null, ...over,
});
const NOW = Date.parse('2026-09-24T12:30:00Z');
const quiet = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('tokens: random, unguessable, 22 chars of [A-Za-z0-9_-]', async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = newRequestToken();
    assert.match(t, /^[A-Za-z0-9_-]{22}$/);
    assert.match(t, REQUEST_TOKEN_RE);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
  assert.equal(await requestScanId('abc'), await requestScanId('abc'));
});

test('config: AUTO_SCAN is off unless "on"; caps default to 25 scans / $20', () => {
  assert.equal(autoScanOn({}), false);
  assert.equal(autoScanOn({ AUTO_SCAN: '1' }), false);
  assert.equal(autoScanOn({ AUTO_SCAN: ' On ' }), true);
  assert.deepEqual(autoScanLimits({}), { max: 25, usd: 20 });
  assert.deepEqual(autoScanLimits({ AUTO_SCAN_DAILY_MAX: '3', AUTO_SCAN_DAILY_USD: '2.5' }), { max: 3, usd: 2.5 });
  assert.deepEqual(autoScanLimits({ AUTO_SCAN_DAILY_MAX: 'x', AUTO_SCAN_DAILY_USD: '-1' }), { max: 25, usd: 20 });
  assert.ok(estimateRequestScanUsd(['chatgpt', 'gemini']) > 0);
});

test('dedupe key: case, punctuation and "&" don\'t matter; ZIP does', () => {
  assert.equal(requestKey({ name: 'Otter Plumbing & Heating, Inc.', zip: '11758' }), requestKey({ name: 'otter plumbing and heating inc', zip: '11758' }));
  assert.notEqual(requestKey({ name: 'Otter Plumbing', zip: '11758' }), requestKey({ name: 'Otter Plumbing', zip: '11762' }));
});

test('capDecision: count uses rows before ours; spend counts every other row', () => {
  const rows = [
    { id: 'a', created_at: '1', status: 'done', total_cost_usd: 1, est_cost_usd: 2 },
    { id: 'b', created_at: '2', status: 'running', total_cost_usd: 0.1, est_cost_usd: 2 },
    { id: 'c', created_at: '3', status: 'running', total_cost_usd: 0, est_cost_usd: 2 },
  ];
  assert.equal(capDecision(rows, 'c', { max: 3, usd: 100, estimateUsd: 2 }), null);
  assert.equal(capDecision(rows, 'c', { max: 2, usd: 100, estimateUsd: 2 }), 'count');
  assert.equal(capDecision(rows, 'b', { max: 2, usd: 100, estimateUsd: 2 }), null);
  // spend: a=1 (done: real cost) + c=2 (running: estimate) + our 2 = 5
  assert.equal(capDecision(rows, 'b', { max: 9, usd: 5, estimateUsd: 2 }), null);
  assert.equal(capDecision(rows, 'b', { max: 9, usd: 4.99, estimateUsd: 2 }), 'spend');
  assert.equal(capDecision(rows, 'b', { max: 0, usd: 100, estimateUsd: 0 }), 'count');
});

// ---------------------------------------------------------------------------
// startRequestScan
// ---------------------------------------------------------------------------
test('AUTO_SCAN on: a new request gets a link, a running scans row and one workflow (activeEngines, 1 run)', async () => {
  const db = fakeDb();
  const env = baseEnv();
  const r = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
  assert.equal(r.status, 'running');
  assert.match(r.token, REQUEST_TOKEN_RE);
  assert.equal(env.SCAN_WORKFLOW.created.length, 1);
  const { id, params } = env.SCAN_WORKFLOW.created[0];
  assert.equal(id, r.scanId);
  assert.equal(params.trigger, 'request');
  assert.equal(params.runs, 1);
  assert.deepEqual(params.engines, ['chatgpt', 'gemini']);
  assert.equal(params.reportToken, r.token);
  assert.equal(params.dryRun, false);
  assert.deepEqual({ name: params.business.name, trade: params.business.trade, town: params.business.town, zip: params.business.zip },
    { name: 'Otter Plumbing', trade: 'plumbing', town: 'Massapequa', zip: '11758' });
  const row = db.rows[0];
  assert.equal(row.status, 'running');
  assert.equal(row.trigger, 'request');
  assert.equal(row.report_token, r.token);
  assert.ok(row.est_cost_usd > 0);
  assert.equal(row.business.name, 'Otter Plumbing');
});

test('AUTO_SCAN off: no workflow is started; the request is queued and still gets its link', async () => {
  for (const flag of [undefined, 'off', '']) {
    const db = fakeDb();
    const env = baseEnv({ AUTO_SCAN: flag });
    const r = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
    assert.equal(r.status, 'queued');
    assert.equal(r.reason, 'auto-scan-off');
    assert.match(r.token, REQUEST_TOKEN_RE);
    assert.equal(env.SCAN_WORKFLOW.created.length, 0);
    assert.equal(db.rows[0].status, 'queued');
    assert.equal(db.rows[0].est_cost_usd, 0);
  }
});

test('dedupe: same business within 7 days never hands out the earlier token; a finished report is copied to a new one', async () => {
  const prior = { id: '11111111-1111-4111-8111-111111111111', trigger: 'request', status: 'done', report_token: 'OLDTOKENOLDTOKEN1234', request_key: requestKey({ name: 'Otter Plumbing', zip: '11758' }), created_at: '2026-09-20T00:00:00.000Z' };
  const stored = { report_token: 'OLDTOKENOLDTOKEN1234', version: 2, business_id: 'b1', scanned_at: '2026-09-20T01:00:00Z', report: { version: 2, id: 'OLDTOKENOLDTOKEN1234', business: { name: 'Otter Plumbing' } } };
  const db = fakeDb([prior], [stored]);
  const env = baseEnv();
  const r = await startRequestScan(env, req({ businessName: 'OTTER plumbing.' }), { now: NOW, fetchImpl: db.fetch });
  assert.equal(r.status, 'reused');
  assert.notEqual(r.token, 'OLDTOKENOLDTOKEN1234');
  assert.match(r.token, REQUEST_TOKEN_RE);
  assert.equal(env.SCAN_WORKFLOW.created.length, 0);
  assert.equal(db.rows.length, 1);
  const copy = db.reports.find((x) => x.report_token === r.token);
  assert.ok(copy, 'report copied to the new token');
  assert.equal(copy.report.id, r.token);
  assert.equal(copy.scan_id, null);
  // 8 days later it scans again.
  const later = await startRequestScan(env, req(), { now: Date.parse('2026-09-28T12:00:00Z'), fetchImpl: db.fetch });
  assert.equal(later.status, 'running');
  // A failed earlier scan is not reused.
  const db2 = fakeDb([{ ...prior, status: 'failed' }]);
  const r2 = await startRequestScan(baseEnv(), req(), { now: NOW, fetchImpl: db2.fetch });
  assert.equal(r2.status, 'running');
  assert.notEqual(r2.token, 'OLDTOKENOLDTOKEN1234');
});

test('dedupe while the earlier report is not ready: a queued duplicate with its own token, not a dedupe anchor', async () => {
  const prior = { id: '11111111-1111-4111-8111-111111111111', trigger: 'request', status: 'running', report_token: 'OLDTOKENOLDTOKEN1234', request_key: requestKey({ name: 'Otter Plumbing', zip: '11758' }), created_at: '2026-09-24T00:00:00.000Z' };
  const db = fakeDb([prior]);
  const env = baseEnv();
  const r = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
  assert.deepEqual([r.status, r.reason], ['queued', 'duplicate']);
  assert.notEqual(r.token, 'OLDTOKENOLDTOKEN1234');
  assert.equal(env.SCAN_WORKFLOW.created.length, 0);
  const row = db.rows.find((x) => x.report_token === r.token);
  assert.equal(row.status, 'queued');
  assert.equal(row.request_key, null);
  assert.equal(row.est_cost_usd, 0);
  assert.equal(row.business.name, 'Otter Plumbing');
});

test('dedupe race: two identical submits at once start one scan; neither gets the other token', async () => {
  const db = fakeDb();
  const env = baseEnv();
  const [a, b] = await quiet(() => Promise.all([
    startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch }),
    startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch }),
  ]));
  assert.notEqual(a.token, b.token);
  assert.deepEqual([a.status, b.status].sort(), ['queued', 'running']);
  assert.equal([a, b].find((x) => x.status === 'queued').reason, 'duplicate');
  assert.equal(env.SCAN_WORKFLOW.created.length, 1);
  assert.equal(db.rows.filter((x) => x.request_key).length, 1);
});

test('daily count cap: over AUTO_SCAN_DAILY_MAX the request is queued (link kept); yesterday doesn\'t count', async () => {
  const db = fakeDb([
    { id: '22222222-2222-4222-8222-222222222222', trigger: 'request', status: 'done', report_token: 'x1', request_key: 'a|1', total_cost_usd: 0.5, created_at: '2026-09-24T01:00:00.000Z' },
    { id: '33333333-3333-4333-8333-333333333333', trigger: 'request', status: 'done', report_token: 'x2', request_key: 'b|1', total_cost_usd: 0.5, created_at: '2026-09-23T23:00:00.000Z' },
  ]);
  const env = baseEnv({ AUTO_SCAN_DAILY_MAX: '2' });
  const first = await startRequestScan(env, req({ businessName: 'Alpha Heating' }), { now: NOW, fetchImpl: db.fetch });
  assert.equal(first.status, 'running');
  const second = await quiet(() => startRequestScan(env, req({ businessName: 'Beta Heating' }), { now: NOW, fetchImpl: db.fetch }));
  assert.deepEqual([second.status, second.reason], ['queued', 'daily-count-cap']);
  assert.match(second.token, REQUEST_TOKEN_RE);
  assert.equal(env.SCAN_WORKFLOW.created.length, 1);
  const row = db.rows.find((r) => r.report_token === second.token);
  assert.equal(row.status, 'queued');
  assert.equal(row.est_cost_usd, 0);
  assert.match(row.notes, /queued: daily-count-cap/);
});

test('daily spend cap: queued when today\'s spend + this scan\'s estimate would pass AUTO_SCAN_DAILY_USD', async () => {
  const est = estimateRequestScanUsd(['chatgpt', 'gemini']);
  const db = fakeDb([
    { id: '44444444-4444-4444-8444-444444444444', trigger: 'request', status: 'done', report_token: 'x3', request_key: 'c|1', total_cost_usd: 1, created_at: '2026-09-24T02:00:00.000Z' },
  ]);
  const env = baseEnv({ AUTO_SCAN_DAILY_USD: String(1 + est - 0.0001) });
  const r = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
  assert.deepEqual([r.status, r.reason], ['queued', 'daily-spend-cap']);
  assert.equal(env.SCAN_WORKFLOW.created.length, 0);
  const env2 = baseEnv({ AUTO_SCAN_DAILY_USD: String(1 + est + 0.01) });
  assert.equal((await startRequestScan(env2, req({ businessName: 'Gamma Drain' }), { now: NOW, fetchImpl: db.fetch })).status, 'running');
});

test('cap race: five requests at once with room for two → exactly two run, three queue', async () => {
  const db = fakeDb();
  const env = baseEnv({ AUTO_SCAN_DAILY_MAX: '2' });
  const out = await quiet(() => Promise.all(['A', 'B', 'C', 'D', 'E'].map((x) =>
    startRequestScan(env, req({ businessName: `${x} Racing Plumbers` }), { now: NOW, fetchImpl: db.fetch }))));
  assert.equal(out.filter((r) => r.status === 'running').length, 2);
  assert.equal(out.filter((r) => r.status === 'queued').length, 3);
  assert.equal(env.SCAN_WORKFLOW.created.length, 2);
  assert.equal(db.rows.filter((r) => r.status === 'running').length, 2);
  assert.equal(new Set(out.map((r) => r.token)).size, 5);
});

test('per-IP brake and a failed workflow start both queue the request', async () => {
  const db = fakeDb();
  const request = new Request('https://x.example/api/request', { headers: { 'CF-Connecting-IP': '203.0.113.7' } });
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const env = baseEnv();
  const r = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch, request, limiter });
  assert.deepEqual([r.status, r.reason], ['queued', 'ip']);
  assert.deepEqual(keys, ['autoscan:203.0.113.7']);
  assert.equal(env.SCAN_WORKFLOW.created.length, 0);

  const env2 = baseEnv({ SCAN_WORKFLOW: { create: async () => { throw new Error('boom'); } } });
  const r2 = await quiet(() => startRequestScan(env2, req({ businessName: 'Delta Pipes' }), { now: NOW, fetchImpl: db.fetch }));
  assert.deepEqual([r2.status, r2.reason], ['queued', 'workflow']);
  assert.equal(db.rows.find((x) => x.report_token === r2.token).status, 'queued');
});

test('no service key or a bad business → no link (the request itself is still saved by the caller)', async () => {
  assert.equal(await startRequestScan(baseEnv({ SUPABASE_SERVICE_KEY: '' }), req(), { now: NOW }), null);
  assert.equal(await startRequestScan(baseEnv(), req({ trade: '' }), { now: NOW, fetchImpl: fakeDb().fetch }), null);
});

// ---------------------------------------------------------------------------
// the report page while pending
// ---------------------------------------------------------------------------
test('statusFromRows: running / queued / failed-or-blocked waits for a person', () => {
  assert.equal(statusFromRows([]), null);
  assert.equal(statusFromRows([{ status: 'running' }]), 'running');
  assert.equal(statusFromRows([{ status: 'queued' }]), 'queued');
  assert.equal(statusFromRows([{ status: 'failed' }, { status: 'running' }]), 'running');
  assert.equal(statusFromRows([{ status: 'failed' }]), 'queued');
  assert.equal(statusFromRows([{ status: 'done', report_valid: false }]), 'queued');
  assert.equal(statusFromRows([{ status: 'done', report_valid: true }]), 'running');
  assert.equal(statusFromRows([{ status: 'done', report_valid: true, errors: [{ kind: 'store' }] }]), 'queued');
});

test('pendingReportStatus: reads the token\'s scans rows; unknown tokens are null (404)', async () => {
  const db = fakeDb();
  const env = baseEnv();
  const run = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
  const q = await startRequestScan(baseEnv({ AUTO_SCAN: 'off' }), req({ businessName: 'Queued Co' }), { now: NOW, fetchImpl: db.fetch });
  assert.equal(await pendingReportStatus(env, run.token, { fetchImpl: db.fetch }), 'running');
  assert.equal(await pendingReportStatus(env, q.token, { fetchImpl: db.fetch }), 'queued');
  assert.equal(await pendingReportStatus(env, 'NoSuchTokenAtAll1234', { fetchImpl: db.fetch }), null);
  assert.equal(await pendingReportStatus(env, 'bad token!', { fetchImpl: db.fetch }), null);
  // A failed read is a plain 404, never an error page.
  assert.equal(await quiet(() => pendingReportStatus(env, run.token, { fetchImpl: async () => new Response('x', { status: 500 }) })), null);
});

test('dry run: no database; the token\'s state lives in memory and follows the workflow', async () => {
  const wf = fakeWorkflow();
  const env = { AUTO_SCAN: 'on', SCAN_WORKFLOW: wf };
  const dryEnv = { ...env, OPENAI_API_KEY: 'dry-run', GEMINI_API_KEY: 'dry-run' };
  const r = await startRequestScan(env, req(), { now: NOW, dryRun: true, dryEnv });
  assert.equal(r.status, 'running');
  assert.equal(wf.created[0].params.dryRun, true);
  assert.equal(DRY_RUN_REQUESTS.get(r.token).status, 'running');
  assert.equal(await pendingReportStatus(env, r.token, { dryRun: true }), 'running');
  const off = await startRequestScan({ SCAN_WORKFLOW: wf }, req(), { now: NOW, dryRun: true, dryEnv });
  assert.equal(off.status, 'queued');
  assert.equal(wf.created.length, 1);
  assert.equal(await pendingReportStatus({}, off.token, { dryRun: true }), 'queued');
});

// ---------------------------------------------------------------------------
// POST /api/request → report_url
// ---------------------------------------------------------------------------
const HOST = 'aifoundscore.com';
const TS_ENV = { TURNSTILE_SITE_KEY: '0x4AAAAAAFCuveyMfQ21Ntcr', TURNSTILE_SECRET_KEY: '0x4AAAAAAFrealsecretvalue000000000' };
const FORM = { business_name: 'Test Otter Plumbing', trade: 'plumbing', town: 'Massapequa', zip: '11758', state: 'NY', 'cf-turnstile-response': 'tok' };
const post = (body, json = true) => new Request(`https://${HOST}/api/request`, {
  method: 'POST',
  headers: json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
});
const siteverifyOk = async () => Response.json({ success: true, hostname: HOST, action: REQUEST_ACTION });
const reqDeps = (startRequestScanImpl) => ({
  recordReportRequest: async () => ({}),
  fetchImpl: siteverifyOk,
  startRequestScan: startRequestScanImpl,
});

test('/api/request: a verified request returns {id, report_url}; the scan starter gets the saved request', async () => {
  const seen = [];
  const res = await handleReportRequest(post(FORM), new URL(`https://${HOST}/api/request`), TS_ENV,
    reqDeps(async (env, r) => { seen.push(r); return { token: 'Abc_def-1234567890XYZ', status: 'running' }; }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.equal(body.report_url, '/report/Abc_def-1234567890XYZ');
  assert.equal(seen[0].businessName, 'Test Otter Plumbing');
  assert.equal(seen[0].id, body.id);
});

test('/api/request: no link when the starter can\'t make one, or when the bot check isn\'t configured', async () => {
  const res = await handleReportRequest(post(FORM), new URL(`https://${HOST}/api/request`), TS_ENV, reqDeps(async () => null));
  assert.equal((await res.json()).report_url, null);
  let called = false;
  const res2 = await quiet(() => handleReportRequest(post(FORM), new URL(`https://${HOST}/api/request`), {}, reqDeps(async () => { called = true; return { token: 'x'.repeat(22) }; })));
  const b2 = await res2.json();
  assert.equal(b2.ok, true);
  assert.equal(b2.report_url, null);
  assert.equal(called, false);
});

test('/api/request: a no-JS form post is sent to its report link', async () => {
  const res = await handleReportRequest(post(FORM, false), new URL(`https://${HOST}/api/request`), TS_ENV,
    reqDeps(async () => ({ token: 'Abc_def-1234567890XYZ', status: 'queued' })));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('Location'), `https://${HOST}/report/Abc_def-1234567890XYZ`);
});

// ---------------------------------------------------------------------------
// /admin "Run now"
// ---------------------------------------------------------------------------
test('Run now: a queued request starts under its own id; a failed one gets a new id and the same token', async () => {
  const db = fakeDb();
  const env = baseEnv({ AUTO_SCAN: 'off' });
  const q = await startRequestScan(env, req(), { now: NOW, fetchImpl: db.fetch });
  const r = await runQueuedScan(env, q.scanId, { fetchImpl: db.fetch });
  assert.deepEqual(r, { ok: true, scanId: q.scanId });
  assert.equal(env.SCAN_WORKFLOW.created[0].params.reportToken, q.token);
  assert.equal(db.rows.find((x) => x.id === q.scanId).status, 'running');
  // Not queued any more → refused.
  assert.equal((await runQueuedScan(env, q.scanId, { fetchImpl: db.fetch })).status, 409);
  // Failed → a fresh row, same token.
  db.rows[0].status = 'failed';
  const again = await runQueuedScan(env, q.scanId, { fetchImpl: db.fetch, uuid: () => '55555555-5555-4555-8555-555555555555' });
  assert.deepEqual(again, { ok: true, scanId: '55555555-5555-4555-8555-555555555555' });
  assert.equal(db.rows.find((x) => x.id === again.scanId).report_token, q.token);
  assert.equal(await pendingReportStatus(env, q.token, { fetchImpl: db.fetch }), 'running');
  // An admin scan (not a request) can't be run from here.
  db.rows.push({ id: '66666666-6666-4666-8666-666666666666', trigger: 'admin', status: 'queued', created_at: db.tick() });
  assert.equal((await runQueuedScan(env, '66666666-6666-4666-8666-666666666666', { fetchImpl: db.fetch })).status, 404);
});
