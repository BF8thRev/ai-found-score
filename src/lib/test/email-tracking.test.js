// Cold-email tracking: the pixel, the tracked link (aifoundscore.com only), the attribution token on
// free-report requests (never blocking), and the 'sent' row (one token per business + campaign).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeDestination, refCookie, readRefToken, newTrackingToken, validToken, handleEmailOpen, handleEmailClick,
  logEmailEvent, recordEmailSent, trackingSnippet, clickUrl, FOOTER_ADDRESS,
} from '../email-tracking.js';
import { recordReportRequest } from '../db.js';
import { handleReportRequest } from '../report-request.js';
import { REQUEST_ACTION } from '../turnstile.js';

const SITE = new URL('https://aifoundscore.com/e/click');
const TOKEN = 'Abcdefghij_klmnop-123';
const ENV = { SUPABASE_URL: 'https://db.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service' };

// Records every call; answers from `routes` (first matching [method, regex] wins).
function fakeFetch(routes = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), method, body, headers: init.headers || {} });
    for (const [m, re, answer] of routes) {
      if (m === method && re.test(String(url))) return typeof answer === 'function' ? answer({ url: String(url), body }) : answer;
    }
    return Response.json(true);
  };
  return { impl, calls };
}
const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p) }; };

test('tokens: 22 URL-safe characters, unique, valid', () => {
  const a = newTrackingToken();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, newTrackingToken());
  assert.equal(validToken(a), true);
  for (const bad of ['', 'short', 'has space in it!!', 'x'.repeat(65), null, 42]) assert.equal(validToken(bad), false, String(bad));
});

test('safeDestination: aifoundscore.com (and this host) only, https, no tricks', () => {
  assert.equal(safeDestination('https://aifoundscore.com/', SITE).href, 'https://aifoundscore.com/');
  assert.equal(safeDestination('https://www.aifoundscore.com/report/abc?x=1', SITE).pathname, '/report/abc');
  assert.equal(safeDestination('/report/abc', SITE).href, 'https://aifoundscore.com/report/abc', 'relative → our host');
  const local = new URL('http://localhost:8787/e/click');
  assert.equal(safeDestination('http://localhost:8787/', local).href, 'http://localhost:8787/', 'local preview');
  for (const bad of [
    'https://evil.example/', '//evil.example/x', 'https://aifoundscore.com.evil.example/', 'https://evilaifoundscore.com/',
    'javascript:alert(1)', 'data:text/html,hi', 'http://aifoundscore.com/', 'https://user:pw@aifoundscore.com/', '', null,
    'http://localhost:8787/',
  ]) assert.equal(safeDestination(bad, SITE), null, String(bad));
});

