import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyTurnstile, turnstileConfigured, turnstileSiteKey, warnUnconfiguredOnce, _resetWarning,
  SITEVERIFY_URL, SITE_KEY_PLACEHOLDER, REQUEST_ACTION,
} from '../turnstile.js';
import { handleReportRequest, BOT_CHECK_FAILED, BOT_CHECK_UNAVAILABLE } from '../report-request.js';
import { rateLimit, RATE_LIMITED_MESSAGE } from '../rate-limit.js';

// Cloudflare's documented test keys (developers.cloudflare.com/turnstile/troubleshooting/testing/).
const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET_PASS = '1x0000000000000000000000000000000AA';
const TEST_SECRET_FAIL = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
// A "real" (non-test) secret so hostname/action are enforced. Never sent anywhere: fetch is injected.
const REAL_SECRET = '0x4AAAAAAA-not-a-real-secret-for-tests';

const HOST = 'aifoundscore.com';

/** Fake siteverify: records calls, answers with `reply(callIndex, params)`. */
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, params, init });
    return reply(calls.length - 1, params, init);
  };
  fn.calls = calls;
  return fn;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const good = (over = {}) => json({ success: true, 'error-codes': [], hostname: HOST, action: REQUEST_ACTION, ...over });

const base = { secret: REAL_SECRET, token: 'tok', expectedAction: REQUEST_ACTION, expectedHostnames: [HOST] };

// ---------------------------------------------------------------------------
// verifyTurnstile
// ---------------------------------------------------------------------------
test('siteverify: success with matching hostname and action', async () => {
  const f = fakeFetch(() => good());
  const r = await verifyTurnstile({ ...base, remoteip: '203.0.113.9', fetchImpl: f, idempotencyKey: 'k-1' });
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, SITEVERIFY_URL);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(f.calls[0].params, { secret: REAL_SECRET, response: 'tok', idempotency_key: 'k-1', remoteip: '203.0.113.9' });
  assert.ok(f.calls[0].init.signal, 'request has a timeout signal');
});

test('siteverify: success:false is rejected', async () => {
  const f = fakeFetch(() => json({ success: false, 'error-codes': ['invalid-input-response'] }));
  const r = await verifyTurnstile({ ...base, fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'rejected');
  assert.deepEqual(r.codes, ['invalid-input-response']);
});

test('siteverify: hostname mismatch is rejected', async () => {
  const f = fakeFetch(() => good({ hostname: 'localhost' }));
  const r = await verifyTurnstile({ ...base, fetchImpl: f });
  assert.deepEqual(r, { ok: false, reason: 'hostname-mismatch' });
});

test('siteverify: action mismatch is rejected', async () => {
  const f = fakeFetch(() => good({ action: 'login' }));
  const r = await verifyTurnstile({ ...base, fetchImpl: f });
  assert.deepEqual(r, { ok: false, reason: 'action-mismatch' });
});

test('siteverify: missing / oversized token never calls Cloudflare', async () => {
  const f = fakeFetch(() => good());
  assert.equal((await verifyTurnstile({ ...base, token: '', fetchImpl: f })).reason, 'missing-token');
  assert.equal((await verifyTurnstile({ ...base, token: 'x'.repeat(2049), fetchImpl: f })).reason, 'missing-token');
  assert.equal((await verifyTurnstile({ ...base, token: undefined, fetchImpl: f })).reason, 'missing-token');
  assert.equal(f.calls.length, 0);
});

test('siteverify: timeout fails closed after one retry with the same idempotency key', async () => {
  // Never answers; only the abort signal ends it.
  const f = fakeFetch((i, p, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  const started = Date.now();
  const r = await verifyTurnstile({ ...base, fetchImpl: f, timeoutMs: 30 });
  assert.deepEqual(r, { ok: false, reason: 'unavailable' });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0].params.idempotency_key);
  assert.equal(f.calls[0].params.idempotency_key, f.calls[1].params.idempotency_key);
  assert.ok(Date.now() - started < 2000);
});

test('siteverify: a 5xx then success verifies on the retry', async () => {
  const f = fakeFetch((i) => (i === 0 ? new Response('oops', { status: 502 }) : good()));
  assert.deepEqual(await verifyTurnstile({ ...base, fetchImpl: f }), { ok: true });
  assert.equal(f.calls.length, 2);
});

test('siteverify: network error twice fails closed as unavailable', async () => {
  const f = fakeFetch(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await verifyTurnstile({ ...base, fetchImpl: f }), { ok: false, reason: 'unavailable' });
});

test('siteverify: internal-error from Cloudflare counts as unavailable, not a bot', async () => {
  const f = fakeFetch(() => json({ success: false, 'error-codes': ['internal-error'] }));
  assert.equal((await verifyTurnstile({ ...base, fetchImpl: f })).reason, 'unavailable');
});

test('siteverify: Cloudflare test secrets skip the hostname/action echo (dummy tokens carry none)', async () => {
  const f = fakeFetch(() => json({ success: true, hostname: 'example.com', action: '' }));
  assert.deepEqual(await verifyTurnstile({ ...base, secret: TEST_SECRET_PASS, token: DUMMY_TOKEN, fetchImpl: f }), { ok: true });
  // ...but a failing test secret still fails.
  const g = fakeFetch(() => json({ success: false, 'error-codes': ['invalid-input-response'] }));
  assert.equal((await verifyTurnstile({ ...base, secret: TEST_SECRET_FAIL, token: DUMMY_TOKEN, fetchImpl: g })).ok, false);
});

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
test('config: configured only with a real site key AND a secret', () => {
  assert.equal(turnstileConfigured({}), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SITE_KEY: TEST_SITE_KEY }), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SITE_KEY: SITE_KEY_PLACEHOLDER, TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SITE_KEY: ' ', TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }), false);
  assert.equal(turnstileConfigured({ TURNSTILE_SITE_KEY: TEST_SITE_KEY, TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }), true);
  assert.equal(turnstileSiteKey({ TURNSTILE_SITE_KEY: TEST_SITE_KEY }), '');
  assert.equal(turnstileSiteKey({ TURNSTILE_SITE_KEY: ` ${TEST_SITE_KEY} `, TURNSTILE_SECRET_KEY: 's' }), TEST_SITE_KEY);
});

