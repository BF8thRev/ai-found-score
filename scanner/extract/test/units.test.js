import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintText, lintReport, BANNED_WORDS, pickHeadline, edgeState, validateReport, lostIntents, intentResults } from '../../../shared/report-v2.js';
import { normalizeName, streetKey } from '../normalize.js';
import { verifyAnswer, verifyBusinesses, factStatus } from '../verify.js';
import { groupEntities } from '../entities.js';
import { checkDirectoryPage, normalizeCitation } from '../sources.js';
import { proposeForAnswer, DEFAULT_EXTRACT_MODEL } from '../propose.js';
import { buildReport } from '../build.js';

test('BANNED_WORDS and lintText', () => {
  assert.deepEqual(BANNED_WORDS, ['disconnected', 'minutes', 'guarantee placement', 'more customers', 'rank']);
  assert.deepEqual(lintText('Frank and Cranky ranked'), [{ word: 'rank', match: 'ranked', index: 17 }]);
  assert.equal(lintText('We Guarantee  Placement for MORE customers').length, 2);
  assert.equal(lintText('Takes 5 Minutes').length, 1);
  assert.equal(lintText('see https://example.com/rank-and-minutes').length, 0);
  assert.equal(lintText('ranking').length, 1);
  assert.equal(lintText('prank, franking').length, 0);
});

test('normalizeName drops LLC, Inc, &/and, punctuation, "the"', () => {
  assert.equal(normalizeName('The Mega Wash & Dry, LLC.'), 'mega wash dry');
  assert.equal(normalizeName('Mega Wash and Dry Inc'), 'mega wash dry');
  assert.equal(streetKey('1502 Deer Park Avenue, North Babylon'), '1502 deer park ave');
});

const owner = { name: 'Harbor Plumbing & Heating LLC', phone: '(516) 555-0148', address: '4820 Merrick Road', website: 'harborplumbing.example.com' };

test('verifyBusinesses: literal substrings only, pos re-found', () => {
  const text = 'Try Acme Pipes or Best Drains.';
  const { kept, rejected } = verifyBusinesses(text, [{ name: 'Best Drains', pos: 0 }, { name: 'Acme Pipes', pos: 4 }, { name: 'Acme Pipe Co', pos: 4 }]);
  assert.deepEqual(kept, [{ name: 'Acme Pipes', pos: 4 }, { name: 'Best Drains', pos: 18 }]);
  assert.equal(rejected[0].name, 'Acme Pipe Co');
});

test('owner match: exact name → match; contradicting phone → unsure; near name needs confirmation', () => {
  const run = (text, businesses, citations = []) => verifyAnswer({ answer: { text, citations }, proposal: { businesses, ownerFacts: [] }, business: owner });
  let v = run('Harbor Plumbing and Heating is great.', [{ name: 'Harbor Plumbing and Heating', pos: 0 }]);
  assert.equal(v.namedYou, true);
  assert.equal(v.namedYouFirst, true);

  v = run('Harbor Plumbing & Heating (631) 222-3333 is great.', [{ name: 'Harbor Plumbing & Heating', pos: 0 }]);
  assert.equal(v.namedYou, false);
  assert.equal(v.ownerMatch, 'unsure');

  v = run('Try Zed Co, or Harbor Plumbing for boilers.', [{ name: 'Zed Co', pos: 4 }, { name: 'Harbor Plumbing', pos: 15 }]);
  assert.equal(v.ownerMatch, 'unsure');
  assert.equal(v.namedYou, false);

  v = run('Try Zed Co, or Harbor Plumbing at 4820 Merrick Rd.', [{ name: 'Zed Co', pos: 4 }, { name: 'Harbor Plumbing', pos: 15 }]);
  assert.equal(v.namedYou, true);
  assert.equal(v.namedYouFirst, false);

  v = run('Harbor Plumbing is nearby.', [{ name: 'Harbor Plumbing', pos: 0 }], [{ url: 'https://harborplumbing.example.com/', domain: 'harborplumbing.example.com' }]);
  assert.equal(v.namedYou, true);
});

