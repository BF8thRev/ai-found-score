// Cloudflare Worker — AI Found Score.
//
// Routes:
//   GET  /api/report/[id]   -> report JSON (mock data for now; Supabase later)
//   POST /api/stripe-webhook -> Stripe webhook, verified signature, writes payment
//   everything else          -> static assets (public/) via env.ASSETS

import { recordPayment, recordUnsubscribe, getReport } from './lib/db.js';
import { verifyStripeSignature } from './lib/stripe.js';
import { MOCK_REPORTS } from './mock/sample-reports.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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
