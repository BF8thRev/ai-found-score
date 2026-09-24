// Step 2 gate: rerunning the extractor on the Mega Wash & Dry answers reproduces the demo.
// Fixture is RECONSTRUCTED FROM DEMO EXCERPTS (see scan.json _note). Fully offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReport } from '../build.js';
import { validateReport, lostIntents, intentResults, edgeState, computeTotals } from '../../../shared/report-v2.js';

const dir = new URL('../../test/fixtures/megawash/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const ypHtml = readFileSync(new URL('yellowpages-babylon-ny-laundromats.html', dir), 'utf8');

const fetched = [];
async function fetchImpl(url) {
  fetched.push(String(url));
  if (String(url).startsWith('https://api.openai.com')) throw new Error('test must not call the model');
  if (String(url).includes('yellowpages.com/babylon-ny/laundromats')) return new Response(ypHtml, { status: 200 });
  return new Response('not found', { status: 404 });
}

async function build() {
  return buildReport({
    scan: load('scan.json'),
    business: load('business.json'),
    proposalsByAnswer: load('proposals.json').proposals,
    env: {},
    fetchImpl,
  });
}
const clone = (x) => JSON.parse(JSON.stringify(x));

test('Mega Wash & Dry: counts match the demo', async () => {
  const { report, validation } = await build();
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(report.version, 2);
  assert.equal(report.locked, true);
  assert.deepEqual(report.totals, { answers: 10, namedYou: 8, firstYou: 4 });
  assert.deepEqual(computeTotals(report), report.totals);

  // Grid: ✗ best/cheapest on Perplexity; ★ on P-24h, P-pickup, G-24h, G-comforter.
  const cell = (engine, q) => report.answers.find((a) => a.engine === engine && a.questionId === q);
  const mark = (a) => (a.namedYouFirst ? '★' : a.namedYou ? '✓' : '✗');
  const grid = ['q1', 'q2', 'q3', 'q4', 'q5'].map((q) => mark(cell('perplexity', q)) + mark(cell('google_ai_mode', q)));
  assert.deepEqual(grid, ['✗✓', '★★', '★✓', '✓★', '✗✓']);
});

test('Mega Wash & Dry: "Who AI names" (2+ answers) matches the demo', async () => {
  const { report } = await build();
  const shown = report.entities
    .filter((e) => e.named >= 2 || e.isYou)
    .map((e) => ({ name: e.name, aliases: e.aliases, named: e.named, first: e.first, isYou: e.isYou }));
  assert.deepEqual(shown, [
    { name: 'Mega Wash & Dry', aliases: [], named: 8, first: 4, isYou: true },
    { name: 'One Hour Laundry', aliases: [], named: 5, first: 4, isYou: false },
    { name: 'The Best Around Laundromat', aliases: [], named: 3, first: 0, isYou: false },
    { name: 'Park Avenue Laundromat', aliases: ['Park Avenue Laundry'], named: 2, first: 1, isYou: false },
    { name: '24/7 Laundromat', aliases: [], named: 2, first: 0, isYou: false },
  ]);
  for (const e of report.entities) assert.equal(e.answerIds.length, e.named, e.name);
});

test('Mega Wash & Dry: headline is the Perplexity "cheapest" answer; 1-of-2 splits are not lost intents', async () => {
  const { report } = await build();
  const h = report.answers.find((a) => a.id === report.headline.answerId);
  assert.equal(report.headline.rule, 'most_others_named_not_you');
  assert.equal(h.engine, 'perplexity');
  assert.equal(h.questionId, 'q5');
  assert.deepEqual(
    h.businessesNamed.map((b) => b.name),
    ['One Hour Laundry', 'The Best Around Laundromat', 'Check Your Pockets Laundromat', 'Wash N Go Laundromat', 'Azartin Laundry Care'],
  );
  // best and price were each missed by Perplexity but named by Google AI Mode (1 of 2).
  // Lost = named in half or fewer of the intent's answers, so 1 of 2 is lost (as in the demo).
  assert.deepEqual(lostIntents(report), ['best', 'price']);
  assert.deepEqual(
    intentResults(report).filter((x) => x.named < x.answers).map((x) => [x.intent, x.named, x.answers]),
    [['best', 1, 2], ['price', 1, 2]],
  );
  assert.equal(edgeState(report).state, 'normal');
});

test('Mega Wash & Dry: code rejects bad proposals and fixes an off pos', async () => {
  const { report, rejected } = await build();
  assert.deepEqual(rejected.map((r) => r.name), ['Suds City Laundromat']);
  const a = report.answers.find((x) => x.engine === 'perplexity' && x.questionId === 'q3');
  const w = a.businessesNamed.find((b) => b.name === 'WashUp Laundry');
  assert.equal(a.text.slice(w.pos, w.pos + w.name.length), 'WashUp Laundry');
  assert.ok(!fetched.some((u) => u.startsWith('https://api.openai.com')));
});

test('Mega Wash & Dry: sources, facts and issues', async () => {
  const { report } = await build();
  const yp = report.sources.find((s) => s.domain === 'yellowpages.com');
  assert.equal(yp.youListed, false);
  assert.equal(yp.youPosition, null);
  assert.equal(yp.topListed, 'Park Avenue Laundromat');
  assert.deepEqual(yp.citedIn, [report.answers.find((a) => a.engine === 'perplexity' && a.questionId === 'q1').id]);
  const sp = report.sources.find((s) => s.domain === 'superpages.com');
  assert.equal(sp.youListed, null, 'unfetchable page stays unknown, never guessed');

  const price = report.aiFacts.find((f) => f.field === 'price');
  assert.equal(price.aiSays, '$2.25/lb with a 20 lb. minimum');
  assert.equal(price.status, 'match');
  assert.ok(report.aiFacts.every((f) => f.status === 'match'));

  assert.equal(report.issues[0].title, 'Not listed on yellowpages.com, which AI cited when it named others');
  assert.equal(report.issues[0].severity, 'high');
  assert.deepEqual(report.method.enginesFailed, []);
  assert.equal(report.method.window, '5:01–5:10pm ET');
  assert.equal(report.method.runs, 1);
});

test('validateReport fails on a tampered total', async () => {
  const { report } = await build();
  const r = clone(report);
  r.totals.namedYou = 9;
  const v = validateReport(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e === 'totals.namedYou is 9 but the answers show 8'), v.errors.join('\n'));
});