test('facts: literal quotes only; status vs owner facts', () => {
  const v = verifyAnswer({
    answer: { text: 'Harbor Plumbing & Heating is open 24 hours and charges $99 per visit.', citations: [] },
    proposal: { businesses: [{ name: 'Harbor Plumbing & Heating', pos: 0 }], ownerFacts: [{ field: 'hours', quote: 'open 24 hours' }, { field: 'price', quote: '$89 per visit' }] },
    business: owner,
  });
  assert.deepEqual(v.facts.map((f) => f.aiSays), ['open 24 hours']);
  assert.equal(factStatus('hours', 'open 24 hours', 'Open 24/7'), 'match');
  assert.equal(factStatus('hours', 'open 24 hours', 'Mon–Fri 8am–6pm'), 'differs');
  assert.equal(factStatus('price', '$99 per visit', '$89 service call'), 'differs');
  assert.equal(factStatus('phone', '516-555-0148', '(516) 555-0148'), 'match');
  assert.equal(factStatus('price', '$99', null), 'not stated');
});

test('entities: variants grouped by shared street address (Island Laundromat / One Hour Laundry)', () => {
  const answers = [
    { id: 'a1', text: 'Island Laundromat at 1137 Deer Park Ave is fine.', businessesNamed: [{ name: 'Island Laundromat', pos: 0 }] },
    { id: 'a2', text: 'One Hour Laundry, 1137 Deer Park Avenue, is best. Also Zed Wash.', businessesNamed: [{ name: 'One Hour Laundry', pos: 0 }, { name: 'Zed Wash', pos: 55 }] },
    { id: 'a3', text: 'Zed Wash first, then One Hour Laundry.', businessesNamed: [{ name: 'Zed Wash', pos: 0 }, { name: 'One Hour Laundry', pos: 21 }] },
  ];
  const { entities } = groupEntities(answers);
  const oh = entities.find((e) => e.name === 'One Hour Laundry');
  assert.deepEqual(oh.aliases, ['Island Laundromat']);
  assert.equal(oh.named, 3);
  assert.equal(oh.first, 2);
  assert.deepEqual(oh.answerIds, ['a1', 'a2', 'a3']);
  const zed = entities.find((e) => e.name === 'Zed Wash');
  assert.equal(zed.named, 2);
  assert.equal(zed.first, 1);
});

test('entities: grouped by phone', () => {
  const answers = [
    { id: 'a1', text: 'Acme Rooter (516) 555-0100 is good.', businessesNamed: [{ name: 'Acme Rooter', pos: 0 }] },
    { id: 'a2', text: 'Acme Drain Pros 516-555-0100.', businessesNamed: [{ name: 'Acme Drain Pros', pos: 0 }] },
  ];
  const { entities } = groupEntities(answers);
  assert.equal(entities.length, 1);
  assert.equal(entities[0].named, 2);
  assert.equal(entities[0].phone, '5165550100');
});

test('sources: citation normalization and directory page check', () => {
  assert.deepEqual(normalizeCitation({ url: 'https://www.Yelp.com/biz/x?utm_source=a&b=1#top' }), { domain: 'yelp.com', url: 'https://www.yelp.com/biz/x?b=1' });
  assert.equal(normalizeCitation({ url: 'not a url' }), null);
  const html = `<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
    {"position":2,"item":{"name":"Harbor Plumbing &amp; Heating"}},{"position":1,"item":{"name":"Zed Plumbing"}}]}</script>`;
  assert.deepEqual(checkDirectoryPage(html, owner), { youListed: true, youPosition: 2, topListed: 'Zed Plumbing', listingsRead: 2 });
  const html2 = '<a class="business-name">Zed Plumbing</a><p>Call 516.555.0148</p>';
  assert.deepEqual(checkDirectoryPage(html2, owner), { youListed: true, youPosition: null, topListed: 'Zed Plumbing', listingsRead: 1 });
});

const messagesBody = (over = {}) => ({
  id: 'msg_01XYZ', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: JSON.stringify({ businesses: [{ name: 'Zed Co', pos: 3 }], ownerFacts: [{ field: 'bogus', quote: 'x' }, { field: 'hours', quote: 'open late' }] }) },
  ],
  stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
  usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});
const fakeFetch = (status, body, sink = {}, headers = {}) => async (url, init) => {
  sink.url = String(url);
  sink.headers = new Headers(init.headers);
  sink.body = JSON.parse(init.body);
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1', ...headers } });
};

