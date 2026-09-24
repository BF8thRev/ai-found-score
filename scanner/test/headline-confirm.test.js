// Headline confirmation: with one run per engine, the search the report leads with is asked
// once more on the same engine. If the owner's named / not-named status flips, the report leads
// with the next candidate and marks the first `headlineUnstable`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, applyHeadlineConfirmation } from '../extract/build.js';
import { validateReport, pickHeadline } from '../../shared/report-v2.js';
import {
  parseScanRequest, confirmHeadline, headlineTarget, confirmationForBuild, shouldConfirmHeadline, scanTotals,
} from '../../src/admin/scan-core.js';
import { runLocalScan, dryRunSetup } from '../run.js';
import { ACTIVE_ENGINES } from '../config.js';

const dir = new URL('./fixtures/megawash-live/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const business = parseScanRequest({ business: load('business.json') }).params.business;
const build = (headlineConfirmation = null) => buildReport({
  scan: load('scan.json'), business, proposalsByAnswer: load('proposals.json').proposals,
  env: {}, fetchImpl: async () => new Response('not found', { status: 404 }), id: 'mega-wash-and-dry', maxFetch: 0,
  headlineConfirmation,
});

// Fake engine + extractor for the re-ask.
const fakeAsk = (text, extra = {}) => async () => ({ ok: true, text, citations: [], costUsd: 0.01, ...extra });
const fakeExtract = (businesses) => async () => ({ ok: true, businesses, ownerFacts: [], ownerDescriptors: [], costUsd: 0.002 });

test('only single-run scans confirm their headline', () => {
  assert.equal(shouldConfirmHeadline(1), true);
  assert.equal(shouldConfirmHeadline(2), false);
  assert.equal(shouldConfirmHeadline(3), false);
});

test('same result on the re-ask: headline kept, method.headlineConfirmed true', async () => {
  const { report: pre } = await build();
  const target = headlineTarget(pre);
  assert.deepEqual(target, { ref: 'chatgpt:q5:1', engine: 'chatgpt', questionId: 'q5', namedYou: false });
  // Re-ask names nobody again: agreed.
  const c = await confirmHeadline({ target, business, ask: fakeAsk('Try a few laundromats in the area and compare prices.'), extract: fakeExtract([]) });
  assert.equal(c.agreed, true);
  assert.equal(c.costUsd, 0.01);
  assert.equal(c.extractCostUsd, 0.002);
  const { report, validation } = await build(confirmationForBuild(c));
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(report.headline.answerId, pre.headline.answerId);
  assert.equal(report.method.headlineConfirmed, true);
  assert.equal(report.method.headlineConfirm.result, 'same');
  assert.ok(!report.answers.some((a) => a.headlineUnstable));
});

test('owner status flips on the re-ask: first marked headlineUnstable, next candidate leads', async () => {
  const { report: pre } = await build();
  const target = headlineTarget(pre);
  const text = 'For cheap wash and fold near North Babylon, Mega Wash & Dry on Deer Park Ave charges by the pound.';
  const c = await confirmHeadline({
    target, business, ask: fakeAsk(text), extract: fakeExtract([{ name: 'Mega Wash & Dry', pos: text.indexOf('Mega Wash & Dry') }]),
  });
  assert.equal(c.namedYou, true);
  assert.equal(c.agreed, false);
  const { report, validation } = await build(confirmationForBuild(c));
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  const first = report.answers.find((a) => a.id === pre.headline.answerId);
  assert.equal(first.headlineUnstable, true);
  assert.notEqual(report.headline.answerId, first.id);
  // Mega Wash's only miss was the unstable one, so the report now leads with its best named answer.
  assert.equal(report.headline.rule, 'best_named_you');
  assert.deepEqual(report.headline, pickHeadline(report));
  assert.equal(report.method.headlineConfirmed, false);
  assert.equal(report.method.headlineConfirm.result, 'changed');
});

test('a failed or unsure re-ask keeps the headline but is not "confirmed"', async () => {
  const { report: pre } = await build();
  const target = headlineTarget(pre);
  const failed = await confirmHeadline({ target, business, ask: fakeAsk(null, { ok: false, error: 'HTTP 500', costUsd: 0 }), extract: fakeExtract([]) });
  assert.equal(failed.agreed, null);
  assert.equal(failed.ok, false);
  const extractFailed = await confirmHeadline({ target, business, ask: fakeAsk('x y z'), extract: async () => ({ ok: false, error: 'max_tokens', costUsd: 0.003 }) });
  assert.equal(extractFailed.agreed, null);
  assert.equal(extractFailed.extractCostUsd, 0.003, 'a billed failed extraction is still counted');
  const threw = await confirmHeadline({ target, business, ask: async () => { throw new Error('boom'); }, extract: fakeExtract([]) });
  assert.equal(threw.agreed, null);
  for (const c of [failed, extractFailed, threw]) {
    const { report, validation } = await build(confirmationForBuild(c));
    assert.equal(validation.ok, true);
    assert.equal(report.headline.answerId, pre.headline.answerId);
    assert.equal(report.method.headlineConfirmed, false);
    assert.equal(report.method.headlineConfirm.result, 'inconclusive');
  }
});

test('validateReport rejects a headline that points at an unstable answer while others exist', async () => {
  const { report } = await build();
  const r = structuredClone(report);
  applyHeadlineConfirmation(r, { ref: 'chatgpt:q5:1', ok: true, agreed: false });
  r.headline = { answerId: 'a5', rule: 'most_others_named_not_you' };
  assert.ok(validateReport(r).errors.some((e) => /headline is a5/.test(e)));
});

test('scanTotals counts the re-ask as one more call and its costs', () => {
  const calls = [{ ok: true, costUsd: 0.1 }, { ok: true, costUsd: 0.2 }];
  const extractions = [{ ok: true, costUsd: 0.01 }, { ok: true, costUsd: 0.01 }];
  const confirmation = { attempted: true, ok: true, costUsd: 0.1, extractCostUsd: 0.01 };
  const t = scanTotals({ calls, extractions, confirmation });
  assert.equal(t.calls_total, 3);
  assert.equal(t.calls_ok, 3);
  assert.equal(t.engine_cost_usd, 0.4);
  assert.equal(t.extract_cost_usd, 0.03);
  // Every scan_usage row wins when known (a resumed scan's earlier extraction runs).
  assert.equal(scanTotals({ calls, extractions, confirmation, usageCostUsd: 0.07 }).extract_cost_usd, 0.07);
  assert.equal(scanTotals({ calls, extractions }).calls_total, 2);
});

test('local scan: a flipped re-ask moves the headline and is stored as run 2 (fake extractor)', async () => {
  const d = await dryRunSetup();
  let extracts = 0;
  // The 16th extractor call is the confirm call (15 answers first). Return no businesses: the
  // dry-run headline names the owner, so the re-ask "flips" to not named.
  const fetchImpl = async (url, init = {}) => {
    const host = new URL(String(url)).hostname;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    if (host === 'api.anthropic.com' && body?.output_config && ++extracts === 16) {
      return new Response(JSON.stringify({
        id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'text', text: JSON.stringify({ businesses: [], ownerFacts: [], ownerDescriptors: [] }) }],
        stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return d.fetchImpl(url, init);
  };
  const sample = JSON.parse(readFileSync(new URL('../examples/sample-business.json', import.meta.url), 'utf8'));
  const biz = parseScanRequest({ business: sample }).params.business;
  const sum = await runLocalScan({ business: biz, engines: ACTIVE_ENGINES, runs: 1, reportToken: 'tokflip1234', env: d.env, fetchImpl, sleep: async () => {} });
  assert.equal(extracts, 16);
  assert.equal(sum.reportSaved, true);
  assert.equal(sum.headlineConfirmed, false);
  const report = d.db.tables.scan_results[0].report;
  assert.equal(report.method.headlineConfirm.result, 'changed');
  const unstable = report.answers.filter((a) => a.headlineUnstable);
  assert.equal(unstable.length, 1);
  assert.notEqual(report.headline.answerId, unstable[0].id);
  assert.ok(validateReport(report).ok);
  const row = d.db.tables.scan_raw.find((r) => r.run === 2);
  assert.equal(row.engine, unstable[0].engine);
  assert.equal(row.question_id, unstable[0].questionId);
});

test('runs = 2: no re-ask', async () => {
  const d = await dryRunSetup();
  const sample = JSON.parse(readFileSync(new URL('../examples/sample-business.json', import.meta.url), 'utf8'));
  const biz = parseScanRequest({ business: sample }).params.business;
  const sum = await runLocalScan({ business: biz, engines: ['chatgpt'], runs: 2, reportToken: 'tokruns2abc', env: d.env, fetchImpl: d.fetchImpl, sleep: async () => {} });
  assert.equal(sum.callsTotal, 10);
  assert.equal(sum.headlineConfirmed, null);
  assert.equal(d.db.tables.scan_results[0].report.method.headlineConfirmed, undefined);
});
