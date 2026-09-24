// --rebuild (replace the saved report of a resumed scan) and ensureBusiness keeping owner facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLocalScan, parseArgs, dryRunSetup, formatSummary } from '../run.js';
import { ensureBusiness } from '../store.js';
import { memorySupabase } from '../memory-supabase.js';
import { parseScanRequest } from '../../src/admin/scan-core.js';
import { ACTIVE_ENGINES } from '../config.js';

const sample = JSON.parse(readFileSync(new URL('../examples/sample-business.json', import.meta.url), 'utf8'));
const FACTS = { hours: 'Open 24/7', price: '$129 service call' };
const business = parseScanRequest({ business: { ...sample, facts: FACTS } }).params.business;
const noSleep = async () => {};

async function setup() {
  const d = await dryRunSetup();
  const hits = [];
  const fetchImpl = async (url, init = {}) => {
    const host = new URL(String(url)).hostname;
    let body = null;
    try { body = typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch { /* not json */ }
    hits.push(host === 'api.anthropic.com' ? (body?.output_config ? 'extract' : 'claude') : host);
    return d.fetchImpl(url, init);
  };
  return { ...d, fetchImpl, hits };
}
const run = (s, o = {}) => runLocalScan({
  business, engines: ACTIVE_ENGINES, runs: 1, reportToken: 'tok123abcd', env: s.env, fetchImpl: s.fetchImpl, sleep: noSleep, retryDelayMs: 0, ...o,
});

test('--rebuild needs --resume', () => {
  assert.throws(() => parseArgs(['--business', 'b.json', '--rebuild']), /--rebuild needs --resume/);
  const id = globalThis.crypto.randomUUID();
  const a = parseArgs(['--business', 'b.json', '--resume', id, '--rebuild']);
  assert.equal(a.rebuild, true);
  assert.equal(a.resume, id);
});

test('resume keeps the saved report; --rebuild re-extracts and replaces it in place', async () => {
  const s = await setup();
  const scanId = globalThis.crypto.randomUUID();
  await run(s, { scanId });
  const t = s.db.tables;
  assert.equal(t.scan_results.length, 1);
  const rowId = t.scan_results[0].id;
  // Tamper with the stored report so a replacement is visible.
  t.scan_results[0].report = { ...t.scan_results[0].report, generatedAt: '2000-01-01T00:00:00.000Z', stale: true };

  // Plain resume: the stored report stays.
  s.hits.length = 0;
  let sum = await run(s, { scanId, resume: true });
  assert.equal(sum.reportReplaced, false);
  assert.equal(t.scan_results.length, 1);
  assert.equal(t.scan_results[0].report.stale, true);

  // Rebuild: no engine is asked again, every answer is re-extracted (and recorded), row replaced.
  s.hits.length = 0;
  const usageBefore = t.scan_usage.length;
  sum = await run(s, { scanId, resume: true, rebuild: true });
  assert.equal(s.hits.filter((h) => h === 'api.openai.com' || h === 'claude' || h === 'generativelanguage.googleapis.com').length, 0);
  // 15 answers + the stored headline re-ask (its engine call is reused, its extraction is not).
  assert.equal(s.hits.filter((h) => h === 'extract').length, 16);
  assert.equal(t.scan_usage.length, usageBefore + 16, 're-extraction recorded in scan_usage');
  assert.equal(sum.reportSaved, true);
  assert.equal(sum.reportReplaced, true);
  assert.equal(sum.callsReused, 15);
  assert.equal(t.scan_results.length, 1, 'replaced in place, no second row');
  const row = t.scan_results[0];
  assert.equal(row.id, rowId);
  assert.equal(row.report_token, 'tok123abcd');
  assert.equal(row.report.stale, undefined);
  assert.equal(row.report.id, 'tok123abcd');
  assert.notEqual(row.report.generatedAt, '2000-01-01T00:00:00.000Z');
  assert.equal(row.scanned_at, row.report.generatedAt);
  // This run paid only for extraction; scans.extract_cost_usd is every scan_usage row of the
  // scan (first run + resume + rebuild), not just this run's.
  const allUsage = t.scan_usage.filter((r) => r.scan_id === scanId).reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(t.scans[0].extract_cost_usd - allUsage) < 1e-5, `${t.scans[0].extract_cost_usd} vs ${allUsage}`);
  assert.ok(Math.abs(sum.extractCostUsd - allUsage) < 1e-5);
  const thisRun = t.scan_usage.slice(usageBefore).reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(sum.runCostUsd - thisRun) < 1e-5, 'this run paid only for extraction');
  assert.ok(sum.extractCostUsd > sum.runCostUsd, 'the total includes the earlier runs');
  const rawCost = t.scan_raw.reduce((a, r) => a + r.cost_usd, 0);
  assert.ok(Math.abs(t.scans[0].total_cost_usd - (rawCost + allUsage)) < 1e-5);
  assert.match(formatSummary(sum), /Report \(replaced\): /);
});

