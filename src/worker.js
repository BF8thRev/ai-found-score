// Cloudflare Worker — AI Found Score.
//
// Routes:
//   GET  /r/[code]            -> printed short code (postcard) -> 302 to /report/[token]
//   GET  /api/report/[id]     -> report JSON; fix details withheld until paid
//   POST /api/visit           -> report-page view beacon (arm looked up from token)
//   POST /api/lead            -> "Email me this report"
//   POST /api/request         -> landing-page free-report request
//   POST /api/stripe-webhook  -> Stripe webhook, verified signature, writes payment
//   GET|POST /unsubscribe, /stop -> email or postcard opt-out
//   everything else           -> static assets (public/) via env.ASSETS

import {
  recordPayment, recordUnsubscribe, recordReportRequest, recordVisit, recordLead,
  getReport, getReportLink, isReportUnlocked,
} from './lib/db.js';
import { verifyStripeSignature } from './lib/stripe.js';
import { MOCK_REPORTS } from './mock/sample-reports.js';

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

    if (url.pathname.startsWith('/r/') && request.method === 'GET') {
      return handleShortCode(url, env);
    }

    if (url.pathname === '/api/request' && request.method === 'POST') {
      return handleReportRequest(request, url, env);
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
      const id = decodeURIComponent(url.pathname.slice('/api/report/'.length));
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
  const code = normalizeCode(decodeURIComponent(url.pathname.slice('/r/'.length)));
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
  return Response.json(unlocked ? report : lockReport(report), {
    // Real reports change the moment they're paid for, so never cache them.
    headers: { 'Cache-Control': isSample ? 'public, max-age=300' : 'private, no-store' },
  });
}

// Headline findings stay visible: the score, which assistants named you,
// which listings are wrong, and the issue titles. What's wrong on each
// listing and how to fix each issue are withheld server-side until paid,
// so they are never in the page for anyone to un-blur.
function lockReport(r) {
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

// Free-report request from the landing page form. Accepts JSON (fetch) or a
// plain form post (no-JS fallback). Writes one row to report_requests.
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

  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const req = {
    businessName: clean(data.business_name, 120),
    town: clean(data.town, 80),
    email: clean(data.email, 160).toLowerCase(),
    trade: clean(data.trade, 40) || null,
    website: clean(data.website, 160) || null,
    userAgent: request.headers.get('User-Agent') || null,
  };
  // Honeypot: real people never fill the hidden field.
  if (clean(data.company_url, 10)) {
    return isJson ? Response.json({ ok: true }) : Response.redirect(new URL('/?request=ok#request', url).toString(), 303);
  }
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(req.email);
  if (!req.businessName || !req.town || !emailOk) {
    return isJson
      ? Response.json({ ok: false, error: 'Please fill in business name, town, and a valid email.' }, { status: 422 })
      : Response.redirect(new URL('/?request=error#request', url).toString(), 303);
  }

  try {
    await recordReportRequest(env, req);
  } catch (e) {
    console.error('[request] write failed', e);
    return isJson
      ? Response.json({ ok: false, error: 'Could not save your request.' }, { status: 500 })
      : Response.redirect(new URL('/?request=error#request', url).toString(), 303);
  }
  return isJson ? Response.json({ ok: true }) : Response.redirect(new URL('/?request=ok#request', url).toString(), 303);
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

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get('Stripe-Signature');

  let ok = false;
  try {
    ok = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
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

  // We only care about completed checkouts; ack everything else.
  if (event.type !== 'checkout.session.completed') {
    return Response.json({ received: true });
  }

  // Payment Links carry one fixed metadata set per link (only `tier` fits
  // there). The report page appends ?client_reference_id=<report token>, and
  // business + arm come from that token's report_links row.
  const session = event.data.object;
  const reportToken = session.client_reference_id || session.metadata?.report_id || null;

  try {
    const link = reportToken ? await getReportLink(env, { token: reportToken }) : null;
    const payment = {
      businessId: link?.business_id ?? session.metadata?.business_id ?? null,
      reportToken,
      arm: link?.arm ?? session.metadata?.arm ?? null,
      tier: session.metadata?.tier ?? 'unknown',
      amountCents: session.amount_total ?? null,
      currency: session.currency ?? 'usd',
      stripeSessionId: session.id,
      stripePaymentIntent: session.payment_intent ?? null,
      customerEmail: session.customer_details?.email ?? null,
      status: 'paid',
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