test('/e/click: logs the click after the redirect, sets the ref cookie and ?ref=, 302 to the destination', async () => {
  const f = fakeFetch();
  const c = ctx();
  const url = new URL(clickUrl('https://aifoundscore.com', TOKEN, 'https://aifoundscore.com/#request'));
  const res = handleEmailClick(new Request(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome' } }), url, ENV, c, { fetchImpl: f.impl });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname + loc.hash, 'https://aifoundscore.com/#request');
  assert.equal(loc.searchParams.get('ref'), TOKEN);
  assert.match(res.headers.get('Set-Cookie'), new RegExp(`^afs_ref=${TOKEN}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly; Secure; Domain=aifoundscore.com$`));
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  await Promise.all(c.waits);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://db.example/rest/v1/rpc/log_email_event');
  assert.deepEqual({ t: f.calls[0].body.p_token, e: f.calls[0].body.p_event, d: f.calls[0].body.p_detail }, { t: TOKEN, e: 'clicked', d: '/' });
  assert.equal(f.calls[0].headers.apikey, 'anon');
});

test('/e/click: a link scanner or HEAD is redirected but not counted; bad token / bad destination still land safely', async () => {
  for (const [ua, method] of [['Mozilla/5.0 (compatible; Proofpoint)', 'GET'], ['Mozilla/5.0 Chrome', 'HEAD']]) {
    const f = fakeFetch();
    const c = ctx();
    const url = new URL(clickUrl('https://aifoundscore.com', TOKEN, 'https://aifoundscore.com/'));
    const res = handleEmailClick(new Request(url, { method, headers: { 'User-Agent': ua } }), url, ENV, c, { fetchImpl: f.impl });
    assert.equal(res.status, 302);
    assert.equal(c.waits.length, 0, `${ua} ${method}`);
  }
  const off = new URL(clickUrl('https://aifoundscore.com', TOKEN, 'https://evil.example/phish'));
  const r1 = handleEmailClick(new Request(off), off, ENV, ctx(), { fetchImpl: fakeFetch().impl });
  assert.equal(new URL(r1.headers.get('Location')).hostname, 'aifoundscore.com', 'never off-site');
  const bad = new URL('https://aifoundscore.com/e/click?token=nope&to=https%3A%2F%2Faifoundscore.com%2F');
  const c2 = ctx();
  const r2 = handleEmailClick(new Request(bad), bad, ENV, c2, { fetchImpl: fakeFetch().impl });
  assert.equal(r2.headers.get('Location'), 'https://aifoundscore.com/');
  assert.equal(r2.headers.get('Set-Cookie'), null);
  assert.equal(c2.waits.length, 0);
});

test('/e/click: a failed log never breaks the redirect', async () => {
  const c = ctx();
  const url = new URL(clickUrl('https://aifoundscore.com', TOKEN, 'https://aifoundscore.com/'));
  const errors = [];
  const orig = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = handleEmailClick(new Request(url), url, ENV, c, { fetchImpl: async () => { throw new Error('db down'); } });
    assert.equal(res.status, 302);
    await Promise.all(c.waits);
  } finally { console.error = orig; }
  assert.match(errors.join(''), /db down/);
});

test('/e/open: a 1x1 GIF, never cached; GET logs the open, HEAD and bad tokens do not', async () => {
  const f = fakeFetch();
  const c = ctx();
  const url = new URL(`https://aifoundscore.com/e/open?token=${TOKEN}`);
  const res = handleEmailOpen(new Request(url), url, ENV, c, { fetchImpl: f.impl });
  assert.equal(res.headers.get('Content-Type'), 'image/gif');
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 6)), 'GIF89a');
  await Promise.all(c.waits);
  assert.equal(f.calls[0].body.p_event, 'opened');
  const c2 = ctx();
  handleEmailOpen(new Request(url, { method: 'HEAD' }), url, ENV, c2, { fetchImpl: f.impl });
  const bad = new URL('https://aifoundscore.com/e/open?token=x');
  handleEmailOpen(new Request(bad), bad, ENV, c2, { fetchImpl: f.impl });
  assert.equal(c2.waits.length, 0);
});

test('logEmailEvent: true for a known token, false for unknown / invalid / no key', async () => {
  assert.equal(await logEmailEvent(ENV, { token: TOKEN, event: 'opened' }, { fetchImpl: async () => Response.json(true) }), true);
  assert.equal(await logEmailEvent(ENV, { token: TOKEN, event: 'opened' }, { fetchImpl: async () => Response.json(false) }), false);
  let called = false;
  const spy = async () => { called = true; return Response.json(true); };
  assert.equal(await logEmailEvent(ENV, { token: 'bad', event: 'opened' }, { fetchImpl: spy }), false);
  assert.equal(await logEmailEvent({}, { token: TOKEN, event: 'opened' }, { fetchImpl: spy }), false);
  assert.equal(called, false);
  await assert.rejects(logEmailEvent(ENV, { token: TOKEN, event: 'opened' }, { fetchImpl: async () => new Response('x', { status: 500 }) }), /500/);
});

