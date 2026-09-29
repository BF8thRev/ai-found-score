// The Gmail sender (src/lib/gmail-sender.js): MIME + footer, the token cache, every gate before a
// send (credentials, outreach switch, own-address, unsubscribes, pause, cap, 5 s gap), the log row,
// and auth / limit failures pausing everything. Google, Gmail, Supabase and Resend are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendViaGmail, buildMime, headerValue, base64url, footerFor, withFooter, getAccessToken, clearTokenCache,
  dailyCap, outreachEnabled, isOwnAddress, gmailStatus, testRecipients, GmailAuthError,
} from '../gmail-sender.js';
import { fakeGmail, decodeRaw, GMAIL_ENV as ENV } from './fake-gmail.js';

const ME = 'bryan@getaifoundscore.com';
const MAIL = { to: ME, subject: 'Hello', text: 'Line one.\nLine two.' };
const send = (fake, msg = MAIL, env = ENV) => sendViaGmail(env, msg, { fetchImpl: fake.impl });

test.beforeEach(() => clearTokenCache());

// ---- pure pieces ----------------------------------------------------------------------------

test('settings: cap defaults to 150, outreach is off unless "on", own addresses only', () => {
  assert.equal(dailyCap({}), 150);
  assert.equal(dailyCap({ GMAIL_DAILY_CAP: '40' }), 40);
  assert.equal(dailyCap({ GMAIL_DAILY_CAP: '0' }), 0);
  for (const bad of ['-1', 'lots', '2.5']) assert.equal(dailyCap({ GMAIL_DAILY_CAP: bad }), 150, bad);
  assert.equal(outreachEnabled({}), false);
  assert.equal(outreachEnabled({ GMAIL_OUTREACH: 'off' }), false);
  assert.equal(outreachEnabled({ GMAIL_OUTREACH: ' ON ' }), true);
  assert.equal(isOwnAddress(ENV, 'hello@getaifoundscore.com'), true);
  assert.equal(isOwnAddress(ENV, 'Bryan.Fields@8threv.com'), true, 'ALERT_EMAILS');
  assert.equal(isOwnAddress(ENV, 'owner@plumber.com'), false);
  assert.equal(isOwnAddress(ENV, 'x@getaifoundscore.com.evil.com'), false);
  assert.deepEqual(testRecipients(ENV), [ME, 'bryan.fields@8threv.com']);
});

test('gmailStatus: says which secrets are set, never their values', () => {
  const s = gmailStatus({ ...ENV, GMAIL_REFRESH_TOKEN: ' ' });
  assert.equal(s.configured, false);
  assert.deepEqual(s.secrets, { GMAIL_CLIENT_ID: true, GMAIL_CLIENT_SECRET: true, GMAIL_REFRESH_TOKEN: false });
  const flat = JSON.stringify(gmailStatus(ENV));
  for (const v of [ENV.GMAIL_CLIENT_ID, ENV.GMAIL_CLIENT_SECRET, ENV.GMAIL_REFRESH_TOKEN]) assert.ok(!flat.includes(v));
});

