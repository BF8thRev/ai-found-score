// src/lib/followups.js — the EXP-002 follow-up funnel: who gets a follow-up, which one, and when.
// Copy: outreach/followup-templates.js. Tables, views and RPCs: supabase/v14_followups.sql.
//
// Rules (campaign 'exp002', from the prospect's first email; a click on any email in the chain counts):
//   followup1   clicked, nothing bought 3 days after the first click
//   followup2   clicked, nothing bought 7 days after the first click (and 3+ days after the last follow-up)
//   bump        no open and no click 5 days after the first email; only when nothing else has gone out
//   Max 2 follow-ups per prospect, ever. None to anyone who replied, bought anything or unsubscribed.
//
// Every check fails closed: a read that fails, a row that doesn't say "not purchased", or an
// unsubscribe lookup that errors means nothing is sent. The same checks run again in the database
// (claim_followup_send), under a per-prospect lock, together with the max-2 cap. Delivery is
// sendViaGmail (src/lib/gmail-sender.js): the Pause switch, the 150/day cap, 5 s between sends, the
// footer + List-Unsubscribe, GMAIL_OUTREACH, and its own unsubscribe check.
//
//   GMAIL_FOLLOWUPS   "on" lets the half-hourly cron (and /admin "Run follow-ups now") send them. Off by
//                     default: the copy is placeholder until the EXP-001 read, and a reply only stops
//                     follow-ups once someone presses "Mark replied" (the Gmail credential can't read mail).
// Sends only on weekdays, 9am-5pm New York time, at most MAX_PER_RUN per run.

import { resolveKeys } from '../../scanner/config.js';
import { isSuppressed } from '../../outreach/suppression.js';
import { renderFollowup, mergeTemplates, validateTemplate, templateKey, FOLLOWUP_STAGES, VARIANTS } from '../../outreach/followup-templates.js';
import { sendViaGmail, outreachEnabled, gmailConfigured, GAP_SECONDS } from './gmail-sender.js';
import { newTrackingToken, clickUrl, validToken } from './email-tracking.js';
import { siteUrl } from './email.js';

export const FOLLOWUP_CAMPAIGN = 'exp002';
export const MAX_FOLLOWUPS = 2;
export const MAX_PER_RUN = 20;
export const RULES = { followup1Days: 3, followup2Days: 7, bumpDays: 5, minGapDays: 3 };
const DAY = 24 * 3600 * 1000;

export const followupsEnabled = (env) => String(env?.GMAIL_FOLLOWUPS ?? '').trim().toLowerCase() === 'on';

/** Weekdays, 9:00-16:59 in New York. */
export function sendWindowOpen(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  return !['Sat', 'Sun'].includes(p.weekday) && hour >= 9 && hour < 17;
}

const at = (v) => (v ? Date.parse(v) : NaN);

/**
 * What a v_followup_candidates row gets next. Pure.
 * → { due: stage } | { wait: stage, at: ms } | { skip: reason }
 * reasons: 'bad row', 'replied', 'purchased', 'unsubscribed', 'no email', 'no report', 'max', 'done',
 * 'opened, no click', 'bump sent'. `purchased` must be exactly false: anything else counts as bought.
 */
export function nextFollowup(c, now = Date.now()) {
  if (!c || !validToken(c.token) || !Array.isArray(c.followups)) return { skip: 'bad row' };
  if (c.replied_at) return { skip: 'replied' };
  if (c.purchased !== false) return { skip: 'purchased' };
  if (c.unsubscribed_at) return { skip: 'unsubscribed' };
  if (!c.email) return { skip: 'no email' };
  if (!c.report_token) return { skip: 'no report' };
  const fus = c.followups;
  if (fus.length >= MAX_FOLLOWUPS) return { skip: 'max' };
  const has = new Set(fus.map((f) => f?.stage));
  const last = fus.reduce((m, f) => Math.max(m, at(f?.sent_at) || 0), 0);
  const notBefore = (t) => Math.max(t, fus.length ? last + RULES.minGapDays * DAY : 0);
  const clicked = at(c.clicked_at);
  if (Number.isFinite(clicked)) {
    let stage;
    let when;
    if (!has.has('followup1')) { stage = 'followup1'; when = clicked + RULES.followup1Days * DAY; }
    else if (!has.has('followup2')) { stage = 'followup2'; when = clicked + RULES.followup2Days * DAY; }
    else return { skip: 'done' };
    when = notBefore(when);
    return now >= when ? { due: stage } : { wait: stage, at: when };
  }
  if (c.opened_at) return { skip: 'opened, no click' };
  if (fus.length) return { skip: 'bump sent' };
  const sent = at(c.sent_at);
  if (!Number.isFinite(sent)) return { skip: 'bad row' };
  const when = sent + RULES.bumpDays * DAY;
  return now >= when ? { due: 'bump' } : { wait: 'bump', at: when };
}

