// src/admin/outreach.js — the cold-email arm on /admin: the email funnel table, the Prospects table
// with its timeline drawer (read-only), and the "Log a sent email" / "Add a prospect" forms.
// Data: v_email_funnel, v_email_prospects, v_email_timeline (supabase/v12_email_tracking.sql).
// Nothing here sends email: "Log as sent" only writes the 'sent' row and shows what to paste.

import { esc, pct, shortTime } from './metrics.js';
import { trackingSnippet, ARM_EMAIL, CAMPAIGN_RE } from '../lib/email-tracking.js';

export const STAGES = [
  { key: 'sent', label: 'Sent' },
  { key: 'opened', label: 'Opened' },
  { key: 'clicked', label: 'Clicked' },
  { key: 'snapshot_started', label: 'Snapshot started' },
  { key: 'snapshot_completed', label: 'Snapshot completed' },
  { key: 'paid', label: 'Paid' },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
const STAGE_TONE = { sent: 'neutral', opened: 'neutral', clicked: 'warn', snapshot_started: 'warn', snapshot_completed: 'good', paid: 'good' };

const EVENT_LABEL = {
  sent: 'Email sent',
  opened: 'Opened (image loaded)',
  clicked: 'Clicked a link',
  visit: 'Report viewed',
  snapshot_started: 'Free Snapshot requested',
  scan: 'Snapshot finished',
  payment: 'Paid',
  payment_test: 'Test payment (not counted)',
  payment_refunded: 'Paid, then refunded (not counted)',
  unsubscribed: 'Unsubscribed',
  replied: 'Replied (marked on /admin)',
};
export const eventLabel = (kind) => EVENT_LABEL[kind] || String(kind || '—');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The "Log a sent email" form → { ok, row: { businessId, campaign, email, town } } | { ok: false, error }. */
export function parseSentForm(f = {}) {
  const businessId = String(f.business_id || '').trim().toLowerCase();
  const campaign = String(f.campaign || '').trim();
  const email = String(f.email || '').trim().toLowerCase();
  const town = String(f.town || '').trim().slice(0, 60);
  if (!UUID_RE.test(businessId)) return { ok: false, error: 'Pick a business.' };
  if (!CAMPAIGN_RE.test(campaign)) return { ok: false, error: 'Campaign: letters, numbers, spaces, dots, dashes or underscores (up to 80).' };
  if (email && !EMAIL_RE.test(email)) return { ok: false, error: 'That recipient email doesn’t look right.' };
  return { ok: true, row: { businessId, campaign, email: email || null, town: town || null } };
}

/** The "Add a prospect" form → { ok, row } (a businesses row) | { ok: false, error }. */
export function parseProspectForm(f = {}) {
  const clean = (v, max) => String(v ?? '').trim().slice(0, max);
  const row = {
    name: clean(f.name, 200),
    trade: clean(f.trade, 40) || null,
    town: clean(f.town, 60) || null,
    website: clean(f.website, 200) || null,
    phone: clean(f.phone, 30) || null,
    address: clean(f.address, 200) || null,
  };
  if (!row.name) return { ok: false, error: 'Business name is required.' };
  if (!row.town) return { ok: false, error: 'Town is required.' };
  return { ok: true, row };
}

/**
 * Funnel rows per arm with stage-to-stage conversion. The email arm is always there (zeros when
 * nothing has been sent yet). → [{ arm, counts: {stage: n}, unsubscribed, rates: {stage: fraction|null} }]
 */
export function emailFunnelRows(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.some((r) => r.arm === ARM_EMAIL)) list.unshift({ arm: ARM_EMAIL });
  return list.map((r) => {
    const counts = Object.fromEntries(STAGES.map((s) => [s.key, num(r[s.key])]));
    const rates = {};
    STAGES.forEach((s, i) => {
      if (i === 0) return;
      const prev = counts[STAGES[i - 1].key];
      rates[s.key] = prev > 0 ? counts[s.key] / prev : null;
    });
    return { arm: r.arm || '—', counts, unsubscribed: num(r.unsubscribed), rates };
  });
}

/** Timeline rows grouped by token, oldest first. */
export function groupTimeline(rows) {
  const by = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r?.token) continue;
    if (!by.has(r.token)) by.set(r.token, []);
    by.get(r.token).push(r);
  }
  for (const list of by.values()) list.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return by;
}