test('readRefToken: a posted ref first, else the cookie; junk is ignored', () => {
  const req = (cookie) => new Request('https://aifoundscore.com/api/request', { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(readRefToken(req(`a=1; afs_ref=${TOKEN}; b=2`), {}), TOKEN);
  assert.equal(readRefToken(req(`afs_ref=${TOKEN}`), { ref: 'Zyxwvutsrqponmlk' }), 'Zyxwvutsrqponmlk');
  assert.equal(readRefToken(req(`afs_ref=${TOKEN}`), { ref: 'no good!' }), TOKEN);
  assert.equal(readRefToken(req('afs_ref=<script>'), {}), null);
  assert.equal(readRefToken(req(null), {}), null);
  assert.equal(readRefToken(null, null), null);
});

test('refCookie: host-only and not Secure on a local preview', () => {
  const c = refCookie(TOKEN, new URL('http://localhost:8787/e/click'));
  assert.ok(!/Domain=|Secure/.test(c), c);
});

// ---- the request form ------------------------------------------------------------------------

const HOST = 'aifoundscore.com';
const TS_ENV = { TURNSTILE_SITE_KEY: '0x4AAAAAAFCuveyMfQ21Ntcr', TURNSTILE_SECRET_KEY: '0x4AAAAAAFrealsecretvalue000000000' };
const FORM = { business_name: 'Test Otter Plumbing', trade: 'plumbing', town: 'Massapequa', zip: '11758', state: 'NY', 'cf-turnstile-response': 'tok' };
const deps = (saved) => ({
  recordReportRequest: async (env, r) => { saved.push(r); return {}; },
  fetchImpl: async () => Response.json({ success: true, hostname: HOST, action: REQUEST_ACTION }),
  startRequestScan: async () => ({ token: 'Abc_def-1234567890XYZ', status: 'running' }),
  checkSubmission: async () => ({ ok: true }),
});
const post = (body, headers = {}) => new Request(`https://${HOST}/api/request`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('/api/request: the ref cookie from a tracked click rides on the request; none is fine too', async () => {
  const saved = [];
  const u = new URL(`https://${HOST}/api/request`);
  const r1 = await handleReportRequest(post(FORM, { Cookie: `afs_ref=${TOKEN}` }), u, TS_ENV, deps(saved));
  assert.equal((await r1.json()).ok, true);
  assert.equal(saved[0].refToken, TOKEN);
  const r2 = await handleReportRequest(post(FORM), u, TS_ENV, deps(saved));
  assert.equal((await r2.json()).ok, true);
  assert.equal(saved[1].refToken, null);
  const r3 = await handleReportRequest(post({ ...FORM, ref: '../../etc' }), u, TS_ENV, deps(saved));
  assert.equal((await r3.json()).ok, true, 'a junk ref never blocks the request');
  assert.equal(saved[2].refToken, null);
});

test('recordReportRequest: ref_token only when present; a refused ref_token is dropped, the request still saved', async () => {
  const bodies = [];
  const orig = globalThis.fetch;
  const warn = console.warn; console.warn = () => {};
  try {
    globalThis.fetch = async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); };
    await recordReportRequest(ENV, { businessName: 'A', town: 'B' });
    assert.equal('ref_token' in bodies[0], false);
    await recordReportRequest(ENV, { businessName: 'A', town: 'B', refToken: TOKEN });
    assert.equal(bodies[1].ref_token, TOKEN);
    bodies.length = 0;
    globalThis.fetch = async (url, init) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      return 'ref_token' in b ? new Response('column "ref_token" does not exist', { status: 400 }) : new Response(null, { status: 201 });
    };
    const { row } = await recordReportRequest(ENV, { businessName: 'A', town: 'B', refToken: TOKEN });
    assert.equal(bodies.length, 2);
    assert.equal('ref_token' in bodies[1], false);
    assert.equal(row.business_name, 'A');
  } finally { globalThis.fetch = orig; console.warn = warn; }
});

// ---- 'sent' rows ------------------------------------------------------------------------------

const BIZ = '11111111-1111-4111-8111-111111111111';