test('--rebuild never replaces a saved report with one that fails validation', async () => {
  const s = await setup();
  const scanId = globalThis.crypto.randomUUID();
  await run(s, { scanId });
  const before = JSON.stringify(s.db.tables.scan_results[0].report);
  let n = 0;
  const failing = { ...s, fetchImpl: async (url, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (new URL(String(url)).hostname === 'api.anthropic.com' && body?.output_config && n++ === 2) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'nope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return s.fetchImpl(url, init);
  } };
  const sum = await run(failing, { scanId, resume: true, rebuild: true });
  assert.equal(sum.reportValid, false);
  assert.equal(sum.reportReplaced, false);
  assert.equal(JSON.stringify(s.db.tables.scan_results[0].report), before);
});

test('ensureBusiness returns the input business (facts, aliases) merged onto the stored row', async () => {
  const db = memorySupabase();
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' };
  const opts = { fetchImpl: (u, i) => db.handle(u, i) };
  const input = { name: 'Mega Wash & Dry', trade: 'laundromat', town: 'North Babylon', phone: '(631) 254-0914', facts: FACTS, aliases: ['Mega Wash'] };
  const created = await ensureBusiness(env, { ...input }, opts);
  assert.deepEqual(created.facts, FACTS);
  const byName = await ensureBusiness(env, { ...input }, opts);
  assert.equal(byName.id, created.id);
  assert.deepEqual(byName.facts, FACTS);
  assert.deepEqual(byName.aliases, ['Mega Wash']);
  const byId = await ensureBusiness(env, { id: created.id, name: 'Mega Wash & Dry', town: 'North Babylon', facts: FACTS }, opts);
  assert.deepEqual(byId.facts, FACTS);
  assert.equal(byId.phone, '(631) 254-0914', 'gaps filled from the stored row');
  assert.equal(db.tables.businesses.length, 1);
  assert.equal(db.tables.businesses[0].facts, undefined, 'facts are not a businesses column');
});

test('a local scan checks AI facts against the business file facts', async () => {
  // Make the (fixture) extractor quote an hours fact from every answer that names the owner.
  const s = await setup();
  const base = s.fetchImpl;
  s.fetchImpl = async (url, init = {}) => {
    const res = await base(url, init);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (new URL(String(url)).hostname !== 'api.anthropic.com' || !body?.output_config) return res;
    const msg = await res.json();
    const answer = body.messages[0].content.split('<answer>\n')[1].split('\n</answer>')[0];
    const block = msg.content.find((b) => b.type === 'text');
    const proposal = JSON.parse(block.text);
    const owner = proposal.businesses.find((b) => b.name === business.name);
    if (owner) proposal.ownerFacts = [{ field: 'hours', quote: answer.slice(owner.pos, owner.pos + business.name.length) }];
    block.text = JSON.stringify(proposal);
    return new Response(JSON.stringify(msg), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const sum = await run(s);
  assert.equal(sum.reportSaved, true);
  const report = s.db.tables.scan_results[0].report;
  assert.ok(report.aiFacts.length > 0);
  for (const f of report.aiFacts) assert.equal(f.sourceSays, FACTS.hours, 'compared with the business file fact, not "not on your site"');
});
