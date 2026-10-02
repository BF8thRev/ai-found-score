// "Find a report" + "Unlock" on /admin (src/admin/unlock.js, src/admin/data.js reportLookup), through
// the real router with a fake Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../routes.js';
import { reportTokenFrom } from '../data.js';
import { parseUnlockForm } from '../unlock.js';
import { paymentSource } from '../page.js';

const SECRET = 'test-admin-token-1234567890';
const ORIGIN = 'https://aifoundscore.com';
const TOKEN = 'zDLK7Xwl4vsA3SaJ-FQr4w';
const SB = 'https://sb.example';
const bearer = { Authorization: `Bearer ${SECRET}` };

const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
  const url = new URL(path, ORIGIN);
  return handleAdminRequest(new Request(url, { method, headers, body, redirect: 'manual' }), url, env);
};
const post = (env, fields, headers = bearer) => call(env, '/admin/report/unlock', {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});

/** A fake Supabase holding one finished free report for TOKEN (PR 73), its scan's cost, and any payments. */
function fakeDb({ payments = [], scans } = {}) {
  const db = {
    payments: [...payments],
    scans: scans || [{ scan_id: 's-free', trigger: 'request', status: 'done', started_at: '2026-10-01T17:49:15Z', total_cost_usd: 0.33, business_name: 'PR 73', report_saved: true, engines: ['chatgpt', 'gemini', 'claude'], answers: 8, calls_ok: 9 }],
    scanRows: [],
    calls: [],
  };
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const u = new URL(String(input));
    const method = init.method || 'GET';
    db.calls.push(`${method} ${u.pathname}`);
    const forToken = u.search.includes(encodeURIComponent(TOKEN)) || u.search.includes(TOKEN);
    if (u.pathname === '/rest/v1/rpc/report_unlocked') {
      const { p_token } = JSON.parse(init.body);
      return json(p_token === TOKEN && db.payments.some((p) => !p.revoked_at && p.tier !== 'competitor_breakdown'));
    }
    if (u.pathname === '/rest/v1/v_scan_costs') return json(forToken ? db.scans : []);
    if (u.pathname === '/rest/v1/scan_results') return json(forToken ? [{ name: 'PR 73' }] : []);
    if (u.pathname === '/rest/v1/payments' && method === 'GET') return json(forToken ? db.payments : []);
    if (u.pathname === '/rest/v1/payments' && method === 'POST') { db.payments.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    if (u.pathname === '/rest/v1/report_links') return json([]);
    if (u.pathname === '/rest/v1/scans' && method === 'GET') {
      if (u.search.includes('business=not.is.null')) return json([{ business: { name: 'PR 73', town: 'New York City', state: 'NY', zip: '10001', trade: 'PR agency' } }]);
      return json(db.scanRows);
    }
    if (u.pathname === '/rest/v1/scans' && (method === 'POST' || method === 'PATCH')) { db.scanRows.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    return json([]); // every other dashboard read: empty
  };
  return { db, fetchImpl };
}

function mockEnv() {
  const created = [];
  return {
    created,
    env: {
      ADMIN_TOKEN: SECRET, SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: 'service', SUPABASE_ANON_KEY: 'anon',
      OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k',
      SCAN_WORKFLOW: { create: async ({ id, params }) => { created.push({ id, params }); return { id }; } },
    },
  };
}

async function withFetch(fetchImpl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('reportTokenFrom: a pasted link or a bare token', () => {
  assert.equal(reportTokenFrom(`https://aifoundscore.com/report/${TOKEN}`), TOKEN);
  assert.equal(reportTokenFrom(`https://aifoundscore.com/report/${TOKEN}?from=checkout#x`), TOKEN);
  assert.equal(reportTokenFrom(` ${TOKEN} `), TOKEN);
  assert.equal(reportTokenFrom('nope!'), null);
  assert.equal(reportTokenFrom(''), null);
});

test('parseUnlockForm: dollars, optional email, tick boxes', () => {
  assert.deepEqual(parseUnlockForm({ amount: '49', email: ' A@B.co ', breakdown: 'on' }).row, { amountCents: 4900, email: 'a@b.co', breakdown: true, runAudit: false });
  assert.equal(parseUnlockForm({}).row.amountCents, 0, 'blank amount is a comp');
  assert.equal(parseUnlockForm({ amount: '$74.00', run: 'on' }).row.runAudit, true);
  assert.equal(parseUnlockForm({ amount: '-5' }).ok, false);
  assert.equal(parseUnlockForm({ amount: '1000' }).ok, false);
  assert.equal(parseUnlockForm({ amount: '0', email: 'not-an-email' }).ok, false);
});

test('paymentSource tells admin unlocks from Stripe', () => {
  assert.equal(paymentSource({ stripe_session_id: 'cs_live_1', livemode: true }), 'Stripe');
  assert.equal(paymentSource({ stripe_session_id: 'admin_x', amount_cents: 0 }), 'Admin, comp');
  assert.equal(paymentSource({ stripe_session_id: 'admin_x', amount_cents: 4900 }), 'Admin, paid outside Stripe');
});

test('routes: GET /admin?report=<link> shows the business, locked, and its scan cost', async () => {
  const { env } = mockEnv();
  const { fetchImpl } = fakeDb();
  const res = await withFetch(fetchImpl, () => call(env, `/admin?report=${encodeURIComponent(`https://aifoundscore.com/report/${TOKEN}`)}`, { headers: bearer }));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="report"/);
  assert.match(html, /PR 73/);
  assert.match(html, />locked</);
  assert.match(html, /\$0\.33/, 'the free report’s API cost is shown on this link');
  assert.match(html, /action="\/admin\/report\/unlock"/, 'the unlock form is offered');
  assert.match(html, /name="run"(?! checked)/, 'the full audit is opt-in');
});

test('routes: POST /admin/report/unlock is gated, CSRF-checked and validated', async () => {
  assert.equal((await post({ ADMIN_TOKEN: ' ' }, { token: TOKEN })).status, 404, 'no ADMIN_TOKEN');
  const { env, created } = mockEnv();
  const { db, fetchImpl } = fakeDb();
  await withFetch(fetchImpl, async () => {
    assert.equal((await post(env, { token: TOKEN }, {})).status, 303, 'unauthenticated → the login page');
    assert.equal((await post(env, { token: 'bad token!' })).status, 422);
    assert.equal((await post(env, { token: TOKEN, amount: 'lots' })).status, 422);
    assert.equal((await post(env, { token: 'unknownTok123' })).status, 422, 'no report on that link');
    assert.equal((await call(env, '/admin/report/unlock', { headers: bearer })).status, 303, 'GET goes back to the page');
  });
  assert.equal(db.payments.length, 0, 'nothing written');
  assert.equal(created.length, 0, 'no scan started');
});

test('routes: unlock with no tick box writes an xray payment and makes NO API calls', async () => {
  const { env, created } = mockEnv();
  const { db, fetchImpl } = fakeDb();
  const res = await withFetch(fetchImpl, () => post(env, { token: `https://aifoundscore.com/report/${TOKEN}`, amount: '0', breakdown: 'on' }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Location'), new RegExp(`/admin\\?report=${TOKEN}&unlocked=1#report$`));
  assert.equal(db.payments.length, 1);
  const p = db.payments[0];
  assert.equal(p.report_token, TOKEN);
  assert.equal(p.tier, 'xray');
  assert.deepEqual(p.addons, ['competitor_breakdown']);
  assert.equal(p.amount_cents, 0);
  assert.equal(p.livemode, false, 'a comp is not revenue');
  assert.match(p.stripe_session_id, /^admin_/);
  assert.equal(created.length, 0, 'no full audit: the page shows the answers already collected');

  // Now the page says unlocked and offers no second unlock.
  const page = await withFetch(fetchImpl, () => call(env, `/admin?report=${TOKEN}&unlocked=1`, { headers: bearer }));
  const html = await page.text();
  assert.match(html, />unlocked</);
  assert.match(html, /no new API calls/);
  assert.doesNotMatch(html, /action="\/admin\/report\/unlock"/);
  assert.match(html, /Admin, comp/);
  // And a second unlock is refused.
  const again = await withFetch(fetchImpl, () => post(env, { token: TOKEN }));
  assert.equal(again.status, 409);
  assert.equal(db.payments.length, 1);
});

test('routes: unlock with a paid amount and "run the full audit" starts the paid scan under the same token', async () => {
  const { env, created } = mockEnv();
  const { db, fetchImpl } = fakeDb();
  const res = await withFetch(fetchImpl, () => post(env, { token: TOKEN, amount: '49', email: 'owner@pr73.com', run: 'on' }));
  assert.equal(res.status, 303);
  assert.match(res.headers.get('Location'), /&started=[0-9a-f-]{36}#report$/);
  const p = db.payments[0];
  assert.equal(p.amount_cents, 4900);
  assert.equal(p.livemode, true, 'money taken outside Stripe counts as revenue');
  assert.equal(p.customer_email, 'owner@pr73.com');
  assert.deepEqual(p.addons, []);
  assert.equal(created.length, 1);
  assert.equal(created[0].params.reportToken, TOKEN, 'same link');
  const row = db.scanRows[0];
  assert.equal(row.trigger, 'paid', 'counted as a full-audit scan in the cost tables');
  assert.equal(row.report_token, TOKEN);
  assert.equal(row.business_name, 'PR 73', 'its API cost is tied to PR 73');
});

test('routes: /admin/report/breakdown adds the Breakdown to an unlocked report only, no API calls', async () => {
  const bd = (env, fields, headers = bearer) => call(env, '/admin/report/breakdown', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
  });
  assert.equal((await bd({ ADMIN_TOKEN: ' ' }, { token: TOKEN })).status, 404, 'no ADMIN_TOKEN');
  const { env, created } = mockEnv();
  // Locked report: refused.
  const locked = fakeDb();
  await withFetch(locked.fetchImpl, async () => {
    assert.equal((await bd(env, { token: TOKEN }, {})).status, 303, 'unauthenticated → the login page');
    assert.equal((await bd(env, { token: TOKEN })).status, 422, 'unlock first');
  });
  assert.equal(locked.db.payments.length, 0);
  // Audit bought on Stripe without the add-on: the page offers "Add Competitor Breakdown", and it works once.
  const paid = fakeDb({ payments: [{ tier: 'xray', amount_cents: 4900, addons: [], livemode: true, stripe_session_id: 'cs_live_1', paid_at: '2026-10-02T12:00:00Z' }] });
  await withFetch(paid.fetchImpl, async () => {
    const page = await (await call(env, `/admin?report=${TOKEN}`, { headers: bearer })).text();
    assert.match(page, /action="\/admin\/report\/breakdown"/);
    const r = await bd(env, { token: TOKEN, amount: '25' });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('Location'), /&breakdown=1#report$/);
    assert.equal((await bd(env, { token: TOKEN })).status, 409, 'already has it');
    const after = await (await call(env, `/admin?report=${TOKEN}&breakdown=1`, { headers: bearer })).text();
    assert.doesNotMatch(after, /action="\/admin\/report\/breakdown"/);
    assert.match(after, /Competitor Breakdown added/);
  });
  const p = paid.db.payments[1];
  assert.equal(p.tier, 'competitor_breakdown');
  assert.equal(p.amount_cents, 2500);
  assert.equal(p.livemode, true);
  assert.equal(created.length, 0, 'no scan');
});
