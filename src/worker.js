// Cloudflare Worker — AI Found Score.
//
// Routes:
//   GET  /api/report/[id]   -> report JSON (mock data for now; Supabase later)
//   POST /api/stripe-webhook -> Stripe webhook, verified signature, writes payment
//   everything else          -> static assets (public/) via env.ASSETS

import { recordPayment, recordUnsubscribe, recordReportRequest, getReport } from './lib/db.js';
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

    if (url.pathname === '/api/request' && request.method === 'POST') {
      return handleReportRequest(request, url, env);
    }

    if (url.pathname === '/api/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    if (url.pathname === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
      return handleUnsubscribe(request, url, env);
    }

    if (url.pathname.startsWith('/api/report/') && request.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/report/'.length));
      return handleGetReport(id, env);
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

async function handleGetReport(id, env) {
  const report = await getReport(env, id, MOCK_REPORTS);
  if (!report) {
    return Response.json({ error: 'Report not found' }, { status: 404 });
  }
  return Response.json(report, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
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

// One-click unsubscribe. Three ways in, all write the same suppression row:
//   GET  /unsubscribe?t=<report token>          link in the email footer
//   POST /unsubscribe?t=<token>  List-Unsubscribe=One-Click   RFC 8058, from the mail client
//   POST /unsubscribe  email=<address>            the form on the page, for people without a link
// No token and no email -> just serve the page (which shows the form).
async function handleUnsubscribe(request, url, env) {
  const token = (url.searchParams.get('t') || '').trim() || null;
  let email = null;
  let oneClick = false;

  if (request.method === 'POST') {
    const ct = request.headers.get('Content-Type') || '';
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const form = await request.formData();
      oneClick = form.get('List-Unsubscribe') === 'One-Click';
      email = String(form.get('email') || '').trim().toLowerCase() || null;
    }
  }

  const servePage = (status) => {
    const page = new URL('/unsubscribe', url);
    if (status) page.searchParams.set('status', status);
    return status
      ? Response.redirect(page.toString(), 303)
      : env.ASSETS.fetch(page.toString());
  };

  if (!token && !email) return servePage(null);

  try {
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

  const session = event.data.object;
  const payment = {
    businessId: session.metadata?.business_id ?? null,
    reportId: session.metadata?.report_id ?? null,
    arm: session.metadata?.arm ?? null,
    tier: session.metadata?.tier ?? 'unknown',
    amountCents: session.amount_total ?? null,
    currency: session.currency ?? 'usd',
    stripeSessionId: session.id,
    stripePaymentIntent: session.payment_intent ?? null,
    customerEmail: session.customer_details?.email ?? null,
    status: 'paid',
  };

  try {
    const result = await recordPayment(env, payment);
    console.log('[webhook] payment recorded', JSON.stringify(result));
  } catch (e) {
    console.error('[webhook] payment write failed', e);
    // Return 500 so Stripe retries the event.
    return Response.json({ error: 'Payment write failed' }, { status: 500 });
  }

  return Response.json({ received: true });
}
