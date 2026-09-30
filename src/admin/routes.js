// src/admin/routes.js — everything under /admin and /api/admin/*.
//
//   GET  /admin                 dashboard (or the sign-in form)
//   POST /admin/login           ADMIN_TOKEN → signed session cookie (12h), 303 → /admin
//   POST /admin/logout          clears the cookie (GET works too)
//   POST /admin/expenses        add a manual expense
//   POST /admin/scan            start a background scan from the form
//   POST /admin/scan/run        "Run now" for a queued (or failed) free-report request scan (src/lib/auto-scan.js)
//   POST /admin/email/sent      log a hand-sent cold email → 303 /admin?sent=<token> (shows the links to paste; sends nothing)
//   POST /admin/prospects       add a business to email (src/admin/outreach.js)
//   POST /admin/gmail/pause     the Gmail sender's Pause switch (src/lib/gmail-sender.js) → 303 /admin?gmail=paused
//   POST /admin/gmail/resume    turn sending back on → 303 /admin?gmail=resumed
//   POST /admin/gmail/test      one test email through Gmail to one of our own addresses → 303 /admin?gmail=sent
//   POST /admin/followups/run       send every EXP-002 follow-up due now (src/lib/followups.js) → 303 /admin?followups=ran…
//   POST /admin/followups/replied   "Mark replied" on a prospect: no more follow-ups → 303 /admin?followups=replied
//   POST /admin/followups/template  save (or reset=1: drop) one follow-up template → 303 /admin?followups=saved
//   GET  /admin/admin.js        the page's small script
//   /api/admin/*                see src/admin/api.js
//
// Auth: the session cookie OR `Authorization: Bearer <ADMIN_TOKEN>` on every route.
// With no ADMIN_TOKEN set, every route here is a 404. Cookie-authenticated POSTs must carry a
// same-origin Origin header (with SameSite=Strict, that is the CSRF defence).

import { adminAuth, tokenMatches, signSession, sessionCookie, clearSessionCookie, sameOrigin } from './session.js';
import { loadDashboard, insertExpense, insertProspect, prospectDetails } from './data.js';
import { renderLogin, renderDashboard, ADMIN_JS } from './page.js';
import { parseExpenseForm, scanFormToBody } from './metrics.js';
import { handleAdminPing, handleAdminScanStart, handleAdminScanStatus, startScan, ALL_ENGINES, NO_STORE } from './api.js';
import { dryRunEnabled, isLocalRequest } from './dry-run.js';
import { redact } from './redact.js';
import { defaultScanEngines } from '../../scanner/config.js';
import { runQueuedScan, cancelRequestScan, startFullScan } from '../lib/auto-scan.js';
import { parseSentForm, parseProspectForm } from './outreach.js';
import { recordEmailSent, validToken } from '../lib/email-tracking.js';
import { sendViaGmail, setGmailPaused, gmailStatus, outreachEnabled } from '../lib/gmail-sender.js';
import { runFollowups, markReplied, saveTemplate, resetTemplate, followupsEnabled } from '../lib/followups.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nonce() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/[^A-Za-z0-9]/g, '');
}

function html(body, { status = 200, nonce: n, headers = {} } = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...NO_STORE,
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${n}'; img-src 'self' data:; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      // Not 'no-referrer': with that policy browsers send `Origin: null` on the page's own form
      // POSTs, and the CSRF check (sameOrigin) would refuse every sign-in and form submit.
      'Referrer-Policy': 'same-origin',
      ...headers,
    },
  });
}

const notFound = () => new Response('Not found', { status: 404, headers: NO_STORE });
const redirect = (url, location, headers = {}) => new Response(null, { status: 303, headers: { Location: new URL(location, url).toString(), ...NO_STORE, ...headers } });

async function form(request) {
  try { return await request.formData(); } catch { return null; }
}

export function isAdminPath(pathname) {
  return pathname === '/admin' || pathname.startsWith('/admin/') || pathname.startsWith('/api/admin/');
}