// ---- Supabase (service key) ----------------------------------------------------------------------

function service(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function read(s, path, fetchImpl) {
  const res = await fetchImpl(`${s.base}/${path}`, { headers: s.headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

async function rpc(s, name, args, fetchImpl) {
  const res = await fetchImpl(`${s.base}/rpc/${name}`, { method: 'POST', headers: s.headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${name} failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.json();
}

/** The campaign's first emails with everything nextFollowup needs. Throws on any failure. */
export async function loadCandidates(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const rows = await read(s, `v_followup_candidates?select=*&campaign=ilike.${FOLLOWUP_CAMPAIGN}&order=sent_at.asc&limit=2000`, fetchImpl);
  if (!Array.isArray(rows)) throw new Error('v_followup_candidates: not a list');
  return rows;
}

/** The follow-up copy: saved rows over the placeholder copy. Throws on a failed read (nothing sends). */
export async function loadTemplates(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return mergeTemplates(await read(s, 'outreach_templates?select=*', fetchImpl));
}

async function loadReport(s, reportToken, fetchImpl) {
  const rows = await read(s, `scan_results?select=report&report_token=eq.${encodeURIComponent(reportToken)}&report=not.is.null&order=scanned_at.desc&limit=1`, fetchImpl);
  return rows[0]?.report || null;
}

/** /admin "Mark replied" on a prospect (its first email's token). → true when the prospect exists. Throws on failure. */
export async function markReplied(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!validToken(token)) return false;
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return (await rpc(s, 'mark_email_replied', { p_root: token }, fetchImpl)) === true;
}

/** Save one template from /admin. → { ok: true } | { ok: false, errors }. Throws on a failed write. */
export async function saveTemplate(env, { stage, variant, subject, body }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!FOLLOWUP_STAGES.includes(stage) || !VARIANTS.includes(variant)) return { ok: false, errors: ['Unknown template.'] };
  const t = { subject: String(subject ?? '').trim(), body: String(body ?? '').replace(/\r\n?/g, '\n').trim() };
  const errors = validateTemplate(t, variant);
  if (errors.length) return { ok: false, errors };
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const res = await fetchImpl(`${s.base}/outreach_templates?on_conflict=key`, {
    method: 'POST',
    headers: { ...s.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: templateKey(stage, variant), ...t, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`outreach_templates save failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { ok: true };
}

/** Back to the placeholder copy (deletes the saved row). Throws on a failed write. */
export async function resetTemplate(env, { stage, variant }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!FOLLOWUP_STAGES.includes(stage) || !VARIANTS.includes(variant)) return { ok: false, errors: ['Unknown template.'] };
  const s = service(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const res = await fetchImpl(`${s.base}/outreach_templates?key=eq.${encodeURIComponent(templateKey(stage, variant))}`, {
    method: 'DELETE', headers: { ...s.headers, Prefer: 'return=minimal' }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`outreach_templates reset failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return { ok: true };
}

// ---- the run -------------------------------------------------------------------------------------

// sendViaGmail answers that mean nothing reached Gmail: the claimed follow-up is taken back and can
// go out on a later run. Any other failure keeps the claim (marked 'not sent: …'), so an email Gmail
// may have taken is never sent twice; it still counts toward the max of 2.
const NOT_SENT = new Set(['not configured', 'outreach off', 'bad address', 'bad token', 'bad campaign', 'suppressed', 'paused', 'cap',
  'rate', 'auth', 'limit', 'subject and text are required', 'SUPABASE_SERVICE_KEY is not set', 'claim refused']);
const notSent = (reason) => NOT_SENT.has(reason) || /^claim_gmail_send failed/.test(String(reason));
// Answers that stop the whole run (they hold for every prospect).
const STOP = new Set(['not configured', 'outreach off', 'paused', 'cap', 'auth', 'limit', 'SUPABASE_SERVICE_KEY is not set']);

async function followOne(env, s, c, stage, templates, d) {
  // Unsubscribed (address, report, or business)? A failed check means no send.
  let suppressed = true;
  try {
    suppressed = await isSuppressed(env, {
      email: c.email, ...(c.report_token ? { reportToken: c.report_token } : {}), ...(c.business_id ? { businessId: c.business_id } : {}),
    }, d.fetchImpl);
  } catch { suppressed = true; }
  if (suppressed) return { ok: false, reason: 'suppressed' };

  let report;
  try { report = await loadReport(s, c.report_token, d.fetchImpl); } catch (e) { return { ok: false, reason: 'report read failed', detail: String(e?.message || e).slice(0, 200) }; }
  if (!report) return { ok: false, reason: 'no report' };

  const token = newTrackingToken();
  const base = siteUrl(env);
  const link = clickUrl(base, token, `${base}/report/${encodeURIComponent(c.report_token)}`);
  let msg;
  try { msg = renderFollowup({ stage, templates, report, link }); } catch (e) { return { ok: false, reason: 'copy', detail: String(e?.message || e).slice(0, 300) }; }

  let claim;
  try { claim = await rpc(s, 'claim_followup_send', { p_parent: c.token, p_stage: stage, p_token: token }, d.fetchImpl); } catch (e) {
    return { ok: false, reason: 'claim failed', detail: String(e?.message || e).slice(0, 200), stop: true };
  }
  if (!claim?.ok) return { ok: false, reason: claim?.reason || 'claim refused' };

  const mail = { to: c.email, subject: msg.subject, text: msg.text, html: msg.html, kind: 'outreach', token, campaign: c.campaign, reportToken: c.report_token };
  let r = await d.send(env, mail, { fetchImpl: d.fetchImpl });
  if (!r.ok && r.reason === 'rate') {
    await d.sleep(Math.max(1, Number(r.retryAfter) || GAP_SECONDS) * 1000);
    r = await d.send(env, mail, { fetchImpl: d.fetchImpl });
  }
  if (r.ok) return { ok: true, token, variant: msg.variant, messageId: r.messageId || null };

  try {
    if (notSent(r.reason)) await rpc(s, 'release_followup_send', { p_token: token }, d.fetchImpl);
    else {
      const res = await d.fetchImpl(`${s.base}/email_events?token=eq.${encodeURIComponent(token)}&event=eq.sent`, {
        method: 'PATCH', headers: { ...s.headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ detail: `not sent: ${String(r.reason).slice(0, 200)}` }), signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`email_events update failed: ${res.status}`);
    }
  } catch (e) {
    console.error('[followups] could not undo a claim', String(e?.message || e).slice(0, 200));
  }
  return { ok: false, reason: r.reason, token, stop: STOP.has(r.reason) };
}

/**
 * One pass: every prospect whose follow-up is due gets it (up to maxSends). Never throws.
 * → { ok, skipped? , error?, due, sent, results: [{ token, stage, ok, reason?, variant? }], stopped? }
 * deps: fetchImpl, now (ms), send (sendViaGmail), sleep, maxSends.
 */
export async function runFollowups(env, deps = {}) {
  const d = {
    fetchImpl: deps.fetchImpl || ((...a) => fetch(...a)),
    send: deps.send || sendViaGmail,
    sleep: deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
  const now = deps.now ?? Date.now();
  const maxSends = deps.maxSends ?? MAX_PER_RUN;
  if (!followupsEnabled(env)) return { ok: true, skipped: 'followups off' };
  if (!outreachEnabled(env)) return { ok: true, skipped: 'outreach off' };
  if (!gmailConfigured(env)) return { ok: true, skipped: 'not configured' };
  if (!sendWindowOpen(new Date(now))) return { ok: true, skipped: 'outside hours' };
  const s = service(env);
  if (!s) return { ok: false, skipped: 'SUPABASE_SERVICE_KEY is not set' };

  let templates;
  let candidates;
  try {
    [templates, candidates] = await Promise.all([loadTemplates(env, d), loadCandidates(env, d)]);
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 300), due: 0, sent: 0, results: [] };
  }
  const due = candidates.map((c) => ({ c, n: nextFollowup(c, now) })).filter((x) => x.n.due);
  const out = { ok: true, due: due.length, sent: 0, results: [] };
  for (const { c, n } of due) {
    if (out.sent >= maxSends) break;
    const r = await followOne(env, s, c, n.due, templates, d);
    out.results.push({ token: c.token, stage: n.due, ...r });
    if (r.ok) out.sent += 1;
    if (r.stop) { out.stopped = r.reason; break; }
  }
  return out;
}
