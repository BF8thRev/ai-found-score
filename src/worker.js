// Cloudflare Worker — AI Found Score.
//
// Routes:
//   GET  /r/[code]            -> printed short code (postcard) -> 302 to /report/[token]
//   GET  /api/report/[id]     -> report JSON; fix details + X-Ray sections withheld until paid;
//                                202 {status:'running'|'queued'|..., business?, hasEmail?} while a free-report request's scan is pending
//   POST /api/visit           -> report-page view beacon (arm looked up from token)
//   POST /api/lead            -> "Email me this report"; while the report is still being made, attaches the email to the request instead
//   POST /api/request         -> landing-page free-report request (email optional; returns id + report_url;
//                                AUTO_SCAN=on starts its scan at once, src/lib/auto-scan.js);
//                                Turnstile-checked + per-IP rate limit (src/lib/report-request.js)
//                                or {request_id, email} to attach an email to that request
//   GET  /api/questions       -> the 3 questions the free scan asks for ?trade=&town=&zip=&state=
//                                (per-IP rate limit)
//   POST /api/stripe-webhook  -> Stripe webhook, verified signature, writes payment
//   GET|POST /unsubscribe, /stop -> email or postcard opt-out
//   /admin, /admin/*          -> business dashboard (session cookie or Bearer ADMIN_TOKEN); src/admin/routes.js
//   GET  /api/admin/ping      -> live key check per engine + extractor (cookie or Bearer ADMIN_TOKEN)
//   POST /api/admin/scan      -> start a background scan (Cloudflare Workflow) -> { scanId, instanceId, statusUrl }
//   GET  /api/admin/scan/:id  -> scan status + progress
//   POST /api/live-preview    -> ask one of the visitor's questions live (src/lib/live-preview.js);
//                                needs the signed token /api/request returned after Turnstile
//   GET  /api/site-check      -> the gate before a scan: is ?website= real, is ?name= a name (src/lib/site-check.js)
//   GET  /api/zip           -> town for ?zip= (src/lib/zip.js, zippopotam.us, cached 30 days; per-IP rate limit)
//   GET|POST /api/fix-kit/[token], GET /api/fix-kit/[token].zip -> Fix Kit details form + zip download
//                                ($49 xray, which includes it / $499 be_the_answer / retired $149 fix_kit); src/lib/fix-kit-route.js
//   GET  /fix-kit/[token]     -> the Fix Kit page (public/fix-kit.html)
//   GET|POST /api/plan/[token] -> Be the Answer: towns, directory checklist, Google posts; src/lib/plan-route.js
//   GET  /plan/[token]        -> the Be the Answer page (public/plan.html)
//   cron (daily)              -> the free 30-day re-check of every paid report (src/lib/auto-scan.js startDueRechecks),
//                                then Be the Answer's monthly re-scans (startDueMonthly)
//   GET  /api/proof           -> homepage proof line (src/lib/proof.js), hidden below PROOF_MIN_SCANS; cached 1 h
//   GET  /                    -> homepage; the hero's real AI answer card comes from showcase_answers
//                                (src/lib/showcase.js, filled by `node scanner/showcase.js`), cached 1 h
//   everything else           -> static assets (public/) via env.ASSETS; HTML gets the Turnstile site key
//                                and local examples from the visitor's request.cf (src/lib/geo.js)
//
// Also exports ScanWorkflow (src/scan-workflow.js), bound as SCAN_WORKFLOW in wrangler.jsonc.

import {
  recordPayment, recordUnsubscribe, recordVisit, recordLead,
  getReport, getReportLink, isReportUnlocked, getPaidTiers,
  getRequestInfo, requestHasEmail, attachRequestEmailByToken,
} from './lib/db.js';
import { handleQuestions } from './lib/questions-route.js';
import { handleReportRequest } from './lib/report-request.js';
import { handleSiteCheck } from './lib/site-check.js';
import { turnstileConfigured, turnstileSiteKey } from './lib/turnstile.js';
import { rateLimit } from './lib/rate-limit.js';
import { verifyStripeSignature, tierForSession } from './lib/stripe.js';
import { MOCK_REPORTS } from './mock/sample-reports.js';
import { validateReport } from '../shared/report-v2.js';
import { reportBody, BREAKDOWN_TIERS } from './lib/lock.js';
import {
  pendingReportStatus, startPaidScan, paidScanRunning, startDueRechecks, startDueMonthly, readPlanParent,
  retryFailedScans, startAbandonedCheckout, REQUEST_TOKEN_RE,
} from './lib/auto-scan.js';
import { sendCreditAlerts, sendPaidScanAlert } from './lib/alerts.js';

