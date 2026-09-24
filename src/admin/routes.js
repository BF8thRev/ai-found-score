// src/admin/routes.js — everything under /admin and /api/admin/*.
//
//   GET  /admin                 dashboard (or the sign-in form)
//   POST /admin/login           ADMIN_TOKEN → signed session cookie (12h), 303 → /admin
//   POST /admin/logout          clears the cookie (GET works too)
//   POST /admin/expenses        add a manual expense
//   POST /admin/scan            start a background scan from the form
//   GET  /admin/admin.js        the page's small script
//   /api/admin/*                see src/admin/api.js
//
// Auth: the session cookie OR `Authorization: Bearer <ADMIN_TOKEN>` on every route.
// With no ADMIN_TOKEN set, every route here is a 404. Cookie-authenticated POSTs must carry a
// same-origin Origin header (with SameSite=Strict, that is the CSRF defence).

import { adminAuth, tokenMatches, signSession, sessionCookie, clearSessionCookie, sameOrigin } from './session.js';
import { loadDashboard, insertExpense } from './data.js';
import { renderLogin, renderDashboard, ADMIN_JS } from './page.js';
import { parseExpenseForm, scanFormToBody } from './metrics.js';
import { handleAdminPing, handleAdminScanStart, handleAdminScanStatus, startScan, ALL_ENGINES, NO_STORE } from './api.js';
import { dryRunEnabled, isLocalRequest } from './dry-run.js';
import { redact } from './redact.js';

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

  if (path !== '/admin' && path !== '/admin/' && path !== '/admin/expenses' && path !== '/admin/scan') return notFound();

  const who = await adminAuth(request, adminToken);
  if (!who) {
    if (method !== 'GET' && method !== 'HEAD') return redirect(url, '/admin');
    const n = nonce();
    return html(renderLogin({ nonce: n }), { nonce: n });
  }
  if (method === 'POST' && who === 'cookie' && !sameOrigin(request)) {
    return new Response('Cross-origin request refused', { status: 403, headers: NO_STORE });
  }

  const render = async ({ flash = {}, watch = [], status = 200 } = {}) => {
    const n = nonce();
    const dash = await loadDashboard(env);
    const dryRun = dryRunEnabled(env) && isLocalRequest(url);
    return html(renderDashboard(dash, { nonce: n, engineIds: ALL_ENGINES, flash, watch, dryRun }), { status, nonce: n });
  };

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
  return render({ flash, watch });
}
