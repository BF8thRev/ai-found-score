// Cold-email tracking (the "email" arm): opens, clicks, unsubscribes, and the attribution token that
// carries a click through to a free-report request. Tables and views: supabase/v12_email_tracking.sql.
//
//   GET /e/open?token=…              1x1 GIF; logs 'opened' (first one wins)
//   GET /e/click?token=…&to=<url>    logs 'clicked', sets the afs_ref cookie, 302 to <url>?ref=…
//                                    (aifoundscore.com only: anything else goes to the homepage)
//   /stop?ref=…                      the unsubscribe link (worker.js handleUnsubscribe → logEmailEvent)
//
// The token is generic ("ref"): a request from the homepage form picks it up from the cookie (or a
// posted `ref`) and saves it on report_requests.ref_token. Postcards and later channels can reuse it.
// Tracking never blocks anything: every write here is best-effort, and a bad token still redirects.
//
// recordEmailSent() writes the 'sent' row: /admin "Log a sent email" (manual Gmail sends) today, the
// Gmail API sender later. One token per (business, campaign): logging the same pair twice returns the
// first token, so the snippet pasted into the email always matches the row.

import { resolveKeys } from '../../scanner/config.js';

export const REF_COOKIE = 'afs_ref';
export const REF_PARAM = 'ref';
export const TOKEN_RE = /^[A-Za-z0-9_-]{12,64}$/;
// Campaign names: plain words (no * or %, which the business+campaign lookup would read as wildcards).
export const CAMPAIGN_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
export const ARM_EMAIL = 'email';
export const FOOTER_ADDRESS = '120 Terminal Drive, Plainview, NY 11803';
const REF_DAYS = 30;
const ALLOWED_HOSTS = new Set(['aifoundscore.com', 'www.aifoundscore.com']);

// Link scanners (Outlook Safe Links, Proofpoint, …) follow every link in a message: they still get
// redirected, but a click is not logged for them. Same list as the report-page visit beacon.
const BOT_UA = /bot|crawl|spider|slurp|preview|headless|phantom|python|curl|wget|java\/|go-http|okhttp|scanner|safelinks|proofpoint|mimecast|barracuda|forcepoint/i;

// A transparent 1x1 GIF.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' };

/** A new random token: 22 URL-safe characters (128 bits). */
export function newTrackingToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const validToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/**
 * Where a click may go: an http(s) address on aifoundscore.com (or on this Worker's own host, for
 * previews and local runs). Anything else → null, so /e/click can't be used to bounce people elsewhere.
 */
export function safeDestination(to, requestUrl) {
  if (!to) return null;
  let u;
  try { u = new URL(String(to), requestUrl.origin); } catch { return null; }
  const own = u.host === requestUrl.host;
  if (!own && !ALLOWED_HOSTS.has(u.hostname)) return null;
  if (u.protocol !== 'https:' && !(own && u.protocol === requestUrl.protocol)) return null;
  if (u.username || u.password) return null;
  return u;
}

/** The afs_ref cookie: first-party, 30 days, shared by www and the bare domain in production. */
export function refCookie(token, requestUrl) {
  const domain = ALLOWED_HOSTS.has(requestUrl.hostname) ? '; Domain=aifoundscore.com' : '';
  const secure = requestUrl.protocol === 'https:' ? '; Secure' : '';
  return `${REF_COOKIE}=${token}; Path=/; Max-Age=${REF_DAYS * 86400}; SameSite=Lax; HttpOnly${secure}${domain}`;
}

/** The attribution token for a request: a posted `ref` first, else the afs_ref cookie. null if neither is valid. */
export function readRefToken(request, data = {}) {
  const posted = String(data?.[REF_PARAM] ?? '').trim();
  if (validToken(posted)) return posted;
  const cookie = request?.headers?.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)afs_ref=([A-Za-z0-9_-]{12,64})(?:;|$)/);
  return m ? m[1] : null;
}

/**
 * Log 'opened' / 'clicked' / 'unsubscribed' for a token (the log_email_event RPC, anon key). First
 * event wins; an 'unsubscribed' also writes the unsubscribes row. → true when the token is known.
 * Throws only on a network or database error.
 */
export async function logEmailEvent(env, { token, event, detail = null, userAgent = null }, { fetchImpl = fetch } = {}) {
  if (!validToken(token)) return false;
  const key = String(env.SUPABASE_ANON_KEY || '').trim();
  if (!env.SUPABASE_URL || !key) return false;
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/log_email_event`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token, p_event: event, p_detail: detail, p_user_agent: userAgent ? String(userAgent).slice(0, 500) : null }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`log_email_event failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) === true;
}

function later(ctx, p) {
  const safe = p.catch((e) => console.error('[email-tracking]', String(e?.message || e).slice(0, 200)));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(safe);
  return safe;
}

