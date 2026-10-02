// src/admin/unlock.js — "Unlock" in /admin's "Find a report" box: an owner who buys outside the
// site (or a comp) gets what a Stripe checkout gives, on the same link.
//
// It writes the same payments row the Stripe webhook writes (src/worker.js handleStripeWebhook):
// tier 'xray' (the $49 audit) and, ticked, the 'competitor_breakdown' add-on. report_unlocked() and
// getPaidTiers() then show the whole report, the Fix Kit and the Breakdown, and hide every offer.
// stripe_session_id is 'admin_<uuid>' so these rows can be told apart from Stripe's.
//   amount 0  → a comp: livemode false, so it is not revenue, not "paying" in the funnel, and gets
//               no free 30-day re-check (src/lib/auto-scan.js readDuePayments is livemode-only).
//   amount >0 → money taken outside Stripe: livemode true, counted as revenue, re-checked at 30 days.
// By default no API calls are made: the page shows the answers already collected. "Run the full audit"
// (opt-in) starts the same paid scan the webhook starts (startPaidScan: every question, every assistant
// with a key, under the same token), so its API cost lands on this business's scans.

import { recordPayment, getReportLink } from '../lib/db.js';
import { startPaidScan } from '../lib/auto-scan.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_ADMIN_CENTS = 99900;

/** The unlock form → { ok, row: { amountCents, email, breakdown, runAudit } } or { ok: false, error }. */
export function parseUnlockForm(f) {
  const rawAmount = String(f.amount ?? '0').trim().replace(/^\$/, '') || '0';
  if (!/^\d+(\.\d{1,2})?$/.test(rawAmount)) return { ok: false, error: 'Amount must be dollars, like 49 or 0.' };
  const amountCents = Math.round(Number(rawAmount) * 100);
  if (amountCents > MAX_ADMIN_CENTS) return { ok: false, error: 'Amount is over $999.' };
  const email = String(f.email || '').trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'That email doesn’t look right.' };
  return { ok: true, row: { amountCents, email: email || null, breakdown: f.breakdown === 'on', runAudit: f.run === 'on' } };
}

/**
 * Record the unlock, then (only if asked) start the full audit. The payment is written first: a scan
 * that won't start leaves the page unlocked and says why ("Re-run full audit" retries it).
 * → { ok: true, sessionId, scan: { ok, scanId?, reason? } | null }
 */
export async function adminUnlock(env, token, { amountCents, email, breakdown, runAudit }) {
  const sessionId = `admin_${crypto.randomUUID()}`;
  const link = await getReportLink(env, { token }).catch(() => null);
  await recordPayment(env, {
    businessId: link?.business_id ?? null,
    reportToken: token,
    arm: link?.arm ?? null,
    tier: 'xray',
    amountCents,
    currency: 'usd',
    stripeSessionId: sessionId,
    addons: breakdown ? ['competitor_breakdown'] : [],
    customerEmail: email,
    status: 'paid',
    livemode: amountCents > 0,
  });
  const scan = runAudit ? await startPaidScan(env, { token, sessionId, tier: 'xray' }) : null;
  return { ok: true, sessionId, scan };
}

/** True when this report's live payments already include the Competitor Breakdown (bought alone, as an add-on, or with the plan). */
export function hasBreakdown(payments) {
  return (payments || []).some((p) => !p.revoked_at
    && (['competitor_breakdown', 'be_the_answer'].includes(p.tier) || (Array.isArray(p.addons) && p.addons.includes('competitor_breakdown'))));
}

/**
 * Add the Competitor Breakdown to a report that is already unlocked: the row a $25 Stripe checkout
 * for it writes (tier 'competitor_breakdown'). Built from the answers already collected: no API calls.
 */
export async function adminAddBreakdown(env, token, { amountCents, email }) {
  const sessionId = `admin_${crypto.randomUUID()}`;
  const link = await getReportLink(env, { token }).catch(() => null);
  await recordPayment(env, {
    businessId: link?.business_id ?? null, reportToken: token, arm: link?.arm ?? null,
    tier: 'competitor_breakdown', amountCents, currency: 'usd', stripeSessionId: sessionId, addons: [],
    customerEmail: email, status: 'paid', livemode: amountCents > 0,
  });
  return { ok: true, sessionId };
}