test('propose (Claude): Messages API request shape, parsing, usage and cost', async () => {
  const sent = {};
  const p = await proposeForAnswer({ answer: { text: 'Hi Zed Co, open late' }, business: owner, env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl: fakeFetch(200, messagesBody(), sent) });
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers.get('x-api-key'), 'sk-test');
  assert.equal(sent.body.model, 'claude-sonnet-5');
  assert.equal(DEFAULT_EXTRACT_MODEL, 'claude-sonnet-5');
  assert.equal(sent.body.max_tokens, 16000);
  assert.deepEqual(sent.body.thinking, { type: 'adaptive' });
  assert.equal(sent.body.output_config.format.type, 'json_schema');
  assert.equal(sent.body.output_config.format.schema.additionalProperties, false);
  assert.equal(sent.body.output_format, undefined);
  assert.equal(sent.body.temperature, undefined);
  assert.equal(sent.body.messages.length, 1);
  assert.equal(sent.body.messages[0].role, 'user');
  assert.match(sent.body.messages[0].content, /Hi Zed Co, open late/);
  assert.equal(typeof sent.body.system, 'string');
  assert.equal(p.ok, true);
  assert.deepEqual(p.businesses, [{ name: 'Zed Co', pos: 3 }]);
  assert.deepEqual(p.ownerFacts, [{ field: 'hours', quote: 'open late' }]);
  assert.deepEqual(p.usage, { input_tokens: 1200, output_tokens: 300 });
  assert.equal(p.costUsd, (1200 * 2 + 300 * 10) / 1e6);

  await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: { ANTHROPIC_API_KEY: 'k', EXTRACT_MODEL: 'claude-opus-5' }, fetchImpl: fakeFetch(200, messagesBody(), sent) });
  assert.equal(sent.body.model, 'claude-opus-5', 'EXTRACT_MODEL overrides the default');
});

test('propose (Claude): refusal and max_tokens give no proposals, never invented', async () => {
  const refusal = messagesBody({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'declined' }, usage: { input_tokens: 900, output_tokens: 0 } });
  let p = await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fakeFetch(200, refusal) });
  assert.equal(p.ok, false);
  assert.equal(p.error, 'refusal');
  assert.deepEqual([p.businesses, p.ownerFacts], [[], []]);
  assert.equal(p.costUsd, 900 * 2 / 1e6);

  const cut = messagesBody({ content: [{ type: 'text', text: '{"businesses":[{"name":"Ze' }], stop_reason: 'max_tokens' });
  p = await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fakeFetch(200, cut) });
  assert.deepEqual([p.ok, p.error, p.businesses], [false, 'max_tokens', []]);
});

test('propose (Claude): typed SDK errors and missing key', async () => {
  const err = { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } };
  let p = await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fakeFetch(429, err), maxRetries: 0 });
  assert.deepEqual([p.ok, p.error], [false, 'rate_limited (HTTP 429)']);
  p = await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fakeFetch(500, { type: 'error', error: { type: 'api_error', message: 'boom' } }), maxRetries: 0 });
  assert.equal(p.ok, false);
  assert.match(p.error, /^api_error \(HTTP 500\)/);
  p = await proposeForAnswer({ answer: { text: 'x' }, business: owner, env: {} });
  assert.deepEqual([p.ok, p.error], [false, 'ANTHROPIC_API_KEY missing and no recorded proposals given']);
});

