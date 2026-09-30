// src/admin/followups.js — "Follow-ups" on /admin: the EXP-002 follow-up funnel (src/lib/followups.js).
// The switches, the per-stage funnel (v_followup_funnel), every prospect with what it gets next and a
// "Mark replied" button, "Run follow-ups now", and the copy editor (outreach_templates) that swaps in
// the real copy without a code change. Data: supabase/v14_followups.sql.

import { esc, pct, shortTime } from './metrics.js';
import { nextFollowup, FOLLOWUP_CAMPAIGN, RULES, MAX_PER_RUN } from '../lib/followups.js';
import { mergeTemplates, FOLLOWUP_STAGES, VARIANTS, STAGE_LABELS, GENERIC_SLOTS, GAP_SLOTS, SLOT_HELP, templateKey } from '../../outreach/followup-templates.js';

const badge = (tone, label) => `<span class="badge t-${esc(tone)}">${esc(label)}</span>`;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const FUNNEL_ROWS = [
  { key: 'initial', label: 'First email' },
  { key: 'bump', label: 'Bump' },
  { key: 'followup1', label: 'Follow-up 1' },
  { key: 'followup2', label: 'Follow-up 2' },
];
const FUNNEL_COLS = ['opened', 'clicked', 'replied', 'paid', 'unsubscribed'];

/** v_followup_funnel rows for the campaign, one per stage in order (zeros when nothing went out). */
export function followupFunnelRows(rows) {
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => String(r?.campaign || '').toLowerCase() === FOLLOWUP_CAMPAIGN);
  return FUNNEL_ROWS.map(({ key, label }) => {
    const r = mine.find((x) => x.followup_stage === key) || {};
    return { key, label, sent: num(r.sent), ...Object.fromEntries(FUNNEL_COLS.map((c) => [c, num(r[c])])) };
  });
}

const SKIP_LABEL = {
  replied: 'Replied: no more follow-ups',
  purchased: 'Bought: no more follow-ups',
  unsubscribed: 'Unsubscribed',
  'no email': 'No email address on the first email',
  'no report': 'No saved report to point to',
  max: 'Had its 2 follow-ups',
  done: 'Had both follow-ups',
  'opened, no click': 'Opened, never clicked: no follow-up',
  'bump sent': 'Bump sent, no click since',
  'bad row': 'Unreadable row',
};
const STAGE_SHORT = { followup1: 'Follow-up 1', followup2: 'Follow-up 2', bump: 'Bump' };

/** What the queue shows for one candidate. */
export function nextLabel(n) {
  if (n.due) return { tone: 'warn', text: `${STAGE_SHORT[n.due]} due now` };
  if (n.wait) return { tone: 'neutral', text: `${STAGE_SHORT[n.wait]} on ${shortTime(new Date(n.at).toISOString())}` };
  return { tone: n.skip === 'replied' || n.skip === 'purchased' ? 'good' : 'neutral', text: SKIP_LABEL[n.skip] || n.skip };
}

function templateForm(stage, variant, t) {
  const slots = variant === 'gap' ? [...GENERIC_SLOTS, ...GAP_SLOTS] : GENERIC_SLOTS;
  return `<details class="tpl"><summary><b>${esc(STAGE_LABELS[stage])}</b>, ${variant === 'gap' ? 'with a gap from their scan' : 'generic (no clean gap)'} ${t.saved ? badge('good', `saved ${shortTime(t.updatedAt)}`) : badge('neutral', 'placeholder')}</summary>
  <form class="grid" method="post" action="/admin/followups/template">
    <input type="hidden" name="stage" value="${esc(stage)}"><input type="hidden" name="variant" value="${esc(variant)}">
    <label class="full">Subject<input type="text" name="subject" maxlength="150" required value="${esc(t.subject)}"></label>
    <label class="full">Body (a blank line starts a new paragraph)<textarea name="body" rows="9" maxlength="4000" required>${esc(t.body)}</textarea></label>
    <p class="full small">Slots: ${slots.map((s) => `<code>{${esc(s)}}</code> ${esc(SLOT_HELP[s])}`).join(' · ')}</p>
    <div class="full"><button class="primary" type="submit">Save ${esc(templateKey(stage, variant))}</button></div>
  </form>
  ${t.saved ? `<form class="inline-form" method="post" action="/admin/followups/template" data-confirm="Go back to the placeholder copy?"><input type="hidden" name="stage" value="${esc(stage)}"><input type="hidden" name="variant" value="${esc(variant)}"><input type="hidden" name="reset" value="1"><button type="submit">Back to the placeholder copy</button></form>` : ''}
</details>`;
}

/**
 * The section. `status` = { enabled, outreach } (GMAIL_FOLLOWUPS / GMAIL_OUTREACH); `now` = Date.
 */
