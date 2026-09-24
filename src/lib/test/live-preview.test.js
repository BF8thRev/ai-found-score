import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleLivePreview, livePreviewStatus, signPreviewToken, verifyPreviewToken, nameRanges, citedDomains,
  capCheck, dailyCapUsd, pickEngine, ipCode, startOfUtcDay, MSG, PER_IP_DAILY, TOKEN_TTL_S,
} from '../live-preview.js';
import { handleReportRequest } from '../report-request.js';
import { fixtureFetch, jsonResponse } from '../../../scanner/dry-run.js';

const TEST_SITE_KEY = '1x00000000000000000000AA';
const TEST_SECRET_PASS = '1x0000000000000000000000000000000AA';
const REQ_ID = '0b5f2a9c-1d2e-4f3a-8b4c-5d6e7f8a9b0c';
const IP = '203.0.113.7';

// Keys are placeholders; every fetch is injected, nothing leaves the process.
const ENV = {
  TURNSTILE_SITE_KEY: TEST_SITE_KEY,
  TURNSTILE_SECRET_KEY: TEST_SECRET_PASS,
  GEMINI_API_KEY: 'test-gemini',
  OPENAI_API_KEY: 'test-openai',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'test-service',
};

const BIZ = { id: REQ_ID, businessName: 'Suds & Bubbles Laundromat', trade: 'laundromat', town: 'North Babylon', zip: '11703', state: 'NY' };

async function call(env, body, deps = {}) {
  const saved = [];
  const req = new Request('https://aifoundscore.com/api/live-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP },
    body: JSON.stringify(body),
  });
  const res = await handleLivePreview(req, env, {
    fetchImpl: fixtureFetch(),
    readUsage: async () => [],
    saveUsage: async (e, rows) => { saved.push(...rows); return { ok: true }; },
    // The reservation row is updated in place once the engine answers: mirror that here.
    patchUsage: async (e, id, fields) => {
      const row = saved.find((r) => r.id === id);
      if (row) Object.assign(row, fields);
      return { ok: true };
    },
    limiter: { limit: async () => ({ success: true }) },
    ...deps,
  });
  return { status: res.status, body: await res.json(), saved };
}

const good = async (env = ENV, extra = {}) => ({ request_id: REQ_ID, question_id: 'q1', token: await signPreviewToken(env, BIZ), ...extra });

// ---- pure helpers -----------------------------------------------------------

test('nameRanges: literal, case-insensitive, regex characters are literal', () => {
  const text = 'Try A&B Plumbing first. a&b plumbing is fast. AxB Plumbing is not it.';
  assert.deepEqual(nameRanges(text, 'A&B Plumbing'), [[4, 16], [24, 36]]);
  assert.deepEqual(nameRanges('Call (516) Pros+ today', '(516) Pros+'), [[5, 16]]);
  assert.deepEqual(nameRanges('Joe.s Diner and Joes Diner', 'Joe.s Diner'), [[0, 11]], 'dot is not a wildcard');
  assert.deepEqual(nameRanges('Nothing here', 'A&B Plumbing'), []);
  assert.deepEqual(nameRanges('a b c', ' '), [], 'blank name never matches');
  assert.deepEqual(nameRanges('Ünïcode Café is open', 'ÜNÏCODE CAFÉ'), [[0, 12]]);
  // Slicing the original text with the ranges gives back the original casing.
  const t = 'We like SUDS & BUBBLES LAUNDROMAT.';
  const [[s, e]] = nameRanges(t, 'Suds & Bubbles Laundromat');
  assert.equal(t.slice(s, e), 'SUDS & BUBBLES LAUNDROMAT');
});

test('citedDomains: unique, lower-case, no www', () => {
  assert.deepEqual(citedDomains([{ domain: 'Yelp.com' }, { domain: 'www.yelp.com' }, { domain: '' }, { domain: 'bbb.org' }]), ['yelp.com', 'bbb.org']);
});

