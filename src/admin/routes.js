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
    && path !== '/admin/email/sent' && path !== '/admin/prospects') return notFound();

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
    return html(renderDashboard(dash, { nonce: n, engineIds: ALL_ENGINES, flash, watch, dryRun, activeIds: defaultScanEngines(env), sent, siteOrigin: url.origin }), { status, nonce: n });
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
  const sentParam = url.searchParams.get('sent');
  return render({ flash, watch, sent: validToken(sentParam || '') ? sentParam : null });
}
