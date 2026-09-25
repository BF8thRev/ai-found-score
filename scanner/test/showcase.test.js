// Homepage "real AI answer" card: answer cleanup, the excerpt rule, and the weekly job (scanner/showcase.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { displayText, excerptAnswer, nameSpans } from '../answer-text.js';
import { showcaseOne, parseTowns, parseTrades, saveShowcase } from '../showcase.js';
import { fixtureFetch, DRY_RUN_ENV } from '../dry-run.js';
import { fakeProposal } from '../../src/admin/dry-run.js';

const scan = JSON.parse(readFileSync(new URL('./fixtures/megawash-live/scan.json', import.meta.url), 'utf8'));

test('displayText drops citation links and bold markers, keeps every word in order', () => {
  const raw = 'Short answer: **Mega Wash & Dry** is great. ([megawashanddry.com](https://megawashanddry.com/?utm_source=openai))\n\n- See [their site](https://x.com/a_(b)) for hours.';
  assert.equal(displayText(raw), 'Short answer: Mega Wash & Dry is great.\n\n- See their site for hours.');
});

test('excerpt of the real Mega Wash answer is the quote the homepage already shows', () => {
  const text = displayText(scan.calls[0].text);
  const ex = excerptAnswer(text, ['Mega Wash & Dry', 'One Hour Laundry']);
  assert.ok(ex.text.endsWith('is another top option.'));
  assert.ok(ex.text.includes('Many people in North Babylon recommend Mega Wash & Dry as the best all‑around choice'));
  assert.equal(ex.truncated, true);
  assert.deepEqual(ex.spans.map(([s, e]) => ex.text.slice(s, e)), ['Mega Wash & Dry', 'One Hour Laundry']);
  assert.ok(text.startsWith(ex.text), 'a prefix of the displayed answer, nothing rewritten');
});

test('excerpt stops before a phone number or street address; none if no name comes first', () => {
  const t = 'Try Acme Plumbing. Call 516-555-0142 for Bolt Plumbing.';
  assert.equal(excerptAnswer(t, ['Acme Plumbing', 'Bolt Plumbing']).text, 'Try Acme Plumbing.');
  assert.equal(excerptAnswer('Visit 12 Main St for Bolt Plumbing.', ['Bolt Plumbing']), null);
  assert.equal(excerptAnswer('No businesses here.', []), null);
});

test('excerpt keeps to ~60 words and ends at a sentence end', () => {
  const filler = 'This sentence is filler with exactly ten words in it. ';
  const t = `Acme Plumbing is good. ${filler.repeat(10)}Bolt Plumbing too.`;
  const ex = excerptAnswer(t, ['Acme Plumbing', 'Bolt Plumbing']);
  assert.equal(ex.text, 'Acme Plumbing is good.', 'later filler never names anyone, so the cut ends at the last named sentence');
});

test('nameSpans: every occurrence, sorted, no overlaps', () => {
  assert.deepEqual(nameSpans('A Co and A Co Plus', ['A Co', 'A Co Plus']), [[0, 4], [9, 18]]);
});

test('parseTowns / parseTrades', () => {
  assert.deepEqual(parseTowns('Massapequa,NY,11758; Hicksville,ny'), [{ town: 'Massapequa', state: 'NY', zip: '11758' }, { town: 'Hicksville', state: 'NY', zip: '' }]);
  assert.throws(() => parseTowns('Nowhere'));
  assert.deepEqual(parseTrades('plumbing,hvac'), ['plumbing', 'hvac']);
  assert.throws(() => parseTrades('bakery'));
});

test('showcaseOne: asks the "best" question, stores a verbatim excerpt and records the spend', async () => {
  const propose = async ({ raw }) => ({ ok: true, error: null, model: 'dry-run', usage: null, costUsd: 0.01, businesses: fakeProposal(raw, '').businesses });
  const r = await showcaseOne({
    trade: 'plumbing', town: 'Massapequa', state: 'NY', zip: '11758', engine: 'chatgpt',
    env: DRY_RUN_ENV, fetchImpl: fixtureFetch(), propose, now: () => new Date('2026-09-25T12:00:00Z'),
  });
  assert.ok(r.ok, r.reason);
  assert.equal(r.row.question, "What's the best plumber in Massapequa, NY?");
  assert.ok(displayText(r.row.answer).startsWith(r.row.excerpt));
  assert.ok(r.row.spans.length > 0);
  for (const [s, e] of r.row.spans) assert.ok(e <= r.row.excerpt.length && s < e);
  assert.ok(!('active' in r.row), 'a takedown (active=false) survives the weekly refresh');
  assert.deepEqual(r.usage.map((u) => [u.kind, u.answer_ref]), [['other', 'showcase:plumbing:Massapequa,NY'], ['extract', 'showcase:plumbing:Massapequa,NY']]);
});

test('showcaseOne: an answer that names nobody is skipped', async () => {
  const propose = async () => ({ ok: true, businesses: [], costUsd: 0 });
  const r = await showcaseOne({ trade: 'roofing', town: 'Massapequa', state: 'NY', engine: 'chatgpt', env: DRY_RUN_ENV, fetchImpl: fixtureFetch(), propose });
  assert.equal(r.ok, false);
  assert.match(r.reason, /names no business/);
});

test('saveShowcase upserts on (trade, town, state) with the service key', async () => {
  const calls = [];
  const fetchImpl = async (u, init) => { calls.push({ u, init }); return new Response(null, { status: 201 }); };
  const out = await saveShowcase(DRY_RUN_ENV, [{ trade: 'plumbing' }], { fetchImpl });
  assert.ok(out.ok);
  assert.match(calls[0].u, /showcase_answers\?on_conflict=trade,town,state$/);
  assert.match(calls[0].init.headers.Prefer, /merge-duplicates/);
});
