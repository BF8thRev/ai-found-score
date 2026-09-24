import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  signSession, verifySession, sessionCookie, clearSessionCookie, parseCookies, tokenMatches, sameOrigin, adminAuth,
  SESSION_COOKIE, SESSION_TTL_MS,
} from '../session.js';
import {
  esc, usd, pct, periodStarts, moneySummary, moneySeries, engineVerdicts, parseExpenseForm, activityFeed, scanFormToBody, shortTime,
} from '../metrics.js';
import {
  parseScanRequest, scanJobs, compactCall, scanTotals, isTransientEngineError, isTransientExtractError, chunk, MAX_STEP_TEXT,
} from '../scan-core.js';
import { redact, secretValues } from '../redact.js';
import { fakeProposal, dryRunEnv, isLocalRequest, dryRunEnabled } from '../dry-run.js';
import { renderDashboard, renderLogin } from '../page.js';
import { scrubKeyFragments, rawRow, usageRow, stableUuid } from '../../../scanner/store.js';
import { buildReport } from '../../../scanner/extract/build.js';
import { proposeForAnswer } from '../../../scanner/extract/propose.js';
import { ENGINE_IDS, DEFAULT_RUNS } from '../../../scanner/config.js';

const SECRET = 'test-admin-token-1234567890';

// ---------------------------------------------------------------------------
// session cookie
// ---------------------------------------------------------------------------
test('session: a signed value verifies with the same secret', async () => {
  const v = await signSession(SECRET);
  assert.match(v, /^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await verifySession(SECRET, v), true);
});

test('session: wrong secret, tampering, expiry and junk all fail', async () => {
  const now = Date.now();
  const v = await signSession(SECRET, { now });
  assert.equal(await verifySession('another-token-000000', v), false);
  const [ver, exp, nonce, sig] = v.split('.');
  assert.equal(await verifySession(SECRET, [ver, String(Number(exp) + 1000), nonce, sig].join('.')), false, 'extended expiry');
  assert.equal(await verifySession(SECRET, [ver, exp, `${nonce}x`, sig].join('.')), false, 'changed nonce');
  const flipped = sig.slice(0, -2) + (sig.at(-2) === 'A' ? 'B' : 'A') + sig.at(-1);
  assert.equal(await verifySession(SECRET, [ver, exp, nonce, flipped].join('.')), false, 'changed signature');
  assert.equal(await verifySession(SECRET, v, { now: now + SESSION_TTL_MS + 1 }), false, 'expired');
  for (const junk of ['', 'v1', 'v1.a.b.c', 'v2.1.2.3', null, undefined, 42, 'x'.repeat(400)]) {
    assert.equal(await verifySession(SECRET, junk), false, String(junk).slice(0, 20));
  }
  assert.equal(await verifySession('', v), false);
});

test('session: a value signed far in the future is refused (max 12h)', async () => {
  const v = await signSession(SECRET, { ttlMs: 30 * 24 * 3600 * 1000 });
  assert.equal(await verifySession(SECRET, v), false);
});

test('session: cookie attributes are HttpOnly, Secure, SameSite=Strict, host-only, 12h', async () => {
  const c = sessionCookie('abc');
  assert.ok(c.startsWith(`${SESSION_COOKIE}=abc;`));
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(c.includes(part), part);
  assert.ok(!/Domain=/i.test(c));
  assert.ok(clearSessionCookie().includes('Max-Age=0'));
});

