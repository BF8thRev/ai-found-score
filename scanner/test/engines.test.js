import test from 'node:test';
import assert from 'node:assert/strict';
import * as chatgpt from '../engines/chatgpt.js';
import * as gemini from '../engines/gemini.js';
import * as perplexity from '../engines/perplexity.js';
import * as aiMode from '../engines/google_ai_mode.js';
import * as claude from '../engines/claude.js';
import { ENGINES } from '../engines/index.js';
import { ENGINE_IDS, ENGINE_NAMES, enginesConfigured, resolveKeys } from '../config.js';
import { ENGINE_NAMES as REPORT_ENGINE_NAMES, ENGINE_ORDER } from '../../shared/report-v2.js';
import { fixtureFetch, loadFixture, jsonResponse, DRY_RUN_ENV } from '../dry-run.js';

const business = { name: 'Fictional Wash', trade: 'laundromat', town: 'North Babylon', state: 'NY', zip: '11703' };
const question = { id: 'q1', intent: 'best', text: "What's the best laundromat in North Babylon, NY?" };
const env = { ...DRY_RUN_ENV };
const noRetry = { timeoutMs: 5000 };

function assertContract(r, engine) {
  for (const k of ['engine', 'ok', 'text', 'citations', 'request', 'raw', 'costUsd', 'error', 'askedAt', 'model']) assert.ok(k in r, `missing ${k}`);
  assert.equal(r.engine, engine);
  assert.ok(Array.isArray(r.citations));
  assert.ok(!Number.isNaN(Date.parse(r.askedAt)));
  assert.equal(typeof r.costUsd, 'number');
  // The key must never land in the stored request.
  assert.doesNotMatch(JSON.stringify(r.request), /dry-run/);
}

// ---------------------------------------------------------------- ChatGPT
test('chatgpt: parses Responses API output_text + url_citation annotations', async () => {
  const f = fixtureFetch();
  const r = await chatgpt.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'chatgpt');
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /^Here are a few well-reviewed laundromats/);
  assert.ok(r.text.includes('Clean Spin Laundry Center'));
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com', 'sudsandbubbleslaundry.example.com']);
  assert.equal(r.citations[1].url, 'https://www.yellowpages.com/north-babylon-ny/laundromats', 'utm_source=openai stripped');
  assert.equal(r.citations[0].title, 'THE BEST 10 Laundromats in NORTH BABYLON, NY - Yelp');
  // 11842 in × $0.25/M + 1316 out × $2/M + 1 search × $0.01
  assert.equal(r.costUsd, 0.015593);
  assert.equal(r.raw.id, loadFixture('openai.responses.json').id);

  const [call] = f.calls;
  assert.equal(call.url, 'https://api.openai.com/v1/responses');
  assert.equal(call.init.headers.Authorization, 'Bearer dry-run');
  const body = JSON.parse(call.init.body);
  assert.equal(body.tools[0].type, 'web_search');
  assert.deepEqual(body.tools[0].user_location, { type: 'approximate', country: 'US', city: 'North Babylon', region: 'New York' });
  assert.equal(body.input, question.text);
});

test('chatgpt: HTTP 401 → ok:false with the API message, never throws', async () => {
  const f = fixtureFetch(undefined, { openai: () => jsonResponse(loadFixture('openai.error_401.json'), 401) });
  const r = await chatgpt.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'chatgpt');
  assert.equal(r.ok, false);
  assert.match(r.error, /^HTTP 401: Incorrect API key/);
  assert.equal(r.text, null);
  assert.equal(r.raw.error.code, 'invalid_api_key');
  assert.equal(f.calls.length, 1, '401 is not retried');
});

