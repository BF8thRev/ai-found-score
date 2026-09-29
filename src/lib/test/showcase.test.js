// Homepage hero card from showcase_answers (src/lib/showcase.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickShowcase, renderShowcase, tradeParam, validRow, showcaseTag, loadShowcaseRows, answerHtml, namedIn, namesHtml, previewStart, answerBlockHtml, keepLastWords } from '../showcase.js';
import { SHOWCASE_TOKENS, SHOWCASE_ALIASES } from '../checkout.js';

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
  assert.match(html, /<span data-sc-src>Real AI answer<\/span> &middot; asked <span data-sc-date>Sep 24, 2026<\/span>/);
  assert.match(html, /What&#39;s the best plumber in Massapequa,\xa0NY\?/);
  assert.match(html, /Try <b>&lt;Acme&gt; Plumbing<\/b> now\.<span class="sc-more"> &hellip;<\/span>/);
  assert.ok(!/<script type="application\/json" id="sc-data">[^]*<Acme/.test(html), 'JSON cannot close its <script>');
  assert.match(html, /named by AI, not by us/);
});

test('keepLastWords: the last two words of the question stay on one line', () => {
  assert.equal(keepLastWords("What's the best laundromat in North Babylon, NY?"), "What's the best laundromat in North Babylon,\xa0NY?");
  assert.equal(keepLastWords('Plumber'), 'Plumber');
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

test('renderShowcase: two-line answer, then who got the call and everyone else in town', () => {
  const html = renderShowcase(pickShowcase([row({ engine: 'chatgpt' })], null, null));
  assert.match(html, /<div class="sc-full"><p class="sc-a" data-sc-a>Many people recommend <b>Acme/);
  assert.match(html, /<button type="button" class="sc-expand" data-sc-expand aria-expanded="false">Read the full answer, word for word<\/button><\/div>\s*<p class="sc-k">/);
  assert.match(html, /<ul class="sc-names" data-sc-names><li>Acme Plumbing &amp; Heating<\/li><li>Bolt Plumbing<\/li><\/ul>/);
  assert.match(html, /<b data-sc-lost>Every other plumber in Massapequa<\/b><span data-sc-why>Not mentioned\. ChatGPT didn&rsquo;t give this customer their name\.<\/span>/);
  assert.match(html, /"town":"Massapequa"/);
});

test('previewStart: the preview starts at the sentence naming the first business, not the filler', () => {
  const a = { excerpt: 'Here are some good options near you:\n\n1. Acme Plumbing is great. Bolt Plumbing too.', spans: [[41, 54], [65, 78]], truncated: false };
  assert.equal(previewStart(a), 41);
  assert.equal(answerBlockHtml(a), '<p class="sc-a has-intro" data-sc-a><span class="sc-intro">Here are some good options near you:\n1. </span><b>Acme Plumbing</b> is great. <b>Bolt Plumbing</b> too.</p>');
  assert.equal(previewStart({ excerpt: 'Try Acme Co. Or Bolt.', spans: [[4, 11]] }), 0, 'a short lead-in is kept');
});

test('renderShowcase: the label names the assistant that answered, else "Real AI answer"', () => {
  assert.match(renderShowcase(pickShowcase([row({ engine: 'chatgpt' })], null, null)), /<span data-sc-src>ChatGPT&rsquo;s answer<\/span> &middot; asked/);
  assert.match(renderShowcase(pickShowcase([row({ engine: 'nope' })], null, null)), /<span data-sc-src>Real AI answer<\/span>/);
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
  for (const t of tokens) assert.ok(SHOWCASE_TOKENS.includes(SHOWCASE_ALIASES[t] || t), `${t} is linked but locked`);
});

test('report page (public/js/report.js) treats the same reports as showcases as the server', () => {
  const js = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const m = /const SHOWCASE_TOKENS = (\[[^\]]*\]);/.exec(js);
  assert.ok(m, 'SHOWCASE_TOKENS in report.js');
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), SHOWCASE_TOKENS);
  for (const [alias, token] of Object.entries(SHOWCASE_ALIASES)) assert.ok(js.includes(`href: '/report/${alias}'`) && js.includes(`id: '${token}'`), `${alias} is in the switcher`);
});