export function followupsSection(d, errors = {}, { flash = '', status = {}, now = new Date() } = {}) {
  const candidates = Array.isArray(d.followupCandidates) ? d.followupCandidates : [];
  const templates = mergeTemplates(d.followupTemplates);
  const errs = ['followupFunnel', 'followupCandidates', 'followupTemplates'].filter((k) => errors[k]).map((k) => `<p class="err">${esc(errors[k])}</p>`).join('');
  const funnel = followupFunnelRows(d.followupFunnel);
  const rows = candidates.map((c) => ({ c, n: nextFollowup(c, now.getTime()) }));
  const dueNow = rows.filter((r) => r.n.due).length;
  const queue = rows.length ? `<div class="tw"><table>
    <thead><tr><th>Prospect</th><th>First email</th><th>Follow-ups sent</th><th>Next</th><th></th></tr></thead>
    <tbody>${rows.map(({ c, n }) => {
      const l = nextLabel(n);
      const sent = (Array.isArray(c.followups) ? c.followups : []).map((f) => `${esc(STAGE_SHORT[f.stage] || f.stage)} ${esc(shortTime(f.sent_at))}${f.note ? ` <span class="small">(${esc(f.note)})</span>` : ''}`).join('<br>') || '—';
      const reply = c.replied_at
        ? `<span class="small">Replied ${esc(shortTime(c.replied_at))}</span>`
        : `<form class="inline-form" method="post" action="/admin/followups/replied" data-confirm="Mark ${esc(c.business || 'this prospect')} as replied? No more follow-ups go to them."><input type="hidden" name="token" value="${esc(c.token)}"><button type="submit">Mark replied</button></form>`;
      return `<tr><td>${esc(c.business || '—')}${c.email ? `<div class="small">${esc(c.email)}</div>` : ''}</td>
        <td class="small">${esc(shortTime(c.sent_at))}${c.clicked_at ? `<br>clicked ${esc(shortTime(c.clicked_at))}` : c.opened_at ? '<br>opened' : ''}</td>
        <td class="small">${sent}</td><td>${badge(l.tone, l.text)}</td><td>${reply}</td></tr>`;
    }).join('')}</tbody>
  </table></div>` : (errors.followupCandidates ? '' : `<p class="small">No “${esc(FOLLOWUP_CAMPAIGN)}” emails logged yet.</p>`);
  return `<section id="followups">
  <h2>Follow-ups (${esc(FOLLOWUP_CAMPAIGN)})</h2>
  <p class="sub">Clicked but didn’t buy: Follow-up 1 after ${RULES.followup1Days} days, Follow-up 2 after ${RULES.followup2Days}. Never opened or clicked: one bump after ${RULES.bumpDays} days. At most 2 per prospect, ever. Nothing goes to anyone who replied, bought or unsubscribed. Weekdays 9am–5pm New York, up to ${MAX_PER_RUN} per half hour, through the Gmail sender (same Pause switch, daily cap and 5 seconds between sends). The copy never mentions what the prospect did.</p>
  ${flash}
  ${errs}
  <ul class="gmail-facts">
    <li><b>Follow-ups:</b> ${status.enabled ? badge('warn', 'On') : `${badge('neutral', 'Off')} <span class="small">GMAIL_FOLLOWUPS in wrangler.jsonc. Turn on after the real copy is saved below.</span>`}</li>
    <li><b>Emails to prospects (GMAIL_OUTREACH):</b> ${status.outreach ? badge('warn', 'On') : badge('neutral', 'Off')}</li>
    <li><b>Replies:</b> Gmail access is send-only, so a reply is only seen here once you press <b>Mark replied</b>. Check the inbox before turning follow-ups on.</li>
    <li><b>Due now:</b> ${esc(dueNow)}</li>
  </ul>
  <form class="inline-form" method="post" action="/admin/followups/run" data-confirm="Send every follow-up that is due now?"><button class="primary" type="submit">Run follow-ups now</button></form>
  <h3>Funnel by email</h3>
  <p class="sub">% = share of that email’s sends. A follow-up counts as paid when the business paid after it went out.</p>
  <div class="tw"><table>
    <thead><tr><th>Email</th><th class="n">Sent</th>${FUNNEL_COLS.map((c) => `<th class="n">${esc(c[0].toUpperCase() + c.slice(1))}</th>`).join('')}</tr></thead>
    <tbody>${funnel.map((r) => `<tr><td><b>${esc(r.label)}</b></td><td class="n">${esc(r.sent)}</td>${FUNNEL_COLS.map((c) => `<td class="n">${esc(r[c])}<div class="small">${r.sent ? pct(r[c] / r.sent) : '—'}</div></td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>
  <h3>Prospects</h3>
  ${queue}
  <h3>Copy</h3>
  <p class="sub">Saved copy replaces the placeholder at once (no deploy). Saving refuses anything that says what the prospect did (“saw you”, “noticed you”, “checked out”, “clicked”, …), unknown slots, and gap slots in the generic version.</p>
  ${FOLLOWUP_STAGES.map((stage) => VARIANTS.map((variant) => templateForm(stage, variant, templates[stage][variant])).join('')).join('')}
</section>`;
}

export const FOLLOWUPS_CSS = `
.adm textarea{display:block;width:100%;margin-top:4px;font:inherit;font-size:14px;font-weight:400;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);resize:vertical}
details.tpl{border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}
details.tpl summary{cursor:pointer}
details.tpl form{margin-top:10px}
`;
