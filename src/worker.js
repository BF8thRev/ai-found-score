// Cloudflare Worker — AI Found Score.
//
// Routes:
//   GET  /r/[code]            -> printed short code (postcard) -> 302 to /report/[token]
//   GET  /api/report/[id]     -> report JSON; fix details withheld until paid
//   POST /api/visit           -> report-page view beacon (arm looked up from token)
//   POST /api/lead            -> "Email me this report"
//   POST /api/request         -> landing-page free-report request (email optional; returns id)
//                                or {request_id, email} to attach an email to that request
//   GET  /api/questions       -> the 5 questions we'd ask for ?trade=&town=&zip=&state=
//   POST /api/stripe-webhook  -> Stripe webhook, verified signature, writes payment
//   GET|POST /unsubscribe, /stop -> email or postcard opt-out
//   /admin, /admin/*          -> business dashboard (session cookie or Bearer ADMIN_TOKEN); src/admin/routes.js
//   GET  /api/admin/ping      -> live key check per engine + extractor (cookie or Bearer ADMIN_TOKEN)
//   POST /api/admin/scan      -> start a background scan (Cloudflare Workflow) -> { scanId, instanceId, statusUrl }
//   GET  /api/admin/scan/:id  -> scan status + progress
//   everything else           -> static assets (public/) via env.ASSETS
//
// Also exports ScanWorkflow (src/scan-workflow.js), bound as SCAN_WORKFLOW in wrangler.jsonc.

import {
  recordPayment, recordUnsubscribe, recordReportRequest, attachReportRequestEmail, recordVisit, recordLead,
  getReport, getReportLink, isReportUnlocked,
} from './lib/db.js';
import { buildQuestions, normalizeTrade } from '../scanner/questions.js';
import { verifyStripeSignature } from './lib/stripe.js';
import { MOCK_REPORTS } from './mock/sample-reports.js';
import { validateReport } from '../shared/report-v2.js';
import { resolveKeys, enginesConfigured } from '../scanner/config.js';
import { handleAdminRequest, isAdminPath } from './admin/routes.js';

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
      return handleReportRequest(request, url, env);
    }

    if (url.pathname === '/api/questions' && request.method === 'GET') {
      return handleQuestions(url);
    }

    if (url.pathname === '/api/visit' && request.method === 'POST') {
      return handleVisit(request, env);
    }

    if (url.pathname === '/api/lead' && request.method === 'POST') {
      return handleLead(request, env);
    }

    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    if ((url.pathname === '/unsubscribe' || url.pathname === '/stop')
        && (request.method === 'GET' || request.method === 'POST')) {
      return handleUnsubscribe(request, url, env);
    }

    if (url.pathname.startsWith('/api/report/') && request.method === 'GET') {
      let id;
      try { id = decodeURIComponent(url.pathname.slice('/api/report/'.length)); } catch {
        return Response.json({ error: 'Report not found' }, { status: 404 });
      }
      return handleGetReport(id, url, env);
    }

    // Pretty-URL rewrites. Serve the clean-URL asset paths directly.
    if (url.pathname.startsWith('/report/') && url.pathname.length > '/report/'.length) {
      return env.ASSETS.fetch(new URL('/report', url).toString());
    }
    if (url.pathname === '/success') {
      return env.ASSETS.fetch(new URL('/success', url).toString());
    }

    // Static assets (landing, report, success pages).
    return env.ASSETS.fetch(request);
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
    stripeWebhookSecretTest: !!env.STRIPE_WEBHOOK_SECRET_TEST,
    // Scanner keys: present or not, never the values.
    // `claude` uses ANTHROPIC_API_KEY; config.js wins once it reports it itself.
    engineKeys: { claude: !!String(env.ANTHROPIC_API_KEY || '').trim(), ...enginesConfigured(env) },
    anthropicApiKey: !!String(env.ANTHROPIC_API_KEY || '').trim(),
    supabaseServiceKey: !!resolveKeys(env).supabaseServiceKey,
    adminToken: !!String(env.ADMIN_TOKEN || '').trim(),
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