/** wrangler.jsonc triggers: this one is the half-hourly recovery + credit check; the other is daily. */
const RECOVERY_CRON = '*/30 * * * *';
import { notifyPayment, notifyLead, notifyRequestEmail, reportSummary } from './lib/notify.js';
import { resolveKeys, enginesConfigured } from '../scanner/config.js';
import { handleAdminRequest, isAdminPath } from './admin/routes.js';
import { geoForRequest, geoTag, addGeoHandlers } from './lib/geo.js';
import { handleLivePreview, livePreviewStatus } from './lib/live-preview.js';
import { handleProof } from './lib/proof.js';
import { handleZip } from './lib/zip.js';
import { handleFixKit } from './lib/fix-kit-route.js';
import { handlePlan } from './lib/plan-route.js';
import { handleCheckout, SHOWCASE_TOKENS } from './lib/checkout.js';
import { handleRefundEvent, REFUND_EVENTS } from './lib/refunds.js';
import { loadShowcaseRows, pickShowcase, showcaseTag, addShowcaseHandler } from './lib/showcase.js';
import { dryRunEnabled, isLocalRequest, dryRunEnv, dryRunFetch } from './admin/dry-run.js';

// The background scan runner (Cloudflare Workflows entrypoint; binding SCAN_WORKFLOW).
export { ScanWorkflow } from './scan-workflow.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // One canonical host: www -> apex, keeping path and query.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return handleHealth(env);
    }

    if (isAdminPath(url.pathname)) {
      return handleAdminRequest(request, url, env);
    }

    if (url.pathname.startsWith('/r/') && request.method === 'GET') {
      return handleShortCode(url, env);
    }

    if (url.pathname === '/api/request' && request.method === 'POST') {
      const dry = previewDryRun(env, url);
      return (await rateLimit(env, request, 'request'))
        || handleReportRequest(request, url, env, dry
          // Local dry run: nothing is written to Supabase.
          ? { previewDryRun: true, scanDryRun: true, dryEnv: dryRunEnv(env), recordReportRequest: async () => console.log('[dry-run] request not saved') }
          : {});
    }

    if (url.pathname === '/api/live-preview' && request.method === 'POST') {
      return handleLivePreviewRoute(request, url, env, ctx);
    }

    if (url.pathname === '/api/proof' && request.method === 'GET') {
      return handleProof(request, env, { waitUntil: (p) => ctx.waitUntil(p) });
    }

    if (url.pathname === '/api/zip' && request.method === 'GET') {
      return (await rateLimit(env, request, 'zip')) || handleZip(url);
    }
    if (url.pathname === '/api/site-check' && request.method === 'GET') {
      return (await rateLimit(env, request, 'site')) || handleSiteCheck(url, { env });
    }
    if (url.pathname === '/api/questions' && request.method === 'GET') {
      return (await rateLimit(env, request, 'questions')) || handleQuestions(url);
    }

    if (url.pathname === '/api/visit' && request.method === 'POST') {
      return handleVisit(request, env);
    }

    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLead(request, env);
    }

    // Our own checkout: prices set per report, then Stripe's hosted page (src/lib/checkout.js).
    if (url.pathname === '/api/checkout' && request.method === 'POST') {
      return handleCheckout(request, url, env, { mockReports: MOCK_REPORTS });
    }
    // Stripe's cancel link for a pay-up-front order: start the free report instead, then show it.
    if (url.pathname === '/api/checkout/cancel' && request.method === 'GET') {
      const t = String(url.searchParams.get('t') || '');
      if (!REQUEST_TOKEN_RE.test(t)) return Response.redirect(new URL('/#pricing', url).toString(), 303);
      const r = await startAbandonedCheckout(env, t);
      console.log('[checkout] cancelled', JSON.stringify({ ok: !!r?.ok, why: r?.reason || r?.error || null }));
      return Response.redirect(new URL(`/report/${encodeURIComponent(t)}?from=checkout`, url).toString(), 303);
    }

    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    if ((url.pathname === '/unsubscribe' || url.pathname === '/stop')
        && (request.method === 'GET' || request.method === 'POST')) {
      return handleUnsubscribe(request, url, env);
    }

    // Fix Kit: confirm details, download the zip (src/lib/fix-kit-route.js; sample-* works with no database).
    if (url.pathname.startsWith('/api/fix-kit/') && (request.method === 'GET' || request.method === 'POST')) {
      return handleFixKit(request, url, env, { mockReports: MOCK_REPORTS });
    }

    // Be the Answer: towns, directory checklist, Google posts (src/lib/plan-route.js; sample-* works with no database).
    if (url.pathname.startsWith('/api/plan/') && (request.method === 'GET' || request.method === 'POST')) {
      return handlePlan(request, url, env, { mockReports: MOCK_REPORTS });
    }

    if (url.pathname.startsWith('/api/report/') && request.method === 'GET') {
      let id;
      try { id = decodeURIComponent(url.pathname.slice('/api/report/'.length)); } catch {
        return Response.json({ error: 'Report not found' }, { status: 404 });
      }
      return handleGetReport(id, url, env, previewDryRun(env, url));
    }

    // Pretty-URL rewrites. Serve the clean-URL asset paths directly.
    if (url.pathname.startsWith('/report/') && url.pathname.length > '/report/'.length) {
      return serveAsset(env, request, '/report');
    }
    if (url.pathname.startsWith('/fix-kit/') && url.pathname.length > '/fix-kit/'.length) {
      return serveAsset(env, request, '/fix-kit');
    }
    if (url.pathname.startsWith('/plan/') && url.pathname.length > '/plan/'.length) {
      return serveAsset(env, request, '/plan');
    }
    if (url.pathname === '/success') {
      return serveAsset(env, request, '/success');
    }

    // Static assets (landing, report, success pages).
    return serveAsset(env, request, undefined, undefined, ctx);
  },

  // Daily cron (wrangler.jsonc triggers): the free 30-day re-check for every paid report
  // (src/lib/auto-scan.js startDueRechecks). RECHECK_SCAN=off turns it off.
  async scheduled(event, env, ctx) {
    // Every 30 minutes: retry a failed scan once, run the free report for a checkout left unpaid,
    // and email the owner when an engine's credits are low or out (src/lib/alerts.js).
    if (event.cron === RECOVERY_CRON) {
      ctx.waitUntil(retryFailedScans(env)
        .then((r) => console.log('[recovery]', JSON.stringify(r)))
        .then(() => sendCreditAlerts(env))
        .then((r) => console.log('[credits]', JSON.stringify({ checked: r?.checked, alerts: r?.alerts }))));
      return;
    }
    // Daily. One after the other: a plan's month 1 is skipped when the re-check just scanned that report.
    ctx.waitUntil(startDueRechecks(env)
      .then((r) => console.log('[recheck]', JSON.stringify(r)))
      .then(() => startDueMonthly(env))
      .then((r) => console.log('[monthly]', JSON.stringify(r))));
  },
};

