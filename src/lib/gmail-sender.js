// src/lib/gmail-sender.js — cold email through the Gmail API, as bryan@getaifoundscore.com.
//
// Resend (src/lib/email.js) forbids cold outreach, so outreach goes out here and nowhere else. The
// credential is send-only (the gmail.send scope): it can't read bounces or spam complaints. A person
// watches the bounce inbox and Google Postmaster Tools and presses Pause on /admin (#gmail) if
// complaints get near 0.3%.
//
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//                    Worker secrets (Cloudflare dashboard). Any unset → nothing sends.
//   GMAIL_FROM       optional, default "Bryan Fields <bryan@getaifoundscore.com>"
//   GMAIL_DAILY_CAP  attempts per day (America/New_York), default 150: a warm-up cap for a fresh sender
//   GMAIL_OUTREACH   "on" lets kind 'outreach' email prospects. Off until the EXP-001 read (Oct 5)
//                    picks the winning arm. Test sends to our own addresses work without it.
//
// sendViaGmail(), in order: credentials set → outreach switch / own-address check → address ok → not
// unsubscribed (fails closed) → claim_gmail_send() (supabase/v13_gmail_sender.sql: paused? daily cap?
// 5 s since the last attempt? then the gmail_sends row, all under one lock) → access token → send →
// the row gets the Gmail message id or the error. The footer (postal address + unsubscribe link) and
// the List-Unsubscribe headers are added here, so no caller can leave them out.
//
// A Gmail auth failure (refresh token revoked or expired) or a Gmail sending-limit error pauses all
// sending and emails ALERT_EMAILS. There is no fallback: nothing else sends cold email. Auth fix:
// re-issue the refresh token (ask Alfred), replace GMAIL_REFRESH_TOKEN, then Resume on /admin.

import { resolveKeys } from '../../scanner/config.js';
import { isSuppressed } from '../../outreach/suppression.js';
import { sendEmail, siteUrl, POSTAL } from './email.js';
import { alertEmails } from './alerts.js';
import { trackingSnippet, validToken, CAMPAIGN_RE } from './email-tracking.js';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
export const DEFAULT_FROM = 'Bryan Fields <bryan@getaifoundscore.com>';
export const DEFAULT_DAILY_CAP = 150;
export const GAP_SECONDS = 5;
export const OWN_DOMAIN = 'getaifoundscore.com';
export const SECRET_NAMES = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'];
// Access tokens last an hour; reuse one for 55 minutes at most.
const TOKEN_TTL_MS = 55 * 60 * 1000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v) => String(v ?? '').trim();

/** Which of the three secrets are set: { GMAIL_CLIENT_ID: true, … }. Never the values. */
export function gmailSecretsSet(env) {
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!clean(env?.[n])]));
}
export const gmailConfigured = (env) => Object.values(gmailSecretsSet(env)).every(Boolean);
export const outreachEnabled = (env) => clean(env?.GMAIL_OUTREACH).toLowerCase() === 'on';