test('chatgpt: missing key → ok:false, no network call', async () => {
  const f = fixtureFetch();
  const r = await chatgpt.ask({ question, business, env: {}, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test('chatgpt: network error and timeout → ok:false', async () => {
  const boom = fixtureFetch(undefined, { openai: () => { throw new TypeError('fetch failed'); } });
  const r1 = await chatgpt.ask({ question, business, env, fetchImpl: boom, timeoutMs: 1000 });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /network error: fetch failed/);

  const hang = fixtureFetch(undefined, {
    openai: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  const r2 = await chatgpt.ask({ question, business, env, fetchImpl: hang, timeoutMs: 50 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /timeout after 50ms/);
  assert.equal(hang.calls.length, 1, 'timeouts are not retried');
});

test('chatgpt: alternate env name OPENAI_KEY works', async () => {
  const r = await chatgpt.ask({ question, business, env: { OPENAI_KEY: 'dry-run' }, fetchImpl: fixtureFetch(), ...noRetry });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- Gemini
test('gemini: parses parts text + groundingChunks, resolves redirect URLs', async () => {
  const f = fixtureFetch();
  const r = await gemini.ask({ question, business, env, fetchImpl: f, resolveRedirects: true, ...noRetry });
  assertContract(r, 'gemini');
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /^If you're looking for a laundromat in North Babylon/);
  assert.deepEqual(r.citations.map((c) => c.url), [
    'https://www.yelp.com/search?cflt=laundromat&find_loc=North+Babylon%2C+NY',
    'https://www.yellowpages.com/north-babylon-ny/laundromats',
    'https://sudsandbubbleslaundry.example.com/',
  ]);
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com', 'sudsandbubbleslaundry.example.com']);
  assert.match(r.citations[0].redirectUrl, /^https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//);
  // (12 + 212) in × $0.75/M + (118 + 1060) out × $3.75/M + 1 query × $0.014
  assert.equal(r.costUsd, 0.018586);
  const call = f.calls[0];
  assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(call.init.headers['x-goog-api-key'], 'dry-run');
  assert.deepEqual(JSON.parse(call.init.body).tools, [{ google_search: {} }]);
  assert.ok(f.calls.slice(1).every((c) => c.init.redirect === 'manual'));
});

test('gemini: without redirect resolution, domain comes from chunk title/domain', async () => {
  const f = fixtureFetch();
  const r = await gemini.ask({ question, business, env, fetchImpl: f, resolveRedirects: false, ...noRetry });
  assert.equal(r.ok, true);
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com', 'sudsandbubbleslaundry.example.com']);
  assert.equal(f.calls.length, 1);
});

test('gemini: blocked prompt → ok:false', async () => {
  const f = fixtureFetch(undefined, { gemini: () => jsonResponse(loadFixture('gemini.blocked.json')) });
  const r = await gemini.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.match(r.error, /blocked: OTHER/);
});

test('gemini: 503 is retried once, then reported', async () => {
  const f = fixtureFetch(undefined, { gemini: () => jsonResponse({ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }, 503) });
  const r = await gemini.ask({ question, business, env: { ...env }, fetchImpl: f, timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 503: The model is overloaded/);
  assert.equal(f.calls.length, 2);
});

// ---------------------------------------------------------------- Perplexity
test('perplexity: parses Agent API message + search_results, [n] markers pick citations', async () => {
  const f = fixtureFetch();
  const r = await perplexity.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'perplexity');
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /Suds & Bubbles Laundromat/);
  // Result 3 (angi) was returned but never cited.
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com']);
  assert.equal(r.citations[0].ref, 1);
  assert.equal(r.costUsd, 0.001503, 'uses usage.cost.total_cost');
  assert.equal(r.model, 'fast');
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.perplexity.ai/v1/agent');
  const body = JSON.parse(call.init.body);
  assert.equal(body.preset, 'fast');
  assert.equal(body.input, question.text);
  assert.deepEqual(body.tools, [{ type: 'web_search', user_location: { country: 'US', city: 'North Babylon', region: 'New York' } }]);
});

test('perplexity: status "failed" on HTTP 200 → ok:false', async () => {
  const f = fixtureFetch(undefined, { perplexity: () => jsonResponse(loadFixture('perplexity.failed.json')) });
  const r = await perplexity.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.match(r.error, /run failed: Upstream model temporarily unavailable/);
});

test('perplexity: legacy Sonar shape still parses (citations[] + search_results)', () => {
  const p = perplexity.parseResponse(loadFixture('perplexity.sonar.json'));
  assert.match(p.text, /^Suds & Bubbles Laundromat and Clean Spin/);
  assert.deepEqual(p.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com']);
  assert.equal(p.citations[1].title, 'Laundromats in North Babylon, NY - YellowPages');
  assert.equal(p.reportedCost, 0.005);
});

test('perplexity: answer without [n] markers falls back to all search results, flagged uncited', () => {
  const fx = structuredClone(loadFixture('perplexity.agent.json'));
  fx.output[1].content[0].text = 'Suds & Bubbles Laundromat is a popular choice.';
  const p = perplexity.parseResponse(fx);
  assert.equal(p.citations.length, 3);
  assert.ok(p.citations.every((c) => c.uncited === true));
});

test('perplexity: a model id with "/" is sent as model, not preset', () => {
  const b = perplexity.buildRequest({ question, business, model: 'openai/gpt-5-mini' });
  assert.equal(b.model, 'openai/gpt-5-mini');
  assert.equal(b.preset, undefined);
});

// ---------------------------------------------------------------- Google AI Mode (DataForSEO)
test('google_ai_mode: parses ai_overview markdown + references', async () => {
  const f = fixtureFetch();
  const r = await aiMode.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'google_ai_mode');
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /^Top-rated laundromats in North Babylon, NY include \*\*Suds & Bubbles Laundromat\*\*/);
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'yellowpages.com', 'sudsandbubbleslaundry.example.com']);
  assert.equal(r.citations[0].source, 'Yelp');
  assert.equal(r.costUsd, 0.004);
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced');
  assert.equal(call.init.headers.Authorization, `Basic ${btoa('dry-run:dry-run')}`);
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, [{ keyword: question.text, location_name: 'North Babylon,New York,United States', language_code: 'en', device: 'mobile' }]);
});

test('google_ai_mode: unknown town location → retries once at state level and records it', async () => {
  let n = 0;
  const f = fixtureFetch(undefined, {
    dataforseo: () => jsonResponse(n++ === 0 ? loadFixture('dataforseo.location_error.json') : loadFixture('dataforseo.ai_mode.json')),
  });
  const r = await aiMode.ask({ question, business: { ...business, town: 'Nowhere Hamlet' }, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, true, r.error);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.parse(f.calls[1].init.body)[0].location_name, 'New York,United States');
  assert.deepEqual(r.request.locationFallback.to, 'New York,United States');
  assert.equal(r.request.body[0].location_name, 'New York,United States');
});

test('google_ai_mode: task-level error → ok:false', async () => {
  const fx = structuredClone(loadFixture('dataforseo.ai_mode.json'));
  fx.tasks[0].status_code = 40602;
  fx.tasks[0].status_message = 'Task Handed.';
  fx.tasks[0].result = null;
  const f = fixtureFetch(undefined, { dataforseo: () => jsonResponse(fx) });
  const r = await aiMode.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.match(r.error, /DataForSEO task 40602: Task Handed/);
});

test('google_ai_mode: no ai_overview item → ok:false', async () => {
  const fx = structuredClone(loadFixture('dataforseo.ai_mode.json'));
  fx.tasks[0].result[0].items = [];
  fx.tasks[0].result[0].item_types = [];
  const f = fixtureFetch(undefined, { dataforseo: () => jsonResponse(fx) });
  const r = await aiMode.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.match(r.error, /no AI Mode answer/);
});

// ---------------------------------------------------------------- Claude
const claudeBody = (call) => JSON.parse(call.init.body);
const sequence = (...bodies) => { let i = 0; return () => jsonResponse(bodies[Math.min(i++, bodies.length - 1)]); };

test('claude: Messages API + web_search, text after the search, citations from web_search_result_location', async () => {
  const f = fixtureFetch();
  const r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'claude');
  assert.equal(r.ok, true, r.error);
  // The "I'll search…" preamble before the tool call is not part of the answer.
  assert.match(r.text, /^Here are some well-reviewed laundromats in North Babylon, NY:\n\n1\. \*\*Suds & Bubbles Laundromat\*\* – a clean, bright store/);
  assert.ok(r.text.includes("It's open daily from 6 AM to 11 PM.\n2. **Clean Spin Laundry Center** – open late"), 'citation-split blocks joined with no separator');
  assert.ok(!r.text.includes("I'll search"));
  // Cited: yelp, the store's own site, yellowpages (yelp cited twice → once). Angi was returned but never cited.
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'sudsandbubbleslaundry.example.com', 'yellowpages.com']);
  assert.equal(r.citations[0].title, 'THE BEST 10 Laundromats in NORTH BABYLON, NY - Yelp');
  assert.ok(r.citations.every((c) => !c.uncited));
  // 14872 in × $2/M + 1043 out × $10/M + 1 search × $0.01
  assert.equal(r.costUsd, 0.050174);
  assert.equal(r.model, 'claude-sonnet-5');
  assert.equal(r.raw.id, loadFixture('claude.messages.json').id);

  assert.equal(f.calls.length, 1);
  const [call] = f.calls;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(new Headers(call.init.headers).get('x-api-key'), 'dry-run');
  const body = claudeBody(call);
  assert.equal(body.model, 'claude-sonnet-5');
  assert.deepEqual(body.messages, [{ role: 'user', content: question.text }], 'the question exactly as a customer types it');
  assert.equal(body.system, undefined, 'no system prompt');
  assert.deepEqual(body.tools, [{
    type: 'web_search_20260209', name: 'web_search', max_uses: 5,
    user_location: { type: 'approximate', country: 'US', city: 'North Babylon', region: 'New York' },
  }]);
  assert.deepEqual(r.request.body, body);
});

test('claude: CLAUDE_MODEL overrides the model; CLAUDE_API_KEY is accepted', async () => {
  const f = fixtureFetch();
  const r = await claude.ask({ question, business, env: { CLAUDE_API_KEY: 'dry-run', CLAUDE_MODEL: 'claude-opus-5' }, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, true, r.error);
  assert.equal(claudeBody(f.calls[0]).model, 'claude-opus-5');
  assert.equal(resolveKeys({}).claudeModel, 'claude-sonnet-5');
});

test('claude: pause_turn → resends user + paused assistant content, then joins the turn', async () => {
  const paused = loadFixture('claude.pause_turn.json');
  const f = fixtureFetch(undefined, { anthropic: sequence(paused, loadFixture('claude.continued.json')) });
  const r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, true, r.error);
  assert.equal(f.calls.length, 2);
  const second = claudeBody(f.calls[1]);
  assert.equal(second.messages.length, 2);
  assert.deepEqual(second.messages[0], { role: 'user', content: question.text });
  assert.deepEqual(second.messages[1], { role: 'assistant', content: paused.content }, 'paused content sent back unchanged');
  assert.deepEqual(second.tools, claudeBody(f.calls[0]).tools);
  assert.equal(r.text, claude.parseResponse(loadFixture('claude.messages.json')).text);
  assert.deepEqual(r.citations.map((c) => c.domain), ['yelp.com', 'sudsandbubbleslaundry.example.com', 'yellowpages.com']);
  // Both calls are billed: (9120 + 10480) in × $2/M + (212 + 831) out × $10/M + 1 search × $0.01
  assert.equal(r.costUsd, 0.05963);
  assert.equal(r.request.continuations, 1);
  assert.equal(r.raw.responses.length, 2);
});

test('claude: pause_turn forever → stops after MAX_CONTINUATIONS, ok:false', async () => {
  const paused = loadFixture('claude.pause_turn.json');
  const f = fixtureFetch(undefined, { anthropic: () => jsonResponse(paused) });
  const r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.match(r.error, /^pause_turn: not finished after 3 continuations/);
  assert.equal(f.calls.length, 1 + claude.MAX_CONTINUATIONS);
  // Paused content accumulates across continuations.
  assert.equal(claudeBody(f.calls[3]).messages[1].content.length, 3 * paused.content.length);
  assert.ok(r.costUsd > 0);
});

test('claude: refusal → ok:false with the category, billed tokens kept', async () => {
  const fx = structuredClone(loadFixture('claude.refusal.json'));
  let f = fixtureFetch(undefined, { anthropic: () => jsonResponse(fx) });
  let r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'claude');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'refusal');
  assert.equal(r.text, null);
  assert.equal(r.costUsd, 0.001224);
  fx.stop_details.category = 'cyber';
  f = fixtureFetch(undefined, { anthropic: () => jsonResponse(fx) });
  r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.error, 'refusal (cyber)');
});