// Config check without exposing values: yes/no for each setting plus one
// real read (a short code that can't exist).
async function handleHealth(env) {
  const out = {
    supabaseUrl: !!env.SUPABASE_URL,
    supabaseKey: !!env.SUPABASE_ANON_KEY,
    supabaseKeyType: keyType(env.SUPABASE_ANON_KEY),
    stripeWebhookSecret: !!env.STRIPE_WEBHOOK_SECRET,
    stripeSecretKey: !!String(env.STRIPE_SECRET_KEY || '').trim(),
    stripeWebhookSecretTest: !!env.STRIPE_WEBHOOK_SECRET_TEST,
    // live | test | unset, from the key's prefix (sk_live_/rk_live_ vs sk_test_/rk_test_). Never the key.
    stripeMode: (() => { const k = String(env.STRIPE_SECRET_KEY || '').trim(); return !k ? 'unset' : /^[sr]k_live_/.test(k) ? 'live' : /^[sr]k_test_/.test(k) ? 'test' : 'unknown'; })(),
    // Receipts, "audit ready", monthly emails and alerts all need it (src/lib/email.js).
    resendKey: !!String(env.RESEND_API_KEY || '').trim(),
    // Scanner keys: present or not, never the values.
    // `claude` uses ANTHROPIC_API_KEY; config.js wins once it reports it itself.
    engineKeys: { claude: !!String(env.ANTHROPIC_API_KEY || '').trim(), ...enginesConfigured(env) },
    anthropicApiKey: !!String(env.ANTHROPIC_API_KEY || '').trim(),
    supabaseServiceKey: !!resolveKeys(env).supabaseServiceKey,
    adminToken: !!String(env.ADMIN_TOKEN || '').trim(),
    // Site key + secret both set; false means free-report requests are not bot-checked.
    turnstile: turnstileConfigured(env),
    // The form's "ask one now" (src/lib/live-preview.js): Turnstile + an engine key + service key.
    livePreview: livePreviewStatus(env).enabled,
    database: 'not checked',
  };
  if (out.supabaseUrl && out.supabaseKey) {
    try {
      await getReportLink(env, { code: 'HEALTH' });
      out.database = 'ok';
    } catch (e) {
      out.database = String(e.message || e).slice(0, 200);
    }
  }
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
}

