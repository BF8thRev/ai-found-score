// src/lib/checkout.js — our own checkout: POST /api/checkout creates a Stripe Checkout Session.
//
// Why not fixed Payment Links: the price is set here, per report. Be the Answer is $499 minus what the
// owner has already paid on that report ("everything you've paid counts"); the $25 Competitor
// Breakdown can ride along with the audit as an add-on; and every session carries metadata.tier, so a
// payment is never recorded as 'unknown'. The buyer still pays on Stripe's own hosted page.
//
//   POST /api/checkout { token, tier, addons?, prepay? } → { ok, url } (redirect the browser to url)
//     prepay true: the visitor bought from /checkout, so there's no report yet, only the request's
//     queued scan (src/lib/auto-scan.js PAID_INTENT). The $49 audit at full price, optionally with the
//     $25 Competitor Breakdown ticked; the paid scan starts when the webhook records the payment.
//     tier   'xray' ($49 audit, Fix Kit included) | 'competitor_breakdown' ($25) | 'be_the_answer' ($499)
//     addons ['competitor_breakdown'], with 'xray' only
//
// What may be bought, per report (the same rules the report page shows buttons by):
//   xray                  a v2 report not yet paid for, with MIN_FIX_ITEMS fixes specific to the business
//                         (xrayOffered: the refund promise)
//   competitor_breakdown  a report whose audit is paid, without the breakdown yet
//   be_the_answer         any real v2 report not on the plan yet; the price is $499 minus its payments
// Needs STRIPE_SECRET_KEY (Worker secret; a restricted key with write access to Checkout Sessions is
// enough). Without it: 503 and the page says checkout opens soon. The webhook (src/worker.js) records
// the payment from metadata.tier and metadata.addons.

import { getReport, getPayments } from './db.js';
import { rateLimit } from './rate-limit.js';
import { xrayOffered, buildCompetitorBreakdown } from '../../shared/report-v2.js';
import { TIER_BY_CENTS } from './stripe.js';
import { pendingReportStatus } from './auto-scan.js';

export const PRICES = Object.freeze({ xray: 4900, competitor_breakdown: 2500, be_the_answer: 49900 });
export const PRODUCTS = Object.freeze({
  xray: { name: 'AI Visibility Audit', description: 'Every answer word for word, every fix with the text to paste, your Fix Kit, and a free re-check in 30 days to see what your fixes changed.' },
  competitor_breakdown: { name: 'Competitor Breakdown', description: 'The top 3 businesses AI names instead of you, side by side with you.' },
  be_the_answer: { name: 'Be the Answer (one year)', description: 'A re-scan every month in up to 3 towns, a monthly email with your next 3 fixes, competitor alerts, your directory checklist and 12 Google posts.' },
});
/** The line under Stripe's Pay button (custom_text.submit.message, max 1,200 characters): the plan's promise. */
export const SUBMIT_MESSAGES = Object.freeze({
  xray: 'Fewer than 3 problems specific to your business? Your $49 back: just reply to your receipt. One-time payment, no subscription. We never ask for your logins.',
  competitor_breakdown: 'Your Competitor Breakdown appears in your report the moment you pay. One-time payment, no subscription.',
  be_the_answer: 'The 60-Day Guarantee: not useful in the first 60 days? Full refund, just reply to your receipt. One payment for the year, no auto-renew. We never ask for your logins.',
});

/** Never charge less than this for Be the Answer after credits (Stripe's floor is $0.50). */
export const MIN_CENTS = 100;
const AUDIT_TIERS = ['xray', 'fix_kit', 'be_the_answer'];
/** Plans that can be bought before the report exists (public/checkout.html). Be the Answer is off sale. */
export const PREPAY_TIERS = ['xray'];
/** Real reports shown in full to everyone (homepage "See what you get"); never sold. */
export const SHOWCASE_TOKENS = ['mega-wash-and-dry'];
const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** The plans a report's payments add up to (tier, else the tier for its amount, plus add-ons). */
export function paidTiers(payments) {
  const out = new Set();
  for (const p of payments || []) {
    const t = p.tier && p.tier !== 'unknown' ? p.tier : TIER_BY_CENTS[p.amount_cents];
    if (t) out.add(t);
    for (const a of Array.isArray(p.addons) ? p.addons : []) out.add(a);
  }
  return out;
}

/**
 * What this checkout would charge, or why it can't happen. Pure.
 * → { ok: true, items: [{ tier, cents, name, description }], credit, total } | { ok: false, status, error }
 */