export async function handleAdminRequest(request, url, env) {
  const adminToken = String(env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return notFound();
  const path = url.pathname;
  const method = request.method;

  // ---- API ---------------------------------------------------------------------------
  if (path.startsWith('/api/admin/')) {
    const who = await adminAuth(request, adminToken);
    if (!who) {
      await sleep(250);
      return Response.json({ error: 'Unauthorized' }, { status: 401, headers: { ...NO_STORE, 'WWW-Authenticate': 'Bearer' } });
    }
    if (who === 'cookie' && method !== 'GET' && method !== 'HEAD' && !sameOrigin(request)) {
      return Response.json({ error: 'Cross-origin request refused' }, { status: 403, headers: NO_STORE });
    }
    if (path === '/api/admin/ping' && method === 'GET') return handleAdminPing(env);
    if (path === '/api/admin/scan' && method === 'POST') return handleAdminScanStart(request, url, env);
    const m = path.match(/^\/api\/admin\/scan\/([^/]+)$/);
    if (m && method === 'GET') {
      let id;
      try { id = decodeURIComponent(m[1]); } catch { id = ''; } // malformed %-escape → 404, not a 500
      return handleAdminScanStatus(id, env);
    }
    return Response.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });
  }

  // ---- page --------------------------------------------------------------------------
  if (path === '/admin/admin.js' && method === 'GET') {
    return new Response(ADMIN_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...NO_STORE, 'X-Content-Type-Options': 'nosniff' } });
  }

  if (path === '/admin/login' && method === 'POST') {
    if (!sameOrigin(request)) return new Response('Cross-origin request refused', { status: 403, headers: NO_STORE });
    const f = await form(request);
    const given = String(f?.get('token') || '').trim();
    const n = nonce();
    if (!given || !(await tokenMatches(given, adminToken))) {
      await sleep(1000 + Math.floor(Math.random() * 500)); // slow down guessing
      return html(renderLogin({ nonce: n, error: 'That token is not right.' }), { status: 401, nonce: n });
    }
    return redirect(url, '/admin', { 'Set-Cookie': sessionCookie(await signSession(adminToken)) });
  }

  if (path === '/admin/logout' && (method === 'POST' || method === 'GET')) {
    if (method === 'POST' && !sameOrigin(request)) return new Response('Cross-origin request refused', { status: 403, headers: NO_STORE });
    return redirect(url, '/admin', { 'Set-Cookie': clearSessionCookie() });
  }

  if (path !== '/admin' && path !== '/admin/' && path !== '/admin/expenses' && path !== '/admin/scan' && path !== '/admin/scan/run' && path !== '/admin/scan/cancel' && path !== '/admin/scan/paid'
    && path !== '/admin/email/sent' && path !== '/admin/prospects'
    && path !== '/admin/gmail/pause' && path !== '/admin/gmail/resume' && path !== '/admin/gmail/test'
    && path !== '/admin/followups/run' && path !== '/admin/followups/replied' && path !== '/admin/followups/template') return notFound();

  const who = await adminAuth(request, adminToken);
  if (!who) {
    if (method !== 'GET' && method !== 'HEAD') return redirect(url, '/admin');
    const n = nonce();
    return html(renderLogin({ nonce: n }), { nonce: n });
  }
  if (method === 'POST' && who === 'cookie' && !sameOrigin(request)) {
    return new Response('Cross-origin request refused', { status: 403, headers: NO_STORE });
  }

  const render = async ({ flash = {}, watch = [], status = 200, sent = null } = {}) => {
    const n = nonce();
    const dash = await loadDashboard(env);
    const dryRun = dryRunEnabled(env) && isLocalRequest(url);
    return html(renderDashboard(dash, { nonce: n, engineIds: ALL_ENGINES, flash, watch, dryRun, activeIds: defaultScanEngines(env), sent, siteOrigin: url.origin, gmail: gmailStatus(env), followups: { enabled: followupsEnabled(env), outreach: outreachEnabled(env) } }), { status, nonce: n });
  };

  // Log a cold email sent by hand. Writes the 'sent' row only; the redirect shows what to paste.
  if (path === '/admin/email/sent') {
    if (method !== 'POST') return redirect(url, '/admin#log-email');
    const f = await form(request);
    const parsed = parseSentForm(f ? Object.fromEntries(f.entries()) : {});
    const fail = (text, status) => render({ flash: { email: { ok: false, text } }, status });
    if (!parsed.ok) return fail(parsed.error, 422);
    try {
      const biz = await prospectDetails(env, parsed.row.businessId);
      if (!biz) return fail('That business isn’t in the database.', 422);
      const r = await recordEmailSent(env, { ...parsed.row, town: parsed.row.town || biz.town, reportToken: biz.reportToken });
      return redirect(url, `/admin?sent=${encodeURIComponent(r.token)}${r.existing ? '&again=1' : ''}#log-email`);
    } catch (e) {
      return fail(`Could not save: ${redact(env, e?.message || e, 200)}`, 500);
    }
  }

  if (path === '/admin/prospects') {
    if (method !== 'POST') return redirect(url, '/admin#log-email');
    const f = await form(request);
    const parsed = parseProspectForm(f ? Object.fromEntries(f.entries()) : {});
    if (!parsed.ok) return render({ flash: { email: { ok: false, text: parsed.error } }, status: 422 });
    try {
      const r = await insertProspect(env, parsed.row);
      return redirect(url, `/admin?prospect=${r.existing ? 'exists' : 'added'}#log-email`);
    } catch (e) {
      return render({ flash: { email: { ok: false, text: `Could not save: ${redact(env, e?.message || e, 200)}` } }, status: 500 });
    }
  }

  // The Gmail sender: Pause / Resume (sender_state) and a test send to our own address.
  if (path === '/admin/gmail/pause' || path === '/admin/gmail/resume') {
    if (method !== 'POST') return redirect(url, '/admin#gmail');
    const pause = path === '/admin/gmail/pause';
    const f = await form(request);
    const reason = String(f?.get('reason') || '').trim().slice(0, 200);
    try {
      await setGmailPaused(env, pause, pause ? `Paused from /admin${reason ? `: ${reason}` : ''}` : null);
    } catch (e) {
      return render({ flash: { gmail: { ok: false, text: `Could not save: ${redact(env, e?.message || e, 200)}` } }, status: 500 });
    }
    return redirect(url, `/admin?gmail=${pause ? 'paused' : 'resumed'}#gmail`);
  }

  if (path === '/admin/gmail/test') {
    if (method !== 'POST') return redirect(url, '/admin#gmail');
    const f = await form(request);
    const to = String(f?.get('to') || '').trim();
    const r = await sendViaGmail(env, {
      to,
      kind: 'test',
      subject: 'AI Found Score: Gmail sender test',
      text: 'This is a test of the Gmail sender on aifoundscore.com /admin. If it arrived, sending works. Nothing needs doing.',
    });
    if (r.ok) return redirect(url, `/admin?gmail=sent#gmail`);
    const text = {
      'not configured': 'The Gmail secrets (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN) are not all set on this Worker.',
      'not our address': 'Test emails only go to our own addresses.',
      'bad address': 'Test emails only go to our own addresses.',
      suppressed: 'That address is on the unsubscribe list (or the check failed), so nothing was sent.',
      paused: 'Sending is paused. Resume it first.',
      cap: 'Today’s sending cap is used up. Nothing was sent.',
      rate: `One send every 5 seconds: try again in ${r.retryAfter || 5} s.`,
      auth: 'Gmail refused the login, so all sending is now paused and you were emailed. The refresh token probably needs re-issuing (ask Alfred).',
      limit: 'Gmail says the sending limit is reached, so all sending is now paused and you were emailed.',
    }[r.reason] || `Not sent: ${redact(env, r.reason, 300)}`;
    const status = { 'not our address': 422, 'bad address': 422, rate: 429, 'not configured': 503 }[r.reason] || (['paused', 'cap', 'suppressed'].includes(r.reason) ? 409 : 502);
    return render({ flash: { gmail: { ok: false, text } }, status });
  }

  // EXP-002 follow-ups (src/lib/followups.js): run now, mark a prospect replied, save / reset the copy.
  if (path === '/admin/followups/run') {
    if (method !== 'POST') return redirect(url, '/admin#followups');
    const r = await runFollowups(env);
    if (r.error) return render({ flash: { followups: { ok: false, text: `Nothing sent: ${redact(env, r.error, 300)}` } }, status: 500 });
    if (r.skipped) return redirect(url, `/admin?followups=skipped&why=${encodeURIComponent(r.skipped)}#followups`);
    const q = new URLSearchParams({ followups: 'ran', sent: String(r.sent), due: String(r.due) });
    if (r.stopped) q.set('stopped', r.stopped);
    const failed = [...new Set(r.results.filter((x) => !x.ok).map((x) => x.reason))].slice(0, 5).join(', ');
    if (failed) q.set('failed', failed);
    return redirect(url, `/admin?${q}#followups`);
  }

  if (path === '/admin/followups/replied') {
    if (method !== 'POST') return redirect(url, '/admin#followups');
    const f = await form(request);
    const token = String(f?.get('token') || '').trim();
    if (!validToken(token)) return render({ flash: { followups: { ok: false, text: 'Bad prospect.' } }, status: 422 });
    try {
      if (!(await markReplied(env, token))) return render({ flash: { followups: { ok: false, text: 'That prospect isn’t in the database.' } }, status: 422 });
    } catch (e) {
      return render({ flash: { followups: { ok: false, text: `Could not save: ${redact(env, e?.message || e, 200)}` } }, status: 500 });
    }
    return redirect(url, '/admin?followups=replied#followups');
  }

  if (path === '/admin/followups/template') {
    if (method !== 'POST') return redirect(url, '/admin#followups');
    const f = await form(request);
    const t = { stage: String(f?.get('stage') || ''), variant: String(f?.get('variant') || ''), subject: f?.get('subject'), body: f?.get('body') };
    try {
      const r = f?.get('reset') === '1' ? await resetTemplate(env, t) : await saveTemplate(env, t);
      if (!r.ok) return render({ flash: { followups: { ok: false, text: `Not saved. ${r.errors.join(' ')}` } }, status: 422 });
    } catch (e) {
      return render({ flash: { followups: { ok: false, text: `Could not save: ${redact(env, e?.message || e, 200)}` } }, status: 500 });
    }
    return redirect(url, `/admin?followups=${f?.get('reset') === '1' ? 'reset' : 'saved'}#followups`);
  }

  if (path === '/admin/expenses') {
    if (method !== 'POST') return redirect(url, '/admin#expenses');
    const f = await form(request);
    const parsed = parseExpenseForm(f ? Object.fromEntries(f.entries()) : {});
    if (!parsed.ok) return render({ flash: { expense: { ok: false, text: parsed.error } }, status: 422 });
    try {
      await insertExpense(env, parsed.row);
    } catch (e) {
      return render({ flash: { expense: { ok: false, text: `Could not save: ${redact(env, e?.message || e, 200)}` } }, status: 500 });
    }
    return redirect(url, '/admin?expense=saved#expenses');
  }

  if (path === '/admin/scan/run') {
    if (method !== 'POST') return redirect(url, '/admin#requests');
    const f = await form(request);
    const id = String(f?.get('id') || '').trim().toLowerCase();
    if (!UUID_RE.test(id)) return render({ flash: { requests: { ok: false, text: 'Bad scan id.' } }, status: 422 });
    const r = await runQueuedScan(env, id);
    if (!r.ok) return render({ flash: { requests: { ok: false, text: redact(env, r.error, 300) } }, status: r.status || 500 });
    return redirect(url, `/admin?started=${r.scanId}#run`);
  }

  if (path === '/admin/scan/cancel') {
    if (method !== 'POST') return redirect(url, '/admin#requests');
    const f = await form(request);
    const id = String(f?.get('id') || '').trim().toLowerCase();
    if (!UUID_RE.test(id)) return render({ flash: { requests: { ok: false, text: 'Bad scan id.' } }, status: 422 });
    const r = await cancelRequestScan(env, id).catch((e) => ({ ok: false, status: 500, error: String(e?.message || e) }));
    if (!r.ok) return render({ flash: { requests: { ok: false, text: redact(env, r.error, 300) } }, status: r.status || 500 });
    return redirect(url, '/admin?cancelled=1#requests');
  }

  // Re-run a paid audit by report token (a paid scan that failed twice, or never started). A fresh id
  // each time (Workflow ids are single-use); refused while a paid scan for the token is running or done.
  if (path === '/admin/scan/paid') {
    if (method !== 'POST') return redirect(url, '/admin#run');
    const f = await form(request);
    const token = String(f?.get('token') || '').trim();
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(token)) return render({ flash: { run: { ok: false, text: 'Bad report token.' } }, status: 422 });
    const r = await startFullScan(env, { token, trigger: 'paid', scanId: crypto.randomUUID(), notes: 'paid scan, re-run from /admin' })
      .catch((e) => ({ ok: false, reason: String(e?.message || e) }));
    if (!r.ok) return render({ flash: { run: { ok: false, text: r.reason === 'already' ? 'A paid scan for that report is running or already done.' : redact(env, r.reason, 300) } }, status: 409 });
    return redirect(url, `/admin?started=${r.scanId}#run`);
  }

  if (path === '/admin/scan') {
    if (method !== 'POST') return redirect(url, '/admin#run');
    const f = await form(request);
    const fields = f ? Object.fromEntries(f.entries()) : {};
    const r = await startScan(env, url, scanFormToBody(fields, f ? f.getAll('engines').map(String) : []));
    if (!r.ok) return render({ flash: { run: { ok: false, text: r.error } }, status: r.status || 422 });
    return redirect(url, `/admin?started=${r.scanId}#run`);
  }

  // GET /admin
  if (method !== 'GET' && method !== 'HEAD') return notFound();
  const started = url.searchParams.get('started');
  const watch = started && UUID_RE.test(started) ? [started.toLowerCase()] : [];
  const flash = {};
  if (watch.length) flash.run = { ok: true, text: 'Scan started. Progress updates below every few seconds.' };
  if (url.searchParams.get('expense') === 'saved') flash.expense = { ok: true, text: 'Expense saved.' };
  if (url.searchParams.get('cancelled') === '1') flash.requests = { ok: true, text: 'Request cancelled. It will not run.' };
  if (url.searchParams.get('prospect') === 'added') flash.email = { ok: true, text: 'Prospect added. Pick it in “Log a sent email”.' };
  if (url.searchParams.get('prospect') === 'exists') flash.email = { ok: true, text: 'A business with that exact name is already there. Pick it in “Log a sent email”.' };
  if (url.searchParams.get('again') === '1') flash.email = { ok: true, text: 'Already logged for this business and campaign: the same links as before.' };
  const gmailFlash = { paused: 'All Gmail sending is paused.', resumed: 'Gmail sending is back on.', sent: 'Test email sent. Check the inbox; the row is under “Last sends”.' }[url.searchParams.get('gmail')];
  if (gmailFlash) flash.gmail = { ok: true, text: gmailFlash };
  const fu = url.searchParams;
  const followupFlash = {
    ran: () => `Follow-ups sent: ${Number(fu.get('sent')) || 0} of ${Number(fu.get('due')) || 0} due.${fu.get('failed') ? ` Not sent: ${fu.get('failed').slice(0, 200)}.` : ''}${fu.get('stopped') ? ` Stopped early: ${fu.get('stopped').slice(0, 60)}.` : ''}`,
    skipped: () => `Nothing sent: ${{ 'followups off': 'follow-ups are off (GMAIL_FOLLOWUPS)', 'outreach off': 'emails to prospects are off (GMAIL_OUTREACH)', 'not configured': 'the Gmail secrets are not all set', 'outside hours': 'follow-ups only go out on weekdays, 9am–5pm New York time' }[fu.get('why')] || 'the Supabase service key is not set'}.`,
    replied: () => 'Marked replied. No more follow-ups go to them.',
    saved: () => 'Copy saved. The next follow-up uses it.',
    reset: () => 'Back to the placeholder copy.',
  }[fu.get('followups')];
  if (followupFlash) flash.followups = { ok: fu.get('followups') !== 'skipped', text: followupFlash() };
  const sentParam = url.searchParams.get('sent');
  return render({ flash, watch, sent: validToken(sentParam || '') ? sentParam : null });
}