test('config: the unconfigured warning is logged once', () => {
  _resetWarning();
  const lines = [];
  warnUnconfiguredOnce((m) => lines.push(m));
  warnUnconfiguredOnce((m) => lines.push(m));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /TURNSTILE_SECRET_KEY/);
});

// ---------------------------------------------------------------------------
// POST /api/request
// ---------------------------------------------------------------------------
const CONFIGURED = { TURNSTILE_SITE_KEY: '0x4AAAAAAFCuveyMfQ21Ntcr', TURNSTILE_SECRET_KEY: REAL_SECRET };
const URL_ = new URL(`https://${HOST}/api/request`);
// Fictional business.
const FORM = { business_name: 'Test Otter Plumbing', trade: 'plumbing', town: 'Massapequa', zip: '11758', state: 'NY' };
const RID = '3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b';

function post(body) {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify(body),
  });
}
function deps({ attachResult = false, attachThrows = false, verify = () => good() } = {}) {
  const rows = [];
  const attaches = [];
  const fetchImpl = fakeFetch(verify);
  return {
    rows, attaches, fetchImpl,
    recordReportRequest: async (env, r) => { rows.push(r); return { row: r }; },
    attachReportRequestEmail: async (env, a) => { attaches.push(a); if (attachThrows) throw new Error('rpc down'); return attachResult; },
    turnstileTimeoutMs: 30,
  };
}
const quiet = async (fn) => {
  const { warn, error } = console;
  console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.warn = warn; console.error = error; }
};

test('request: verified first submit saves a row; siteverify checks this host', async () => {
  const d = deps();
  const res = await handleReportRequest(post({ ...FORM, 'cf-turnstile-response': 'tok' }), URL_, CONFIGURED, d);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(d.rows.length, 1);
  assert.equal(body.id, d.rows[0].id);
  assert.equal(d.fetchImpl.calls[0].params.response, 'tok');
  assert.equal(d.fetchImpl.calls[0].params.remoteip, '203.0.113.9');
});

test('request: no token -> 403, nothing saved, Cloudflare not called', async () => {
  const d = deps();
  const res = await quiet(() => handleReportRequest(post(FORM), URL_, CONFIGURED, d));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { ok: false, error: BOT_CHECK_FAILED });
  assert.equal(d.rows.length, 0);
  assert.equal(d.fetchImpl.calls.length, 0);
});

test('request: token solved on another hostname -> 403, nothing saved', async () => {
  const d = deps({ verify: () => good({ hostname: 'localhost' }) });
  const res = await quiet(() => handleReportRequest(post({ ...FORM, 'cf-turnstile-response': 'tok' }), URL_, CONFIGURED, d));
  assert.equal(res.status, 403);
  assert.equal(d.rows.length, 0);
});