test('session: parseCookies, tokenMatches, sameOrigin, adminAuth', async () => {
  assert.deepEqual(parseCookies('a=1; b=two=2;  c = 3'), { a: '1', b: 'two=2', c: '3' });
  assert.equal(await tokenMatches(SECRET, SECRET), true);
  assert.equal(await tokenMatches(`${SECRET}x`, SECRET), false);
  assert.equal(await tokenMatches('', SECRET), false);

  const req = (headers, url = 'https://aifoundscore.com/admin/scan') => new Request(url, { method: 'POST', headers });
  assert.equal(sameOrigin(req({ Origin: 'https://aifoundscore.com' })), true);
  assert.equal(sameOrigin(req({ Origin: 'https://evil.example' })), false);
  assert.equal(sameOrigin(req({})), false, 'missing Origin is refused');
  assert.equal(sameOrigin(req({ Origin: 'null' })), false);
  // Origin: null + browser-set Sec-Fetch-Site (no-referrer pages): same-origin only.
  assert.equal(sameOrigin(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' })), true);
  assert.equal(sameOrigin(req({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' })), false);
  assert.equal(sameOrigin(req({ Origin: 'null', 'Sec-Fetch-Site': 'same-site' })), false);
  assert.equal(sameOrigin(req({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' })), false, 'a real Origin always wins');

  const cookie = `${SESSION_COOKIE}=${await signSession(SECRET)}`;
  assert.equal(await adminAuth(req({ Cookie: cookie }), SECRET), 'cookie');
  assert.equal(await adminAuth(req({ Authorization: `Bearer ${SECRET}` }), SECRET), 'bearer');
  assert.equal(await adminAuth(req({ Authorization: 'Bearer nope' , Cookie: cookie }), SECRET), null, 'a bad Bearer is not rescued by a cookie');
  assert.equal(await adminAuth(req({ Cookie: `${SESSION_COOKIE}=v1.1.2.3` }), SECRET), null);
  assert.equal(await adminAuth(req({ Cookie: cookie }), ''), null, 'no ADMIN_TOKEN → nobody');
});

// ---------------------------------------------------------------------------
// formatting + money
// ---------------------------------------------------------------------------
test('esc escapes every HTML-significant character', () => {
  assert.equal(esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(esc(null), '');
});

test('usd and pct', () => {
  assert.equal(usd(12.345), '$12.35');
  assert.equal(usd(0.04123), '$0.0412');
  assert.equal(usd(-3), '−$3.00');
  assert.equal(usd(null), '—');
  assert.equal(usd('1234.5'), '$1,234.50');
  assert.equal(pct(0.5), '50%');
  assert.equal(pct(0.034), '3.4%');
  assert.equal(pct(0), '0%');
  assert.equal(pct(null), '—');
});

test('periodStarts uses New York dates and Monday weeks', () => {
  // 2026-09-24 01:30 UTC is still Wednesday Sep 23 in New York.
  assert.deepEqual(periodStarts(new Date('2026-09-24T01:30:00Z')), { day: '2026-09-23', week: '2026-09-21', month: '2026-09-01' });
  // Sunday belongs to the week that started the Monday before.
  assert.equal(periodStarts(new Date('2026-09-27T16:00:00Z')).week, '2026-09-21');
  assert.equal(periodStarts(new Date('2026-09-28T16:00:00Z')).week, '2026-09-28');
});

test('moneySummary picks the current week/month rows and the all-time row', () => {
  const rows = [
    { period: 'week', period_start: '2026-09-21', api_spend_usd: '1.5', expenses_usd: '30', api_topups_usd: '0', spent_usd: '31.5', revenue_usd: '59', net_usd: '27.5' },
    { period: 'week', period_start: '2026-09-14', api_spend_usd: '9', spent_usd: '9', revenue_usd: '0', net_usd: '-9' },
    { period: 'month', period_start: '2026-09-01', api_spend_usd: '10.5', expenses_usd: '30', spent_usd: '40.5', revenue_usd: '59', net_usd: '18.5' },
    { period: 'all', period_start: null, api_spend_usd: '12', expenses_usd: '30', api_topups_usd: '20', spent_usd: '42', revenue_usd: '59', net_usd: '17' },
  ];
  const m = moneySummary(rows, new Date('2026-09-24T16:00:00Z'));
  assert.equal(m.week.spent, 31.5);
  assert.equal(m.week.net, 27.5);
  assert.equal(m.month.spent, 40.5);
  assert.equal(m.all.topups, 20);
  assert.equal(m.all.net, 17);
  // A new week with no rows yet is all zeros, not last week's numbers.
  assert.equal(moneySummary(rows, new Date('2026-09-29T16:00:00Z')).week.spent, 0);
  const series = moneySeries(rows, 'week', 3, new Date('2026-09-24T16:00:00Z'));
  assert.deepEqual(series.map((s) => [s.start, s.spent]), [['2026-09-07', 0], ['2026-09-14', 9], ['2026-09-21', 31.5]]);
});

test('engineVerdicts: fixed rules, first match wins', () => {
  const base = { scans: 10, calls: 50, ok_calls: 50, ok_rate: 1, named_any_rate: 0.9, headline_share: 0, unique_competitors: 2 };
  const rows = engineVerdicts([
    { ...base, engine: 'cheap', cost_per_answer_usd: 0.01 },
    { ...base, engine: 'pricey_useless', cost_per_answer_usd: 0.1, unique_competitors: 0 },
    { ...base, engine: 'flaky', cost_per_answer_usd: 0.01, ok_rate: 0.5, ok_calls: 25 },
    { ...base, engine: 'new', calls: 3, ok_calls: 3, cost_per_answer_usd: 0.01 },
    { ...base, engine: 'headliner', cost_per_answer_usd: 0.01, headline_share: 0.4 },
    { ...base, engine: 'vague', cost_per_answer_usd: 0.01, unique_competitors: 0, named_any_rate: 0.2 },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.engine, r]));
  assert.equal(by.pricey_useless.tone, 'bad');
  assert.match(by.pricey_useless.verdict, /^Costs \d+(\.\d)?× the average per answer and surfaced no unique competitors in the last 10 scans\.$/);
  assert.equal(by.flaky.tone, 'bad');
  assert.match(by.flaky.verdict, /^Unreliable: 50% of its calls failed in the last 10 scans\.$/);
  assert.equal(by.new.tone, 'neutral');
  assert.match(by.new.verdict, /Not enough data yet: 3 calls/);
  assert.equal(by.headliner.tone, 'good');
  assert.match(by.headliner.verdict, /headline in 40% of reports/);
  assert.equal(by.vague.tone, 'warn');
  assert.match(by.cheap.verdict, /^Pulls its weight: 2 competitors only it named, at \$0\.0100 per answer\.$/);
  assert.deepEqual(engineVerdicts([]), []);
});

test('parseExpenseForm validates category, amount and date', () => {
  const now = new Date('2026-09-24T16:00:00Z');
  const ok = parseExpenseForm({ category: 'postcards', amount_usd: '$1,234.567', spent_on: '2026-09-20', vendor: ' Lob ', description: 'first batch' }, now);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.row, { spent_on: '2026-09-20', category: 'postcards', vendor: 'Lob', description: 'first batch', amount_usd: 1234.57 });
  assert.equal(parseExpenseForm({ category: 'postcards', amount_usd: '5' }, now).row.spent_on, '2026-09-24');
  assert.equal(parseExpenseForm({ category: 'bitcoin', amount_usd: '5' }, now).ok, false);
  assert.equal(parseExpenseForm({ category: 'domain', amount_usd: '-5' }, now).ok, false);
  assert.equal(parseExpenseForm({ category: 'domain', amount_usd: 'abc' }, now).ok, false);
  assert.equal(parseExpenseForm({ category: 'domain', amount_usd: '5', spent_on: '2027-01-01' }, now).ok, false);
  assert.equal(parseExpenseForm({ category: 'domain', amount_usd: '5', spent_on: '09/20/2026' }, now).ok, false);
});

test('activityFeed merges and sorts newest first, flags requests with/without email', () => {
  const items = activityFeed({
    scans: [{ started_at: '2026-09-24T10:00:00Z', status: 'done', business_name: 'A', total_cost_usd: 0.5 }],
    requests: [{ requested_at: '2026-09-24T12:00:00Z', business_name: 'B', town: 'T', email: 'x@y.co' }, { requested_at: '2026-09-24T09:00:00Z', business_name: 'C', town: 'T', email: null }],
    leads: [{ created_at: '2026-09-24T11:00:00Z', arm: 'mail' }],
    payments: [{ paid_at: '2026-09-24T13:00:00Z', amount_cents: 5900, tier: 'before_after', livemode: true }],
  });
  assert.deepEqual(items.map((i) => i.kind), ['payment', 'request', 'lead', 'scan', 'request']);
  assert.match(items[1].text, /with email/);
  assert.match(items[4].text, /without email/);
  assert.match(items[0].text, /\$59\.00/);
});

test('shortTime formats in New York time', () => {
  assert.equal(shortTime('2026-09-24T21:01:00Z'), 'Sep 24, 5:01pm');
  assert.equal(shortTime(null), '—');
});

// ---------------------------------------------------------------------------
// scan request + step data
// ---------------------------------------------------------------------------
test('parseScanRequest: defaults to every engine and DEFAULT_RUNS; validates', () => {
  const r = parseScanRequest({ business: { name: ' Acme  Plumbing ', trade: 'Plumber', town: 'Massapequa, NY', zip: '11758' } });
  assert.equal(r.ok, true);
  assert.equal(r.params.business.name, 'Acme Plumbing');
  assert.equal(r.params.business.trade, 'plumbing');
  assert.equal(r.params.business.town, 'Massapequa');
  assert.deepEqual(r.params.engines, ENGINE_IDS);
  assert.equal(r.params.engines.length, 5);
  assert.equal(r.params.runs, DEFAULT_RUNS);
  assert.equal(r.params.questionLimit, null);
  assert.equal(r.params.trigger, 'admin');

  assert.equal(parseScanRequest({ business: { name: 'A', trade: 'plumbing' } }).ok, false);
  assert.equal(parseScanRequest({ business: { name: 'A', trade: 'plumbing', town: 'T' }, engines: ['bing'] }).ok, false);
  assert.equal(parseScanRequest({ business: { name: 'A', trade: 'plumbing', town: 'T' }, runs: 9 }).ok, false);
  assert.equal(parseScanRequest({ business: { name: 'A', trade: 'plumbing', town: 'T', zip: '123' } }).ok, false);
  const light = parseScanRequest({ business: { name: 'A', trade: 'plumbing', town: 'T' }, engines: ['perplexity'], questions: '1', runs: '2' });
  assert.equal(light.params.questionLimit, 1);
  assert.equal(light.params.runs, 2);
  assert.deepEqual(light.params.engines, ['perplexity']);
});

test('scanFormToBody maps the dashboard form', () => {
  const body = scanFormToBody({ business_name: 'X', trade: 'hvac', town: 'Y', runs: '1', questions: '5' }, ['chatgpt', 'gemini']);
  const r = parseScanRequest(body);
  assert.equal(r.ok, true);
  assert.deepEqual(r.params.engines, ['chatgpt', 'gemini']);
  assert.equal(r.params.questionLimit, null);
});

test('scanJobs orders run → question → engine; chunk splits', () => {
  const jobs = scanJobs([{ id: 'q1' }, { id: 'q2' }], ['chatgpt', 'gemini'], 2);
  assert.equal(jobs.length, 8);
  assert.deepEqual(jobs.slice(0, 3).map((j) => j.key), ['chatgpt:q1:1', 'gemini:q1:1', 'chatgpt:q2:1']);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('compactCall keeps only small fields and never the raw response', () => {
  const c = compactCall({
    engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: 'x'.repeat(MAX_STEP_TEXT + 10),
    citations: [{ url: 'https://a.com/x', domain: 'a.com', title: 'A', extra: 'drop me' }],
    raw: { huge: 'y'.repeat(1e6) }, request: { big: true }, costUsd: 0.0123456789, error: null, askedAt: '2026-09-24T00:00:00Z', model: 'm',
  }, { id: 'q1', intent: 'best', text: 'Q?' });
  assert.equal(c.text.length, MAX_STEP_TEXT);
  assert.equal(c.truncated, true);
  assert.equal(c.raw, undefined);
  assert.equal(c.request, undefined);
  assert.deepEqual(c.citations, [{ url: 'https://a.com/x', domain: 'a.com', title: 'A' }]);
  assert.equal(c.costUsd, 0.012346);
  assert.ok(JSON.stringify(c).length < 50_000);
  const failed = compactCall({ engine: 'chatgpt', ok: false, text: null, error: 'HTTP 401: Incorrect API key provided: sk-proj-****abcd. See docs.' });
  assert.equal(failed.ok, false);
  assert.ok(!failed.error.includes('abcd'));
});

test('transient error detection never retries a billed call', () => {
  assert.equal(isTransientEngineError({ ok: false, costUsd: 0, error: 'HTTP 429: slow down' }), true);
  assert.equal(isTransientEngineError({ ok: false, costUsd: 0, error: 'network error: reset' }), true);
  assert.equal(isTransientEngineError({ ok: false, costUsd: 0.01, error: 'HTTP 503' }), false);
  assert.equal(isTransientEngineError({ ok: false, costUsd: 0, error: 'HTTP 401: bad key' }), false);
  assert.equal(isTransientEngineError({ ok: false, costUsd: 0, error: 'timeout after 120000ms' }), false);
  assert.equal(isTransientExtractError('rate_limited (HTTP 429)'), true);
  assert.equal(isTransientExtractError('api_error (HTTP 529): overloaded'), true);
  assert.equal(isTransientExtractError('refusal'), false);
  assert.equal(isTransientExtractError('auth_failed (HTTP 401)'), false);
});

test('scanTotals sums costs and collects errors', () => {
  const t = scanTotals({
    calls: [{ engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, costUsd: 0.02 }, { engine: 'gemini', questionId: 'q1', run: 1, ok: false, costUsd: 0, error: 'HTTP 500' }],
    extractions: [{ key: 'chatgpt:q1:1', ok: true, costUsd: 0.005 }],
    build: { valid: true, totals: { answers: 1, namedYou: 0, firstYou: 0 }, errors: [], extraExtractCostUsd: 0.001 },
  });
  assert.equal(t.calls_total, 2);
  assert.equal(t.calls_ok, 1);
  assert.equal(t.engine_cost_usd, 0.02);
  assert.equal(t.extract_cost_usd, 0.006);
  assert.equal(t.total_cost_usd, 0.026);
  assert.equal(t.answers, 1);
  assert.equal(t.report_valid, true);
  assert.equal(t.status, 'done');
  assert.deepEqual(t.errors, [{ kind: 'engine', engine: 'gemini', questionId: 'q1', run: 1, error: 'HTTP 500' }]);
  assert.equal(scanTotals({ calls: [{ ok: false }] }).status, 'failed');
});

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------
test('scrubKeyFragments strips the masked key from the recorded OpenAI 401', () => {
  const fx = JSON.parse(readFileSync(new URL('../../../scanner/test/fixtures/engines/openai.error_401.json', import.meta.url), 'utf8'));
  const msg = `HTTP 401: ${fx.error.message}`;
  const s = scrubKeyFragments(msg);
  assert.ok(!s.includes('sk-proj'), s);
  assert.ok(!s.includes('abcd'), s);
  assert.match(s, /Incorrect API key provided: \[redacted\]/);
  // Ordinary words with "sk-" inside are left alone.
  assert.equal(scrubKeyFragments('a risk-free task-runner'), 'a risk-free task-runner');
  for (const k of ['sk-ant-api03-AbC123', 'pplx-123abc456', 'AIzaSyD-1234567890abc', 'Bearer abcdefghijklmnop', 'https://x.com/?key=abc123', 'sb_secret_abc123']) {
    assert.ok(!scrubKeyFragments(`err ${k} end`).includes(k), k);
  }
});

test('rawRow scrubs the error and a failed response body; usageRow shapes tokens', () => {
  const row = rawRow({ scanId: 's', businessId: null, id: 'i', call: { engine: 'chatgpt', questionId: 'q1', run: 1, ok: false, error: 'Incorrect API key provided: sk-proj-****abcd.', raw: { error: { message: 'Incorrect API key provided: sk-proj-****abcd.' } }, costUsd: 0 } });
  assert.equal(row.id, 'i');
  assert.ok(!JSON.stringify(row).includes('abcd'));
  const u = usageRow({ scanId: '11111111-1111-4111-8111-111111111111', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.00012345678, answerRef: 'chatgpt:q1:1' });
  assert.deepEqual([u.kind, u.provider, u.input_tokens, u.output_tokens, u.cost_usd, u.ok], ['extract', 'anthropic', 10, 5, 0.000123, true]);
});

test('stableUuid is deterministic and uuid-shaped', async () => {
  const a = await stableUuid('scan:chatgpt:q1:1');
  assert.equal(a, await stableUuid('scan:chatgpt:q1:1'));
  assert.notEqual(a, await stableUuid('scan:chatgpt:q1:2'));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('redact covers alternate key names (resolveKeys aliases), not just the primary ones', () => {
  const env = { OPENAI_KEY: 'alt-openai-secret-123', PPLX_API_KEY: 'alt-pplx-secret-456', CLAUDE_API_KEY: 'alt-claude-secret-789', SUPABASE_SERVICE_ROLE_KEY: 'alt-service-role-000', DFS_LOGIN: 'dfs-user', DATAFORSEO_PASSWORD: 'dfs-pass-1' };
  const msg = `a alt-openai-secret-123 b alt-pplx-secret-456 c alt-claude-secret-789 d alt-service-role-000 e ${btoa('dfs-user:dfs-pass-1')}`;
  const out = redact(env, msg);
  for (const v of Object.values(env).filter((x) => x.length >= 6)) assert.ok(!out.includes(v), v);
  assert.ok(!out.includes(btoa('dfs-user:dfs-pass-1')));
  assert.ok(secretValues({ SUPABASE_URL: 'https://x.supabase.co' }).length === 0, 'URLs are not secrets');
});

// ---------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------
test('dry run: only with SCANNER_DRY_RUN=1, never stores, fake extractor quotes real substrings', () => {
  assert.equal(dryRunEnabled({ SCANNER_DRY_RUN: '1' }), true);
  assert.equal(dryRunEnabled({ SCANNER_DRY_RUN: 'true' }), false);
  assert.equal(dryRunEnabled({}), false);
  assert.equal(isLocalRequest('http://localhost:8787/admin'), true);
  assert.equal(isLocalRequest('https://aifoundscore.com/admin'), false);
  const env = dryRunEnv({ SUPABASE_SERVICE_KEY: 'real', SUPABASE_SERVICE_ROLE_KEY: 'real2', SUPABASE_URL: 'u' });
  assert.equal(env.SUPABASE_SERVICE_KEY, undefined);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  const text = 'Try **Suds & Bubbles Laundromat** or **Clean Spin** – or Mega Wash & Dry on Deer Park Ave.';
  const p = fakeProposal(text, 'Mega Wash & Dry');
  assert.deepEqual(p.businesses.map((b) => b.name), ['Suds & Bubbles Laundromat', 'Clean Spin', 'Mega Wash & Dry']);
  for (const b of p.businesses) assert.equal(text.slice(b.pos, b.pos + b.name.length), b.name);
});

// ---------------------------------------------------------------------------
// extractor hooks
// ---------------------------------------------------------------------------
test('propose: a recorded failure stays a failure (blocks the report)', async () => {
  const r = await proposeForAnswer({ answer: { id: 'a1', text: 'x' }, business: { name: 'B' }, proposals: { ok: false, error: 'rate_limited (HTTP 429)' } });
  assert.equal(r.ok, false);
  assert.equal(r.source, 'recorded');
  assert.equal(r.costUsd, 0);
});

test('buildReport: onExtract reports each paid extractor call; recorded proposals report nothing', async () => {
  const business = { name: 'Acme Plumbing', trade: 'plumbing', town: 'Massapequa' };
  const scan = {
    questions: [{ id: 'q1', intent: 'best', text: 'Best plumber?' }],
    engines: ['chatgpt', 'gemini'],
    calls: [
      { engine: 'chatgpt', questionId: 'q1', run: 1, ok: true, text: 'Call Acme Plumbing or Beta Pipes.', citations: [], askedAt: '2026-09-24T21:00:00Z' },
      { engine: 'gemini', questionId: 'q1', run: 1, ok: true, text: 'Beta Pipes is good.', citations: [], askedAt: '2026-09-24T21:01:00Z' },
    ],
  };
  const fetchImpl = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify({ businesses: [{ name: 'Beta Pipes', pos: 0 }], ownerFacts: [] }) }],
        usage: { input_tokens: 1000, output_tokens: 200 } });
    }
    return new Response('', { status: 404 });
  };
  const seen = [];
  const { extraction } = await buildReport({
    scan, business, env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl, id: 't',
    proposalsByAnswer: { 'chatgpt:q1:1': { businesses: [{ name: 'Acme Plumbing', pos: 5 }, { name: 'Beta Pipes', pos: 22 }], ownerFacts: [] } },
    onExtract: (x) => { seen.push(x); },
  });
  assert.equal(seen.length, 1, 'only the model call is reported');
  assert.equal(seen[0].key, 'gemini:q1:1');
  assert.deepEqual(seen[0].usage, { input_tokens: 1000, output_tokens: 200 });
  assert.ok(Math.abs(seen[0].costUsd - (1000 * 2 + 200 * 10) / 1e6) < 1e-9);
  assert.ok(Math.abs(extraction.costUsd - seen[0].costUsd) < 1e-9);
});

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------
test('dashboard escapes untrusted names and errors; login page has no token in it', () => {
  const evil = '<script>alert(1)</script>';
  const html = renderDashboard({
    configured: true,
    data: {
      money: [], kpis: null, funnel: [], gates: [], expenses: [], leads: [], payments: [],
      scans: [{ scan_id: '11111111-1111-4111-8111-111111111111', business_name: evil, status: 'running', per_engine: { chatgpt: { calls: 1, ok: 0, cost_usd: 0 } }, errors: [] }],
      engines: [{ engine: 'chatgpt', calls: 10, ok_calls: 9, ok_rate: 0.9, cost_per_answer_usd: 0.02, unique_competitors: 1, scans: 2 }],
      requests: [{ requested_at: '2026-09-24T10:00:00Z', business_name: evil, town: '"><b>x', email: null }],
    },
    errors: { funnel: `boom ${evil}` },
  }, { nonce: 'n0nce', engineIds: ENGINE_IDS, watch: [] });
  assert.ok(!html.includes(evil));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('"><b>x'));
  assert.ok(html.includes('data-watch="11111111-1111-4111-8111-111111111111"'), 'running scans get a live status panel');
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">'));
  assert.ok(!/<script>(?!alert)/.test(html), 'no inline scripts');
  const login = renderLogin({ nonce: 'n', error: evil });
  assert.ok(!login.includes(evil));
});

// ---------------------------------------------------------------------------
// routes: every /admin* and /api/admin/* path gated; CSRF; no ADMIN_TOKEN → 404
// (env has no Supabase key and a mock Workflow binding: nothing leaves the process)
// ---------------------------------------------------------------------------
import { handleAdminRequest, isAdminPath } from '../routes.js';

const ORIGIN = 'https://aifoundscore.com';
const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
  const url = new URL(path, ORIGIN);
  return handleAdminRequest(new Request(url, { method, headers, body, redirect: 'manual' }), url, env);
};
const mockEnv = () => {
  const created = [];
  return {
    created,
    env: {
      ADMIN_TOKEN: SECRET,
      SCAN_WORKFLOW: {
        create: async ({ id, params }) => { created.push(params); return { id }; },
        get: async () => ({ status: async () => ({ status: 'running' }) }),
      },
    },
  };
};
const ROUTES = [
  ['GET', '/admin'], ['GET', '/admin/'], ['POST', '/admin/expenses'], ['POST', '/admin/scan'],
  ['GET', '/admin/expenses'], ['GET', '/admin/scan'], ['GET', '/admin/other'], ['POST', '/admin'],
  ['GET', '/api/admin/ping'], ['POST', '/api/admin/scan'], ['POST', '/api/admin/scan?sync=1'],
  ['GET', '/api/admin/scan/11111111-1111-4111-8111-111111111111'], ['GET', '/api/admin/scan/%E0'], ['DELETE', '/api/admin/x'],
];

test('routes: with no ADMIN_TOKEN every admin path is a 404', async () => {
  for (const [method, path] of [...ROUTES, ['POST', '/admin/login'], ['GET', '/admin/logout'], ['GET', '/admin/admin.js']]) {
    const r = await call({ ADMIN_TOKEN: '  ' }, path, { method });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal(isAdminPath('/administrator'), false);
  assert.equal(isAdminPath('/admin'), true);
});

test('routes: unauthenticated requests never reach data or start scans', async () => {
  const { env, created } = mockEnv();
  for (const [method, path] of ROUTES) {
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
    const body = method === 'POST' ? JSON.stringify({ business: { name: 'X', trade: 'plumber', town: 'Y' } }) : undefined;
    for (const auth of [{}, { Authorization: 'Bearer wrong' }, { Cookie: `${SESSION_COOKIE}=v1.9999999999999.abcdefgh.${'A'.repeat(43)}` }]) {
      const r = await call(env, path, { method, headers: { ...headers, ...auth }, body });
      const text = await r.text();
      if (path.startsWith('/api/')) assert.equal(r.status, 401, `${method} ${path}`);
      else if (method === 'POST') assert.equal(r.status, 303, `${method} ${path}`);
      else assert.ok([200, 303, 404].includes(r.status) && !/Dashboard/.test(text), `${method} ${path} → ${r.status}`);
      if (r.status === 200) assert.match(text, /name="token"/, 'only the sign-in form');
    }
  }
  assert.equal(created.length, 0, 'no workflow was started');
});

test('routes: login sets a __Host- cookie; CSRF refused cross-origin; same-origin form POSTs work', async () => {
  const { env, created } = mockEnv();
  const form = (o) => new URLSearchParams(o).toString();
  const fh = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // login: cross-origin / missing Origin refused before the token is even checked
  assert.equal((await call(env, '/admin/login', { method: 'POST', headers: { ...fh, Origin: 'https://evil.example' }, body: form({ token: SECRET }) })).status, 403);
  assert.equal((await call(env, '/admin/login', { method: 'POST', headers: fh, body: form({ token: SECRET }) })).status, 403);
  // what a browser sends from a no-referrer page: Origin null + Sec-Fetch-Site same-origin
  const ok = await call(env, '/admin/login', { method: 'POST', headers: { ...fh, Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }, body: form({ token: SECRET }) });
  assert.equal(ok.status, 303);
  const setCookie = ok.headers.get('Set-Cookie');
  assert.match(setCookie, /^__Host-afs_admin=v1\.[^;]+; Path=\/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict$/);
  const cookie = setCookie.split(';')[0];

  // the pages it serves must not make browsers send Origin: null
  const page = await call(env, '/admin', { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.notEqual(page.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(await page.text(), /Dashboard/);

  const scanBody = form({ business_name: 'Acme', trade: 'plumber', town: 'Massapequa', engines: 'chatgpt', runs: '1', questions: '1' });
  for (const origin of ['https://evil.example', 'null', undefined]) {
    const h = { ...fh, Cookie: cookie, ...(origin ? { Origin: origin } : {}) };
    assert.equal((await call(env, '/admin/scan', { method: 'POST', headers: h, body: scanBody })).status, 403, `origin ${origin}`);
    assert.equal((await call(env, '/admin/expenses', { method: 'POST', headers: h, body: form({ category: 'other', amount_usd: '1' }) })).status, 403);
    assert.equal((await call(env, '/api/admin/scan', { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await call(env, '/admin/logout', { method: 'POST', headers: h })).status, 403);
  }
  assert.equal(created.length, 0);
  // Bearer clients need no Origin (no ambient credential); malformed id → 404 not 500
  const bearer = { Authorization: `Bearer ${SECRET}` };
  assert.equal((await call(env, '/api/admin/scan/%E0', { headers: bearer })).status, 404);
  // Forms from localhost-looking headers can't switch on the dry run in production
  const r = await call({ ...env, SCANNER_DRY_RUN: '1' }, '/api/admin/scan', {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json', Host: 'localhost', 'X-Forwarded-Host': 'localhost' },
    body: JSON.stringify({ business: { name: 'Acme', trade: 'plumber', town: 'Massapequa' }, engines: ['chatgpt'], questions: 1 }),
  });
  assert.equal(r.status, 503, 'no service key and not a localhost URL → refused, not a dry run');
});
