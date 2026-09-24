// The first REAL report (Mega Wash & Dry, scan 37233a42): its answers and extractor proposals,
// rebuilt offline. Guards the bugs that report showed: owner facts lost on the way in, a vague
// location flagged as a wrong address (and made the #1 fix), ~25 duplicate fact cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport, MAX_FACTS } from '../build.js';
import { validateReport } from '../../../shared/report-v2.js';
import { parseScanRequest } from '../../../src/admin/scan-core.js';

const dir = new URL('../../test/fixtures/megawash-live/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));

async function build() {
  // Same path as scanner/run.js: the business file goes through parseScanRequest first.
  const parsed = parseScanRequest({ business: load('business.json') });
  assert.ok(parsed.ok, parsed.error);
  return buildReport({
    scan: load('scan.json'),
    business: parsed.params.business,
    proposalsByAnswer: load('proposals.json').proposals,
    env: {},
    fetchImpl: async () => new Response('not found', { status: 404 }),
    id: 'mega-wash-and-dry',
  });
}

test('live Mega Wash & Dry: owner facts survive parseScanRequest and are compared', async () => {
  const { report, validation } = await build();
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.deepEqual(report.totals, { answers: 10, namedYou: 9, firstYou: 5 });
  assert.ok(report.aiFacts.length > 0);
  assert.ok(report.aiFacts.every((f) => f.sourceSays), 'every fact is checked against the owner facts');
  assert.ok(report.aiFacts.every((f) => f.status === 'match'), JSON.stringify(report.aiFacts.map((f) => [f.field, f.status, f.aiSays])));
  const fields = new Set(report.aiFacts.map((f) => f.field));
  for (const f of ['hours', 'price', 'address', 'services']) assert.ok(fields.has(f), `${f} fact shown`);
  const price = report.aiFacts.find((f) => f.field === 'price');
  assert.match(price.aiSays, /\$2\.25 per pound with a 20 lb minimum/);
  assert.equal(price.sourceSays, '$2.25/lb, 20 lb minimum');
});

test('live Mega Wash & Dry: a vague location is not an address, and makes no issue', async () => {
  const { report, rejected } = await build();
  assert.ok(!report.aiFacts.some((f) => /border/.test(f.aiSays)));
  assert.ok(rejected.some((r) => r.kind === 'fact' && /border/.test(r.quote) && /street number/.test(r.reason)));
  assert.ok(!report.issues.some((i) => i.kind === 'fact_differs'), report.issues.map((i) => i.title).join('\n'));
  assert.ok(!report.issues.some((i) => /differently/.test(i.title)));
  assert.equal(report.issues[0].kind, 'lost_question');
  assert.equal(report.issues[0].title, 'Not named when asked "Cheapest wash and fold near North Babylon NY"');
});

test('live Mega Wash & Dry: one fact per field and engine, capped, no "not stated" cards', async () => {
  const { report } = await build();
  assert.ok(report.aiFacts.length <= MAX_FACTS);
  const engineOf = new Map(report.answers.map((a) => [a.id, a.engine]));
  const keys = report.aiFacts.map((f) => `${f.field}|${engineOf.get(f.answerId)}`);
  assert.equal(new Set(keys).size, keys.length, keys.join(', '));
  assert.ok(report.aiFacts.every((f) => f.status !== 'not stated'));
  // The most specific quote wins (most of the owner's own words, then the shorter one).
  const quote = (field, engine) => report.aiFacts.find((f) => f.field === field && engineOf.get(f.answerId) === engine)?.aiSays;
  assert.equal(quote('address', 'claude'), '1502 Deer Park Ave, North Babylon, NY');
  assert.equal(quote('hours', 'chatgpt'), 'open 24 hours');
  assert.equal(quote('hours', 'claude'), 'open 24 hours a day, 365 days a year');
  assert.equal(validateReport(report).ok, true);
});

test('live Mega Wash & Dry: headline is the only answer that missed the owner (it named nobody)', async () => {
  const { report } = await build();
  const h = report.answers.find((a) => a.id === report.headline.answerId);
  assert.equal(report.headline.rule, 'most_others_named_not_you');
  assert.equal(h.engine, 'chatgpt');
  assert.equal(h.questionId, 'q5');
  assert.equal(h.namedYou, false);
  assert.deepEqual(h.businessesNamed, []);
  assert.deepEqual(report.method.enginesFailed, ['gemini']);
});