/** GMAIL_DAILY_CAP as a whole number ≥ 0 (default 150). */
export function dailyCap(env) {
  const raw = clean(env?.GMAIL_DAILY_CAP);
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/** Addresses a test send may go to: ALERT_EMAILS plus anything @getaifoundscore.com. */
export function isOwnAddress(env, addr) {
  const a = clean(addr).toLowerCase();
  if (!EMAIL_RE.test(a)) return false;
  return a.endsWith(`@${OWN_DOMAIN}`) || alertEmails(env).map((x) => x.toLowerCase()).includes(a);
}

/** The addresses offered for a test send on /admin (ALERT_EMAILS, own domain first). */
export function testRecipients(env) {
  const list = alertEmails(env).map((a) => a.toLowerCase()).filter((a) => EMAIL_RE.test(a));
  return [...new Set(list)].sort((a, b) => Number(!a.endsWith(`@${OWN_DOMAIN}`)) - Number(!b.endsWith(`@${OWN_DOMAIN}`)));
}

/** What /admin shows about the sender (no secret values). */
export function gmailStatus(env) {
  return {
    secrets: gmailSecretsSet(env),
    configured: gmailConfigured(env),
    cap: dailyCap(env),
    outreach: outreachEnabled(env),
    from: clean(env?.GMAIL_FROM) || DEFAULT_FROM,
    testTo: testRecipients(env),
  };
}

// ---- MIME ----------------------------------------------------------------------------------------

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const utf8B64 = (t) => bytesToB64(new TextEncoder().encode(String(t)));
export const base64url = (t) => utf8B64(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A header value on one line (no CR/LF: no header injection); RFC 2047 when it isn't plain ASCII. */
export function headerValue(v) {
  const one = String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(one) ? one : `=?UTF-8?B?${utf8B64(one)}?=`;
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');

/**
 * The raw message: multipart/alternative (text + html), base64 bodies, CRLF line ends.
 * `headers` are added as given (values through headerValue).
 */
export function buildMime({ from, to, subject, text, html, headers = {}, boundary = `afs_${crypto.randomUUID()}` }) {
  const lines = [
    `From: ${headerValue(from)}`,
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(subject)}`,
    'MIME-Version: 1.0',
    ...Object.entries(headers).map(([k, v]) => `${String(k).replace(/[^A-Za-z0-9-]/g, '')}: ${headerValue(v)}`),
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8B64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(utf8B64(html)),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The footer every Gmail send carries: who we are, the postal address, the unsubscribe link, and for
 * a tracked outreach email the open pixel. → { text, html, unsubUrl }
 */
export function footerFor(env, { token = null } = {}) {
  const base = siteUrl(env);
  const t = token ? trackingSnippet(base, { token }) : null;
  const unsubUrl = t ? t.stopUrl : `${base}/unsubscribe`;
  const text = `\n\n--\n${POSTAL}\nDon't want these emails? Unsubscribe: ${unsubUrl}`;
  const html = `<p style="font-size:12px;color:#666;margin-top:24px">${escHtml(POSTAL)}<br>`
    + `Don't want these emails? <a href="${escHtml(unsubUrl)}">Unsubscribe</a></p>`
    + (t ? `<img src="${escHtml(t.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">` : '');
  return { text, html, unsubUrl };
}

/** The body with the footer in it (html: before </body> when there is one). */
export function withFooter({ text, html }, footer) {
  const h = String(html || `<p>${escHtml(text || '').replace(/\n/g, '<br>')}</p>`);
  const i = h.toLowerCase().lastIndexOf('</body>');
  return {
    text: `${String(text || '').replace(/\s+$/, '')}${footer.text}`,
    html: i >= 0 ? `${h.slice(0, i)}${footer.html}${h.slice(i)}` : `${h}${footer.html}`,
  };
}

// ---- Google OAuth --------------------------------------------------------------------------------

export class GmailAuthError extends Error {}

let cached = null; // { key, token, exp }: one per isolate

/** Forget the cached access token (tests; and after Gmail refuses one). */
export function clearTokenCache() { cached = null; }

/**
 * An access token from the refresh token, reused for up to 55 minutes. A refusal from Google's token
 * endpoint (4xx: invalid_grant, invalid_client, …) throws GmailAuthError; anything else throws Error.
 */
export async function getAccessToken(env, { fetchImpl = (...a) => fetch(...a), now = Date.now() } = {}) {
  const id = clean(env.GMAIL_CLIENT_ID);
  const refresh = clean(env.GMAIL_REFRESH_TOKEN);
  const key = `${id}\n${refresh}`;
  if (cached && cached.key === key && cached.exp > now) return cached.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: clean(env.GMAIL_CLIENT_SECRET), refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Google's error code only (e.g. invalid_grant): never the request, which holds the secrets.
    const what = `${res.status} ${String(body.error || '').slice(0, 60)}`.trim();
    if (res.status >= 400 && res.status < 500) throw new GmailAuthError(`Google token refused: ${what}`);
    throw new Error(`Google token endpoint: ${what}`);
  }
  const ttl = Math.min(TOKEN_TTL_MS, Math.max(60, Number(body.expires_in) || 3600) * 1000 - 5 * 60 * 1000);
  cached = { key, token: body.access_token, exp: now + Math.max(60 * 1000, ttl) };
  return cached.token;
}

// ---- Supabase (service key) ----------------------------------------------------------------------

function service(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function claimSend(env, s, row, fetchImpl) {
  const res = await fetchImpl(`${s.base}/rpc/claim_gmail_send`, {
    method: 'POST',
    headers: s.headers,
    body: JSON.stringify({
      p_kind: row.kind, p_to: row.to, p_subject: row.subject, p_token: row.token, p_campaign: row.campaign,
      p_daily_cap: dailyCap(env), p_gap_seconds: GAP_SECONDS,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`claim_gmail_send failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function finishSend(s, id, patch, fetchImpl) {
  try {
    const res = await fetchImpl(`${s.base}/gmail_sends?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...s.headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ ...patch, finished_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error('[gmail] could not update gmail_sends', res.status);
  } catch (e) {
    console.error('[gmail] could not update gmail_sends', String(e?.message || e).slice(0, 200));
  }
}

/** The Pause switch (sender_state 'gmail'). Throws on failure. */
export async function setGmailPaused(env, paused, reason = null, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const res = await fetchImpl(`${s.base}/sender_state?on_conflict=id`, {
    method: 'POST',
    headers: { ...s.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ id: 'gmail', paused: !!paused, reason: paused ? String(reason || 'Paused').slice(0, 300) : null, changed_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`sender_state update failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

async function pauseAndAlert(env, reason, deps) {
  const fetchImpl = deps.fetchImpl;
  try { await setGmailPaused(env, true, reason, { fetchImpl }); } catch (e) {
    console.error('[gmail] could not pause after', reason, String(e?.message || e).slice(0, 200));
  }
  const day = new Date().toISOString().slice(0, 10);
  const admin = `${siteUrl(env)}/admin#gmail`;
  const subject = 'Gmail sending is paused';
  const text = `All cold-email sending through Gmail stopped on its own.\n\nReason: ${reason}\n\nNothing else sends these emails. `
    + 'If it is an auth error, the refresh token needs re-issuing (ask Alfred), then GMAIL_REFRESH_TOKEN is replaced in the Worker. '
    + `Then press Resume on /admin: ${admin}`;
  const html = `<!doctype html><html><body style="font-family:sans-serif"><p><strong>All cold-email sending through Gmail stopped on its own.</strong></p>`
    + `<p>Reason: ${escHtml(reason)}</p><p>Nothing else sends these emails. If it is an auth error, the refresh token needs re-issuing (ask Alfred), then GMAIL_REFRESH_TOKEN is replaced in the Worker.</p>`
    + `<p>Then press <strong>Resume</strong> on <a href="${escHtml(admin)}">/admin</a>.</p></body></html>`;
  const send = deps.sendEmail || sendEmail;
  // An internal alert through Resend (transactional), not a fallback for the cold email.
  await Promise.all(alertEmails(env).map((to) => send(env, { to, subject, text, html, transactional: true, idempotencyKey: `gmail-paused:${day}:${to}` }, { fetchImpl })
    .catch((e) => console.error('[gmail] alert failed', String(e?.message || e).slice(0, 200)))));
}

// Gmail's own "you're sending too much" answers: stop everything rather than keep hitting it.
const LIMIT_RE = /dailyLimitExceeded|userRateLimitExceeded|rateLimitExceeded|sending limit/i;
const SCOPE_RE = /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|invalid_grant|unauthorized/i;

async function postToGmail(env, raw, deps, retried = false) {
  const token = await getAccessToken(env, deps);
  const res = await deps.fetchImpl(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.ok) {
    const j = await res.json().catch(() => ({}));
    return { ok: true, messageId: j.id || null };
  }
  const body = (await res.text().catch(() => '')).slice(0, 300);
  if (res.status === 401 && !retried) { clearTokenCache(); return postToGmail(env, raw, deps, true); }
  if (res.status === 401 || (res.status === 403 && SCOPE_RE.test(body))) throw new GmailAuthError(`Gmail refused the access token: ${res.status}`);
  if (res.status === 429 || (res.status === 403 && LIMIT_RE.test(body))) return { ok: false, limit: true, reason: `Gmail sending limit: ${res.status} ${body.slice(0, 150)}` };
  return { ok: false, reason: `Gmail ${res.status} ${body.slice(0, 200)}` };
}

/**
 * Send one email through Gmail. → { ok: true, id, messageId } | { ok: false, reason, retryAfter? }.
 * Never throws.
 *   kind 'test'      only to our own addresses (isOwnAddress); works while GMAIL_OUTREACH is off
 *   kind 'outreach'  to a prospect; refused unless GMAIL_OUTREACH is "on". `token` (from
 *                    recordEmailSent) puts the tracked unsubscribe link and the open pixel in the footer.
 * reason is one of: 'not configured', 'outreach off', 'not our address', 'bad address', 'suppressed',
 * 'paused', 'cap', 'rate' (retryAfter seconds), 'auth' (sending is now paused), 'limit' (paused), or
 * an error text.
 */
export async function sendViaGmail(env, { to, subject, text, html = null, kind = 'test', token = null, campaign = null, reportToken = null }, deps = {}) {
  const d = { ...deps, fetchImpl: deps.fetchImpl || ((...a) => fetch(...a)) };
  let claimed = null;
  let s = null;
  try {
    if (!gmailConfigured(env)) return { ok: false, reason: 'not configured' };
    const addr = clean(to).toLowerCase();
    if (!EMAIL_RE.test(addr) || /[\r\n,<>]/.test(addr)) return { ok: false, reason: 'bad address' };
    if (kind === 'outreach') {
      if (!outreachEnabled(env)) return { ok: false, reason: 'outreach off' };
      if (token != null && !validToken(token)) return { ok: false, reason: 'bad token' };
      if (campaign != null && !CAMPAIGN_RE.test(String(campaign))) return { ok: false, reason: 'bad campaign' };
    } else if (kind === 'test') {
      if (!isOwnAddress(env, addr)) return { ok: false, reason: 'not our address' };
    } else {
      return { ok: false, reason: 'bad kind' };
    }
    const subj = clean(subject);
    if (!subj || !clean(text)) return { ok: false, reason: 'subject and text are required' };

    s = service(env);
    if (!s) return { ok: false, reason: 'SUPABASE_SERVICE_KEY is not set' };

    // Unsubscribed (the address, or the business behind the report)? A failed check means no send.
    let suppressed = true;
    try { suppressed = await isSuppressed(env, { email: addr, ...(reportToken ? { reportToken } : {}) }, d.fetchImpl); } catch { suppressed = true; }
    if (suppressed) return { ok: false, reason: 'suppressed' };

    const claim = await claimSend(env, s, { kind, to: addr, subject: subj, token, campaign }, d.fetchImpl);
    if (!claim?.ok) {
      const reason = claim?.reason || 'claim refused';
      return { ok: false, reason, ...(claim?.retry_after ? { retryAfter: Number(claim.retry_after) } : {}), ...(claim?.detail ? { detail: claim.detail } : {}) };
    }
    claimed = claim.id;

    const footer = footerFor(env, { token: kind === 'outreach' ? token : null });
    const body = withFooter({ text, html }, footer);
    const raw = base64url(buildMime({
      from: clean(env.GMAIL_FROM) || DEFAULT_FROM,
      to: addr,
      subject: subj,
      text: body.text,
      html: body.html,
      headers: { 'List-Unsubscribe': `<${footer.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    }));

    const sent = await postToGmail(env, raw, d);
    if (sent.ok) {
      await finishSend(s, claimed, { status: 'sent', message_id: sent.messageId }, d.fetchImpl);
      return { ok: true, id: claimed, messageId: sent.messageId };
    }
    await finishSend(s, claimed, { status: 'failed', error: sent.reason.slice(0, 300) }, d.fetchImpl);
    if (sent.limit) {
      await pauseAndAlert(env, sent.reason, d);
      return { ok: false, reason: 'limit', detail: sent.reason };
    }
    return { ok: false, reason: sent.reason };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    if (claimed && s) await finishSend(s, claimed, { status: 'failed', error: msg }, d.fetchImpl);
    if (e instanceof GmailAuthError) {
      clearTokenCache();
      await pauseAndAlert(env, `Gmail auth failed (${msg}). The refresh token may need re-issuing.`, d);
      return { ok: false, reason: 'auth', detail: msg };
    }
    return { ok: false, reason: msg };
  }
}
