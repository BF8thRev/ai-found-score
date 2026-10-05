import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanFinished, parseScanRequest } from '../../src/admin/scan-core.js';
import { decide, prepareItems, runBatch, parseArgs } from '../batch.js';

const BATCH_JS = fileURLToPath(new URL('../batch.js', import.meta.url));

// A scan as the workflow's finalize step writes it when everything went right.
const finishedRow = (over = {}) => ({
  id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'done', report_token: 'abc23def45', report_valid: true,
  calls_total: 15, calls_ok: 15, errors: [], created_at: '2026-10-04T13:00:00Z', updated_at: '2026-10-04T13:05:00Z', ...over,
});

// ---------------------------------------------------------------------------
// strict "finished"
// ---------------------------------------------------------------------------
test('scanFinished: only done + report link + valid report + every engine call answered + no errors', () => {
  assert.deepEqual(scanFinished(finishedRow()), { finished: true, reason: 'finished' });
  // The PR-73 shape: scanTotals says "done" because some calls answered, but one engine call failed.
  const pr73 = finishedRow({ calls_ok: 14, errors: [{ kind: 'engine', engine: 'gemini', questionId: 'q3', run: 1, error: '503' }] });
  assert.equal(scanFinished(pr73).finished, false);
  assert.match(scanFinished(pr73).reason, /14 of 15 engine calls/);
  // Each condition on its own is enough to refuse.
  assert.equal(scanFinished(finishedRow({ errors: [{ kind: 'engine', error: 'x' }] })).finished, false, 'a failed call listed in errors');
  assert.equal(scanFinished(finishedRow({ errors: [{ kind: 'store', error: 'x' }] })).finished, false, 'report not stored');
  assert.equal(scanFinished(finishedRow({ report_token: null })).finished, false, 'no report link');
  assert.equal(scanFinished(finishedRow({ report_valid: false })).finished, false, 'invalid report');
  assert.equal(scanFinished(finishedRow({ report_valid: null })).finished, false, 'unknown validity');
  assert.equal(scanFinished(finishedRow({ calls_total: 0, calls_ok: 0 })).finished, false, 'no calls at all');
  for (const status of ['queued', 'running', 'failed', 'cancelled', undefined]) {
    assert.equal(scanFinished(finishedRow({ status })).finished, false, String(status));
  }
  assert.equal(scanFinished(null).finished, false);
});

test('parseScanRequest: batch tag passes through only as a valid pair', () => {
  const business = { name: 'Acme Plumbing', trade: 'plumber', town: 'Massapequa' };
  const ok = parseScanRequest({ business, batchId: 'exp002-2026-10-04', batchItem: 'p01' });
  assert.equal(ok.params.batchId, 'exp002-2026-10-04');
  assert.equal(ok.params.batchItem, 'p01');
  assert.equal('batchId' in parseScanRequest({ business }).params, false, 'untagged scans carry no batch fields');
  assert.match(parseScanRequest({ business, batchId: 'x' }).error, /go together/);
  assert.match(parseScanRequest({ business, batchItem: 'x' }).error, /go together/);
  assert.match(parseScanRequest({ business, batchId: 'bad id!', batchItem: 'p1' }).error, /batchId/);
  assert.match(parseScanRequest({ business, batchId: 'b', batchItem: 'x'.repeat(65) }).error, /batchItem/);
});

// ---------------------------------------------------------------------------
// decide / prepareItems
// ---------------------------------------------------------------------------
test('decide: skip a finished scan, wait for a live one, re-scan everything else', () => {
  const now = Date.parse('2026-10-04T14:00:00Z');
  assert.equal(decide([], { now }).action, 'scan');
  assert.equal(decide([finishedRow()], { now }).action, 'skip');
  // A newer failed retry doesn't hide an older finished one.
  assert.equal(decide([finishedRow({ id: 'n', status: 'failed' }), finishedRow()], { now }).action, 'skip');
  const pr73 = finishedRow({ calls_ok: 14 });
  const d = decide([pr73], { now });
  assert.equal(d.action, 'scan', 'done-with-a-failed-call is scanned again, not kept');
  assert.match(d.reason, /14 of 15/);
  const running = finishedRow({ status: 'running', updated_at: '2026-10-04T13:50:00Z' });
  assert.equal(decide([running], { now }).action, 'wait', 'never start a second scan while one is live');
  const stuck = finishedRow({ status: 'running', updated_at: '2026-10-04T12:00:00Z' });
  assert.equal(decide([stuck], { now }).action, 'scan', 'a scan untouched for 2h is dead');
  assert.equal(decide([finishedRow({ status: 'cancelled' })], { now }).action, 'scan');
});