test('pickEngine: cheapest with a key first', () => {
  assert.equal(pickEngine(ENV), 'gemini');
  assert.equal(pickEngine({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k' }), 'chatgpt');
  assert.equal(pickEngine({ ANTHROPIC_API_KEY: 'k' }), 'claude');
  assert.equal(pickEngine({}), null);
});

test('dailyCapUsd: default 1.00, env override, junk ignored', () => {
  assert.equal(dailyCapUsd({}), 1);
  assert.equal(dailyCapUsd({ LIVE_PREVIEW_DAILY_USD: '2.5' }), 2.5);
  assert.equal(dailyCapUsd({ LIVE_PREVIEW_DAILY_USD: 'lots' }), 1);
  assert.equal(dailyCapUsd({ LIVE_PREVIEW_DAILY_USD: '0' }), 0);
});

test('startOfUtcDay', () => {
  assert.equal(startOfUtcDay(Date.parse('2026-09-24T23:59:00Z')), '2026-09-24T00:00:00.000Z');
});

test('status: off without Turnstile, engine key or service key; dry run needs no keys', () => {
  assert.deepEqual(livePreviewStatus(ENV), { enabled: true, reason: null });
  const { TURNSTILE_SECRET_KEY, ...noTs } = ENV;
  assert.equal(livePreviewStatus(noTs).reason, 'turnstile');
  assert.equal(livePreviewStatus({ ...ENV, GEMINI_API_KEY: '', OPENAI_API_KEY: '' }).reason, 'no-engine');
  assert.equal(livePreviewStatus({ ...ENV, SUPABASE_SERVICE_KEY: '' }).reason, 'no-store');
  assert.equal(livePreviewStatus({ ...ENV, LIVE_PREVIEW_DAILY_USD: '0' }).reason, 'cap-zero');
  assert.equal(livePreviewStatus({ TURNSTILE_SITE_KEY: TEST_SITE_KEY, TURNSTILE_SECRET_KEY: TEST_SECRET_PASS }, { dryRun: true }).enabled, true);
});

test('token: round trip, tamper, expiry, other key', async () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  const t = await signPreviewToken(ENV, BIZ, { now });
  assert.deepEqual(await verifyPreviewToken(ENV, t, { now }), {
    id: REQ_ID, name: 'Suds & Bubbles Laundromat', trade: 'laundromat', town: 'North Babylon', zip: '11703', state: 'NY',
  });
  const [p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, id: REQ_ID, n: 'X', t: 'plumbing', c: 'Y', z: '', s: 'NY', exp: 9e9 })).toString('base64url');
  assert.equal(await verifyPreviewToken(ENV, `${forged}.${s}`, { now }), null, 'payload swapped');
  assert.equal(await verifyPreviewToken(ENV, `${p}.${s.slice(0, -2)}AA`, { now }), null, 'signature changed');
  assert.equal(await verifyPreviewToken(ENV, t, { now: now + (TOKEN_TTL_S + 1) * 1000 }), null, 'expired');
  assert.equal(await verifyPreviewToken({ ...ENV, PREVIEW_SIGNING_KEY: 'another' }, t, { now }), null, 'other key');
  assert.equal(await verifyPreviewToken(ENV, 'junk', { now }), null);
  assert.equal(await signPreviewToken({}, BIZ), null, 'no key, no token');
});

test('capCheck: global spend, per IP, per request', () => {
  const ip = 'abc123abc123';
  const row = (cost, rid = 'other', code = 'zzz', ok = true) => ({ cost_usd: cost, answer_ref: `live-preview:${rid}:q1:${code}`, ok });
  assert.equal(capCheck([], { capUsd: 1, requestId: REQ_ID, ip, estimateUsd: 0.02 }), null);
  assert.equal(capCheck([row(0.99)], { capUsd: 1, requestId: REQ_ID, ip, estimateUsd: 0.02 }).reason, 'cap');
  assert.equal(capCheck(Array.from({ length: PER_IP_DAILY }, () => row(0.01, 'r', ip, false)), { capUsd: 1, requestId: REQ_ID, ip }).reason, 'ip');
  assert.equal(capCheck([row(0.01, REQ_ID)], { capUsd: 1, requestId: REQ_ID, ip }).reason, 'request');
  assert.equal(capCheck([row(0.01, REQ_ID, 'zzz', false)], { capUsd: 1, requestId: REQ_ID, ip }), null, 'a failed try does not use up the request');
});

