// src/lib/refunds.js — Stripe refunds and lost disputes (supabase/v9_refunds.sql).
//
//   charge.refunded        records refunded_cents / refunded_at on the payment. A full refund also sets
//                          revoked_at: the payment stops unlocking the report, the Fix Kit and the plan,
//                          and no 30-day re-check or monthly scan starts for it. A partial refund of
//                          exactly the $25 Competitor Breakdown add-on drops that add-on; any other
//                          partial refund keeps access (a person decided on it in Stripe).
//   charge.dispute.closed  status 'lost' revokes like a full refund.
//
// The payment row is found by its PaymentIntent (payments.stripe_payment_intent, written by the
// checkout webhook). A full refund also closes the token's open refund_requests rows. Throws on a
// Supabase error so the webhook answers 500 and Stripe retries; an unknown PaymentIntent is only logged.

import { resolveKeys } from '../../scanner/config.js';
import { PRICES } from './checkout.js';

export const REFUND_EVENTS = Object.freeze(['charge.refunded', 'charge.dispute.closed']);

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

const idOf = (v) => (v && typeof v === 'object' ? v.id : v) || null;

/**
 * What a refund/dispute event means for our payment row. Pure.
 * → null (not ours to act on) | { paymentIntent, refundedCents, revoke, dropBreakdown }
 */
export function refundChange(event) {
  const o = event?.data?.object;
  if (!o) return null;
  if (event.type === 'charge.refunded') {
    const paymentIntent = idOf(o.payment_intent);
    const amount = Number(o.amount) || 0;
    const refundedCents = Number(o.amount_refunded) || 0;
    if (!paymentIntent || refundedCents <= 0) return null;
    const revoke = o.refunded === true || (amount > 0 && refundedCents >= amount);
    return { paymentIntent, refundedCents, revoke, dropBreakdown: !revoke && refundedCents === PRICES.competitor_breakdown };
  }
  if (event.type === 'charge.dispute.closed') {
    const paymentIntent = idOf(o.payment_intent);
    if (!paymentIntent || o.status !== 'lost') return null;
    return { paymentIntent, refundedCents: Number(o.amount) || 0, revoke: true, dropBreakdown: false };
  }
  return null;
}

/** Apply a refund or lost dispute to its payment row. → { ok, matched, revoked?, token? } */
export async function handleRefundEvent(env, event, { fetchImpl = (...a) => fetch(...a), now = () => new Date() } = {}) {
  const change = refundChange(event);
  if (!change) return { ok: true, matched: false, ignored: true };
  const s = supa(env);
  const res = await fetchImpl(`${s.base}/payments?stripe_payment_intent=eq.${encodeURIComponent(change.paymentIntent)}&select=id,report_token,amount_cents,addons,revoked_at&limit=5`, {
    headers: s.headers, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`payments read failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const rows = await res.json();
  if (!rows.length) {
    console.warn('[refund] no payment for', change.paymentIntent, '(refunded in Stripe; check /admin)');
    return { ok: true, matched: false };
  }

  const at = now().toISOString();
  for (const row of rows) {
    const patch = { refunded_cents: change.refundedCents, refunded_at: at };
    if (change.revoke && !row.revoked_at) patch.revoked_at = at;
    if (change.dropBreakdown && Array.isArray(row.addons) && row.addons.includes('competitor_breakdown')) {
      patch.addons = row.addons.filter((a) => a !== 'competitor_breakdown');
    }
    const up = await fetchImpl(`${s.base}/payments?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify(patch), signal: AbortSignal.timeout(8000),
    });
    if (!up.ok) throw new Error(`payments update failed: ${up.status} ${(await up.text()).slice(0, 200)}`);
  }

  const token = rows[0].report_token || null;
  if (change.revoke && token) {
    // Best effort: the refund itself is already recorded.
    await fetchImpl(`${s.base}/refund_requests?report_token=eq.${encodeURIComponent(token)}&status=eq.open`, {
      method: 'PATCH', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'refunded' }), signal: AbortSignal.timeout(8000),
    }).catch((e) => console.error('[refund] refund_requests update failed', e));
  }
  return { ok: true, matched: true, revoked: change.revoke, token };
}