export function priceCheckout({ report, payments = [], tier, addons = [], livemode = true, prepay = false }) {
  if (!PRICES[tier]) return { ok: false, status: 400, error: 'Unknown plan.' };
  // Paying up front (/checkout): no report exists yet, only the request's queued scan. The audit is
  // made after payment; the refund promise on Stripe's page ("fewer than 3 problems, your $49 back")
  // covers what xrayOffered checks on a finished report. The Competitor Breakdown can ride along.
  if (!report && prepay) {
    if (!PREPAY_TIERS.includes(tier)) return { ok: false, status: 409, error: 'Get your free report first.' };
    const extras = [...new Set((Array.isArray(addons) ? addons : []).map(String))];
    if (extras.some((a) => a !== 'competitor_breakdown')) return { ok: false, status: 400, error: 'Unknown add-on.' };
    const mine = payments.filter((p) => (p.livemode !== false) === livemode);
    if (paidTiers(mine).has(tier)) return { ok: false, status: 409, error: 'That’s already paid for. Open your report.' };
    const items = [tier, ...extras].map((t) => ({ tier: t, cents: PRICES[t], ...PRODUCTS[t] }));
    return { ok: true, items, credit: 0, total: items.reduce((n, i) => n + i.cents, 0), prepay: true };
  }
  if (!report || report.version !== 2) return { ok: false, status: 404, error: 'Report not found' };
  if (report.sample || SHOWCASE_TOKENS.includes(String(report.id || ''))) return { ok: false, status: 400, error: 'This is an example report. Get your own free report first.' };
  const extras = [...new Set((Array.isArray(addons) ? addons : []).map(String))];
  if (extras.some((a) => a !== 'competitor_breakdown') || (extras.length && tier !== 'xray')) return { ok: false, status: 400, error: 'Unknown add-on.' };
  // Credits come only from payments in the same mode (a test payment never discounts a live one).
  const mine = payments.filter((p) => (p.livemode !== false) === livemode);
  const have = paidTiers(mine);
  const audited = AUDIT_TIERS.some((t) => have.has(t));
  if (tier === 'xray') {
    if (audited) return { ok: false, status: 409, error: 'Your audit is already paid for. Open your report.' };
    if (!xrayOffered(report)) return { ok: false, status: 409, error: 'We found fewer than 3 problems specific to your business, so there is nothing to sell you.' };
  }
  if (tier === 'competitor_breakdown') {
    if (!audited) return { ok: false, status: 409, error: 'The Competitor Breakdown comes after the audit.' };
    if (have.has('competitor_breakdown') || have.has('be_the_answer')) return { ok: false, status: 409, error: 'You already have the Competitor Breakdown. It’s in your report.' };
  }
  if (tier === 'be_the_answer' && have.has('be_the_answer')) return { ok: false, status: 409, error: 'You’re already on Be the Answer.' };
  // Nobody named often enough to compare: there is no Breakdown to sell (alone or as the add-on).
  if ((tier === 'competitor_breakdown' || extras.length) && !buildCompetitorBreakdown(report).competitors.length) {
    return { ok: false, status: 409, error: 'No other business was named often enough to compare, so there is no Competitor Breakdown to sell you.' };
  }
  const items = [tier, ...extras].map((t) => ({ tier: t, cents: PRICES[t], ...PRODUCTS[t] }));
  let credit = 0;
  if (tier === 'be_the_answer') {
    const paid = mine.reduce((n, p) => n + (Number.isInteger(p.amount_cents) ? p.amount_cents : 0), 0);
    credit = Math.min(paid, PRICES.be_the_answer - MIN_CENTS);
    items[0].cents -= credit;
  }
  return { ok: true, items, credit, total: items.reduce((n, i) => n + i.cents, 0) };
}