test('recordEmailSent: a new row (arm email, token, sent_at); the same business + campaign returns the first token', async () => {
  const f = fakeFetch([
    ['GET', /email_events\?/, Response.json([])],
    ['POST', /email_events$/, new Response(null, { status: 201 })],
  ]);
  const r = await recordEmailSent(ENV, { businessId: BIZ, campaign: 'test20_a', email: 'Owner@Shop.com', town: 'Hicksville', reportToken: 'rep123' }, { fetchImpl: f.impl });
  assert.equal(r.existing, false);
  assert.equal(validToken(r.token), true);
  const row = f.calls[1].body;
  assert.equal(row.arm, 'email');
  assert.equal(row.event, 'sent');
  assert.equal(row.token, r.token);
  assert.equal(row.email, 'owner@shop.com');
  assert.equal(row.report_token, 'rep123');
  assert.ok(!('sent_at' in row) && !('occurred_at' in row), 'the database stamps the time');
  const at = fakeFetch([['GET', /email_events\?/, Response.json([])], ['POST', /email_events$/, new Response(null, { status: 201 })]]);
  await recordEmailSent(ENV, { businessId: BIZ, campaign: 'c2', sentAt: '2026-09-28T10:00:00Z' }, { fetchImpl: at.impl });
  assert.equal(at.calls[1].body.sent_at, '2026-09-28T10:00:00Z', 'a sender may pass its own');
  assert.match(f.calls[0].url, /campaign=ilike\.test20%5C_a/, 'underscore is escaped, not a wildcard');
  assert.equal(f.calls[0].headers.apikey, 'service');

  const again = fakeFetch([['GET', /email_events\?/, Response.json([{ token: TOKEN }])]]);
  assert.deepEqual(await recordEmailSent(ENV, { businessId: BIZ, campaign: 'TEST20_A' }, { fetchImpl: again.impl }), { token: TOKEN, existing: true });
  assert.equal(again.calls.length, 1, 'no second row');
});

test('recordEmailSent: a race (409) returns the winner; bad input and no key throw', async () => {
  let reads = 0;
  const f = fakeFetch([
    ['GET', /email_events\?/, () => Response.json(reads++ ? [{ token: TOKEN }] : [])],
    ['POST', /email_events$/, new Response('duplicate', { status: 409 })],
  ]);
  assert.deepEqual(await recordEmailSent(ENV, { businessId: BIZ, campaign: 'c1' }, { fetchImpl: f.impl }), { token: TOKEN, existing: true });
  await assert.rejects(recordEmailSent(ENV, { businessId: BIZ, campaign: '*' }, { fetchImpl: f.impl }), /campaign/);
  await assert.rejects(recordEmailSent(ENV, { campaign: 'c1' }, { fetchImpl: f.impl }), /businessId/);
  await assert.rejects(recordEmailSent({}, { businessId: BIZ, campaign: 'c1' }), /SUPABASE_SERVICE_KEY/);
});

test('trackingSnippet: tracked links, the /stop link, the pixel, and the CAN-SPAM footer', () => {
  const s = trackingSnippet('https://aifoundscore.com', { token: TOKEN, reportToken: 'rep123' });
  assert.equal(s.links.length, 2);
  for (const l of s.links) {
    const u = new URL(l.url);
    assert.equal(u.pathname, '/e/click');
    assert.equal(u.searchParams.get('token'), TOKEN);
    assert.equal(u.searchParams.get('to'), l.to);
    assert.ok(safeDestination(l.to, SITE), 'lands on our site');
  }
  assert.equal(s.links[1].to, 'https://aifoundscore.com/report/rep123');
  assert.equal(s.stopUrl, `https://aifoundscore.com/stop?ref=${TOKEN}`);
  assert.equal(s.pixelUrl, `https://aifoundscore.com/e/open?token=${TOKEN}`);
  for (const text of [s.footerHtml, s.footerText]) {
    assert.ok(text.includes(FOOTER_ADDRESS), 'address');
    assert.ok(text.includes('120 Terminal Drive, Plainview, NY 11803'));
    assert.ok(text.includes(`/stop?ref=${TOKEN}`), 'unsubscribe');
  }
  assert.match(s.footerHtml, /<img src="https:\/\/aifoundscore\.com\/e\/open\?token=[^"]+" width="1" height="1"/);
  assert.equal(trackingSnippet('https://aifoundscore.com', { token: TOKEN }).links.length, 1, 'no report → the form link only');
});
