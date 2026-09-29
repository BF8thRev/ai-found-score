// /admin "Gmail sender" through the real router (handleAdminRequest): Pause / Resume, a test send to
// our own address, the section on the page, and the new routes gated + CSRF-checked like the rest.
// Google, Gmail, Supabase and Resend are fakes (src/lib/test/fake-gmail.js): nothing real is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../routes.js';
import { signSession, SESSION_COOKIE } from '../session.js';
import { clearTokenCache } from '../../lib/gmail-sender.js';
import { fakeGmail, withFetch, GMAIL_ENV } from '../../lib/test/fake-gmail.js';

const SECRET = 'test-admin-token-1234567890';
const ORIGIN = 'https://aifoundscore.com';
const BEARER = { Authorization: `Bearer ${SECRET}` };
const FORM_H = { 'Content-Type': 'application/x-www-form-urlencoded' };
const ENV = { ...GMAIL_ENV, ADMIN_TOKEN: SECRET };
const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
  const url = new URL(path, ORIGIN);
  return handleAdminRequest(new Request(url, { method, headers, body, redirect: 'manual' }), url, env);
};
const post = (path, fields, env = ENV) => call(env, path, { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: new URLSearchParams(fields).toString() });
const loc = (r) => { const u = new URL(r.headers.get('Location')); return u.pathname + u.search + u.hash; };
const section = (html) => html.slice(html.indexOf('<section id="gmail">'), html.indexOf('</section>', html.indexOf('<section id="gmail">')));

test.beforeEach(() => clearTokenCache());

test('route: the page shows the Gmail sender (running, cap, outreach off, credentials, test form)', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    const r = await call(ENV, '/admin', { headers: BEARER });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<a href="#gmail">Gmail<\/a>/);
    const s = section(html);
    assert.match(s, /Running/);
    assert.match(s, /0 of 150/);
    assert.match(s, /Emails to prospects:<\/b> <span class="badge t-neutral">Off<\/span>/);
    assert.match(s, /Gmail credentials:<\/b> <span class="badge t-good">set/);
    assert.match(s, /action="\/admin\/gmail\/pause"/);
    assert.match(s, /<option value="bryan@getaifoundscore\.com">/);
    assert.ok(!/owner@|plumber/.test(s));
    for (const v of [GMAIL_ENV.GMAIL_CLIENT_ID, GMAIL_ENV.GMAIL_CLIENT_SECRET, GMAIL_ENV.GMAIL_REFRESH_TOKEN]) assert.ok(!html.includes(v), 'no secret on the page');
  });
});

test('route: Pause → sender_state paused (with the reason) → page says PAUSED → Resume turns it back on', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    const p = await post('/admin/gmail/pause', { reason: 'complaints 0.25%' });
    assert.equal(p.status, 303);
    assert.equal(loc(p), '/admin?gmail=paused#gmail');
    assert.equal(f.state.paused, true);
    assert.equal(f.state.reason, 'Paused from /admin: complaints 0.25%');
    const page = await (await call(ENV, '/admin?gmail=paused', { headers: BEARER })).text();
    const s = section(page);
    assert.match(s, /All Gmail sending is paused\./);
    assert.match(s, /PAUSED<\/span> Paused from \/admin: complaints 0\.25%/);
    assert.match(s, /action="\/admin\/gmail\/resume"/);
    // While paused, a test send goes nowhere.
    const t = await post('/admin/gmail/test', { to: 'bryan@getaifoundscore.com' });
    assert.equal(t.status, 409);
    assert.match(await t.text(), /Sending is paused/);
    assert.equal(f.gmail.length, 0);
    const r = await post('/admin/gmail/resume', {});
    assert.equal(loc(r), '/admin?gmail=resumed#gmail');
    assert.equal(f.state.paused, false);
    assert.equal(f.state.reason, null);
  });
});