test('validateReport fails on a competitor shown with only 1 proving answer', async () => {
  const { report } = await build();
  const r = clone(report);
  const e = r.entities.find((x) => x.name === '24/7 Laundromat');
  e.answerIds = e.answerIds.slice(0, 1);
  let v = validateReport(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((m) => m.includes('"24/7 Laundromat"') && m.includes('only 1 stored answer(s) prove it')), v.errors.join('\n'));

  // Also: an attached answer that doesn't actually contain the name.
  const r2 = clone(report);
  const e2 = r2.entities.find((x) => x.name === 'One Hour Laundry');
  e2.answerIds[0] = r2.answers.find((a) => a.engine === 'perplexity' && a.questionId === 'q2').id;
  v = validateReport(r2);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((m) => m.includes('does not contain "One Hour Laundry"')), v.errors.join('\n'));
});

test('validateReport fails on a non-literal quote', async () => {
  const { report } = await build();
  const r = clone(report);
  r.aiFacts.find((f) => f.field === 'price').aiSays = '$2.25 per pound, 20 lb minimum';
  let v = validateReport(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((m) => m.includes('is not a literal quote')), v.errors.join('\n'));

  const r2 = clone(report);
  r2.answers[0].businessesNamed[0].name = 'Park Ave Laundromat';
  v = validateReport(r2);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((m) => m.includes('is not in the answer text at pos')), v.errors.join('\n'));
});

test('validateReport fails on a planted banned word in an issue title, not on "rank" in answer text or "Frank"', async () => {
  const { report } = await build();
  const r = clone(report);
  r.issues[0].title = 'Improve your rank on yellowpages.com';
  let v = validateReport(r);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors, ['banned word "rank" in issues[0].title: "rank"']);

  const r2 = clone(report);
  r2.issues[0].title = 'Frank Laundry is listed on yellowpages.com';
  r2.answers[0].text += ' They rank highly on several directories.';
  v = validateReport(r2);
  assert.deepEqual(v, { ok: true, errors: [] });
});