test('prepareItems: every prospect needs an id; the whole list is checked before anything starts', () => {
  const items = prepareItems([
    { id: 'p1', business: { name: 'A Co', trade: 'plumber', town: 'Massapequa' }, engines: ['chatgpt'] },
    { id: '11111111-1111-4111-8111-111111111111', name: 'B Co', trade: 'roofer', town: 'Babylon' },
  ], 'exp002-2026-10-04');
  assert.deepEqual(items.map((i) => i.id), ['p1', '11111111-1111-4111-8111-111111111111']);
  assert.deepEqual(items[0].body, {
    engines: ['chatgpt'], business: { name: 'A Co', trade: 'plumber', town: 'Massapequa' }, batchId: 'exp002-2026-10-04', batchItem: 'p1',
  });
  assert.equal(items[1].body.business.name, 'B Co', 'a plain business object is the business');
  assert.throws(() => prepareItems([
    { business: { name: 'No Id', trade: 'plumber', town: 'X' } },
    { id: 'p1', business: { name: 'A', trade: 'plumber', town: 'X' } },
    { id: 'p1', business: { name: 'A again', trade: 'plumber', town: 'X' } },
    { id: 'p2', business: { name: 'No town', trade: 'plumber' } },
  ], 'b1'), (e) => /nothing was started/.test(e.message) && /#1 \(No Id\): no id/.test(e.message)
    && /appears twice/.test(e.message) && /#4 \(No town\)/.test(e.message));
  assert.throws(() => prepareItems([], 'b1'), /non-empty/);
  assert.throws(() => prepareItems([{ id: 'p1', business: {} }], 'bad batch!'), /--batch/);
  assert.equal(parseArgs(['--batch', 'b', '--list', 'l.json', '--poll-sec', '0.05', '--yes']).pollSec, 0.05);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

// ---------------------------------------------------------------------------
// A fake site + Supabase: POST /api/admin/scan creates a scans row (one "billed" scan), the REST
// reads serve the rows. `plan[prospect]` says how each new scan ends: 'finish' | 'hang' | 'pr73'.
// ---------------------------------------------------------------------------
function fakeBackend({ adminToken = 'tok', plan = {} } = {}) {
  const rows = [];
  const starts = {};
  let n = 0;
  const touch = (r, patch) => Object.assign(r, patch, { updated_at: new Date().toISOString() });
  const finishLater = (r, how) => setTimeout(() => {
    if (how === 'finish') touch(r, finishedRow({ id: r.id, created_at: r.created_at, batch_id: r.batch_id, batch_item: r.batch_item }));
    if (how === 'pr73') touch(r, finishedRow({ id: r.id, created_at: r.created_at, batch_id: r.batch_id, batch_item: r.batch_item, calls_ok: 14, errors: [{ kind: 'engine', error: '503' }] }));
  }, 30);
  async function handle(method, url, headers, bodyText) {
    const u = new URL(url);
    if (method === 'POST' && u.pathname === '/api/admin/scan') {
      if (headers.authorization !== `Bearer ${adminToken}`) return [401, { error: 'Unauthorized' }];
      const body = JSON.parse(bodyText);
      const parsed = parseScanRequest(body);
      if (!parsed.ok) return [422, { error: parsed.error }];
      const id = `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, '0')}`;
      const now = new Date().toISOString();
      const row = { id, status: 'running', batch_id: body.batchId, batch_item: body.batchItem, created_at: now, updated_at: now, errors: [] };
      rows.push(row);
      starts[body.batchItem] = (starts[body.batchItem] || 0) + 1;
      finishLater(row, (typeof plan[body.batchItem] === 'function' ? plan[body.batchItem]() : plan[body.batchItem]) || 'finish');
      return [202, { scanId: id }];
    }
    if (method === 'GET' && u.pathname === '/rest/v1/scans') {
      if (headers.apikey !== 'svc') return [401, { error: 'bad key' }];
      const eq = (k) => u.searchParams.get(k)?.replace(/^eq\./, '');
      let out = rows.filter((r) => (!eq('id') || r.id === eq('id'))
        && (!eq('batch_id') || r.batch_id === eq('batch_id')) && (!eq('batch_item') || r.batch_item === eq('batch_item')));
      out = [...out].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return [200, out.map((r) => ({ ...r }))];
    }
    return [404, { error: `no route ${method} ${u.pathname}` }];
  }
  const fetchImpl = async (url, init = {}) => {
    const h = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const [status, json] = await handle(init.method || 'GET', String(url), h, init.body);
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return { rows, starts, handle, fetchImpl };
}

const PROSPECTS = [
  { id: 'p1', business: { name: 'Test Plumbing One', trade: 'plumber', town: 'Massapequa' }, engines: ['chatgpt'], questions: 1 },
  { id: 'p2', business: { name: 'Test Roofing Two', trade: 'roofer', town: 'Babylon' }, engines: ['chatgpt'], questions: 1 },
];
const ENV = { SUPABASE_URL: 'http://fake.local', SUPABASE_SERVICE_KEY: 'svc' };

test('runBatch: a re-run skips finished prospects and re-scans only the unfinished ones', async () => {
  const fake = fakeBackend({ plan: { p1: 'finish', p2: 'pr73' } });
  const opts = {
    batchId: 'b1', items: prepareItems(PROSPECTS, 'b1'), env: ENV, base: 'http://fake.local', adminToken: 'tok',
    fetchImpl: fake.fetchImpl, pollMs: 10, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  const first = await runBatch(opts);
  assert.deepEqual(first.results.map((r) => r.outcome), ['finished', 'not finished'], 'p2 came back "done" with a failed call');
  assert.deepEqual(fake.starts, { p1: 1, p2: 1 });

  const second = await runBatch(opts);
  assert.deepEqual(second.results.map((r) => r.outcome), ['skipped', 'not finished']);
  assert.deepEqual(fake.starts, { p1: 1, p2: 2 }, 'p1 not paid again; p2 retried');

  // Once p2 finishes, a third run starts nothing at all.
  const fake2 = fakeBackend({ plan: { p1: 'finish', p2: 'finish' } });
  const o2 = { ...opts, fetchImpl: fake2.fetchImpl };
  await runBatch(o2);
  const third = await runBatch(o2);
  assert.deepEqual(third.results.map((r) => r.outcome), ['skipped', 'skipped']);
  assert.deepEqual(fake2.starts, { p1: 1, p2: 1 });
});

test('runBatch: a refused start is reported and the batch carries on', async () => {
  const fake = fakeBackend({ adminToken: 'other' });
  const out = await runBatch({
    batchId: 'b1', items: prepareItems(PROSPECTS, 'b1'), env: ENV, base: 'http://fake.local', adminToken: 'tok',
    fetchImpl: fake.fetchImpl, pollMs: 1, sleep: async () => {},
  });
  assert.deepEqual(out.results.map((r) => r.outcome), ['error', 'error']);
  assert.match(out.results[0].reason, /401/);
});

// ---------------------------------------------------------------------------
// The dry run asked for: 2 test prospects, kill the real process mid-batch, re-run, and confirm
// the finished prospect is skipped (not started = not billed) while the other is retried.
// ---------------------------------------------------------------------------
test('batch CLI: killed mid-batch, the re-run skips the finished prospect and is not billed for it', { timeout: 30_000 }, async () => {
  let p2Attempts = 0;
  // p2's first scan hangs (we kill the runner while it waits); its retry finishes.
  const fake = fakeBackend({ plan: { p1: 'finish', p2: () => (++p2Attempts === 1 ? 'hang' : 'finish') } });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const [status, json] = await fake.handle(req.method, `http://${req.headers.host}${req.url}`, req.headers, body);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'afs-batch-'));
  const list = join(dir, 'prospects.json');
  writeFileSync(list, JSON.stringify(PROSPECTS));
  // process.env wins over .dev.vars, so the runner only ever talks to the fake server.
  const env = { ...process.env, SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'svc', ADMIN_TOKEN: 'tok', AFS_BASE_URL: base };
  const run = () => {
    const child = spawn(process.execPath, [BATCH_JS, '--batch', 'exp-dry', '--list', list, '--yes', '--poll-sec', '0.05'], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    return { child, exited, output: () => out };
  };
  const until = async (cond, ms = 15_000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    // Run 1: p1 finishes, p2 starts and hangs → kill the process while it waits on p2.
    const r1 = run();
    await until(() => fake.starts.p2 === 1);
    await new Promise((r) => setTimeout(r, 150));
    r1.child.kill('SIGKILL');
    const e1 = await r1.exited;
    assert.ok(e1.signal || e1.code !== 0, 'the first run was killed, not finished');
    assert.match(r1.output(), /Test Plumbing One \(p1\): finished/);
    assert.deepEqual(fake.starts, { p1: 1, p2: 1 });

    // The scan the killed run was waiting on dies too (its row is left "failed").
    const hung = fake.rows.find((r) => r.batch_item === 'p2');
    Object.assign(hung, { status: 'failed', updated_at: new Date().toISOString() });

    // Run 2: same command.
    const r2 = run();
    const e2 = await r2.exited;
    assert.equal(e2.code, 0, r2.output());
    assert.match(r2.output(), /1 already finished \(skipped\), 1 to scan/);
    assert.match(r2.output(), /Test Plumbing One \(p1\): skip, already finished/);
    assert.match(r2.output(), /Test Roofing Two \(p2\): scanning, last try not finished \(status failed\)/);
    assert.match(r2.output(), /Test Roofing Two \(p2\): finished/);
    assert.deepEqual(fake.starts, { p1: 1, p2: 2 }, 'p1 started (billed) once across both runs; p2 retried once');

    // Run 3: nothing left; nothing starts.
    const r3 = run();
    assert.equal((await r3.exited).code, 0);
    assert.match(r3.output(), /2 already finished \(skipped\), 0 to scan/);
    assert.deepEqual(fake.starts, { p1: 1, p2: 2 });
  } finally {
    server.close();
  }
});

test('batch CLI: killed while a scan is still running, the re-run waits for it instead of paying for a second one', { timeout: 30_000 }, async () => {
  const fake = fakeBackend({ plan: { p1: 'finish', p2: 'hang' } });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const [status, json] = await fake.handle(req.method, `http://${req.headers.host}${req.url}`, req.headers, body);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'afs-batch-'));
  const list = join(dir, 'prospects.json');
  writeFileSync(list, JSON.stringify(PROSPECTS));
  const env = { ...process.env, SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'svc', ADMIN_TOKEN: 'tok', AFS_BASE_URL: base };
  const spawnRun = () => {
    const child = spawn(process.execPath, [BATCH_JS, '--batch', 'exp-dry', '--list', list, '--yes', '--poll-sec', '0.05'], { env });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    return { child, exited: new Promise((r) => child.on('exit', (code) => r(code))), output: () => out };
  };
  try {
    const r1 = spawnRun();
    while (fake.starts.p2 !== 1) await new Promise((r) => setTimeout(r, 20));
    r1.child.kill('SIGKILL');
    await r1.exited;
    // p2's scan is still running on the site. Re-run, then let that scan finish.
    const r2 = spawnRun();
    while (!/Test Roofing Two \(p2\): waiting/.test(r2.output())) await new Promise((r) => setTimeout(r, 20));
    const hung = fake.rows.find((r) => r.batch_item === 'p2');
    Object.assign(hung, finishedRow({ id: hung.id, created_at: hung.created_at, batch_id: hung.batch_id, batch_item: 'p2' }));
    assert.equal(await r2.exited, 0, r2.output());
    assert.deepEqual(fake.starts, { p1: 1, p2: 1 }, 'nothing was started twice');
  } finally {
    server.close();
  }
});