const badge = (tone, label) => `<span class="badge t-${esc(tone)}">${esc(label)}</span>`;

/** The email arm's funnel table (goes under the mail arm's, which is unchanged). */
export function emailFunnelTable(rows, errors = {}) {
  if (errors.emailFunnel) return `<p class="err">${esc(errors.emailFunnel)}</p>`;
  const list = emailFunnelRows(rows);
  return `<h3>Email arm</h3>
  <p class="sub">Each email counts at the furthest stage it reached and every stage before it, so these match the Prospects table. % = share of the stage before. Opens are rough (mail apps load or block images on their own); clicks are the number to trust.</p>
  <div class="tw"><table>
    <thead><tr><th>Arm</th>${STAGES.map((s) => `<th class="n">${esc(s.label)}</th>`).join('')}<th class="n">Unsubscribed</th></tr></thead>
    <tbody>${list.map((r) => `<tr><td><b>${esc(r.arm)}</b></td>${STAGES.map((s, i) => `<td class="n">${esc(r.counts[s.key])}${i ? `<div class="small">${r.rates[s.key] == null ? '—' : pct(r.rates[s.key])}</div>` : ''}</td>`).join('')}<td class="n">${esc(r.unsubscribed)}</td></tr>`).join('')}</tbody>
  </table></div>`;
}