// ---- handler ----------------------------------------------------------------

test('preview: asks the cheapest engine once, returns verbatim text, highlights the name, records cost', async () => {
  const fetchImpl = fixtureFetch();
  const r = await call(ENV, await good(), { fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.assistant, 'Gemini');
  assert.match(r.body.question, /laundromat/i);
  assert.match(r.body.answer, /\*\*Suds & Bubbles Laundromat\*\*/, 'verbatim, markdown kept');
  assert.equal(r.body.named, true);
  const [[s, e]] = r.body.ranges;
  assert.equal(r.body.answer.slice(s, e), 'Suds & Bubbles Laundromat');
  assert.ok(r.body.citations.includes('yelp.com'));
  // One engine call, no citation-redirect fetches, no extractor call.
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /generativelanguage/);
  assert.equal(r.saved.length, 1);
  const row = r.saved[0];
  assert.equal(row.kind, 'other');
  assert.equal(row.provider, 'gemini');
  assert.ok(row.cost_usd > 0);
  assert.ok(row.answer_ref.startsWith(`live-preview:${REQ_ID}:q1:`));
  assert.equal(row.answer_ref.split(':')[3], await ipCode(ENV, IP));
  assert.ok(!row.answer_ref.includes(IP), 'no raw IP stored');
});

test('preview: name not in the answer -> named false, no ranges', async () => {
  const token = await signPreviewToken(ENV, { ...BIZ, businessName: 'A&B Plumbing' });
  const r = await call(ENV, { request_id: REQ_ID, question_id: 'q2', token });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.named, false);
  assert.deepEqual(r.body.ranges, []);
});

test('preview: no Turnstile -> off, friendly, nothing spent', async () => {
  const { TURNSTILE_SECRET_KEY, ...env } = ENV;
  const fetchImpl = fixtureFetch();
  const r = await call(env, { request_id: REQ_ID, question_id: 'q1', token: 'x.y' }, { fetchImpl });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.message, MSG.off);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(r.saved.length, 0);
});

test('preview: missing / wrong token or request id -> 403', async () => {
  const fetchImpl = fixtureFetch();
  assert.equal((await call(ENV, { request_id: REQ_ID, question_id: 'q1' }, { fetchImpl })).status, 403);
  const other = await good(ENV);
  assert.equal((await call(ENV, { ...other, request_id: '11111111-2222-4333-8444-555555555555' }, { fetchImpl })).status, 403);
  assert.equal((await call(ENV, { ...other, question_id: 'q9' }, { fetchImpl })).status, 400);
  assert.equal(fetchImpl.calls.length, 0);
});

test('preview: rate-limited by the binding -> 429, nothing spent', async () => {
  const fetchImpl = fixtureFetch();
  const r = await call(ENV, await good(), { fetchImpl, limiter: { limit: async () => ({ success: false }) } });
  assert.equal(r.status, 429);
  assert.equal(r.body.message, MSG.busy);
  assert.equal(fetchImpl.calls.length, 0);
});

test('preview: per-IP daily cap from scan_usage', async () => {
  const code = await ipCode(ENV, IP);
  const rows = Array.from({ length: PER_IP_DAILY }, (_, i) => ({ cost_usd: 0.01, ok: true, answer_ref: `live-preview:rid${i}:q1:${code}` }));
  const fetchImpl = fixtureFetch();
  const r = await call(ENV, await good(), { fetchImpl, readUsage: async () => rows });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'ip');
  assert.equal(fetchImpl.calls.length, 0);
});

test('preview: global daily cap reached -> friendly, no engine call', async () => {
  const fetchImpl = fixtureFetch();
  let since = null;
  const r = await call({ ...ENV, LIVE_PREVIEW_DAILY_USD: '0.50' }, await good(), {
    fetchImpl,
    readUsage: async (env, s) => { since = s; return [{ cost_usd: 0.3, ok: true, answer_ref: 'live-preview:a:q1:x' }, { cost_usd: 0.2, ok: true, answer_ref: 'live-preview:b:q1:y' }]; },
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'cap');
  assert.equal(r.body.message, MSG.cap);
  assert.match(since, /T00:00:00\.000Z$/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('preview: usage read fails -> fail closed', async () => {
  const fetchImpl = fixtureFetch();
  const r = await call(ENV, await good(), { fetchImpl, readUsage: async () => { throw new Error('down'); } });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.message, MSG.fallback);
  assert.equal(fetchImpl.calls.length, 0);
});

test('preview: engine failure -> fallback message, failure recorded', async () => {
  const fetchImpl = fixtureFetch(undefined, { gemini: () => jsonResponse({ error: { message: 'bad request' } }, 400) });
  const r = await call(ENV, await good(), { fetchImpl });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.message, MSG.fallback);
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].ok, false);
});