/** Stripe's form encoding for the Checkout Session. */
export function sessionForm({ items, credit, token, tier, addons, origin, prepay = false }) {
  const f = new URLSearchParams();
  f.set('mode', 'payment');
  f.set('client_reference_id', token);
  // t: the report link, so /success works on any device (not only where localStorage has it);
  // v: dollars charged, for the purchase event (public/js/analytics.js).
  // (items are already net of any credit: priceCheckout takes it off the plan's line.)
  const charged = (items || []).reduce((sum, i) => sum + (Number(i.cents) || 0), 0) / 100;
  f.set('success_url', `${origin}/success?tier=${encodeURIComponent(tier)}&t=${encodeURIComponent(token)}&v=${charged}${prepay ? '&prepay=1' : ''}&session_id={CHECKOUT_SESSION_ID}`);
  // Left Stripe without paying before a report existed: back to /checkout with their details filled in
  // and nothing started. The free snapshot is offered there (/api/checkout/cancel starts it).
  f.set('cancel_url', prepay ? `${origin}/checkout?cancelled=1&t=${encodeURIComponent(token)}` : `${origin}/report/${encodeURIComponent(token)}`);
  if (prepay) f.set('metadata[prepay]', '1');
  f.set('metadata[tier]', tier);
  f.set('metadata[report_id]', token);
  if (addons.length) f.set('metadata[addons]', addons.join(','));
  if (credit) f.set('metadata[credit_cents]', String(credit));
  f.set('custom_text[submit][message]', SUBMIT_MESSAGES[tier]);
  f.set('payment_intent_data[metadata][tier]', tier);
  f.set('payment_intent_data[description]', items.map((i) => i.name).join(' + '));
  f.set('payment_intent_data[metadata][report_id]', token);
  items.forEach((it, i) => {
    f.set(`line_items[${i}][quantity]`, '1');
    f.set(`line_items[${i}][price_data][currency]`, 'usd');
    f.set(`line_items[${i}][price_data][unit_amount]`, String(it.cents));
    f.set(`line_items[${i}][price_data][product_data][name]`, it.name);
    const desc = credit && it.tier === 'be_the_answer'
      ? `${it.description} Includes $${(credit / 100).toFixed(2)} credit for what you've already paid.`
      : it.description;
    f.set(`line_items[${i}][price_data][product_data][description]`, desc);
    // Our square product image next to each item on Stripe's page (a public https image; skipped for local dev).
    if (origin.startsWith('https://')) f.set(`line_items[${i}][price_data][product_data][images][0]`, `${origin}/img/product.png`);
  });
  return f;
}

/** deps (tests pass fakes): { getReport, getPayments, pendingStatus, rateLimit, fetchImpl, mockReports } */
export async function handleCheckout(request, url, env, deps = {}) {
  const d = { getReport, getPayments, pendingStatus: pendingReportStatus, rateLimit, fetchImpl: (...a) => fetch(...a), mockReports: {}, ...deps };
  const limited = await d.rateLimit(env, request, 'checkout');
  if (limited) return limited;
  const key = String(env?.STRIPE_SECRET_KEY || '').trim();
  if (!key) return json({ ok: false, error: 'Checkout opens soon. Email hello@aifoundscore.com and we’ll hold your spot.' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const token = String(body?.token || '');
  const tier = String(body?.tier || '');
  const addons = Array.isArray(body?.addons) ? body.addons.map(String) : [];
  if (!TOKEN_RE.test(token) || token.startsWith('sample-')) return json({ ok: false, error: 'Report not found' }, 404);

  let report;
  let payments;
  let prepay = false;
  try {
    report = await d.getReport(env, token, d.mockReports);
    // No report yet: fine only for a request whose scan is waiting (the paid path from pricing).
    if (!report && body?.prepay === true) prepay = (await d.pendingStatus(env, token)) != null;
    payments = report || prepay ? await d.getPayments(env, token) : [];
  } catch (e) {
    console.error('[checkout] read failed', e);
    return json({ ok: false, error: 'Could not start checkout. Try again in a minute.' }, 503);
  }
  if (report) report = { ...report, id: token };
  const livemode = key.startsWith('sk_live_') || key.startsWith('rk_live_');
  const price = priceCheckout({ report, payments, tier, addons, livemode, prepay });
  if (!price.ok) return json({ ok: false, error: price.error }, price.status);

  const origin = String(env?.SITE_URL || url.origin).replace(/\/+$/, '');
  const form = sessionForm({ ...price, token, tier, addons: price.items.slice(1).map((i) => i.tier), origin, prepay: !!price.prepay });
  let res;
  try {
    res = await d.fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('[checkout] stripe unreachable', e);
    return json({ ok: false, error: 'Could not reach our payment provider. Try again in a minute.' }, 502);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.url) {
    console.error('[checkout] stripe refused', res.status, JSON.stringify(out?.error || {}).slice(0, 300));
    return json({ ok: false, error: 'Could not start checkout. Try again in a minute.' }, 502);
  }
  return json({ ok: true, url: out.url, total: price.total });
}