async function handleGetReport(id, url, env) {
  const isSample = id.startsWith('sample-');
  let report;
  let unlocked = true;
  try {
    report = await getReport(env, id, MOCK_REPORTS);
    if (report && !isSample) {
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
  const body = unlocked
    ? (report.version === 2 ? { ...report, locked: false } : report)
    : lockReport(report);
  return Response.json(body, {
    // Real reports change the moment they're paid for, so never cache them.
    headers: { 'Cache-Control': isSample ? 'public, max-age=300' : 'private, no-store' },
  });
}

// Headline findings stay visible: the score, which assistants named you,
// which listings are wrong, and the issue titles. What's wrong on each
// listing and how to fix each issue are withheld server-side until paid,
// so they are never in the page for anyone to un-blur.
// v2 follows the same rule: sections 1-7 and 9-11 are the free report;
// section 8's issue descriptions and steps are the paid part.
function lockReport(r) {
  if (r.version === 2) {
    return {
      ...r,
      locked: true,
      // Anything that isn't a clean match keeps only its platform and status.
      listings: (r.listings || []).map((l) =>
        l.status === 'match' ? l : { platform: l.platform, status: l.status, locked: true }),
      issues: (r.issues || []).map((i) => ({ severity: i.severity, title: i.title, locked: true })),
    };
  }
  return {
    ...r,
    locked: true,
    listings: r.listings.map((l) =>
      l.status === 'mismatch' ? { platform: l.platform, status: l.status, locked: true } : l),
    issues: r.issues.map((i) => ({ severity: i.severity, title: i.title, locked: true })),
  };
}

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
  return Response.json({ ok: true });
}

// The assistants the free report asks (site copy: 5 questions x 5 = 25 searches).
const REPORT_ASSISTANTS = ['ChatGPT', 'Claude', 'Gemini', 'Google AI Mode', 'Perplexity'];
const TOWN_RE = /^[\p{L}\p{M}0-9 .,'’-]{1,60}$/u;

// The exact questions the scanner would ask for this trade and town, built
// from the scanner's own templates. Pure function of the query: no DB, no keys.
function handleQuestions(url) {
  const p = url.searchParams;
  const trade = normalizeTrade(String(p.get('trade') || '').slice(0, 40));
  const town = String(p.get('town') || '').trim().replace(/\s+/g, ' ').replace(/,\s*[A-Za-z]{2}$/, '');
  const zip = String(p.get('zip') || '').trim();
  const state = String(p.get('state') || 'NY').trim();
  const bad = (error) => Response.json({ ok: false, error }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  if (!trade) return bad('Unknown trade.');
  if (!TOWN_RE.test(town)) return bad('Please enter your town.');
  if (zip && !/^\d{5}$/.test(zip)) return bad('ZIP must be 5 digits.');
  if (!/^[A-Za-z]{2}$/.test(state)) return bad('State must be a 2-letter code.');
  const questions = buildQuestions({ trade, town, zip, state }).map(({ id, intent, text }) => ({ id, intent, text }));
  return Response.json({
    ok: true,
    trade,
    questions,
    assistants: REPORT_ASSISTANTS,
    searches: questions.length * REPORT_ASSISTANTS.length,
  }, { headers: { 'Cache-Control': 'public, max-age=300' } });
}

// Free-report request from the landing page form. Accepts JSON (fetch) or a
// plain form post (no-JS fallback). Email is optional: the page asks for it
// only after the owner has seen the questions.
//   {business_name, trade, town, zip, state?, website?, phone?, email?} -> new row, returns {ok, id}
//   {request_id, email, ...same fields}                                  -> attaches the email to that row;
//     if the attach can't be done (row missing, first save failed) and the business fields are present,
//     saves a fresh row with the email instead, so the email is never lost.
async function handleReportRequest(request, url, env) {
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
  const okResponse = (id) => (isJson
    ? Response.json({ ok: true, id: id ?? null })
    : Response.redirect(new URL('/?request=ok#request', url).toString(), 303));

  // Honeypot: real people never fill the hidden field.
  if (clean(data.company_url, 10)) return okResponse(null);

  const email = clean(data.email, 160).toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
  if (email && !emailOk) return fail(422, 'Please enter a valid email.');

  // Step 2: attach an email to the request saved in step 1.
  const requestId = clean(data.request_id, 36).toLowerCase();
  if (requestId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) return fail(422, 'Bad request');
    if (!emailOk) return fail(422, 'Please enter a valid email.');
    try {
      if (await attachReportRequestEmail(env, { id: requestId, email })) return okResponse(requestId);
    } catch (e) {
      console.error('[request] email attach failed', e);
    }
    // Couldn't attach: fall through and save a fresh row with the email, if we have the details.
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

  try {
    await recordReportRequest(env, req);
  } catch (e) {
    console.error('[request] write failed', e);
    return fail(500, 'Could not save your request.');
  }
  return okResponse(req.id);
}

// One-click unsubscribe. Every way in writes the same suppression row:
//   GET  /unsubscribe?t=<report token>          link in the email footer
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
      : env.ASSETS.fetch(page.toString());
  };

  if (!token && !email && !code) return servePage(null);

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

// Tier from the amount paid, so Payment Links need no metadata. Keep in
// step with the prices on the site.
const TIER_BY_CENTS = { 2900: 'snapshot', 5900: 'before_after', 6900: 'full_year', 19900: 'listing_fix' };

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

  // The report page appends ?client_reference_id=<report token> to the
  // Payment Link; business + arm come from that token's report_links row.
  const reportToken = session.client_reference_id || session.metadata?.report_id || null;

  try {
    const link = reportToken ? await getReportLink(env, { token: reportToken }) : null;
    const payment = {
      businessId: link?.business_id ?? session.metadata?.business_id ?? null,
      reportToken,
      arm: link?.arm ?? session.metadata?.arm ?? null,
      tier: session.metadata?.tier ?? TIER_BY_CENTS[session.amount_total] ?? 'unknown',
      amountCents: session.amount_total ?? null,
      currency: session.currency ?? 'usd',
      stripeSessionId: session.id,
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

  return Response.json({ received: true });
}

// Admin routes (/admin, /api/admin/*) live in src/admin/: routes.js (auth, pages), api.js (scan API).
