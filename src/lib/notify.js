// src/lib/notify.js — who gets which email, and when (templates and sending: src/lib/email.js).
//
//   request scan done   → every address on that request (report_requests.report_token, email)
//   email added later   → the same "report ready" email, if the report already exists; else "we got it" + link
//   "Email me this"     → the report link to the address typed on the report page (leads)
//   payment             → a receipt to the Stripe checkout email (payments.customer_email)
//   paid scan done      → "your full audit is ready" to the buyer
//   30-day re-check done→ "what changed" to the buyer (Be the Answer buyers get the monthly email instead)
//   monthly scan done   → Be the Answer: what changed, a competitor alert, the next 3 fixes (a town's
//                         report goes to the buyer of its plan)
//
// Needs supabase/v7_email.sql (report_requests.report_token, payments.customer_email). Reads use the
// service key. Every function returns a small result object and never throws: a failed email never
// fails a scan, a payment or a form.

import { resolveKeys } from '../../scanner/config.js';
import {
  sendEmail, emailConfigured, reportReadyEmail, requestReceivedEmail, leadEmail, receiptEmail, fullAuditEmail, recheckEmail, monthlyEmail,
} from './email.js';
import { normalizeBizName } from '../../shared/report-v2.js';
import { validateDetails } from './fix-kit.js';
import { googlePosts, PLAN_MONTHS } from './plan.js';

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function read(env, s, path, fetchImpl) {
  const res = await fetchImpl(`${s.base}/${path}`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path.split('?')[0]} read failed: ${res.status}`);
  return res.json();
}

/** The newest stored v2 report's name, totals and baseline for a token, or null. */
export async function reportSummary(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supa(env);
  if (!s) return null;
  const [row] = await read(env, s, `scan_results?report_token=eq.${encodeURIComponent(token)}&version=eq.2&select=name:report->business->>name,totals:report->totals,before:report->baseline->totals&order=scanned_at.desc&limit=1`, fetchImpl);
  return row || null;
}

/** Tie a free-report request to its report link, so "report ready" can find the owner's email. */
export async function linkRequestToken(env, requestId, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supa(env);
  if (!s || !requestId || !token) return false;
  const res = await fetchImpl(`${s.base}/report_requests?id=eq.${encodeURIComponent(requestId)}`, {
    method: 'PATCH', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify({ report_token: token }),
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

const uniq = (list) => [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];

async function buyerEmails(env, s, token, fetchImpl) {
  const rows = await read(env, s, `payments?report_token=eq.${encodeURIComponent(token)}&customer_email=not.is.null&select=customer_email&limit=10`, fetchImpl);
  return uniq(rows.map((r) => r.customer_email));
}

/** Whether a token has a Be the Answer payment. */
async function onPlan(env, s, token, fetchImpl) {
  const rows = await read(env, s, `payments?report_token=eq.${encodeURIComponent(token)}&select=tier,amount_cents&limit=20`, fetchImpl);
  return rows.some((r) => r.tier === 'be_the_answer' || ((!r.tier || r.tier === 'unknown') && r.amount_cents === 49900));
}

/** The plan a town report belongs to, or null. */
async function planParent(env, s, token, fetchImpl) {
  const [row] = await read(env, s, `plan_towns?town_token=eq.${encodeURIComponent(token)}&select=report_token&limit=1`, fetchImpl).catch(() => []);
  return row?.report_token || null;
}

/** Every business tied for "AI named it most" in a stored report (not the owner), best first; [] when none was named twice. */
export function topCompetitors(entities) {
  const list = (Array.isArray(entities) ? entities : []).filter((e) => e && !e.isYou && e.name && (e.named || 0) >= 2);
  list.sort((a, b) => (b.named || 0) - (a.named || 0) || (b.first || 0) - (a.first || 0) || String(a.name).localeCompare(String(b.name)));
  if (!list.length) return [];
  const [best] = list;
  return list.filter((e) => (e.named || 0) === (best.named || 0) && (e.first || 0) === (best.first || 0)).map((e) => e.name);
}

/** The business AI named most in a stored report (not the owner), or null. Ties go to the first name alphabetically. */
export function topCompetitor(entities) {
  return topCompetitors(entities)[0] || null;
}

/**
 * The monthly competitor alert: a new business now leads where another one led last time. None on a
 * first scan, when last time had no clear leader, or when this month's and last month's leaders are
 * tied (a tie flipping order is not news).
 */
export function competitorAlert(nowEntities, prevEntities) {
  const now = topCompetitors(nowEntities);
  const was = topCompetitors(prevEntities);
  if (!now.length || !was.length) return null;
  const norm = (list) => new Set(list.map((n) => normalizeBizName(n)));
  const nowSet = norm(now);
  const wasSet = norm(was);
  if (now.some((n) => wasSet.has(normalizeBizName(n))) || was.some((n) => nowSet.has(normalizeBizName(n)))) return null;
  return { now: now[0], before: was[0] };
}

/** For the monthly email: the town, the next 3 fixes, and an alert when the top competitor changed. */
export async function monthlyDetail(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supa(env);
  if (!s) return null;
  const rows = await read(env, s, `scan_results?report_token=eq.${encodeURIComponent(token)}&version=eq.2&report=not.is.null&select=town:report->business->>town,issues:report->issues,entities:report->entities&order=scanned_at.desc&limit=2`, fetchImpl);
  if (!rows.length) return null;
  const [now, prev] = rows;
  const next3 = (Array.isArray(now.issues) ? now.issues : []).map((i) => i && i.title).filter(Boolean).slice(0, 3);
  const alert = prev ? competitorAlert(now.entities, prev.entities) : null;
  return { town: now.town || null, next3, alert };
}

/** Every report token on a plan: its own and each extra town's. A "Stop these emails" on any of them stops the plan's emails. */
async function planTokens(env, s, planToken, fetchImpl) {
  const rows = await read(env, s, `plan_towns?report_token=eq.${encodeURIComponent(planToken)}&select=town_token&limit=10`, fetchImpl).catch(() => []);
  return [planToken, ...rows.map((r) => r.town_token).filter(Boolean)];
}

/**
 * This month's Google post for a plan, the same one /plan shows for this calendar month:
 * { month, title, text }, or null before the owner confirms their details.
 */
export async function monthlyGooglePost(env, s, planToken, fetchImpl, now = new Date()) {
  const [saved] = await read(env, s, `fix_kit_details?report_token=eq.${encodeURIComponent(planToken)}&select=details&limit=1`, fetchImpl).catch(() => []);
  if (!saved?.details) return null;
  const v = validateDetails(saved.details);
  if (!v.details) return null;
  const [paid] = await read(env, s, `payments?report_token=eq.${encodeURIComponent(planToken)}&or=(tier.eq.be_the_answer,amount_cents.eq.49900)&select=paid_at&order=paid_at.asc&limit=1`, fetchImpl).catch(() => []);
  const start = paid?.paid_at ? new Date(paid.paid_at) : now;
  const i = (now.getUTCFullYear() * 12 + now.getUTCMonth()) - (start.getUTCFullYear() * 12 + start.getUTCMonth());
  return googlePosts(v.details, { start })[Math.min(Math.max(i, 0), PLAN_MONTHS - 1)] || null;
}

/**
 * A scan saved a valid report: email whoever is waiting for it. trigger: 'request' | 'paid' | 'recheck' |
 * 'monthly' (admin scans email nobody). → { sent, skipped?, error? }
 */
export async function notifyScanDone(env, { trigger, token, scanId }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const s = supa(env);
    if (!s || !emailConfigured(env) || !token) return { sent: 0, skipped: 'not configured' };
    if (!['request', 'paid', 'recheck', 'monthly'].includes(trigger)) return { sent: 0, skipped: 'trigger' };
    const sum = await reportSummary(env, token, { fetchImpl });
    if (!sum) return { sent: 0, skipped: 'no report' };
    let to = [];
    let mail;
    let alsoTokens = [];
    if (trigger === 'request') {
      const rows = await read(env, s, `report_requests?report_token=eq.${encodeURIComponent(token)}&email=not.is.null&select=email&limit=10`, fetchImpl);
      to = uniq(rows.map((r) => r.email));
      mail = reportReadyEmail(env, { token, name: sum.name, totals: sum.totals });
    } else {
      // A town's report belongs to its plan: the plan's buyer gets it.
      const parent = trigger === 'monthly' ? await planParent(env, s, token, fetchImpl) : null;
      const buyerToken = parent || token;
      to = await buyerEmails(env, s, buyerToken, fetchImpl);
      if (trigger === 'paid') {
        mail = fullAuditEmail(env, { token, name: sum.name, totals: sum.totals });
      } else if (trigger === 'monthly' || await onPlan(env, s, buyerToken, fetchImpl)) {
        const d = await monthlyDetail(env, token, { fetchImpl }).catch(() => null);
        // A town's first scan (just added on /plan) has nothing to compare with: it gets its own opener.
        const newTown = !!parent && !sum.before;
        // The month's Google post rides on the plan's own report email, not on each town's.
        const post = parent ? null : await monthlyGooglePost(env, s, buyerToken, fetchImpl).catch(() => null);
        mail = monthlyEmail(env, {
          token, planToken: buyerToken, name: sum.name, totals: sum.totals, before: sum.before, town: d?.town, next3: d?.next3 || [], alert: d?.alert || null,
          newTown, post,
        });
        alsoTokens = (await planTokens(env, s, buyerToken, fetchImpl)).filter((t) => t !== token);
      } else {
        mail = recheckEmail(env, { token, name: sum.name, totals: sum.totals, before: sum.before });
      }
    }
    let sent = 0;
    for (const addr of to) {
      const r = await sendEmail(env, { to: addr, ...mail, token, alsoTokens, idempotencyKey: `${trigger}:${scanId || token}:${addr}` }, { fetchImpl });
      if (r.ok) sent++;
      else console.warn('[email]', trigger, r.reason);
    }
    return { sent };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/** An email was added to a request after its report finished: send "report ready" now. */
export async function notifyRequestEmail(env, { requestId, email }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const s = supa(env);
    if (!s || !emailConfigured(env)) return { sent: 0, skipped: 'not configured' };
    const [row] = await read(env, s, `report_requests?id=eq.${encodeURIComponent(requestId)}&select=report_token&limit=1`, fetchImpl);
    const token = row?.report_token;
    if (!token) return { sent: 0, skipped: 'no link yet' };
    const sum = await reportSummary(env, token, { fetchImpl });
    if (!sum) {
      // Not ready yet: a short "we got it" with the link now; the scan's own "done" email follows.
      const [scan] = await read(env, s, `scans?report_token=eq.${encodeURIComponent(token)}&select=business_name&order=created_at.desc&limit=1`, fetchImpl).catch(() => []);
      const r = await sendEmail(env, { to: email, ...requestReceivedEmail(env, { token, name: scan?.business_name }), token, idempotencyKey: `received:${token}:${String(email).toLowerCase()}` }, { fetchImpl });
      return { sent: r.ok ? 1 : 0, received: true, ...(r.ok ? {} : { skipped: r.reason }) };
    }
    const r = await sendEmail(env, { to: email, ...reportReadyEmail(env, { token, name: sum.name, totals: sum.totals }), token, idempotencyKey: `request:${token}:${String(email).toLowerCase()}` }, { fetchImpl });
    return { sent: r.ok ? 1 : 0, ...(r.ok ? {} : { skipped: r.reason }) };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/** "Email me this report". */
export async function notifyLead(env, { token, email }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!emailConfigured(env)) return { sent: 0, skipped: 'not configured' };
    const sum = await reportSummary(env, token, { fetchImpl }).catch(() => null);
    const r = await sendEmail(env, { to: email, ...leadEmail(env, { token, name: sum?.name }), token, idempotencyKey: `lead:${token}:${String(email).toLowerCase()}` }, { fetchImpl });
    return { sent: r.ok ? 1 : 0, ...(r.ok ? {} : { skipped: r.reason }) };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}

/** The business name on a token's newest scans row (a paid-up-front order has no report yet). */
async function scanName(env, token, fetchImpl) {
  const s = supa(env);
  if (!s) return undefined;
  const [row] = await read(env, s, `scans?report_token=eq.${encodeURIComponent(token)}&select=business_name&order=created_at.desc&limit=1`, fetchImpl).catch(() => []);
  return row?.business_name || undefined;
}

/** Receipt after payment (transactional: sent even if the address unsubscribed from updates). */
export async function notifyPayment(env, { token, email, tier, addons = [], sessionId }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!emailConfigured(env) || !email || !token) return { sent: 0, skipped: 'not configured' };
    const sum = await reportSummary(env, token, { fetchImpl }).catch(() => null);
    const r = await sendEmail(env, { to: email, ...receiptEmail(env, { token, name: sum?.name || await scanName(env, token, fetchImpl), tier, addons, ready: !!sum }), token, transactional: true, idempotencyKey: `receipt:${sessionId || token}` }, { fetchImpl });
    return { sent: r.ok ? 1 : 0, ...(r.ok ? {} : { skipped: r.reason }) };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}