test('headerValue: no CR/LF (no header injection); non-ASCII is RFC 2047', () => {
  assert.equal(headerValue('Hi\r\nBcc: victim@x.com'), 'Hi Bcc: victim@x.com');
  assert.match(headerValue('Café ✓'), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.equal(headerValue('Plain'), 'Plain');
});

test('buildMime + base64url: a multipart message Gmail can take; UTF-8 bodies survive', () => {
  const raw = base64url(buildMime({ from: 'Bryan Fields <bryan@getaifoundscore.com>', to: 'a@b.com', subject: 'Test', text: 'Héllo — ok', html: '<p>Héllo</p>', headers: { 'List-Unsubscribe': '<https://x/u>' }, boundary: 'B' }));
  assert.ok(!/[+/=]/.test(raw), 'base64url, unpadded');
  const d = decodeRaw(raw);
  assert.match(d.head, /^From: Bryan Fields <bryan@getaifoundscore\.com>\r\nTo: a@b\.com\r\nSubject: Test\r\nMIME-Version: 1\.0\r\n/);
  assert.match(d.head, /List-Unsubscribe: <https:\/\/x\/u>/);
  assert.match(d.head, /Content-Type: multipart\/alternative; boundary="B"/);
  assert.equal(d.text, 'Héllo — ok');
  assert.equal(d.html, '<p>Héllo</p>');
  assert.ok(d.mime.endsWith('--B--\r\n'));
});

test('footer: postal address + unsubscribe always; a tracked email gets /stop?ref= and the pixel', () => {
  const plain = footerFor({});
  assert.match(plain.text, /120 Terminal Drive, Plainview, NY 11803/);
  assert.equal(plain.unsubUrl, 'https://aifoundscore.com/unsubscribe');
  assert.ok(!plain.html.includes('/e/open'));
  const tracked = footerFor({}, { token: 'Abcdefghij_klmnop-123' });
  assert.equal(tracked.unsubUrl, 'https://aifoundscore.com/stop?ref=Abcdefghij_klmnop-123');
  assert.match(tracked.html, /\/e\/open\?token=Abcdefghij_klmnop-123/);
  const body = withFooter({ text: 'Hi', html: '<html><body><p>Hi</p></body></html>' }, plain);
  assert.ok(body.html.indexOf('Terminal Drive') < body.html.indexOf('</body>'), 'footer inside body');
  assert.match(withFooter({ text: 'a <b>' }, plain).html, /^<p>a &lt;b&gt;<\/p>/, 'html made from text, escaped');
});

// ---- the access token -----------------------------------------------------------------------

test('getAccessToken: one exchange, reused for 55 min, then refreshed; a refusal is a GmailAuthError', async () => {
  const f = fakeGmail();
  const t0 = Date.parse('2026-09-29T14:00:00Z');
  assert.equal(await getAccessToken(ENV, { fetchImpl: f.impl, now: t0 }), 'access-1');
  assert.equal(await getAccessToken(ENV, { fetchImpl: f.impl, now: t0 + 54 * 60 * 1000 }), 'access-1');
  assert.equal(f.tokenCalls, 1);
  assert.equal(await getAccessToken(ENV, { fetchImpl: f.impl, now: t0 + 56 * 60 * 1000 }), 'access-2');
  clearTokenCache();
  f.tokenStatus = 400;
  await assert.rejects(getAccessToken(ENV, { fetchImpl: f.impl }), (e) => e instanceof GmailAuthError && /invalid_grant/.test(e.message) && !e.message.includes(ENV.GMAIL_CLIENT_SECRET));
});

// ---- sendViaGmail ---------------------------------------------------------------------------

test('send: token exchange → Gmail send with the footer and List-Unsubscribe → row gets the message id', async () => {
  const f = fakeGmail();
  const r = await send(f);
  assert.deepEqual(r, { ok: true, id: 'send-1', messageId: 'msg-1' });
  assert.equal(f.gmail.length, 1);
  const [g] = f.gmail;
  assert.equal(g.auth, 'Bearer access-1');
  assert.match(g.decoded.head, /^From: Bryan Fields <bryan@getaifoundscore\.com>\r\nTo: bryan@getaifoundscore\.com\r\nSubject: Hello/);
  assert.match(g.decoded.head, /List-Unsubscribe: <https:\/\/aifoundscore\.com\/unsubscribe>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(g.decoded.text, /^Line one\.\nLine two\.\n\n--\n.*120 Terminal Drive, Plainview, NY 11803\nDon't want these emails\? Unsubscribe: https:\/\/aifoundscore\.com\/unsubscribe$/s);
  assert.match(g.decoded.html, /120 Terminal Drive/);
  assert.equal(f.sends[0].status, 'sent');
  assert.equal(f.sends[0].message_id, 'msg-1');
  assert.equal(f.claims[0].p_daily_cap, 150);
  assert.equal(f.claims[0].p_gap_seconds, 5);
});

test('send: nothing leaves when a gate says no (and nothing is claimed before the gates pass)', async () => {
  const cases = [
    [{ ...ENV, GMAIL_CLIENT_SECRET: '' }, MAIL, 'not configured'],
    [ENV, { ...MAIL, to: 'owner@plumber.com' }, 'not our address'],
    [ENV, { ...MAIL, to: 'bryan@getaifoundscore.com\r\nBcc: x@y.com' }, 'bad address'],
    [ENV, { ...MAIL, kind: 'outreach', to: 'owner@plumber.com' }, 'outreach off'],
    [{ ...ENV, GMAIL_OUTREACH: 'off' }, { ...MAIL, kind: 'outreach', to: 'owner@plumber.com' }, 'outreach off'],
    [ENV, { ...MAIL, subject: '' }, 'subject and text are required'],
  ];
  for (const [env, msg, reason] of cases) {
    const f = fakeGmail();
    assert.equal((await send(f, msg, env)).reason, reason, reason);
    assert.equal(f.claims.length + f.gmail.length + f.tokenCalls, 0, reason);
  }
});

test('send: an unsubscribed address, or a failed unsubscribe check, sends nothing', async () => {
  const f = fakeGmail({ unsubscribed: [ME] });
  assert.equal((await send(f)).reason, 'suppressed');
  const down = fakeGmail({ supabaseDown: true });
  assert.equal((await send(down)).reason, 'suppressed', 'fails closed');
  assert.equal(f.gmail.length + down.gmail.length + f.claims.length, 0);
});

test('send: paused → nothing sent', async () => {
  const f = fakeGmail({ paused: true });
  const r = await send(f);
  assert.equal(r.reason, 'paused');
  assert.equal(f.gmail.length, 0);
});

test('send: one every 5 seconds; retryAfter says how long', async () => {
  const f = fakeGmail();
  assert.equal((await send(f)).ok, true);
  f.tick(2000);
  const r = await send(f);
  assert.equal(r.reason, 'rate');
  assert.equal(r.retryAfter, 3);
  f.tick(3000);
  assert.equal((await send(f)).ok, true);
  assert.equal(f.gmail.length, 2);
  assert.equal(f.tokenCalls, 1, 'the access token was reused');
});

test('send: the daily cap (GMAIL_DAILY_CAP) stops sends', async () => {
  const f = fakeGmail();
  const env = { ...ENV, GMAIL_DAILY_CAP: '2' };
  for (let i = 0; i < 2; i++) { assert.equal((await send(f, MAIL, env)).ok, true); f.tick(6000); }
  assert.equal((await send(f, MAIL, env)).reason, 'cap');
  assert.equal(f.gmail.length, 2);
});

test('send: outreach with GMAIL_OUTREACH=on uses the tracked footer and logs the token', async () => {
  const f = fakeGmail();
  const r = await send(f, { to: 'owner@plumber.com', subject: 'Hi', text: 'Body', kind: 'outreach', token: 'Abcdefghij_klmnop-123', campaign: 'test20-a' }, { ...ENV, GMAIL_OUTREACH: 'on' });
  assert.equal(r.ok, true);
  assert.match(f.gmail[0].decoded.head, /List-Unsubscribe: <https:\/\/aifoundscore\.com\/stop\?ref=Abcdefghij_klmnop-123>/);
  assert.match(f.gmail[0].decoded.html, /\/e\/open\?token=Abcdefghij_klmnop-123/);
  assert.equal(f.claims[0].p_kind, 'outreach');
  assert.equal(f.claims[0].p_token, 'Abcdefghij_klmnop-123');
  assert.equal(f.claims[0].p_campaign, 'test20-a');
});

test('send: a refused refresh token pauses ALL sending and emails ALERT_EMAILS; no fallback send', async () => {
  const f = fakeGmail({ tokenStatus: 400 });
  const r = await send(f);
  assert.equal(r.reason, 'auth');
  assert.equal(f.gmail.length, 0);
  assert.equal(f.state.paused, true);
  assert.match(f.state.reason, /Gmail auth failed.*refresh token/);
  assert.equal(f.sends[0].status, 'failed');
  assert.deepEqual(f.alerts.map((a) => a.to[0]).sort(), ['bryan.fields@8threv.com', ME]);
  assert.ok(f.alerts.every((a) => a.subject === 'Gmail sending is paused'));
  for (const a of f.alerts) for (const v of [ENV.GMAIL_CLIENT_SECRET, ENV.GMAIL_REFRESH_TOKEN]) assert.ok(!JSON.stringify(a).includes(v), 'no secrets in the alert');
  f.tick(6000);
  f.tokenStatus = 200;
  assert.equal((await send(f)).reason, 'paused', 'stays paused until Resume');
});

test('send: Gmail 401 retries once with a fresh token, then pauses', async () => {
  const f = fakeGmail({ sendStatus: 401 });
  const r = await send(f);
  assert.equal(r.reason, 'auth');
  assert.equal(f.gmail.length, 2, 'one retry');
  assert.equal(f.tokenCalls, 2);
  assert.equal(f.state.paused, true);
});

test('send: a Gmail sending-limit answer pauses; other Gmail errors just fail that send', async () => {
  const lim = fakeGmail({ sendStatus: 429, sendBody: '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}' });
  assert.equal((await send(lim)).reason, 'limit');
  assert.equal(lim.state.paused, true);
  assert.equal(lim.alerts.length, 2);
  const oops = fakeGmail({ sendStatus: 500 });
  const r = await send(oops);
  assert.equal(r.ok, false);
  assert.match(r.reason, /^Gmail 500/);
  assert.equal(oops.state.paused, false);
  assert.equal(oops.sends[0].status, 'failed');
  assert.equal(oops.alerts.length, 0);
});