test('claude: web search error on HTTP 200 with no answer text → ok:false', async () => {
  const f = fixtureFetch(undefined, { anthropic: () => jsonResponse(loadFixture('claude.search_error.json')) });
  const r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'web_search error: too_many_requests');
  assert.deepEqual(r.citations, []);
});

test('claude: web search error but Claude still answered → answer kept', () => {
  const fx = structuredClone(loadFixture('claude.search_error.json'));
  fx.content.push({ type: 'text', text: 'Suds & Bubbles Laundromat on Deer Park Ave is a popular choice.' });
  const p = claude.parseResponse(fx);
  assert.equal(p.text, 'Suds & Bubbles Laundromat on Deer Park Ave is a popular choice.');
  assert.deepEqual(p.searchErrors, ['too_many_requests']);
});

test('claude: answer with no citations falls back to returned search results, flagged uncited', () => {
  const fx = structuredClone(loadFixture('claude.messages.json'));
  for (const b of fx.content) delete b.citations;
  const p = claude.parseResponse(fx);
  assert.equal(p.citations.length, 4);
  assert.ok(p.citations.every((c) => c.uncited === true));
  assert.equal(p.citations[3].domain, 'angi.com');
});

test('claude: HTTP 401 → ok:false with the API message, not retried, never throws', async () => {
  const f = fixtureFetch(undefined, { anthropic: () => jsonResponse(loadFixture('anthropic.error_401.json'), 401) });
  const r = await claude.ask({ question, business, env, fetchImpl: f, ...noRetry });
  assertContract(r, 'claude');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'HTTP 401: invalid x-api-key');
  assert.equal(r.raw.error.type, 'authentication_error');
  assert.equal(f.calls.length, 1);
});