/** Prospects: read-only table + a timeline drawer per row (admin.js opens it). No buttons that change anything. */
export function prospectsSection(d, errors = {}) {
  // One row per prospect: follow-ups (v14 parent_token) are in the Follow-ups section.
  const rows = Array.isArray(d.prospects) ? d.prospects.filter((r) => r && !r.parent_token) : [];
  const timeline = groupTimeline(d.timeline);
  const arms = [...new Set(rows.map((r) => r.arm || '—'))].sort();
  const filter = arms.length > 1
    ? `<label class="inline-filter">Arm <select data-prospect-arm><option value="">All</option>${arms.map((a) => `<option value="${esc(a)}"${a === ARM_EMAIL ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select></label>`
    : '';
  const err = ['prospects', 'timeline'].filter((k) => errors[k]).map((k) => `<p class="err">${esc(errors[k])}</p>`).join('');
  const body = rows.length ? `<div class="tw"><table class="prospects">
    <thead><tr><th>Business</th><th>Town</th><th>Campaign</th><th>Stage</th><th>Last event</th><th>When</th></tr></thead>
    <tbody>${rows.map((r) => `<tr class="pick" tabindex="0" role="button" aria-label="Timeline for ${esc(r.business || 'this business')}" data-token="${esc(r.token)}" data-arm="${esc(r.arm || '—')}"${arms.length > 1 && (r.arm || '—') !== ARM_EMAIL ? ' hidden' : ''}>
      <td>${esc(r.business || '—')}${r.email ? `<div class="small">${esc(r.email)}</div>` : ''}</td>
      <td>${esc(r.town || '—')}</td>
      <td class="small">${esc(r.campaign || '—')}</td>
      <td>${badge(STAGE_TONE[r.stage] || 'neutral', STAGE_LABEL[r.stage] || r.stage || '—')}${r.unsubscribed_at ? ` ${badge('bad', 'unsubscribed')}` : ''}</td>
      <td>${esc(eventLabel(r.last_event))}</td>
      <td class="small">${esc(shortTime(r.last_event_at))}</td>
    </tr>`).join('')}</tbody>
  </table></div>
  ${rows.map((r) => `<template data-timeline="${esc(r.token)}"><h3>${esc(r.business || '—')}</h3>
    <p class="small">${esc(r.town || '')}${r.town ? ' · ' : ''}${esc(r.campaign || '')}${r.email ? ` · ${esc(r.email)}` : ''}</p>
    <ol class="timeline">${(timeline.get(r.token) || []).map((e) => `<li><time datetime="${esc(e.at)}">${esc(shortTime(e.at))}</time><span>${esc(eventLabel(e.kind))}${e.detail ? ` <span class="small">${e.kind === 'clicked' ? 'to ' : ''}${esc(e.detail)}</span>` : ''}</span></li>`).join('') || '<li>No events.</li>'}</ol>
  </template>`).join('')}` : (err ? '' : '<p class="small">No emails logged yet. Log one below (“Log a sent email”) and it shows here.</p>');
  return `<section id="prospects">
  <h2>Prospects</h2>
  <p class="sub">One row per email sent (business + campaign), at the furthest stage it reached. Click a row for every event in order. Read-only: stages come from the tracking, never typed in.</p>
  ${filter}
  ${err}
  ${body}
  <aside class="drawer" id="timeline-drawer" hidden aria-label="Timeline">
    <button type="button" class="drawer-close" data-drawer-close aria-label="Close">×</button>
    <div data-drawer-body></div>
  </aside>
</section>`;
}

/** What to paste into a hand-sent Gmail message for one logged email. */
export function snippetBlock(base, prospect) {
  const s = trackingSnippet(base, { token: prospect.token, reportToken: prospect.report_token || null });
  const field = (label, value) => `<label class="full">${esc(label)}<span class="copy-row"><input type="text" readonly value="${esc(value)}"><button type="button" data-copy="${esc(value)}">Copy</button></span></label>`;
  return `<div class="snippet">
    <p class="ok-msg" role="status">Logged as sent: <b>${esc(prospect.business || '—')}</b>, campaign “${esc(prospect.campaign || '')}”. Nothing was emailed. Put these in the Gmail message, then send it.</p>
    <ol class="small steps">
      <li>Write the email in Gmail. For each link, select the words, press Ctrl+K and paste a tracked link below.</li>
      <li>At the very end, click “Copy footer for Gmail” and paste (Ctrl+V). It is the address, the unsubscribe link and the invisible open-tracking image.</li>
      <li>Don’t open the sent message yourself: loading its image counts as an open.</li>
    </ol>
    <div class="grid">
      ${s.links.map((l) => field(`Tracked link: ${l.label}`, l.url)).join('')}
      ${field('Unsubscribe link (already in the footer)', s.stopUrl)}
      ${field('Open-tracking image URL (Gmail: Insert photo → Web address, if the footer paste drops it)', s.pixelUrl)}
    </div>
    <p><button type="button" class="primary" data-copy-html="${esc(s.footerHtml)}" data-copy="${esc(s.footerText)}">Copy footer for Gmail</button> <span class="small" data-copy-note></span></p>
  </div>`;
}

/** "Log a sent email" and "Add a prospect". Only writes rows; never sends anything. */
export function logEmailSection(d, errors = {}, { flash = '', sent = null, base = '' } = {}) {
  const businesses = Array.isArray(d.prospectBusinesses) ? d.prospectBusinesses : [];
  const prospect = sent ? (d.prospects || []).find((p) => p.token === sent) : null;
  return `<section id="log-email">
  <h2>Log a sent email</h2>
  <p class="sub">For emails sent by hand from Gmail. This does not send anything: it records the email as sent and gives you the tracked links and footer to paste, so opens and clicks track on their own. Logging the same business + campaign again gives the same links.</p>
  ${flash}
  ${prospect ? snippetBlock(base, prospect) : ''}
  ${errors.prospectBusinesses ? `<p class="err">${esc(errors.prospectBusinesses)}</p>` : ''}
  <form class="grid" method="post" action="/admin/email/sent">
    <label>Business<select name="business_id" required><option value="">Pick one…</option>${businesses.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}${b.town ? ` (${esc(b.town)})` : ''}</option>`).join('')}</select></label>
    <label>Campaign<input type="text" name="campaign" required maxlength="80" pattern="[A-Za-z0-9][A-Za-z0-9 ._\\-]{0,79}" placeholder="test20-a"></label>
    <label>Recipient email<input type="text" name="email" inputmode="email" maxlength="160" placeholder="owner@business.com"></label>
    <label>Town (if not on the business)<input type="text" name="town" maxlength="60"></label>
    <div class="full"><button class="primary" type="submit">Log as sent and show links</button></div>
  </form>
  <h3>Add a prospect</h3>
  <p class="sub">A business to email that isn’t in the list yet. No scan runs.</p>
  <form class="grid" method="post" action="/admin/prospects">
    <label>Business name<input type="text" name="name" required maxlength="200"></label>
    <label>Town<input type="text" name="town" required maxlength="60"></label>
    <label>Trade<input type="text" name="trade" maxlength="40" placeholder="plumber"></label>
    <label>Website<input type="text" name="website" maxlength="200"></label>
    <label>Phone<input type="text" name="phone" inputmode="tel" maxlength="30"></label>
    <label>Street address<input type="text" name="address" maxlength="200"></label>
    <div class="full"><button class="primary" type="submit">Add prospect</button></div>
  </form>
</section>`;
}

const SEND_STATUS_TONE = { sent: 'good', failed: 'bad', sending: 'warn' };

/**
 * "Gmail sender": the Pause switch, today's count against the cap, a test send to our own address,
 * and the last sends. `gmail` = gmailStatus(env) (src/lib/gmail-sender.js); rows from v13.
 */
export function gmailSection(d, errors = {}, { flash = '', gmail = null } = {}) {
  const g = gmail || { secrets: {}, configured: false, cap: 0, outreach: false, from: '', testTo: [] };
  const state = Array.isArray(d.gmailState) ? d.gmailState[0] || null : null;
  const today = Array.isArray(d.gmailToday) ? d.gmailToday[0] || null : null;
  const sends = Array.isArray(d.gmailSends) ? d.gmailSends : [];
  const paused = !!state?.paused;
  const missing = Object.entries(g.secrets || {}).filter(([, v]) => !v).map(([k]) => k);
  const errs = ['gmailState', 'gmailToday', 'gmailSends'].filter((k) => errors[k]).map((k) => `<p class="err">${esc(errors[k])}</p>`);
  const sendingLine = errors.gmailState
    ? badge('bad', 'unknown')
    : paused
      ? `${badge('bad', 'PAUSED')} ${esc(state.reason || '')} <span class="small">since ${esc(shortTime(state.changed_at))}</span>`
      : badge('good', 'Running');
  const toggle = paused
    ? `<form class="inline-form" method="post" action="/admin/gmail/resume" data-confirm="Resume Gmail sending?"><button class="primary" type="submit">Resume sending</button></form>`
    : `<form class="inline-form" method="post" action="/admin/gmail/pause" data-confirm="Pause ALL Gmail sending?"><input type="text" name="reason" maxlength="200" placeholder="Why (optional), e.g. complaints 0.25%"><button class="danger" type="submit">Pause all sending</button></form>`;
  const table = sends.length ? `<div class="tw"><table>
    <thead><tr><th>When</th><th>Kind</th><th>To</th><th>Subject</th><th>Result</th></tr></thead>
    <tbody>${sends.map((r) => `<tr><td class="small">${esc(shortTime(r.created_at))}</td><td>${esc(r.kind)}</td><td>${esc(r.to_email)}</td><td class="small">${esc(r.subject || '')}</td>
      <td>${badge(SEND_STATUS_TONE[r.status] || 'neutral', r.status || '—')}${r.message_id ? ` <span class="small">id ${esc(r.message_id)}</span>` : ''}${r.error ? `<div class="small">${esc(r.error)}</div>` : ''}</td></tr>`).join('')}</tbody>
  </table></div>` : (errors.gmailSends ? '' : '<p class="small">Nothing sent through Gmail yet.</p>');
  return `<section id="gmail">
  <h2>Gmail sender</h2>
  <p class="sub">Cold email goes out through Gmail as ${esc(g.from)}. Its access is send-only, so bounces and spam complaints never show here: watch the bounce inbox and Google Postmaster Tools, and press Pause if complaints get near 0.3%. At most one send every 5 seconds; a failed Gmail login or a Gmail sending limit pauses everything on its own and emails you.</p>
  ${flash}
  ${errs.join('')}
  <ul class="gmail-facts">
    <li><b>Sending:</b> ${sendingLine}</li>
    <li><b>Today (ET):</b> ${esc(today?.sent_today ?? 0)} of ${esc(g.cap)}${today?.failed_today ? ` <span class="small">(${esc(today.failed_today)} failed)</span>` : ''}${today?.last_at ? ` <span class="small">· last ${esc(shortTime(today.last_at))}</span>` : ''}</li>
    <li><b>Emails to prospects:</b> ${g.outreach ? badge('warn', 'On') : `${badge('neutral', 'Off')} <span class="small">until the EXP-001 read (Oct 5) picks the winning arm. Test sends still work.</span>`}</li>
    <li><b>Gmail credentials:</b> ${g.configured ? badge('good', 'set') : `${badge('bad', 'missing')} ${esc(missing.join(', '))}`}</li>
  </ul>
  ${toggle}
  <h3>Send a test email</h3>
  <p class="sub">Only to our own addresses. Counts toward today’s cap and waits out the 5 seconds like any send.</p>
  <form class="inline-form" method="post" action="/admin/gmail/test">
    <label>To <select name="to">${(g.testTo || []).map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join('')}</select></label>
    <button class="primary" type="submit"${g.configured ? '' : ' disabled'}>Send test email</button>
  </form>
  <h3>Last sends</h3>
  ${table}
</section>`;
}

export const OUTREACH_CSS = `
.gmail-facts{list-style:none;padding:0;margin:8px 0 12px}
.gmail-facts li{padding:3px 0}
.inline-form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:8px 0}
.adm .inline-form input[type="text"],.adm .inline-form select{display:inline-block;width:auto;min-width:min(320px,100%);margin:0}
.inline-form label{display:inline-flex;gap:6px;align-items:center}
.adm button.danger{background:var(--red);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
#funnel h3{margin:14px 0 4px}
.inline-filter{display:inline-flex!important;align-items:center;gap:8px;margin:0 0 8px}
.inline-filter select{width:auto;margin:0}
.prospects tr.pick{cursor:pointer}
.prospects tr.pick:hover td,.prospects tr.pick:focus td{background:var(--wash)}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(420px,100vw);background:#fff;border-left:1px solid var(--line);box-shadow:var(--shadow);padding:18px 18px 24px;overflow-y:auto;z-index:50}
.drawer h3{margin:0 32px 2px 0}
.drawer-close{position:absolute;top:10px;right:12px;background:transparent;border:0;font-size:26px;line-height:1;cursor:pointer;color:var(--navy)}
.timeline{list-style:none;margin:12px 0 0;padding:0}
.timeline li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
.timeline time{color:var(--muted);white-space:nowrap;min-width:108px;font-size:13px}
.snippet{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0 14px;background:var(--wash)}
.snippet .grid{display:grid;gap:8px;margin:8px 0}
.steps{margin:6px 0;padding-left:18px}
.copy-row{display:flex;gap:6px;margin-top:4px}
.copy-row input{margin:0!important;font-size:13px!important}
`;

/** Added to ADMIN_JS: the Prospects filter, the timeline drawer, and the Copy buttons. textContent / template clones only. */
export const OUTREACH_JS = `
  const drawer = document.getElementById('timeline-drawer');
  if (drawer) {
    const body = drawer.querySelector('[data-drawer-body]');
    let last = null;
    const close = () => { drawer.hidden = true; if (last) last.focus(); };
    const open = (row) => {
      const t = document.querySelector('template[data-timeline="' + CSS.escape(row.getAttribute('data-token')) + '"]');
      if (!t) return;
      last = row;
      body.replaceChildren(t.content.cloneNode(true));
      drawer.hidden = false;
      drawer.querySelector('[data-drawer-close]').focus();
    };
    document.querySelectorAll('tr.pick[data-token]').forEach((row) => {
      row.addEventListener('click', () => open(row));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(row); } });
    });
    drawer.querySelector('[data-drawer-close]').addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) close(); });
  }
  const armPick = document.querySelector('[data-prospect-arm]');
  if (armPick) armPick.addEventListener('change', () => {
    document.querySelectorAll('tr.pick[data-arm]').forEach((r) => { r.hidden = !!armPick.value && r.getAttribute('data-arm') !== armPick.value; });
  });
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const text = b.getAttribute('data-copy');
    const html = b.getAttribute('data-copy-html');
    const note = b.parentElement.querySelector('[data-copy-note]');
    const done = () => { const was = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = was; }, 1500); };
    const fail = () => { if (note) note.textContent = 'Copy blocked by the browser. Select the text and copy it instead.'; };
    if (html && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]).then(done, fail);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, fail);
    } else fail();
  }));
`;