test('request: siteverify timeout -> 503 with a friendly message, nothing saved', async () => {
  const d = deps({ verify: (i, p, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
  const res = await quiet(() => handleReportRequest(post({ ...FORM, 'cf-turnstile-response': 'tok' }), URL_, CONFIGURED, d));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: BOT_CHECK_UNAVAILABLE });
  assert.equal(d.rows.length, 0);
});

test('request: no-JS form post without a token redirects to the error notice', async () => {
  const d = deps();
  const form = new URLSearchParams(FORM);
  const req = new Request(URL_, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
  const res = await quiet(() => handleReportRequest(req, URL_, CONFIGURED, d));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Location'), /request=error/);
  assert.equal(d.rows.length, 0);
});

test('request: unconfigured -> saves without a token (and without calling Cloudflare)', async () => {
  _resetWarning();
  const d = deps();
  for (const env of [{}, { TURNSTILE_SITE_KEY: '0x4AAAAAAFCuveyMfQ21Ntcr' }, { TURNSTILE_SITE_KEY: SITE_KEY_PLACEHOLDER, TURNSTILE_SECRET_KEY: 's' }]) {
    const res = await quiet(() => handleReportRequest(post(FORM), URL_, env, d));
    assert.equal(res.status, 200);
  }
  assert.equal(d.rows.length, 3);
  assert.equal(d.fetchImpl.calls.length, 0);
});

test('request: email attach to a verified request needs no token', async () => {
  const d = deps({ attachResult: true });
  const res = await handleReportRequest(post({ request_id: RID, email: 'owner@example.com' }), URL_, CONFIGURED, d);
  assert.deepEqual(await res.json(), { ok: true, id: RID });
  assert.equal(d.attaches.length, 1);
  assert.equal(d.rows.length, 0);
  assert.equal(d.fetchImpl.calls.length, 0);
});

test('request: attach fallback cannot create an unverified row', async () => {
  for (const opt of [{ attachResult: false }, { attachThrows: true }]) {
    const d = deps(opt);
    const res = await quiet(() => handleReportRequest(post({ ...FORM, request_id: RID, email: 'owner@example.com' }), URL_, CONFIGURED, d));
    assert.equal(res.status, 403, JSON.stringify(opt));
    assert.equal(d.rows.length, 0);
    assert.equal(d.attaches.length, 1);
  }
});

test('request: attach fallback with a failing token cannot create a row either', async () => {
  const d = deps({ verify: () => json({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
  const res = await quiet(() => handleReportRequest(post({ ...FORM, request_id: RID, email: 'owner@example.com', 'cf-turnstile-response': 'spent' }), URL_, CONFIGURED, d));
  assert.equal(res.status, 403);
  assert.equal(d.rows.length, 0);
});

test('request: attach fallback with a valid token saves the row with the email', async () => {
  const d = deps();
  const res = await handleReportRequest(post({ ...FORM, request_id: RID, email: 'Owner@Example.com', 'cf-turnstile-response': 'tok' }), URL_, CONFIGURED, d);
  assert.equal(res.status, 200);
  assert.equal(d.rows.length, 1);
  assert.equal(d.rows[0].email, 'owner@example.com');
  assert.notEqual(d.rows[0].id, RID);
});

test('request: honeypot still short-circuits before any check or write', async () => {
  const d = deps();
  const res = await handleReportRequest(post({ ...FORM, company_url: 'x' }), URL_, CONFIGURED, d);
  assert.deepEqual(await res.json(), { ok: true, id: null });
  assert.equal(d.rows.length + d.fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------------------
// rate limit
// ---------------------------------------------------------------------------
test('ratelimit: over the limit -> 429 JSON with a friendly message, keyed per bucket and IP', async () => {
  const seen = [];
  const env = { REQUEST_LIMITER: { limit: async ({ key }) => { seen.push(key); return { success: false }; } } };
  const res = await rateLimit(env, post(FORM), 'request');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
  assert.deepEqual(await res.json(), { ok: false, error: RATE_LIMITED_MESSAGE });
  assert.deepEqual(seen, ['request:203.0.113.9']);
});

test('ratelimit: under the limit, no binding, or a limiter error -> let through', async () => {
  assert.equal(await rateLimit({ REQUEST_LIMITER: { limit: async () => ({ success: true }) } }, post(FORM), 'questions'), null);
  assert.equal(await rateLimit({}, post(FORM), 'questions'), null);
  const broken = { REQUEST_LIMITER: { limit: async () => { throw new Error('down'); } } };
  assert.equal(await quiet(() => rateLimit(broken, post(FORM), 'questions')), null);
});