// Which kind of Supabase key is configured, never the key itself.
function keyType(raw) {
  const k = String(raw || '').trim();
  if (!k) return 'missing';
  if (k.startsWith('sb_publishable_')) return 'publishable (correct)';
  if (k.startsWith('sb_secret_')) return 'SECRET KEY - replace with the publishable key';
  if (k.startsWith('eyJ')) return 'legacy JWT';
  return 'unrecognized';
}

// Printed codes use an alphabet with no look-alikes; people still type
// lowercase, spaces and dashes, so normalize before the lookup.
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

async function handleShortCode(url, env) {
  let raw = url.pathname.slice('/r/'.length);
  try { raw = decodeURIComponent(raw); } catch { /* keep it raw; normalizeCode drops the junk */ }
  const code = normalizeCode(raw);
  if (!code) return Response.redirect(new URL('/', url).toString(), 302);
  let link;
  try {
    link = await getReportLink(env, { code });
  } catch (e) {
    console.error('[r] lookup failed', e);
    return new Response('Something went wrong. Try again in a minute.', { status: 503 });
  }
  const dest = link ? `/report/${encodeURIComponent(link.report_token)}` : '/report/not-found';
  return Response.redirect(new URL(dest, url).toString(), 302);
}

// A free-report request's link works before its report exists: while its scan is queued or
// running the answer is 202 {status: 'running'|'queued'} (src/lib/auto-scan.js pendingReportStatus),
// and report.js shows the "in progress" page, re-checking every 30 s. The status is passed through as
// pendingReportStatus gives it (report.js also knows 'failed' and 'paid'). `business` {name, town, state}
// lets the owner see the page is theirs; `hasEmail` hides the email box (the address is never sent).
function pendingResponse(status, info = {}) {
  const body = { status };
  if (info.business) body.business = info.business;
  if (typeof info.hasEmail === 'boolean') body.hasEmail = info.hasEmail;
  return Response.json(body, { status: 202, headers: { 'Cache-Control': 'no-store', 'Retry-After': '30' } });
}

async function pendingInfo(env, token) {
  return getRequestInfo(env, token).catch((e) => {
    console.warn('[report] pending info read failed', String(e?.message || e).slice(0, 200));
    return {};
  });
}

