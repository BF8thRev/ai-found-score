// src/lib/notify.js — who gets which email, and when (templates and sending: src/lib/email.js).
//
//   request scan done   → every address on that request (report_requests.report_token, email)
//   email added later   → the same "report ready" email, if the report already exists
//   "Email me this"     → the report link to the address typed on the report page (leads)
//   payment             → a receipt to the Stripe checkout email (payments.customer_email)
//   paid scan done      → "your full audit is ready" to the buyer
//   30-day re-check done→ "what changed" to the buyer
//
// Needs supabase/v7_email.sql (report_requests.report_token, payments.customer_email). Reads use the
// service key. Every function returns a small result object and never throws: a failed email never
// fails a scan, a payment or a form.

import { resolveKeys } from '../../scanner/config.js';
import {
  sendEmail, emailConfigured, reportReadyEmail, leadEmail, receiptEmail, fullAuditEmail, recheckEmail,
} from './email.js';

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

/**
 * A scan saved a valid report: email whoever is waiting for it. trigger: 'request' | 'paid' | 'recheck'
 * (admin scans email nobody). → { sent, skipped?, error? }
 */
export async function notifyScanDone(env, { trigger, token, scanId }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const s = supa(env);
    if (!s || !emailConfigured(env) || !token) return { sent: 0, skipped: 'not configured' };
    if (!['request', 'paid', 'recheck'].includes(trigger)) return { sent: 0, skipped: 'trigger' };
    const sum = await reportSummary(env, token, { fetchImpl });
    if (!sum) return { sent: 0, skipped: 'no report' };
    let to = [];
    let mail;
    if (trigger === 'request') {
      const rows = await read(env, s, `report_requests?report_token=eq.${encodeURIComponent(token)}&email=not.is.null&select=email&limit=10`, fetchImpl);
      to = uniq(rows.map((r) => r.email));
      mail = reportReadyEmail(env, { token, name: sum.name, totals: sum.totals });
    } else {
      to = await buyerEmails(env, s, token, fetchImpl);
      mail = trigger === 'paid'
        ? fullAuditEmail(env, { token, name: sum.name, totals: sum.totals })
        : recheckEmail(env, { token, name: sum.name, totals: sum.totals, before: sum.before });
    }
    let sent = 0;
    for (const addr of to) {
      const r = await sendEmail(env, { to: addr, ...mail, token, idempotencyKey: `${trigger}:${scanId || token}:${addr}` }, { fetchImpl });
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
    if (!sum) return { sent: 0, skipped: 'not ready' }; // the scan's own "done" email covers it
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

/** Receipt after payment (transactional: sent even if the address unsubscribed from updates). */
export async function notifyPayment(env, { token, email, tier, sessionId }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    if (!emailConfigured(env) || !email || !token) return { sent: 0, skipped: 'not configured' };
    const sum = await reportSummary(env, token, { fetchImpl }).catch(() => null);
    const r = await sendEmail(env, { to: email, ...receiptEmail(env, { token, name: sum?.name, tier }), token, transactional: true, idempotencyKey: `receipt:${sessionId || token}` }, { fetchImpl });
    return { sent: r.ok ? 1 : 0, ...(r.ok ? {} : { skipped: r.reason }) };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e).slice(0, 200) };
  }
}