/** GET /e/open: always the GIF, never cached; the open is logged after the response. */
export function handleEmailOpen(request, url, env, ctx, deps = {}) {
  const token = url.searchParams.get('token') || '';
  if (validToken(token) && request.method === 'GET') {
    later(ctx, logEmailEvent(env, { token, event: 'opened', userAgent: request.headers.get('User-Agent') }, deps));
  }
  return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Content-Length': String(GIF.length), ...NO_STORE } });
}

/** GET /e/click: 302 to an allowed destination (else the homepage) with ?ref=, and the afs_ref cookie. */
export function handleEmailClick(request, url, env, ctx, deps = {}) {
  const token = url.searchParams.get('token') || '';
  const dest = safeDestination(url.searchParams.get('to'), url) || new URL('/', url.origin);
  const headers = { ...NO_STORE, 'Referrer-Policy': 'no-referrer' };
  if (validToken(token)) {
    dest.searchParams.set(REF_PARAM, token);
    headers['Set-Cookie'] = refCookie(token, url);
    const ua = request.headers.get('User-Agent') || '';
    if (request.method === 'GET' && !BOT_UA.test(ua)) {
      later(ctx, logEmailEvent(env, { token, event: 'clicked', detail: dest.pathname, userAgent: ua }, deps));
    }
  }
  headers.Location = dest.toString();
  return new Response(null, { status: 302, headers });
}

// ---- 'sent' rows (service key) ---------------------------------------------------------------

function service(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

/**
 * Write the 'sent' row for one email (or return the one already there for this business + campaign).
 * @param {object} sent - { businessId, campaign, email?, town?, reportToken?, arm?, sentAt? }
 * @returns {Promise<{ token: string, existing: boolean }>}
 */
export async function recordEmailSent(env, sent, { fetchImpl = fetch } = {}) {
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const campaign = String(sent.campaign || '').trim().slice(0, 80);
  if (!sent.businessId || !CAMPAIGN_RE.test(campaign)) throw new Error('businessId and a campaign name (letters, numbers, spaces, . _ -) are required');
  const find = async () => {
    const q = `email_events?select=token&event=eq.sent&business_id=eq.${encodeURIComponent(sent.businessId)}&campaign=ilike.${encodeURIComponent(campaign.replace(/[%_\\]/g, '\\$&'))}&limit=1`;
    const r = await fetchImpl(`${s.base}/${q}`, { headers: s.headers });
    if (!r.ok) throw new Error(`email_events read failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const [row] = await r.json();
    return row?.token || null;
  };
  const prior = await find();
  if (prior) return { token: prior, existing: true };
  // Times come from the database (sent_at / occurred_at default now()) unless the sender passes its
  // own: the open and click events are stamped there too, so they always sort after the send.
  const at = sent.sentAt ? { sent_at: sent.sentAt, occurred_at: sent.sentAt } : {};
  const row = {
    business_id: sent.businessId,
    arm: sent.arm || ARM_EMAIL,
    campaign,
    token: newTrackingToken(),
    event: 'sent',
    email: sent.email ? String(sent.email).trim().toLowerCase().slice(0, 160) : null,
    town: sent.town ? String(sent.town).trim().slice(0, 60) : null,
    report_token: sent.reportToken || null,
    ...at,
  };
  const res = await fetchImpl(`${s.base}/email_events`, { method: 'POST', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (res.ok) return { token: row.token, existing: false };
  // Two saves at once: the unique (business, campaign) index kept the first one. Use it.
  if (res.status === 409) {
    const again = await find();
    if (again) return { token: again, existing: true };
  }
  throw new Error(`email_events insert failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

// ---- what goes into the email ------------------------------------------------------------------

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A tracked link: /e/click on `base` that lands on `to`. */
export function clickUrl(base, token, to) {
  return `${base}/e/click?token=${encodeURIComponent(token)}&to=${encodeURIComponent(to)}`;
}

/**
 * Everything to paste into a hand-sent email for one token.
 * base: the site origin (https://www.aifoundscore.com in production).
 * → { pixelUrl, stopUrl, links: [{ label, url, to }], footerHtml, footerText }
 */
export function trackingSnippet(base, { token, reportToken = null }) {
  const links = [{ label: 'Free Snapshot (the homepage form)', to: `${base}/` }];
  if (reportToken) links.push({ label: 'Their report', to: `${base}/report/${encodeURIComponent(reportToken)}` });
  for (const l of links) l.url = clickUrl(base, token, l.to);
  const pixelUrl = `${base}/e/open?token=${encodeURIComponent(token)}`;
  const stopUrl = `${base}/stop?${REF_PARAM}=${encodeURIComponent(token)}`;
  const footerText = `AI Found Score · ${FOOTER_ADDRESS}\nDon't want these emails? ${stopUrl}`;
  const footerHtml = `<p style="font-size:12px;color:#666">AI Found Score · ${escHtml(FOOTER_ADDRESS)}<br>`
    + `Don't want these emails? <a href="${escHtml(stopUrl)}">Unsubscribe</a></p>`
    + `<img src="${escHtml(pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
  return { pixelUrl, stopUrl, links, footerHtml, footerText };
}