async function handleGetReport(id, url, env, dryRun = false) {
  const isSample = id.startsWith('sample-');
  let report;
  let unlocked = true;
  // Local dry run: request scans live only in this isolate (no database), so check them first.
  if (dryRun && !isSample) {
    const st = await pendingReportStatus(env, id, { dryRun: true });
    if (st === 'running' || st === 'queued') return pendingResponse(st);
    if (st === 'dry-run-complete') {
      return Response.json({ error: 'Report not ready' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  try {
    report = await getReport(env, id, MOCK_REPORTS);
    // The showcase (homepage "See what you get: a real full report") is open to everyone, like the sample.
    if (report && SHOWCASE_TOKENS.includes(id)) {
      unlocked = true;
    } else if (report && !isSample) {
      // If the check itself fails, show the locked page rather than an error.
      unlocked = await isReportUnlocked(env, id).catch((e) => {
        console.error('[report] unlock check failed', e);
        return false;
      });
    }
    // The sample stays open; ?preview=locked shows how a real one looks.
    if (report && isSample && url.searchParams.get('preview') === 'locked') unlocked = false;
  } catch (e) {
    console.error('[report] read failed', e);
    return Response.json({ error: 'Could not load report' }, { status: 500 });
  }
  if (!report) {
    const st = isSample ? null : await pendingReportStatus(env, id);
    if (st) return pendingResponse(st, await pendingInfo(env, id));
    return Response.json({ error: 'Report not found' }, { status: 404 });
  }
  // Serve gate: a v2 report that fails the guardrails is never shown.
  if (report.version === 2) {
    const v = validateReport(report);
    if (!v.ok) {
      console.error('[report] v2 failed validation', id, JSON.stringify(v.errors.slice(0, 20)));
      return Response.json({ error: 'Report not ready' }, {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'Retry-After': '3600' },
      });
    }
  }
  // Paid plans on this report. A Be the Answer town report (plan_towns) takes its plan's.
  let tiers = [];
  let planToken = null;
  if (unlocked && !isSample && !dryRun) {
    planToken = await readPlanParent(env, id).catch(() => null);
    tiers = await getPaidTiers(env, planToken || id).catch((e) => { console.error('[report] tiers read failed', e); return []; });
  }
  const onPlan = tiers.includes('be_the_answer');
  // Unlocked v2 reports also get the X-Ray sections; locked ones never carry them (src/lib/lock.js).
  // The sample shows the Competitor Breakdown too, as a demo.
  const body = reportBody(report, unlocked, { breakdown: isSample || SHOWCASE_TOKENS.includes(id) || tiers.some((t) => BREAKDOWN_TIERS.includes(t)) });
  // Be the Answer: the page links to the plan (and its Fix Kit) instead of offering the plan again.
  if (onPlan) body.plan = { token: planToken || id, town: !!planToken };
  // Paid, and the full scan (every question, every assistant) is still running: the page says so.
  if (unlocked && !isSample && !dryRun && (await paidScanRunning(env, id))) body.fullScanPending = true;
  // A free report whose request already has an email: the page shows no email box (never the address).
  if (!unlocked && !isSample && !dryRun) body.hasEmail = await requestHasEmail(env, id).catch(() => false);
  return Response.json(body, {
    // Real reports change the moment they're paid for, so never cache them.
    headers: { 'Cache-Control': isSample ? 'public, max-age=300' : 'private, no-store' },
  });
}

// lockReport (src/lib/lock.js): issue descriptions, fix steps, copy-paste text and the X-Ray
// sections (competitor gap sheet, fix checklist) are withheld server-side until paid, so they
// are never in the page to un-blur.

// Link scanners (Outlook Safe Links, Proofpoint, Mimecast, ...) open every
// link in an email. Counting them would inflate the email arm, so skip them.
const BOT_UA = /bot|crawl|spider|slurp|preview|headless|phantom|python|curl|wget|java\/|go-http|okhttp|scanner|safelinks|proofpoint|mimecast|barracuda|forcepoint/i;

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Sent by the report page after it renders, so the JS actually ran. Every
// view is logged; the read-out counts distinct tokens per arm.
async function handleVisit(request, env) {
  const body = await readJson(request);
  const token = String(body?.token || '').slice(0, 200);
  const ua = request.headers.get('User-Agent') || '';
  if (!token || token.startsWith('sample-') || BOT_UA.test(ua)) {
    return new Response(null, { status: 204 });
  }
  try {
    const link = await getReportLink(env, { token });
    await recordVisit(env, {
      token,
      arm: link?.arm ?? null,
      referrer: String(body?.referrer || '').slice(0, 500) || null,
      userAgent: ua || null,
    });
  } catch (e) {
    console.error('[visit] write failed', e);
  }
  return new Response(null, { status: 204 });
}

// "Email me this report". Arm comes from the token, never from the page.
async function handleLead(request, env) {
  const body = await readJson(request);
  if (!body) return Response.json({ ok: false, error: 'Bad request' }, { status: 400 });
  // Honeypot: real people never fill the hidden field.
  if (body.company_url) return Response.json({ ok: true });
  const token = String(body.token || '').slice(0, 200);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
  if (!token || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return Response.json({ ok: false, error: 'Please enter a valid email.' }, { status: 422 });
  }
  if (token.startsWith('sample-')) return Response.json({ ok: true });
  // No report yet for this token (a free-report request still being made): the email goes on the
  // request, so the "report ready" email reaches it. No "here's your report" email for a report
  // that doesn't exist yet.
  const pending = await pendingLeadStatus(env, token);
  if (pending) {
    let attached;
    try {
      attached = await attachRequestEmailByToken(env, { token, email, userAgent: request.headers.get('User-Agent') || null });
    } catch (e) {
      console.error('[lead] attach failed', e);
      return Response.json({ ok: false, error: 'Could not save that. Try again.' }, { status: 500 });
    }
    // The report may have finished between the page's check and now: then send "ready" at once.
    if (!(await rateLimit(env, request, 'lead'))) {
      const r = await notifyRequestEmail(env, { requestId: attached.id, email });
      if (r && r.error) console.warn('[lead] ready email failed', r.error);
    }
    return Response.json({ ok: true, attached: true });
  }
  try {
    const link = await getReportLink(env, { token });
    await recordLead(env, {
      token,
      email,
      arm: link?.arm ?? null,
      userAgent: request.headers.get('User-Agent') || null,
    });
  } catch (e) {
    console.error('[lead] write failed', e);
    return Response.json({ ok: false, error: 'Could not save that. Try again.' }, { status: 500 });
  }
  // Send the link now (src/lib/notify.js). Per-IP brake: the address is whatever was typed.
  if (!(await rateLimit(env, request, 'lead'))) {
    const r = await notifyLead(env, { token, email });
    if (!r.sent) console.warn('[lead] not emailed', JSON.stringify(r));
  }
  return Response.json({ ok: true });
}

// The report for a /api/lead token isn't saved yet but its scan is known → the pending status, else null.
async function pendingLeadStatus(env, token) {
  const sum = await reportSummary(env, token).catch(() => undefined);
  if (sum !== null) return null; // a report exists, or we couldn't tell: the ordinary lead email
  return pendingReportStatus(env, token).catch(() => null);
}

// GET /api/questions lives in src/lib/questions-route.js.


// POST /api/request lives in src/lib/report-request.js (Turnstile-checked).

// Live preview dry run: SCANNER_DRY_RUN=1 (local .dev.vars / --var only) AND a localhost request.
// Answers come from the recorded fixtures and nothing touches Supabase (src/admin/dry-run.js).
function previewDryRun(env, url) {
  return dryRunEnabled(env) && isLocalRequest(url);
}

// POST /api/live-preview: one of the visitor's questions, asked live (src/lib/live-preview.js).
function handleLivePreviewRoute(request, url, env, ctx) {
  const waitUntil = (p) => ctx.waitUntil(p);
  if (previewDryRun(env, url)) {
    return handleLivePreview(request, dryRunEnv(env), { dryRun: true, fetchImpl: dryRunFetch({ delayMs: 600 }), waitUntil });
  }
  return handleLivePreview(request, env, { waitUntil });
}

// One-click unsubscribe. Every way in writes the same suppression row:
//   GET  /unsubscribe?t=<report token>          link in the email footer: shows a confirm button, writes nothing
//   POST /unsubscribe?t=<token>  confirm=1       that button
//   POST /unsubscribe?t=<token>  List-Unsubscribe=One-Click   RFC 8058, from the mail client
//   POST /unsubscribe  email=<address>            the form on the page, for people without a link
//   GET  /stop?c=<code>, POST /stop  code=<code>  postcard opt-out (code printed on the card)
// A token row suppresses that business for both mail and email.
// Nothing to act on -> just serve the page (which shows the forms).
async function handleUnsubscribe(request, url, env) {
  let token = (url.searchParams.get('t') || '').trim() || null;
  let code = normalizeCode(url.searchParams.get('c'));
  let email = null;
  let oneClick = false;

  if (request.method === 'POST') {
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const form = await request.formData();
      oneClick = form.get('List-Unsubscribe') === 'One-Click';
      email = String(form.get('email') || '').trim().toLowerCase() || null;
      code = normalizeCode(form.get('code')) || code;
    }
  }

  const servePage = (status) => {
    const page = new URL('/unsubscribe', url);
    if (status) page.searchParams.set('status', status);
    return status
      ? Response.redirect(page.toString(), 303)
      : serveAsset(env, request, '/unsubscribe', 'GET');
  };

  if (!token && !email && !code) return servePage(null);
  // A GET (the link in an email or a typed /stop?c=) only shows a confirm button: mail scanners open
  // every link in a message, and a paying customer's plan emails must not stop because one did.
  // The button POSTs back to this URL; the RFC 8058 one-click POST from the mail client needs none.
  if (request.method !== 'POST') return servePage(null);

  try {
    if (code && !token) {
      const link = await getReportLink(env, { code });
      if (!link) return servePage('notfound');
      token = link.report_token;
    }
    await recordUnsubscribe(env, {
      token,
      email,
      userAgent: request.headers.get('User-Agent') || null,
    });
  } catch (e) {
    console.error('[unsubscribe] write failed', e);
    // 500 so a mail client retries a one-click POST; humans get the error page.
    return oneClick ? new Response('Unsubscribe failed', { status: 500 }) : servePage('error');
  }

  return oneClick ? new Response('Unsubscribed', { status: 200 }) : servePage('ok');
}

// Tier from the amount paid: TIER_BY_CENTS in src/lib/stripe.js (4900 → 'xray', the $49 X-Ray).

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  // Live endpoint secret first; the optional sandbox endpoint secret lets
  // test-mode checkouts run against production without swapping secrets.
  let ok = false;
  let viaTestSecret = false;
  try {
    ok = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    if (!ok && env.STRIPE_WEBHOOK_SECRET_TEST) {
      viaTestSecret = ok = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET_TEST);
    }
  } catch (e) {
    console.error('[webhook] signature check threw', e);
  }
  if (!ok) {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  // A sandbox secret may only ever vouch for sandbox events.
  if (viaTestSecret && event.livemode !== false) {
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // A refund or lost dispute takes back what the payment unlocked (src/lib/refunds.js). 500 on a
  // failed write so Stripe retries.
  if (REFUND_EVENTS.includes(event.type)) {
    try {
      const result = await handleRefundEvent(env, event);
      console.log('[webhook] refund', event.type, JSON.stringify(result));
      return Response.json({ received: true });
    } catch (e) {
      console.error('[webhook] refund write failed', e);
      return Response.json({ error: 'Refund write failed' }, { status: 500 });
    }
  }

  // A checkout counts once the money is in: card payments are 'paid' at
  // checkout.session.completed; delayed methods (bank debits) complete as
  // 'unpaid' and pay later via async_payment_succeeded. Ack everything else.
  const session = event.data?.object;
  const paidNow =
    (event.type === 'checkout.session.completed' && session?.payment_status === 'paid') ||
    event.type === 'checkout.session.async_payment_succeeded';
  if (!paidNow) {
    return Response.json({ received: true });
  }

  // Our checkout (src/lib/checkout.js) sets client_reference_id to the report token;
  // business + arm come from that token's report_links row.
  const reportToken = session.client_reference_id || session.metadata?.report_id || null;

  try {
    const link = reportToken ? await getReportLink(env, { token: reportToken }) : null;
    const payment = {
      businessId: link?.business_id ?? session.metadata?.business_id ?? null,
      reportToken,
      arm: link?.arm ?? session.metadata?.arm ?? null,
      tier: tierForSession(session),
      amountCents: session.amount_total ?? null,
      currency: session.currency ?? 'usd',
      stripeSessionId: session.id,
      // Add-ons bought in the same checkout (src/lib/checkout.js), e.g. the $25 Competitor Breakdown.
      addons: String(session.metadata?.addons || '').split(',').map((a) => a.trim()).filter((a) => a === 'competitor_breakdown'),
      stripePaymentIntent: session.payment_intent ?? null,
      customerEmail: session.customer_details?.email ?? null,
      status: 'paid',
      livemode: event.livemode !== false,
    };
    const result = await recordPayment(env, payment);
    console.log('[webhook] payment recorded', JSON.stringify(result));
  } catch (e) {
    console.error('[webhook] payment write failed', e);
    // Return 500 so Stripe retries the event.
    return Response.json({ error: 'Payment write failed' }, { status: 500 });
  }

  // The paid audit asks every question on every assistant we have: start that scan now, under the
  // same token. Never fails the webhook (the payment is recorded); a miss shows in the log and /admin.
  const full = await startPaidScan(env, { token: reportToken, sessionId: session.id, tier: tierForSession(session) });
  console.log('[webhook] full scan', JSON.stringify(full));
  // A paid audit that didn't start has no scans row, so no cron will retry it: tell a person.
  if (!full.ok && !['tier', 'already'].includes(full.reason)) {
    await sendPaidScanAlert(env, { token: reportToken, stage: 'start', reason: full.reason, key: session.id });
  }
  // The receipt (src/lib/notify.js). Nothing is sent until RESEND_API_KEY is set.
  const addons = String(session.metadata?.addons || '').split(',').filter((a) => a === 'competitor_breakdown');
  const receipt = await notifyPayment(env, { token: reportToken, email: session.customer_details?.email, tier: tierForSession(session), addons, sessionId: session.id });
  console.log('[webhook] receipt', JSON.stringify(receipt));

  return Response.json({ received: true });
}

// ---------------------------------------------------------------------------
// Static assets, with the Turnstile site key and local examples filled in
// ---------------------------------------------------------------------------
// Marketing pages no longer name the assistants or count the searches (each report lists exactly
// which assistants were asked and when), so the only HTML rewrites are:
//   data-turnstile-sitekey=""   TURNSTILE_SITE_KEY, only when Turnstile is fully configured
//   data-geo-*                  the visitor's town/state/ZIP and example questions (src/lib/geo.js)
//   data-showcase               homepage hero card: a stored real AI answer for this town (src/lib/showcase.js)
// HTML personalised from the visitor's location is Cache-Control: private and its ETag carries a hash
// of that location, so no shared cache hands one visitor's town to another and a 304 never crosses towns.
// The location is only used to fill the page: never logged or stored.

// Goes into rewritten responses' ETags; bump it when the rewrite itself changes.
const PAGE_TAG = '-p2';

/**
 * env.ASSETS.fetch, then fill in the page slots. `path` serves a different asset (pretty
 * URLs); `method` overrides the request's (a POST that ends on a page).
 */
async function serveAsset(env, request, path, method, ctx) {
  let req = request;
  if (path || method) {
    const u = new URL(request.url);
    if (path) { u.pathname = path; u.search = ''; }
    req = new Request(u.toString(), { method: method || request.method, headers: request.headers });
  }
  // The Turnstile site key goes into the page, so it is part of the tag too: a page cached
  // before the key was set (or changed) is not answered with a stale 304.
  const siteKey = turnstileSiteKey(env);
  // The visitor's town (src/lib/geo.js), from the original request so a dev ?geo= survives the pretty-URL rewrite.
  const geo = geoForRequest(request);
  const personal = geo.source === 'ip';
  // Homepage only: the hero's real AI answer for this town and ?trade= (src/lib/showcase.js).
  const reqUrl = new URL(req.url);
  const showcase = !path && (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') && req.method !== 'HEAD'
    ? pickShowcase(await loadShowcaseRows(env, { origin: reqUrl.origin, waitUntil: ctx?.waitUntil?.bind(ctx) }), geo, reqUrl.searchParams.get('trade'))
    : null;
  const tag = PAGE_TAG + (siteKey ? `-ts.${siteKey.slice(-8).replace(/[^A-Za-z0-9_-]/g, '')}` : '') + geoTag(geo) + showcaseTag(showcase);
  // Our ETag = asset ETag + tag; hand the asset server the ETag it knows.
  const inm = req.headers.get('If-None-Match');
  if (inm && inm.includes(tag)) {
    const headers = new Headers(req.headers);
    headers.set('If-None-Match', inm.split(tag).join(''));
    req = new Request(req, { headers });
  }
  const res = await env.ASSETS.fetch(req);
  const isHtml = (res.headers.get('Content-Type') || '').includes('text/html');
  if (!isHtml) return res;

  const tagged = (r) => {
    const etag = r.headers.get('ETag');
    if (etag && !etag.includes(tag)) r.headers.set('ETag', etag.replace(/"$/, `${tag}"`));
    // A page with this visitor's town in it is for this browser only (never a shared/edge cache).
    if (personal) r.headers.set('Cache-Control', 'private, max-age=0, must-revalidate');
    return r;
  };
  if (!res.body || res.status === 304 || req.method === 'HEAD') return tagged(new Response(res.body, res));
  return tagged(addShowcaseHandler(addGeoHandlers(pageRewriter(siteKey), geo), showcase).transform(res));
}

function pageRewriter(siteKey) {
  return new HTMLRewriter()
    // Turnstile widget slot(s): the page script loads the widget only when this is non-empty.
    .on('[data-turnstile-sitekey]', { element(el) { el.setAttribute('data-turnstile-sitekey', siteKey || ''); } });
}

// Admin routes (/admin, /api/admin/*) live in src/admin/: routes.js (auth, pages), api.js (scan API).