test('buildReport: a failed extraction blocks publish and extraction cost is totalled', async () => {
  const scan = { questions: [{ id: 'q1', intent: 'best', text: 'Best plumber?' }], calls: [
    { engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: 'Zed Co is good.', citations: [], askedAt: '2026-09-24T21:00:00Z' },
    { engine: 'perplexity', questionId: 'q1', run: 1, ok: true, text: 'Try Zed Co.', citations: [], askedAt: '2026-09-24T21:01:00Z' },
  ] };
  let n = 0;
  const fetchImpl = async (url) => {
    if (!String(url).startsWith('https://api.anthropic.com')) return new Response('', { status: 404 });
    n++;
    const body = n === 1
      ? messagesBody({ content: [{ type: 'text', text: '{"businesses":[{"name":"Zed Co","pos":0}],"ownerFacts":[]}' }] })
      : messagesBody({ content: [], stop_reason: 'refusal', usage: { input_tokens: 100, output_tokens: 0 } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { validation, extraction } = await buildReport({ scan, business: owner, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl, id: 't' });
  assert.equal(extraction.calls, 2);
  assert.equal(extraction.costUsd, (1200 * 2 + 300 * 10 + 100 * 2) / 1e6);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, ["answer a2 (perplexity q1): extraction failed (refusal); its counts can't be trusted"]);
});

function miniScan(overrides = {}) {
  return {
    questions: [{ id: 'q1', intent: 'best', text: 'Best plumber in Massapequa, NY?' }, { id: 'q2', intent: 'price', text: 'Affordable plumber near 11758' }],
    engines: ['chatgpt', 'gemini', 'perplexity'],
    calls: [
      { engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: 'Zed Plumbing and Acme Pipes are top picks.', citations: [{ url: 'https://www.yelp.com/search?x=1' }], askedAt: '2026-09-24T21:01:00Z', model: 'gpt-x' },
      { engine: 'chatgpt', questionId: 'q2', run: 1, ok: true, text: 'Harbor Plumbing & Heating is affordable; Zed Plumbing too.', citations: [], askedAt: '2026-09-24T21:02:00Z', model: 'gpt-x' },
      { engine: 'gemini', questionId: 'q1', run: 1, ok: false, text: null, error: 'HTTP 500', askedAt: '2026-09-24T21:03:00Z' },
      { engine: 'gemini', questionId: 'q2', run: 1, ok: false, text: null, error: 'HTTP 500', askedAt: '2026-09-24T21:03:00Z' },
      { engine: 'perplexity', questionId: 'q1', run: 1, ok: true, text: 'Acme Pipes is well reviewed.', citations: [], askedAt: '2026-09-24T21:04:00Z', model: 'sonar' },
      { engine: 'perplexity', questionId: 'q2', run: 1, ok: false, text: null, error: 'timeout', askedAt: '2026-09-24T21:04:30Z' },
    ],
    ...overrides,
  };
}
const miniProposals = {
  'chatgpt:q1:1': { businesses: [{ name: 'Zed Plumbing', pos: 0 }, { name: 'Acme Pipes', pos: 17 }], ownerFacts: [] },
  'chatgpt:q2:1': { businesses: [{ name: 'Harbor Plumbing & Heating', pos: 0 }, { name: 'Zed Plumbing', pos: 42 }], ownerFacts: [{ field: 'price', quote: 'affordable' }] },
  'perplexity:q1:1': { businesses: [{ name: 'Acme Pipes', pos: 0 }], ownerFacts: [] },
};

test('buildReport: failed engine dropped and named; failed single call logged; headline tie-break', async () => {
  const { report, validation } = await buildReport({
    scan: miniScan(), business: owner, proposalsByAnswer: miniProposals, env: {},
    fetchImpl: async () => new Response('', { status: 404 }), id: 'tok123',
  });
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(report.id, 'tok123');
  assert.deepEqual(report.method.enginesFailed, ['gemini']);
  assert.ok(report.answers.every((a) => a.engine !== 'gemini'));
  assert.deepEqual(report.method.failedCalls, [{ engine: 'perplexity', questionId: 'q2', run: 1, error: 'timeout' }]);
  assert.deepEqual(report.totals, { answers: 3, namedYou: 1, firstYou: 1 });
  // chatgpt q1 names 2 others, not you → headline.
  assert.equal(report.answers.find((a) => a.id === report.headline.answerId).engine, 'chatgpt');
  assert.deepEqual(edgeState(report).failedEngines, ['gemini']);
  // price fact present but owner's site doesn't state price.
  assert.equal(report.aiFacts[0].status, 'not stated');
});

test('pickHeadline: tie → chatgpt, then google_ai_mode; all named → best_named_you', () => {
  const mk = (id, engine, others, you = false, first = false) => ({
    id, engine, questionId: 'q1', run: 1, namedYou: you, namedYouFirst: first,
    businessesNamed: [...Array(others)].map((_, i) => ({ name: `B${i}`, pos: i, entityId: `e${i}` })),
  });
  const q = [{ id: 'q1', intent: 'best' }];
  assert.equal(pickHeadline({ questions: q, answers: [mk('a1', 'perplexity', 2), mk('a2', 'google_ai_mode', 2), mk('a3', 'gemini', 2)] }).answerId, 'a2');
  assert.equal(pickHeadline({ questions: q, answers: [mk('a1', 'perplexity', 2), mk('a2', 'chatgpt', 2)] }).answerId, 'a2');
  assert.deepEqual(pickHeadline({ questions: q, answers: [mk('a1', 'perplexity', 3, true), mk('a2', 'gemini', 1, true, true)] }), { answerId: 'a2', rule: 'best_named_you' });
});

test('edgeState', () => {
  const base = { method: { enginesFailed: [] }, listings: [], sources: [] };
  assert.equal(edgeState({ ...base, answers: [{ namedYou: false }], entities: [] }).state, 'zero');
  assert.equal(edgeState({ ...base, answers: [{ namedYou: true }], entities: [{ named: 1 }] }).state, 'all_named');
  assert.equal(edgeState({ ...base, answers: [{ namedYou: true }, { namedYou: false }], entities: [{ named: 1 }] }).state, 'nobody_twice');
  assert.equal(edgeState({ ...base, answers: [{ namedYou: true }, { namedYou: false }], entities: [{ named: 2 }] }).state, 'no_fixes');
  assert.equal(edgeState({ ...base, sources: [{ youListed: false }], answers: [{ namedYou: true }, { namedYou: false }], entities: [{ named: 2 }] }).state, 'normal');
});

test('validateReport: missing method and bad input are specific', () => {
  assert.deepEqual(validateReport(null), { ok: false, errors: ['report is not an object'] });
  const v = validateReport({ version: 2, questions: [], answers: [], entities: [], totals: { answers: 0, namedYou: 0, firstYou: 0 } });
  assert.deepEqual(v.errors, ['answers is empty: no engine returned a usable answer, so there is nothing to publish', 'method missing']);
});

test('buildReport: every engine failed → 0 answers → validation fails', async () => {
  const scan = miniScan({ calls: miniScan().calls.map((c) => ({ ...c, ok: false, text: null, error: 'HTTP 500' })) });
  const { report, validation } = await buildReport({ scan, business: owner, env: {}, fetchImpl: async () => new Response('', { status: 404 }), id: 't' });
  assert.equal(report.answers.length, 0);
  assert.deepEqual(report.method.enginesFailed, ['chatgpt', 'gemini', 'perplexity']);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((e) => e.startsWith('answers is empty')));
});

test('buildReport: scan.calls is required (runScan output passes straight through)', async () => {
  const { calls, ...rest } = miniScan();
  await assert.rejects(buildReport({ scan: { ...rest, results: calls }, business: owner, env: {} }), /scan\.calls must be an array/);
});

test('lostIntents: lost when the owner is named in half or fewer of the intent answers; unsure left out', () => {
  const q = [{ id: 'q1', intent: 'best', text: 'x' }, { id: 'q2', intent: 'price', text: 'y' }, { id: 'q3', intent: 'job', text: 'z' }];
  const a = (qid, namedYou, extra = {}) => ({ questionId: qid, namedYou, ...extra });
  const report = {
    questions: q,
    answers: [
      a('q1', true), a('q1', false), a('q1', false), a('q1', false), // 1 of 4 → lost
      a('q2', true), a('q2', true), a('q2', false), a('q2', false), // 2 of 4 → exactly half, lost
      a('q3', false, { ownerMatch: 'unsure' }), a('q3', false, { ownerMatch: 'unsure' }), a('q3', true), // unsure excluded → 1 of 1
    ],
  };
  assert.deepEqual(lostIntents(report), ['best', 'price']);
  assert.deepEqual(intentResults(report).map((x) => [x.intent, x.named, x.answers, x.lost]), [
    ['best', 1, 4, true], ['price', 2, 4, true], ['job', 1, 1, false],
  ]);
});

test('validateReport: owner mention must match its entity isYou; one owner entity', () => {
  const text = 'Zed Plumbing and Acme Pipes.';
  const r = {
    version: 2,
    questions: [{ id: 'q1', intent: 'best', text: 'q' }],
    answers: [{ id: 'a1', questionId: 'q1', engine: 'chatgpt', run: 1, text, namedYou: true, namedYouFirst: true,
      businessesNamed: [{ name: 'Zed Plumbing', pos: 0, isYou: true, entityId: 'e1' }, { name: 'Acme Pipes', pos: 17, entityId: 'e2' }] }],
    entities: [
      { id: 'e1', name: 'Zed Plumbing', aliases: [], isYou: false, named: 1, first: 1, answerIds: ['a1'] },
      { id: 'e2', name: 'Acme Pipes', aliases: [], isYou: false, named: 1, first: 0, answerIds: ['a1'] },
    ],
    totals: { answers: 1, namedYou: 1, firstYou: 1 },
    headline: { answerId: 'a1', rule: 'best_named_you' },
    method: { engines: { chatgpt: {} }, enginesFailed: [], window: 'w', runs: 1 },
  };
  assert.deepEqual(validateReport(r).errors, ['answer a1: businessesNamed "Zed Plumbing" isYou=true but entity e1 "Zed Plumbing" isYou=false']);
  r.entities[0].isYou = true;
  assert.deepEqual(validateReport(r), { ok: true, errors: [] });

  // Numbers the page prints must be plain counts.
  const bad = structuredClone(r);
  bad.answers[0].run = '1<img>';
  bad.sources = [{ domain: 'x.example.com', url: 'https://x.example.com/', citedIn: ['a1'], youListed: true, youPosition: 0 }];
  bad.baseline = { generatedAt: '2026-08-24', totals: { answers: 25, namedYou: -1, firstYou: '3' } };
  const errs = validateReport(bad).errors.join('\n');
  assert.match(errs, /answers\[0\] \(a1\)\.run must be a positive integer/);
  assert.match(errs, /sources\[0\]\.youPosition must be null or a positive integer/);
  assert.match(errs, /baseline\.totals\.namedYou must be a non-negative integer/);
  assert.match(errs, /baseline\.totals\.firstYou must be a non-negative integer/);
  bad.answers[0].run = 1;
  bad.sources[0].youPosition = null;
  bad.baseline.totals = { answers: 25, namedYou: 0, firstYou: 0 };
  assert.deepEqual(validateReport(bad), { ok: true, errors: [] });
});

test('lint: AI quotes and competitor names inside our issue copy do not trip the banned words', () => {
  const report = {
    aiFacts: [{ answerId: 'a1', field: 'hours', aiSays: 'last wash 30 minutes before close', status: 'differs' }],
    entities: [{ id: 'e2', name: 'Top Rank Plumbing', aliases: [] }],
    issues: [
      { title: 'AI states your hours differently than your website', description: 'ChatGPT said "last wash 30 minutes before close". Your website says "7am-10pm".' },
      { title: 'Not named when asked "x"', description: 'ChatGPT answered without naming you and named 1 other business: Top Rank Plumbing.' },
      { title: 'We rank you', description: 'planted' },
    ],
  };
  assert.deepEqual(lintReport(report).map((h) => [h.path, h.match]), [['issues[2].title', 'rank']]);
});

test('buildReport: uncited search results never become cited sources; issue copy names only proven competitors', async () => {
  const scan = {
    questions: [{ id: 'q1', intent: 'best', text: 'Best plumber in Massapequa, NY?' }],
    calls: [
      { engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: 'Acme Pipes and Solo Drains are good.', citations: [{ url: 'https://www.yelp.com/a', uncited: true }], askedAt: '2026-09-24T21:01:00Z' },
      { engine: 'chatgpt', questionId: 'q1', run: 2, ok: true, text: 'Acme Pipes is good.', citations: [{ url: 'https://www.bbb.org/b' }], askedAt: '2026-09-24T21:02:00Z' },
    ],
  };
  const proposalsByAnswer = {
    'chatgpt:q1:1': { businesses: [{ name: 'Acme Pipes', pos: 0 }, { name: 'Solo Drains', pos: 15 }], ownerFacts: [] },
    'chatgpt:q1:2': { businesses: [{ name: 'Acme Pipes', pos: 0 }], ownerFacts: [] },
  };
  const { report, validation } = await buildReport({ scan, business: owner, proposalsByAnswer, env: {}, fetchImpl: async () => new Response('', { status: 404 }), id: 't' });
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.deepEqual(report.sources.map((s) => s.domain), ['bbb.org']);
  const lost = report.issues.find((i) => i.kind === 'lost_question');
  assert.match(lost.description, /named 2 other businesses, including Acme Pipes\.$/);
  assert.doesNotMatch(lost.description, /Solo Drains/);
});