test('claude: 429 retried once; network error and timeout → ok:false', async () => {
  const over = fixtureFetch(undefined, { anthropic: () => jsonResponse({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }, 429) });
  const r1 = await claude.ask({ question, business, env, fetchImpl: over, retryDelayMs: 0, ...noRetry });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /^HTTP 429: Number of request tokens/);
  assert.equal(over.calls.length, 2);

  const boom = fixtureFetch(undefined, { anthropic: () => { throw new TypeError('fetch failed'); } });
  const r2 = await claude.ask({ question, business, env, fetchImpl: boom, retryDelayMs: 0, timeoutMs: 1000 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /^network error/);

  const hang = fixtureFetch(undefined, {
    anthropic: (u, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  const r3 = await claude.ask({ question, business, env, fetchImpl: hang, timeoutMs: 50 });
  assert.equal(r3.ok, false);
  assert.match(r3.error, /timeout after 50ms/);
  assert.equal(hang.calls.length, 1, 'timeouts are not retried');
});

test('claude: missing key → ok:false, no network call', async () => {
  const f = fixtureFetch();
  const r = await claude.ask({ question, business, env: { OPENAI_API_KEY: 'x' }, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.match(r.error, /ANTHROPIC_API_KEY/);
  assert.equal(f.calls.length, 0);
});

test('registry: every engine is registered, named and ordered in one place each', () => {
  assert.deepEqual(Object.keys(ENGINES).sort(), [...ENGINE_IDS].sort());
  for (const e of ENGINE_IDS) {
    assert.equal(ENGINES[e].id, e);
    assert.equal(REPORT_ENGINE_NAMES[e], ENGINE_NAMES[e]);
    assert.ok(ENGINE_ORDER.includes(e), e);
    assert.ok(e in enginesConfigured({}), e);
  }
  assert.deepEqual(ENGINE_ORDER, ['chatgpt', 'google_ai_mode', 'perplexity', 'gemini', 'claude']);
  assert.equal(enginesConfigured({ ANTHROPIC_API_KEY: 'k' }).claude, true);
});

// ---------------------------------------------------------------- ping
test('ping: every engine answers from fixtures', async () => {
  const f = fixtureFetch();
  for (const eng of Object.values(ENGINES)) {
    const p = await eng.ping(env, { fetchImpl: f });
    assert.equal(p.ok, true, `${eng.id}: ${p.error}`);
    assert.equal(p.engine, eng.id);
    assert.equal(typeof p.ms, 'number');
  }
  const ai = await aiMode.ping(env, { fetchImpl: f });
  assert.equal(ai.detail.balanceUsd, 49.12);
  const pp = JSON.parse(f.calls.find((c) => c.url.includes('perplexity')).init.body);
  assert.equal(pp.max_tool_calls, 0);
  const cl = await claude.ping(env, { fetchImpl: f });
  assert.deepEqual(cl.detail, { model: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' });
  assert.ok(f.calls.some((c) => c.url === 'https://api.anthropic.com/v1/models/claude-sonnet-5' && (c.init.method || 'GET') === 'GET'));
});

test('ping: missing keys → ok:false without network', async () => {
  const f = fixtureFetch();
  for (const eng of Object.values(ENGINES)) {
    const p = await eng.ping({}, { fetchImpl: f });
    assert.equal(p.ok, false);
    assert.match(p.error, /missing/);
  }
  assert.equal(f.calls.length, 0);
});