test('preview: engine timeout -> fallback within the cap', async () => {
  const fetchImpl = fixtureFetch(undefined, { gemini: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await call(ENV, await good(), { fetchImpl, timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'timeout');
});

test('/api/request returns a preview token only after a passed Turnstile check', async () => {
  const siteverify = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  const post = (env, body) => handleReportRequest(
    new Request('https://aifoundscore.com/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    new URL('https://aifoundscore.com/api/request'), env, { recordReportRequest: async () => {}, fetchImpl: siteverify },
  ).then((r) => r.json());
  const form = { business_name: 'A&B Plumbing', trade: 'plumbing', town: 'Massapequa', zip: '11758', state: 'NY', 'cf-turnstile-response': 'XXXX.DUMMY.TOKEN.XXXX' };
  const on = await post(ENV, form);
  assert.equal(on.ok, true);
  const tok = await verifyPreviewToken(ENV, on.preview_token);
  assert.equal(tok.id, on.id);
  assert.equal(tok.name, 'A&B Plumbing');
  const { TURNSTILE_SECRET_KEY, ...noTs } = ENV;
  const off = await post(noTs, form);
  assert.equal(off.ok, true);
  assert.equal(off.preview_token, undefined);
  const noEngine = await post({ ...ENV, GEMINI_API_KEY: '', OPENAI_API_KEY: '' }, form);
  assert.equal(noEngine.preview_token, undefined);
});


test('preview: concurrent requests reserve first; other reservations count against the cap', async () => {
  // Another request already reserved (lower id) and used up the whole cap.
  const other = { id: '00000000-0000-4000-8000-000000000000', cost_usd: 5, ok: true, answer_ref: 'live-preview:x:q1:y' };
  const r = await call(ENV, await good(), {
    uuid: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    readUsage: (() => { let n = 0; return async () => (n++ === 0 ? [] : [other]); })(),
  });
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'cap');
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].cost_usd, 0);
  assert.equal(r.saved[0].ok, false);
});

test('preview cap: every other row counts toward spend, whatever its id', async () => {
  // Our id sorts first; the other rows (older, higher ids) must still count.
  const hist = [
    { id: 'ffffffff-ffff-4fff-8fff-fffffffffff1', created_at: '2026-01-01T00:00:01+00:00', cost_usd: 5, ok: true, answer_ref: 'live-preview:x:q1:y' },
  ];
  const r = await call(ENV, await good(), {
    uuid: () => '00000000-0000-4000-8000-000000000000',
    readUsage: (() => { let n = 0; return async () => (n++ === 0 ? [] : hist); })(),
  });
  assert.equal(r.body.reason, 'cap');
  assert.equal(r.saved[0].ok, false);
});

test('rowsBefore: orders by created_at then id; a later-written row is never "before"', async () => {
  const { rowsBefore } = await import('../live-preview.js');
  const rows = [
    { id: 'b', created_at: '2026-01-01T00:00:01+00:00' },
    { id: 'z', created_at: '2026-01-01T00:00:00.5+00:00' },
    { id: 'a', created_at: '2026-01-01T00:00:01+00:00' },
    { id: 'c', created_at: '2026-01-01T00:00:02+00:00' },
  ];
  assert.deepEqual(rowsBefore(rows, 'b').map((r) => r.id).sort(), ['a', 'z']);
  assert.deepEqual(rowsBefore(rows, 'z').map((r) => r.id), []);
  // Own row missing: conservative, everything counts.
  assert.equal(rowsBefore(rows, 'q').length, 4);
});