test('route: test send → one Gmail message to our address with the footer → flash + row with message id', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    const r = await post('/admin/gmail/test', { to: 'bryan@getaifoundscore.com' });
    assert.equal(r.status, 303);
    assert.equal(loc(r), '/admin?gmail=sent#gmail');
    assert.equal(f.gmail.length, 1);
    assert.match(f.gmail[0].decoded.head, /To: bryan@getaifoundscore\.com\r\nSubject: AI Found Score: Gmail sender test/);
    assert.match(f.gmail[0].decoded.text, /120 Terminal Drive, Plainview, NY 11803/);
    assert.equal(f.sends[0].kind, 'test');
    assert.equal(f.sends[0].message_id, 'msg-1');
    const s = section(await (await call(ENV, '/admin?gmail=sent', { headers: BEARER })).text());
    assert.match(s, /Test email sent/);
    assert.match(s, /1 of 150/);
    assert.match(s, /id msg-1/);
    // A second one inside 5 seconds is refused, with the wait.
    const again = await post('/admin/gmail/test', { to: 'bryan@getaifoundscore.com' });
    assert.equal(again.status, 429);
    assert.match(await again.text(), /One send every 5 seconds/);
    assert.equal(f.gmail.length, 1);
  });
});

test('route: test send to anyone but us is refused before anything is claimed or sent', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    for (const to of ['owner@plumber.com', '', 'bryan@getaifoundscore.com\r\nBcc: x@y.com']) {
      const r = await post('/admin/gmail/test', { to });
      assert.equal(r.status, 422, to);
      assert.match(await r.text(), /only go to our own addresses/);
    }
    assert.equal(f.claims.length + f.gmail.length, 0);
  });
});

test('route: missing secrets → 503 and a plain message; auth failure → paused + alert emails', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    const r = await post('/admin/gmail/test', { to: 'bryan@getaifoundscore.com' }, { ...ENV, GMAIL_REFRESH_TOKEN: '' });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /secrets .* are not all set/);
  });
  const bad = fakeGmail({ tokenStatus: 400 });
  await withFetch(bad, async () => {
    const r = await post('/admin/gmail/test', { to: 'bryan@getaifoundscore.com' });
    assert.equal(r.status, 502);
    const html = await r.text();
    assert.match(html, /Gmail refused the login, so all sending is now paused/);
    assert.ok(!html.includes(GMAIL_ENV.GMAIL_CLIENT_SECRET) && !html.includes(GMAIL_ENV.GMAIL_REFRESH_TOKEN));
    assert.equal(bad.state.paused, true);
    assert.equal(bad.alerts.length, 2);
  });
});

test('route: the Gmail routes are gated and CSRF-checked like the rest', async () => {
  const f = fakeGmail();
  await withFetch(f, async () => {
    const cookie = `${SESSION_COOKIE}=${await signSession(SECRET)}`;
    for (const path of ['/admin/gmail/pause', '/admin/gmail/resume', '/admin/gmail/test']) {
      const body = new URLSearchParams({ to: 'bryan@getaifoundscore.com' }).toString();
      assert.equal((await call({ ...ENV, ADMIN_TOKEN: ' ' }, path, { method: 'POST', headers: FORM_H, body })).status, 404, `${path}: no ADMIN_TOKEN`);
      const anon = await call(ENV, path, { method: 'POST', headers: { ...FORM_H, Origin: ORIGIN }, body });
      assert.equal(anon.status, 303);
      assert.equal(loc(anon), '/admin', `${path}: to the sign-in page`);
      const csrf = await call(ENV, path, { method: 'POST', headers: { ...FORM_H, Cookie: cookie, Origin: 'https://evil.example' }, body });
      assert.equal(csrf.status, 403, `${path}: CSRF`);
      const get = await call(ENV, path, { headers: BEARER });
      assert.equal(get.status, 303, `${path}: GET goes back to the page`);
      assert.equal(loc(get), '/admin#gmail');
    }
    assert.equal(f.claims.length + f.gmail.length, 0);
    assert.equal(f.state.paused, false);
    // With a signed-in cookie and our own Origin, the form works (what the browser does).
    const ok = await call(ENV, '/admin/gmail/pause', { method: 'POST', headers: { ...FORM_H, Cookie: cookie, Origin: ORIGIN }, body: '' });
    assert.equal(ok.status, 303);
    assert.equal(f.state.paused, true);
  });
});
