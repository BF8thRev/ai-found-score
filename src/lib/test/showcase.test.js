// Homepage hero card from showcase_answers (src/lib/showcase.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickShowcase, renderShowcase, tradeParam, validRow, showcaseTag, loadShowcaseRows, answerHtml, namedIn, namesHtml } from '../showcase.js';
import { SHOWCASE_TOKENS } from '../checkout.js';

const row = (o = {}) => ({
  trade: 'plumbing', town: 'Massapequa', state: 'NY', question: "What's the best plumber in Massapequa, NY?",
  excerpt: 'Many people recommend Acme Plumbing & Heating. Bolt Plumbing is another option.', spans: [[22, 45], [47, 60]],
  truncated: true, asked_at: '2026-09-24T15:00:00Z', ...o,
});

test('tradeParam accepts only the 8 trades (aliases ok), never echoes anything else', () => {
  assert.equal(tradeParam('plumbing'), 'plumbing');
  assert.equal(tradeParam('plumber'), 'plumbing');
  assert.equal(tradeParam('<script>'), '');
  assert.equal(tradeParam('bakery'), '');
  assert.equal(tradeParam(null), '');
});

test('validRow rejects rows whose spans fall outside the excerpt or overlap', () => {
  assert.ok(validRow(row()));
  assert.ok(!validRow(row({ spans: [[22, 999]] })));
  assert.ok(!validRow(row({ spans: [[22, 45], [30, 50]] })));
  assert.ok(!validRow(row({ spans: [] })), 'the card must name at least one business');
  assert.ok(!validRow(row({ trade: 'bakery' })));
});

test('pickShowcase: visitor town first, else the default town; ?trade= when that trade exists', () => {
  const rows = [row(), row({ trade: 'roofing', question: "What's the best roofer in Massapequa, NY?" }), row({ town: 'Hicksville', question: "What's the best plumber in Hicksville, NY?" })];
  const hicks = pickShowcase(rows, { town: 'Hicksville', state: 'NY' }, null);
  assert.equal(hicks.town, 'Hicksville');
  assert.equal(hicks.trade, 'plumbing');
  const buffalo = pickShowcase(rows, { town: 'Buffalo', state: 'NY' }, 'roofer');
  assert.equal(buffalo.town, 'Massapequa', 'no answers for Buffalo: the default town, named on the card');
  assert.equal(buffalo.trade, 'roofing');
  assert.deepEqual(buffalo.order, ['plumbing', 'roofing']);
  assert.equal(pickShowcase(rows, { town: 'Massapequa', state: 'NY' }, 'hvac').trade, 'plumbing', 'no HVAC answer: first available');
  assert.equal(pickShowcase([], null, null), null);
});

test('renderShowcase: exact question, escaped verbatim excerpt, names in bold, dated label', () => {
  const p = pickShowcase([row({ excerpt: 'Try <Acme> Plumbing now.', spans: [[4, 19]] })], null, null);
  const html = renderShowcase(p);
  assert.match(html, /Real AI answer &middot; asked <span data-sc-date>Sep 24, 2026<\/span>/);
  assert.match(html, /What&#39;s the best plumber in Massapequa, NY\?/);
  assert.match(html, /Try <b>&lt;Acme&gt; Plumbing<\/b> now\.<span class="sc-more"> &hellip;<\/span>/);
  assert.ok(!/<script type="application\/json" id="sc-data">[^]*<Acme/.test(html), 'JSON cannot close its <script>');
  assert.match(html, /named by AI, not by us/);
});

test('answerHtml: no trailing ellipsis when the excerpt is the whole answer', () => {
  assert.equal(answerHtml({ excerpt: 'Acme Co.', spans: [[0, 7]], truncated: false }), '<b>Acme Co</b>.');
});

test('showcaseTag changes when the shown answers change', () => {
  const a = pickShowcase([row()], null, null);
  const b = pickShowcase([row({ asked_at: '2026-10-01T15:00:00Z' })], null, null);
  assert.ok(showcaseTag(a).startsWith('-sc.'));
  assert.notEqual(showcaseTag(a), showcaseTag(b));
  assert.equal(showcaseTag(null), '');
});

test('loadShowcaseRows: read failure is [] (static card stays), cached briefly', async () => {
  const puts = [];
  const cache = { match: async () => undefined, put: async (k, r) => { puts.push(r.headers.get('Cache-Control')); } };
  const rows = await loadShowcaseRows({}, { cache, readRows: async () => { throw new Error('no table'); } });
  assert.deepEqual(rows, []);
  assert.deepEqual(puts, ['public, max-age=300']);
  const ok = await loadShowcaseRows({}, { cache, readRows: async () => [row()] });
  assert.equal(ok.length, 1);
  assert.equal(puts[1], 'public, max-age=3600');
});

test('renderShowcase: names who got the call, then everyone else in town; full answer behind a tap', () => {
  const html = renderShowcase(pickShowcase([row()], null, null));
  assert.match(html, /<ul class="sc-names" data-sc-names><li>Acme Plumbing &amp; Heating<\/li><li>Bolt Plumbing<\/li><\/ul>/);
  assert.match(html, /<b data-sc-lost>Every other plumber in Massapequa<\/b><span>Not mentioned\. Never got the call\.<\/span>/);
  assert.match(html, /<details class="sc-full"><summary>[^<]+<\/summary><p class="sc-a" data-sc-a>/);
  assert.match(html, /"town":"Massapequa"/);
});

test('namedIn / namesHtml: each business once, in order; capped with "+N more"', () => {
  const ex = 'A Co, B Co, a co again, C Co, D Co, E Co, F Co.';
  const spans = [[0, 4], [6, 10], [12, 16], [24, 28], [30, 34], [36, 40], [42, 46]];
  assert.deepEqual(namedIn({ excerpt: ex, spans }), ['A Co', 'B Co', 'C Co', 'D Co', 'E Co', 'F Co']);
  assert.match(namesHtml({ excerpt: ex, spans }), /<li>D Co<\/li><li class="sc-more-names">\+2 more in the answer<\/li>$/);
});

test('every real report the homepage links is open to everyone (and never sold)', () => {
  const index = readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
  const tokens = [...index.matchAll(/href="\/report\/([^"#?]+)"/g)].map((m) => m[1]).filter((t) => !t.startsWith('sample-'));
  assert.ok(tokens.length >= 2);
  for (const t of tokens) assert.ok(SHOWCASE_TOKENS.includes(t), `${t} is linked but locked`);
});
