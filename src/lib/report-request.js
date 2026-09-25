// POST /api/request: the landing page's free-report request. Accepts JSON (fetch) or a plain
// form post (no-JS fallback). Email is optional: the page asks for it only after the owner has
// seen the questions.
//   {business_name, trade, town, zip, state?, website?, phone?, email?, cf-turnstile-response}
//       -> Turnstile check, then a new row; returns {ok, id}
//   {request_id, email}
//       -> attaches the email to that row (the row came from a Turnstile-checked first submit,
//          so this needs no token). If the attach can't be done (row missing, first save failed)
//          and the business fields are present, a fresh row is saved with the email instead,
//          so the email is never lost. That fallback creates a row, so it needs a valid token
//          just like a first submit.
// Turnstile is skipped (with one logged warning) until it is configured: see src/lib/turnstile.js.
// A new row that passed Turnstile also gets {preview_token} when live previews are on
// (src/lib/live-preview.js): the page uses it to ask one question live without a second check.
// Every JSON success also carries {report_url}: "/report/<token>" once the request's scans row
// exists (src/lib/auto-scan.js; scanned at once with AUTO_SCAN=on, else queued for /admin "Run now";
// the same business name + ZIP within 7 days gets its OWN new link, never the earlier one), or null when no link could
// be made (bot check not configured, no service key, a database error). The request is saved either
// way. A no-JS form post is redirected to the report link when there is one.

import { recordReportRequest, attachReportRequestEmail } from './db.js';
import { normalizeTrade } from '../../scanner/questions.js';
import { turnstileConfigured, verifyTurnstile, warnUnconfiguredOnce, REQUEST_ACTION } from './turnstile.js';
import { livePreviewStatus, signPreviewToken } from './live-preview.js';
import { startRequestScan } from './auto-scan.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const BOT_CHECK_FAILED = 'We couldn\'t confirm you\'re a person. Reload the page and try again.';
export const BOT_CHECK_UNAVAILABLE = 'Our spam check didn\'t answer in time. Wait a minute and try again.';

/**
 * @param {Request} request
 * @param {URL} url
 * @param {object} env
 * @param {object} [deps] injected in tests: {recordReportRequest, attachReportRequestEmail, fetchImpl,
 *   startRequestScan}; the Worker passes {previewDryRun, scanDryRun, dryEnv} for a local dry run
 */
export async function handleReportRequest(request, url, env, deps = {}) {
  const record = deps.recordReportRequest || recordReportRequest;
  const attach = deps.attachReportRequestEmail || attachReportRequestEmail;

  const ct = request.headers.get('Content-Type') || '';
  const isJson = ct.includes('application/json');
  let data = {};
  try {
    if (isJson) data = await request.json();
    else {
      const form = await request.formData();
      data = Object.fromEntries(form.entries());
    }
  } catch {
    return isJson
      ? Response.json({ ok: false, error: 'Bad request' }, { status: 400 })
      : Response.redirect(new URL('/?request=error#request', url).toString(), 303);
  }

  if (!data || typeof data !== 'object') data = {};
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const fail = (status, error) => (isJson
    ? Response.json({ ok: false, error }, { status })
    : Response.redirect(new URL('/?request=error#request', url).toString(), 303));
  const okResponse = (id, previewToken, reportUrl) => (isJson
    ? Response.json({
      ok: true, id: id ?? null, ...(previewToken ? { preview_token: previewToken } : {}),
      ...(reportUrl !== undefined ? { report_url: reportUrl } : {}),
    })
    : Response.redirect(new URL(reportUrl || '/?request=ok#request', url).toString(), 303));

  // Honeypot: real people never fill the hidden field.
  if (clean(data.company_url, 10)) return okResponse(null);

  const email = clean(data.email, 160).toLowerCase();
  const emailOk = EMAIL_RE.test(email);
  if (email && !emailOk) return fail(422, 'Please enter a valid email.');

  // Step 2: attach an email to the request saved in step 1.
  const requestId = clean(data.request_id, 36).toLowerCase();
  if (requestId) {
    if (!UUID_RE.test(requestId)) return fail(422, 'Bad request');
    if (!emailOk) return fail(422, 'Please enter a valid email.');
    try {
      if (await attach(env, { id: requestId, email })) return okResponse(requestId);
    } catch (e) {
      console.error('[request] email attach failed', e);
    }
    // Couldn't attach: fall through and save a fresh row with the email (Turnstile-checked below).
  }

  const rawTrade = clean(data.trade, 40);
  const zip = clean(data.zip, 10);
  const state = clean(data.state, 2).toUpperCase() || 'NY';
  const req = {
    id: crypto.randomUUID(),
    businessName: clean(data.business_name, 120),
    town: clean(data.town, 60),
    zip: zip || null,
    state: /^[A-Z]{2}$/.test(state) ? state : 'NY',
    email: emailOk ? email : null,
    trade: normalizeTrade(rawTrade) || rawTrade || null,
    website: clean(data.website, 160) || null,
    phone: clean(data.phone, 30) || null,
    userAgent: request.headers.get('User-Agent') || null,
  };
  if (!req.businessName || !req.town) {
    return fail(422, requestId ? 'Could not save your email. Try again.' : 'Please fill in your business name and town.');
  }
  if (zip && !/^\d{5}$/.test(zip)) return fail(422, 'Please enter a 5-digit ZIP.');

  // Every new row is bot-checked (first submit, and the attach fallback above).
  let verified = false;
  if (turnstileConfigured(env)) {
    const check = await verifyTurnstile({
      secret: String(env.TURNSTILE_SECRET_KEY).trim(),
      token: typeof data['cf-turnstile-response'] === 'string' ? data['cf-turnstile-response'] : '',
      remoteip: request.headers.get('CF-Connecting-IP') || undefined,
      expectedAction: REQUEST_ACTION,
      // The widget runs on the page this Worker serves, so it must have been solved on this
      // request's own host. A production request never matches a token solved on localhost.
      expectedHostnames: [url.hostname],
      fetchImpl: deps.fetchImpl || fetch,
      timeoutMs: deps.turnstileTimeoutMs,
    });
    if (!check.ok) {
      console.warn('[request] turnstile failed', check.reason, (check.codes || []).join(','));
      return check.reason === 'unavailable' ? fail(503, BOT_CHECK_UNAVAILABLE) : fail(403, BOT_CHECK_FAILED);
    }
    verified = true;
  } else {
    warnUnconfiguredOnce();
  }

  try {
    await record(env, req);
  } catch (e) {
    console.error('[request] write failed', e);
    return fail(500, 'Could not save your request.');
  }
  let previewToken = null;
  if (verified && isJson && livePreviewStatus(env, { dryRun: !!deps.previewDryRun }).enabled) {
    previewToken = await signPreviewToken(env, req).catch(() => null);
  }
  // The report link (and, with AUTO_SCAN=on, the scan itself). Only for a Turnstile-checked row.
  let reportUrl = null;
  if (verified) {
    try {
      const r = await (deps.startRequestScan || startRequestScan)(env, req, {
        request, dryRun: !!deps.scanDryRun, dryEnv: deps.dryEnv, fetchImpl: deps.scanFetchImpl,
      });
      if (r && r.token) reportUrl = `/report/${encodeURIComponent(r.token)}`;
    } catch (e) {
      console.error('[request] report link failed', String(e?.message || e).slice(0, 200));
    }
  }
  return okResponse(req.id, previewToken, reportUrl);
}
