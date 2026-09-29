// src/admin/page.js — HTML for /admin (server-rendered; every dynamic value goes through esc()).

import { ENGINE_NAMES, ACTIVE_ENGINES, FREE_ENGINES, estimateScanCost, priceCall, TYPICAL_CALL } from '../../scanner/config.js';
import { isCheckoutRow, estimateRequestScanUsd } from '../lib/auto-scan.js';
import { TRADES } from '../../scanner/questions.js';
import {
  esc, usd, pct, moneySummary, engineVerdicts, activityFeed, shortTime, nyDate, EXPENSE_CATEGORIES,
  FIXED_COSTS, STRIPE_FEE, chargeDates, fixedCosts, unitEconomics,
} from './metrics.js';
import { emailFunnelTable, prospectsSection, logEmailSection, gmailSection, OUTREACH_CSS, OUTREACH_JS } from './outreach.js';

const engineName = (id) => ENGINE_NAMES[id] || id;

const CSS = `
.adm-body{background:var(--wash);min-height:100vh}
.adm-top{background:var(--navy);color:#fff}
.adm-top .wrap{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}
.adm-top img{height:30px;width:auto;filter:brightness(0) invert(1)}
.adm-top .adm-title{font-weight:700;font-size:15px;opacity:.9;margin-right:auto}
.adm-top form{margin:0}
.adm-top button{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:6px 12px;font:inherit;font-size:14px;cursor:pointer}
.adm-nav{display:flex;gap:6px;flex-wrap:wrap;padding:12px 0 0}
.adm-nav a{font-size:13px;font-weight:600;text-decoration:none;background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 10px;color:var(--navy)}
.adm{padding-top:8px;padding-bottom:48px}
.adm section{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:18px 18px 14px;margin:14px 0;box-shadow:var(--shadow)}
.adm h2{font-size:20px;margin:0 0 4px}
.adm .sub{color:var(--muted);font-size:14px;margin:0 0 12px}
.adm .err{background:#FDECEA;color:var(--red);border-radius:8px;padding:8px 10px;font-size:14px;margin:8px 0}
.adm .ok-msg{background:#E7F5EE;color:var(--green);border-radius:8px;padding:8px 10px;font-size:14px;margin:8px 0}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px}
.adm table{border-collapse:collapse;width:100%;font-size:14px}
.adm th,.adm td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.adm th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:700;white-space:nowrap}
.adm td.n,.adm th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.adm .small{font-size:12px;color:var(--muted)}
.money-grid td.n{font-size:16px;font-weight:600}
.money-grid tr.net td{font-weight:800;border-bottom:0}
.acts form{display:inline-block;margin:0 6px 4px 0}
.pos{color:var(--green)}.neg{color:var(--red)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}
.tile{background:var(--wash);border-radius:10px;padding:10px 12px}
.tile b{display:block;font-size:20px;color:var(--navy);font-variant-numeric:tabular-nums}
.tile span{display:block;font-size:12px;line-height:1.35;color:var(--muted);margin-top:2px}
.badge{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
.t-good{background:#E7F5EE;color:var(--green)}.t-bad{background:#FDECEA;color:var(--red)}
.t-warn{background:#FFF4E5;color:var(--amber)}.t-neutral{background:var(--wash-2);color:var(--navy)}
.verdict{font-size:13px;line-height:1.4;min-width:220px}
.adm form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px 12px}
.adm label{display:block;font-size:13px;font-weight:600;color:var(--navy)}
.adm input[type=text],.adm input[type=date],.adm input[type=number],.adm input[type=password],.adm select{display:block;width:100%;margin-top:4px;font:inherit;font-size:15px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink)}
.adm fieldset{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:0;grid-column:1/-1}
.adm fieldset label{display:inline-flex;align-items:center;gap:6px;font-weight:500;margin:4px 14px 4px 0}
.adm .full{grid-column:1/-1}
.adm button.primary{background:var(--blue);color:#fff;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
.adm button.primary:hover{background:var(--blue-dark)}
.watch{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:14px}
.watch.is-done{background:var(--wash)}
.watch .row{display:flex;gap:12px;flex-wrap:wrap}
.watch ul{margin:6px 0 0;padding-left:18px;color:var(--red);font-size:13px}
.feed{list-style:none;margin:0;padding:0}
.feed li{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:14px}
.feed time{color:var(--muted);white-space:nowrap;min-width:100px;font-size:13px}
.credit-alert{border-radius:var(--radius);padding:12px 14px;margin:14px 0 0;font-size:14px;line-height:1.45}
.credit-alert.out{background:#FDECEA;color:var(--red);border:1px solid var(--red)}
.credit-alert.low{background:#FFF4E5;color:var(--amber);border:1px solid var(--amber)}
.credit-alert b{display:block;font-size:15px}
.login{max-width:380px;margin:12vh auto 0;background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow)}
.login h1{font-size:22px;margin-bottom:12px}
.login button{margin-top:12px;width:100%}
${OUTREACH_CSS}
@media (max-width:600px){.adm.wrap,.adm-top .wrap{padding-left:16px;padding-right:16px}.adm section{padding:14px 12px 10px}.adm th,.adm td{padding:6px 6px}}
`;

function head(title, nonce) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/img/mark.svg">
<link rel="stylesheet" href="/css/styles.css">
<style nonce="${esc(nonce)}">${CSS}</style>
</head>`;
}

export function renderLogin({ nonce, error = null }) {
  return `${head('Sign in — AI Found Score admin', nonce)}
<body class="adm-body">
<main class="adm wrap">
  <form class="login" method="post" action="/admin/login">
    <h1>Business dashboard</h1>
    ${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
    <label for="token">Admin token</label>
    <input type="password" id="token" name="token" autocomplete="current-password" required autofocus>
    <button class="primary" type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}

const sectionError = (errors, ...keys) => keys.filter((k) => errors[k]).map((k) => `<p class="err">${esc(errors[k])}</p>`).join('');
const toneBadge = (tone, label) => `<span class="badge t-${esc(tone)}">${esc(label)}</span>`;
const signed = (n) => `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${usd(n)}</span>`;

function moneySection(d, errors, now) {
  const m = moneySummary(d.money || [], now);
  // Fixed plans (FIXED_COSTS) aren't in the database: add their charges to spent and net here.
  const fixed = fixedCosts(FIXED_COSTS, now);
  for (const p of ['week', 'month', 'all']) {
    m[p].plans = fixed[p];
    m[p].spent += fixed[p];
    m[p].net -= fixed[p];
  }
  const k = d.kpis || {};
  const col = (key, f) => ['week', 'month', 'all'].map((p) => `<td class="n">${f(m[p][key])}</td>`).join('');
  return `<section id="money">
  <h2>Money</h2>
  <p class="sub">Spent = metered API cost (every engine and extractor call) + fixed plans (see Costs and break-even) + expenses entered below. Earned = live Stripe payments only. Weeks start Monday, New York time.</p>
  ${sectionError(errors, 'money', 'kpis')}
  <div class="tw"><table class="money-grid">
    <thead><tr><th></th><th class="n">This week</th><th class="n">This month</th><th class="n">All time</th></tr></thead>
    <tbody>
      <tr><td>API spend</td>${col('apiSpend', usd)}</tr>
      <tr><td>Plans (fixed)</td>${col('plans', usd)}</tr>
      <tr><td>Other expenses</td>${col('expenses', usd)}</tr>
      <tr><td><b>Spent</b></td>${col('spent', usd)}</tr>
      <tr><td><b>Earned</b></td>${col('revenue', usd)}</tr>
      <tr class="net"><td>Net</td>${col('net', signed)}</tr>
    </tbody>
  </table></div>
  <div class="tiles">
    <div class="tile"><b>${usd(k.cost_per_report_usd)}</b><span>Cost per saved report</span></div>
    <div class="tile"><b>${usd(k.avg_cost_per_scan_usd)}</b><span>Average cost per scan</span></div>
    <div class="tile"><b>${esc(k.scans ?? '—')}</b><span>Scans run (${esc(k.reports_saved ?? 0)} reports saved)</span></div>
    <div class="tile"><b>${usd(m.all.topups)}</b><span>API credits bought (cash; not added to spent)</span></div>
  </div>
</section>`;
}

// Costs and break-even: fixed plans with their start dates, what one free report and one paid audit
// cost (real averages once scans have run, else the price table), and what a sale keeps.
function costsSection(d, errors, { now, activeIds = ACTIVE_ENGINES }) {
  const today = nyDate(now);
  const fixed = fixedCosts(FIXED_COSTS, now);
  const freeIds = activeIds.filter((e) => FREE_ENGINES.includes(e));
  const est = {
    free: estimateRequestScanUsd(freeIds.length ? freeIds : FREE_ENGINES),
    paid: estimateScanCost({ engines: activeIds, questions: 5, runs: 1 }).total,
  };
  const u = unitEconomics({ scans: d.unitScans || [], est, fixedPerMonth: fixed.perMonth });
  const basis = (x) => (x.real ? `average of ${x.n} finished scan${x.n === 1 ? '' : 's'}` : 'estimate from the price table (no finished scans yet)');
  const plans = FIXED_COSTS.map((c) => {
    const charges = chargeDates(c, today);
    const live = c.since <= today && (!c.until || c.until >= today);
    return `<tr><td><b>${esc(c.name)}</b><div class="small">${esc(c.why || '')}</div></td>
      <td class="n">${usd(c.usdPerMonth)}/mo</td>
      <td>${esc(c.since)}${c.until ? ` to ${esc(c.until)}` : ''}</td>
      <td>${live ? toneBadge('good', 'Active') : toneBadge('neutral', c.since > today ? 'Starts later' : 'Ended')}</td>
      <td class="n">${usd(charges.length * c.usdPerMonth)}<div class="small">${charges.length} charge${charges.length === 1 ? '' : 's'}</div></td></tr>`;
  }).join('');
  return `<section id="costs">
  <h2>Costs and break-even</h2>
  <p class="sub">Fixed plans are charged monthly from their start date and counted in Money above. To add or end a plan, edit <code>FIXED_COSTS</code> in <code>src/admin/metrics.js</code>. Stripe fee: ${esc((STRIPE_FEE.pct * 100).toFixed(1))}% + ${esc(Math.round(STRIPE_FEE.fixedUsd * 100))}¢ per charge.</p>
  ${sectionError(errors, 'unitScans')}
  <div class="tw"><table>
    <thead><tr><th>Plan</th><th class="n">Cost</th><th>Since</th><th>Status</th><th class="n">Paid so far</th></tr></thead>
    <tbody>${plans}</tbody>
  </table></div>
  <div class="tiles">
    <div class="tile"><b>${usd(fixed.perMonth)}</b><span>Fixed plans per month</span></div>
    <div class="tile"><b>${usd(u.free.usd)}</b><span>Cost of one free report (${esc(basis(u.free))})</span></div>
    <div class="tile"><b>${usd(u.paid.usd)}</b><span>Cost of one $49 audit scan (${esc(basis(u.paid))})</span></div>
    <div class="tile"><b>${usd(u.keepAudit)}</b><span>Kept per $49 audit, after ${usd(u.feeAudit)} Stripe fee and the scan</span></div>
    <div class="tile"><b>${usd(u.keepWithAddon)}</b><span>Kept per $74 order (audit + Breakdown), after ${usd(u.feeWithAddon)} fee</span></div>
    <div class="tile"><b>${esc(u.auditsForFixed ?? '—')}</b><span>Audits a month to cover the fixed plans</span></div>
    <div class="tile"><b>${esc(u.freePerAudit ?? '—')}</b><span>Free reports one audit sale pays for</span></div>
  </div>
</section>`;
}

function runSection(d, { watch = [], engineIds, flash, activeIds = ACTIVE_ENGINES }) {
  const running = (d.scans || []).filter((s) => s.status === 'queued' || s.status === 'running');
  const ids = [...new Set([...watch, ...running.map((s) => s.scan_id)])];
  const nameOf = Object.fromEntries((d.scans || []).map((s) => [s.scan_id, s.business_name]));
  // Per-call cost at typical usage, for the live estimate in the form.
  const perCall = Object.fromEntries(engineIds.map((e) => [e, priceCall(e, TYPICAL_CALL[e])]));
  perCall.extract = priceCall('extract', TYPICAL_CALL.extract);
  // Pre-ticked (and estimated): the engines the site advertises. The rest stay selectable.
  const defaults = engineIds.filter((e) => activeIds.includes(e));
  const est = estimateScanCost({ engines: defaults, questions: 5, runs: 1 });
  const trades = Object.keys(TRADES);
  return `<section id="keys">
  <h2>Check engine keys</h2>
  <p class="sub">One tiny live call per engine plus the Claude extractor (a few cents). Shows which keys work.</p>
  <button type="button" id="ping-btn">Check keys</button>
  <ul id="ping-out" class="plain"></ul>
</section>
<section id="run">
  <h2>Run a scan</h2>
  <p class="sub">Runs in the background (about 7–18 minutes for a full scan) and needs the Workers Paid plan. On the Free plan, run full scans from the PC with <code>npm run scan -- --business biz.json</code>; results appear here the same way. The report is saved only if it passes every guardrail.</p>
  ${flash}
  ${ids.map((id) => `<div class="watch" data-watch="${esc(id)}">
    <div class="row"><b>${esc(nameOf[id] || 'Scan')}</b><span class="small">${esc(id)}</span></div>
    <div class="row"><span data-f="status">checking…</span><span data-f="calls"></span><span data-f="extract"></span><span data-f="cost"></span>
      <a data-f="report" hidden>Open report</a></div>
    <div class="small" data-f="hint"></div>
    <ul data-f="errors"></ul>
  </div>`).join('')}
  <form class="grid" id="run-form" method="post" action="/admin/scan" data-per-call='${esc(JSON.stringify(perCall))}'>
    <label>Business name<input type="text" name="business_name" required maxlength="160"></label>
    <label>Trade<select name="trade" required>${trades.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></label>
    <label>Street address<input type="text" name="address" maxlength="200"></label>
    <label>Town<input type="text" name="town" required maxlength="60"></label>
    <label>ZIP<input type="text" name="zip" inputmode="numeric" pattern="[0-9]{5}" maxlength="5"></label>
    <label>Phone<input type="text" name="phone" inputmode="tel" maxlength="30"></label>
    <label>Website<input type="text" name="website" maxlength="200"></label>
    <label>Runs per question<select name="runs"><option value="1" selected>1</option><option value="2">2</option><option value="3">3</option></select></label>
    <label>Questions<select name="questions"><option value="5" selected>All 5</option><option value="2">First 2 (light test)</option><option value="1">First 1 (light test)</option></select></label>
    <fieldset><legend class="small">Engines</legend>
      ${engineIds.map((e) => `<label><input type="checkbox" name="engines" value="${esc(e)}"${defaults.includes(e) ? ' checked' : ''}> ${esc(engineName(e))}</label>`).join('')}
    </fieldset>
    <div class="full"><button class="primary" type="submit">Start scan</button>
      <span class="small" id="run-estimate">Estimated cost: ${usd(est.total)} (typical usage)</span></div>
  </form>
  <h3>Re-run a paid audit</h3>
  <p class="sub">For a “Paid audit failed / didn’t start” alert: the full scan for that report, under the same link. Refused while one is running or already done.</p>
  <form class="grid" method="post" action="/admin/scan/paid">
    <label>Report token<input type="text" name="token" required pattern="[A-Za-z0-9_-]{6,64}" maxlength="64" placeholder="from the /report/… link"></label>
    <div class="full"><button class="primary" type="submit">Re-run paid audit</button></div>
  </form>
</section>`;
}

// Free-report requests (src/lib/auto-scan.js): queued ones wait for "Run now" (AUTO_SCAN off, a cap
// was hit, or the start failed); failed ones need a person. The owner's link shows "in progress" meanwhile.
function requestsSection(d, errors, { flash = '' } = {}) {
  const all = d.requestScans || [];
  const why = (notes) => { const m = String(notes || '').match(/queued: ([\w-]+)/); return m ? m[1] : ''; };
  const checkouts = all.filter(isCheckoutRow);
  const free = all.filter((s) => !isCheckoutRow(s));
  const cancelBtn = (s) => `<form method="post" action="/admin/scan/cancel" data-confirm="Cancel this request? It will never run, and its link will say the request was closed."><input type="hidden" name="id" value="${esc(s.id)}"><button type="submit">Cancel</button></form>`;
  const table = (rows, { run }) => `<div class="tw"><table>
    <thead><tr><th>Business</th><th>Requested</th><th>Status</th><th>Report link</th><th></th></tr></thead>
    <tbody>${rows.map((s) => {
      const tone = s.status === 'running' ? 'neutral' : s.status === 'failed' ? 'bad' : 'warn';
      const reason = s.status === 'queued' && run ? why(s.notes) : '';
      const err = s.status === 'failed' && Array.isArray(s.errors) && s.errors[0] ? `<div class="small">${esc(String(s.errors[0].error || '').slice(0, 160))}</div>` : '';
      const label = run ? s.status : s.status === 'queued' ? 'not paid' : s.status;
      return `<tr>
        <td>${esc(s.business_name || '—')}</td>
        <td class="small">${esc(shortTime(s.created_at))}</td>
        <td>${toneBadge(tone, label)}${reason ? `<div class="small">${esc(reason)}</div>` : ''}${err}</td>
        <td>${s.report_token ? `<a href="/report/${esc(encodeURIComponent(s.report_token))}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
        <td class="acts">${s.status === 'running' ? '' : `${run ? `<form method="post" action="/admin/scan/run"><input type="hidden" name="id" value="${esc(s.id)}"><button type="submit">Run now</button></form>` : ''}${cancelBtn(s)}`}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
  return `<section id="requests">
  <h2>Free-report requests waiting</h2>
  <p class="sub">Queued, running or failed free-report scans. “Run now” starts one scan (every engine with a key, 1 run); the daily caps don’t apply to it. “Cancel” closes the request: it never runs, and its link says so.</p>
  ${flash}
  ${sectionError(errors, 'requestScans')}
  ${free.length ? table(free, { run: true }) : (errors.requestScans ? '' : '<p class="small">Nothing waiting.</p>')}
  <h3>Checkouts started, not paid</h3>
  <p class="sub">Someone pressed pay on /checkout and hasn’t paid. No scan runs for these. If they pay, the audit starts; if they click “Get my free snapshot”, their free report starts. “Cancel” clears one you don’t need (like a test).</p>
  ${checkouts.length ? table(checkouts, { run: false }) : '<p class="small">None.</p>'}
</section>`;
}

// The free 30-day re-checks: every paid report is scanned again 30 days after purchase and compared
// with the audit. Each row is someone to offer Be the Answer: no change → "want us to do it?",
// better → "want us to finish it?". Contact details are in Stripe (searched by report token).
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function recheckVerdict(r) {
  const n = r?.now;
  const b = r?.before;
  if (!n || !b || !Number(n.answers) || !Number(b.answers)) return null;
  const pn = n.namedYou / n.answers;
  const pb = b.namedYou / b.answers;
  if (pn > pb) return { tone: 'good', label: 'Better', pitch: 'Want us to finish it?' };
  if (pn < pb) return { tone: 'bad', label: 'Worse', pitch: 'It slipped. Want us to fix it?' };
  return { tone: 'warn', label: 'No change', pitch: 'Want us to do it for you?' };
}

function rechecksSection(d, errors) {
  const rows = d.rechecks || [];
  const cell = (t) => (t && Number(t.answers) ? `${num(t.namedYou)} of ${num(t.answers)}` : '—');
  return `<section id="rechecks">
  <h2>30-day re-checks: who to offer Be the Answer</h2>
  <p class="sub">Every paid report is scanned again 30 days after purchase (daily cron) and compared with the audit. “Named” is how many answers named them.</p>
  ${sectionError(errors, 'rechecks')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Business</th><th>Re-checked</th><th>Named: audit → now</th><th>Result</th><th>Report</th><th>Contact</th></tr></thead>
    <tbody>${rows.map((r) => {
      const v = r.status === 'done' ? recheckVerdict(r) : null;
      return `<tr>
        <td>${esc(r.business_name || '—')}</td>
        <td class="small">${esc(shortTime(r.created_at))}</td>
        <td>${esc(cell(r.before))} → ${esc(cell(r.now))}</td>
        <td>${v ? `${toneBadge(v.tone, v.label)}<div class="small">${esc(v.pitch)}</div>` : toneBadge(r.status === 'failed' ? 'bad' : 'neutral', r.status)}</td>
        <td>${r.report_token ? `<a href="/report/${esc(encodeURIComponent(r.report_token))}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
        <td>${r.report_token ? `<a href="${esc(stripeSearchUrl(r))}" target="_blank" rel="noopener">Find in Stripe</a>` : '—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : (errors.rechecks ? '' : '<p class="small">No re-checks yet. The first ones run 30 days after the first paid audits.</p>')}
</section>`;
}

// Refund requests (supabase/v4_ladder.sql). No public form yet. Refunds are made by a person in Stripe;
// the link searches the Stripe dashboard for the payment (by email, else by report token).
export function stripeSearchUrl(r) {
  return `https://dashboard.stripe.com/search?query=${encodeURIComponent(r?.email || r?.report_token || '')}`;
}

function refundsSection(d, errors) {
  const rows = d.refunds || [];
  return `<section id="refunds">
  <h2>Refund requests</h2>
  <p class="sub">Check the report, then refund the payment in Stripe. A full refund locks the report again and marks this row refunded on its own (src/lib/refunds.js); set declined by hand in Supabase.</p>
  ${sectionError(errors, 'refunds')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>When</th><th>Email</th><th>Reason</th><th>Status</th><th>Report</th><th>Payment</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="small">${esc(shortTime(r.created_at))}</td>
      <td>${esc(r.email || '—')}</td>
      <td class="small">${esc(String(r.reason || '').slice(0, 300))}</td>
      <td>${toneBadge(r.status === 'open' ? 'warn' : r.status === 'refunded' ? 'good' : 'neutral', r.status || 'open')}</td>
      <td>${r.report_token ? `<a href="/report/${esc(encodeURIComponent(r.report_token))}" target="_blank" rel="noopener">Open</a>` : '—'}</td>
      <td>${r.email || r.report_token ? `<a href="${esc(stripeSearchUrl(r))}" target="_blank" rel="noopener">Find in Stripe</a>` : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>` : (errors.refunds ? '' : '<p class="small">No refund requests.</p>')}
</section>`;
}

function scansSection(d, errors) {
  const rows = d.scans || [];
  return `<section id="scans">
  <h2>Scans</h2>
  <p class="sub">Latest ${rows.length}. Cost = engine answers + extraction, from the per-call records.</p>
  ${sectionError(errors, 'scans')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Business</th><th>Started</th><th>Status</th><th class="n">Answers</th><th class="n">Named / first</th><th class="n">Cost</th><th>Per engine</th><th>Report</th></tr></thead>
    <tbody>${rows.map((s) => {
      const per = Object.entries(s.per_engine || {}).map(([e, v]) => `${esc(engineName(e))} ${usd(v.cost_usd)}${v.ok < v.calls ? ` (${esc(v.calls - v.ok)} failed)` : ''}`).join(' · ');
      const tone = s.status === 'done' ? (s.report_valid === false ? 'warn' : 'good') : s.status === 'failed' ? 'bad' : 'neutral';
      const label = s.status === 'done' && s.report_valid === false ? 'done, report blocked' : s.status;
      return `<tr>
        <td>${esc(s.business_name || '—')}<div class="small">${esc((s.engines || []).map(engineName).join(', '))}${s.trigger && s.trigger !== 'admin' ? ` · ${esc(s.trigger)}` : ''}</div></td>
        <td class="small">${esc(shortTime(s.started_at))}</td>
        <td>${toneBadge(tone, label || '—')}</td>
        <td class="n">${esc(s.answers ?? '—')}</td>
        <td class="n">${s.answers != null ? `${esc(s.named_you ?? 0)} / ${esc(s.first_you ?? 0)}` : '—'}</td>
        <td class="n">${usd(s.total_cost_usd)}<div class="small">extract ${usd(s.extract_cost_usd)}</div></td>
        <td class="small">${per || '—'}</td>
        <td>${s.report_saved && s.report_token ? `<a href="/report/${esc(encodeURIComponent(s.report_token))}" target="_blank" rel="noopener">Open</a>` : '<span class="small">—</span>'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` : (errors.scans ? '' : '<p class="small">No scans yet.</p>')}
</section>`;
}

function enginesSection(d, errors) {
  const rows = engineVerdicts(d.engines || []);
  return `<section id="engines">
  <h2>Engine value</h2>
  <p class="sub">Every scan so far. Unique competitors = businesses only that engine named in a report. Verdicts come from fixed rules, not a model.</p>
  ${sectionError(errors, 'engines')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Engine</th><th class="n">Calls</th><th class="n">OK</th><th class="n">Cost / answer</th><th class="n">Total</th><th class="n">Names owner</th><th class="n">Names anyone</th><th class="n">Unique comp.</th><th class="n">Headline</th><th>Verdict</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><b>${esc(engineName(r.engine))}</b></td>
      <td class="n">${esc(r.calls)}</td>
      <td class="n">${pct(r.ok_rate)}</td>
      <td class="n">${usd(r.cost_per_answer_usd)}${r.costRatio ? `<div class="small">${esc(r.costRatio.toFixed(1))}× avg</div>` : ''}</td>
      <td class="n">${usd(r.total_cost_usd)}</td>
      <td class="n">${pct(r.owner_named_rate)}</td>
      <td class="n">${pct(r.named_any_rate)}</td>
      <td class="n">${esc(r.unique_competitors)}</td>
      <td class="n">${pct(r.headline_share)}</td>
      <td class="verdict">${toneBadge(r.tone, r.tone === 'good' ? 'keep' : r.tone === 'bad' ? 'review' : r.tone === 'warn' ? 'watch' : 'info')} ${esc(r.verdict)}</td>
    </tr>`).join('')}</tbody>
  </table></div>` : (errors.engines ? '' : '<p class="small">No engine calls recorded yet.</p>')}
  ${geminiSearchesLine(d, errors)}
</section>`;
}

// Gemini searches this month against Google's 5,000 free (v_gemini_searches). Costs above already leave the
// free ones out; past 5,000 each search costs $0.014, so the line turns amber at 80% and red past it.
function geminiSearchesLine(d, errors) {
  if (errors.gemini) return sectionError(errors, 'gemini');
  const g = (d.gemini || [])[0];
  const monthStart = new Date().toISOString().slice(0, 7);
  const q = g && String(g.month).slice(0, 7) === monthStart ? Number(g.queries) || 0 : 0;
  const tone = q > 5000 ? 'bad' : q >= 4000 ? 'warn' : 'good';
  const saved = g && String(g.month).slice(0, 7) === monthStart ? Number(g.saved_usd) || 0 : 0;
  return `<p class="small">${toneBadge(tone, q > 5000 ? 'over' : q >= 4000 ? 'near' : 'free')} <b>Gemini searches this month: ${esc(q.toLocaleString('en-US'))} of 5,000 free</b> (UTC month). ${q > 5000 ? `${esc((q - 5000).toLocaleString('en-US'))} paid at $0.014 each.` : `${esc((5000 - q).toLocaleString('en-US'))} left.`} Free searches are left out of every cost on this page${saved ? ` (${usd(saved)} this month)` : ''}.</p>`;
}

function funnelSection(d, errors) {
  const rows = d.funnel || [];
  return `<section id="funnel">
  <h2>Funnel by arm</h2>
  <h3>Mail arm</h3>
  <p class="sub">Recipients in report_links; visits are unique tokens; paying counts live payments only.</p>
  ${sectionError(errors, 'funnel')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Arm</th><th class="n">Recipients</th><th class="n">Visited</th><th class="n">Leads</th><th class="n">Paying</th><th class="n">Revenue</th><th class="n">Visit rate</th><th class="n">Pay rate</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.arm)}</b></td><td class="n">${esc(r.recipients)}</td><td class="n">${esc(r.visited)}</td><td class="n">${esc(r.leads)}</td><td class="n">${esc(r.paying)}</td><td class="n">${usd(r.revenue_usd)}</td><td class="n">${pct(r.visit_rate)}</td><td class="n">${pct(r.pay_rate)}</td></tr>`).join('')}</tbody>
  </table></div>` : (errors.funnel ? '' : '<p class="small">No recipients yet (report_links is empty).</p>')}
  ${emailFunnelTable(d.emailFunnel, errors)}
</section>`;
}

function gateActual(g) {
  if (g.actual == null) return '—';
  return Number(g.target) < 1 ? pct(g.actual) : `${esc(Number(g.actual))}`;
}

function gatesSection(d, errors) {
  const rows = d.gates || [];
  return `<section id="gates">
  <h2>MVP gates</h2>
  <p class="sub">From the build plan. A gate with no data yet is shown as “no data”.</p>
  ${sectionError(errors, 'gates')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Gate</th><th>Target</th><th class="n">Actual</th><th>Basis</th><th>Status</th></tr></thead>
    <tbody>${rows.map((g) => `<tr><td>${esc(g.label)}</td><td>${esc(g.target_label)}</td><td class="n">${gateActual(g)}</td><td class="small">${esc(g.detail)}</td>
      <td>${g.met === true ? toneBadge('good', 'met') : g.met === false ? toneBadge('bad', 'not yet') : toneBadge('neutral', 'no data')}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
</section>`;
}

function activitySection(d, errors) {
  const items = activityFeed({ scans: d.scans || [], requests: d.requests || [], leads: d.leads || [], payments: d.payments || [] });
  return `<section id="activity">
  <h2>Activity</h2>
  ${sectionError(errors, 'requests', 'leads', 'payments')}
  ${items.length ? `<ul class="feed">${items.map((i) => `<li><time datetime="${esc(i.at)}">${esc(shortTime(i.at))}</time><span>${toneBadge(i.tone, i.kind)} ${esc(i.text)}</span></li>`).join('')}</ul>` : '<p class="small">Nothing yet.</p>'}
</section>`;
}

function expensesSection(d, errors, { flash, now }) {
  const rows = d.expenses || [];
  return `<section id="expenses">
  <h2>Add expense</h2>
  <p class="sub">Anything not metered per call: postcards, domain, Cloudflare and Supabase plans. API credit top-ups are tracked as cash but not added to “spent” (the per-call cost already counts them).</p>
  ${flash}
  <form class="grid" method="post" action="/admin/expenses">
    <label>Date<input type="date" name="spent_on" value="${esc(nyDate(now))}" required></label>
    <label>Category<select name="category" required>${Object.entries(EXPENSE_CATEGORIES).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></label>
    <label>Vendor<input type="text" name="vendor" maxlength="80"></label>
    <label>Amount (USD)<input type="text" name="amount_usd" inputmode="decimal" required placeholder="12.50"></label>
    <label class="full">Description<input type="text" name="description" maxlength="300"></label>
    <div class="full"><button class="primary" type="submit">Add expense</button></div>
  </form>
  ${sectionError(errors, 'expenses')}
  ${rows.length ? `<div class="tw"><table>
    <thead><tr><th>Date</th><th>Category</th><th>Vendor</th><th>Description</th><th class="n">Amount</th></tr></thead>
    <tbody>${rows.map((x) => `<tr><td class="small">${esc(x.spent_on)}</td><td>${esc(EXPENSE_CATEGORIES[x.category] || x.category)}</td><td>${esc(x.vendor || '')}</td><td class="small">${esc(x.description || '')}</td><td class="n">${usd(x.amount_usd)}</td></tr>`).join('')}</tbody>
  </table></div>` : ''}
</section>`;
}

/**
 * The red (out of credits) / amber (low) banner from creditStatus() (src/lib/alerts.js), one line
 * per engine. '' when every engine is 'ok' or 'unknown'.
 */
export function creditBanner(credits) {
  const lines = (Array.isArray(credits) ? credits : []).filter((c) => c && (c.state === 'out' || c.state === 'low'));
  return lines.map((c) => `<div class="credit-alert ${c.state === 'out' ? 'out' : 'low'}" role="alert"><b>${esc(c.name || engineName(c.engine))} ${c.state === 'out' ? 'is OUT of credits: live answers and scans are skipping it' : 'credits are LOW'}</b>${esc(c.detail || '')}</div>`).join('\n');
}

/**
 * The dashboard. `dash` = loadDashboard() result; `flash` = { run, expense } messages
 * ({ ok: boolean, text }); `watch` = scan ids to show live status for.
 */
export function renderDashboard(dash, { nonce, engineIds, flash = {}, watch = [], now = new Date(), dryRun = false, activeIds = ACTIVE_ENGINES, sent = null, siteOrigin = 'https://aifoundscore.com', gmail = null }) {
  const d = dash.data || {};
  const errors = dash.errors || {};
  const flashHtml = (f) => (f ? `<p class="${f.ok ? 'ok-msg' : 'err'}" role="status">${esc(f.text)}</p>` : '');
  const notConfigured = dash.configured ? '' : '<section><p class="err">SUPABASE_SERVICE_KEY (and SUPABASE_URL) are not set, so there is no data to show. Scans can still run in dry-run mode locally.</p></section>';
  return `${head('Dashboard — AI Found Score', nonce)}
<body class="adm-body">
<header class="adm-top"><div class="wrap">
  <img src="/img/logo.svg" alt="AI Found Score" width="187" height="30">
  <span class="adm-title">Business dashboard${dryRun ? ' · DRY RUN' : ''}</span>
  <span class="small">${esc(shortTime(now.toISOString()))} ET</span>
  <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>
</div></header>
<main class="adm wrap">
  <nav class="adm-nav" aria-label="Sections">
    <a href="#money">Money</a><a href="#costs">Costs</a><a href="#requests">Requests</a><a href="#run">Run scan</a><a href="#scans">Scans</a><a href="#engines">Engines</a><a href="#refunds">Refunds</a>
    <a href="#funnel">Funnel</a><a href="#prospects">Prospects</a><a href="#log-email">Log email</a><a href="#gmail">Gmail</a><a href="#gates">Gates</a><a href="#activity">Activity</a><a href="#expenses">Expenses</a>
  </nav>
  ${creditBanner(d.credits)}
  ${notConfigured}
  ${moneySection(d, errors, now)}
  ${costsSection(d, errors, { now, activeIds })}
  ${requestsSection(d, errors, { flash: flashHtml(flash.requests) })}
  ${runSection(d, { watch, engineIds, flash: flashHtml(flash.run), activeIds })}
  ${scansSection(d, errors)}
  ${enginesSection(d, errors)}
  ${funnelSection(d, errors)}
  ${prospectsSection(d, errors)}
  ${logEmailSection(d, errors, { flash: flashHtml(flash.email), sent, base: siteOrigin })}
  ${gmailSection(d, errors, { flash: flashHtml(flash.gmail), gmail })}
  ${gatesSection(d, errors)}
  ${activitySection(d, errors)}
  ${rechecksSection(d, errors)}
  ${refundsSection(d, errors)}
  ${expensesSection(d, errors, { flash: flashHtml(flash.expense), now })}
</main>
<script src="/admin/admin.js" defer></script>
</body>
</html>`;
}

/** Served at /admin/admin.js (CSP allows scripts from 'self' only). Uses textContent only. */
export const ADMIN_JS = `(() => {
  // Ask first on a form marked data-confirm (Cancel).
  document.addEventListener('submit', (e) => { const m = e.target.getAttribute && e.target.getAttribute('data-confirm'); if (m && !confirm(m)) e.preventDefault(); });
  const DONE = new Set(['complete', 'errored', 'terminated', 'done', 'failed']);
  const money = (n) => (n == null ? '—' : '$' + Number(n).toFixed(4));
  const set = (el, f, text) => { const x = el.querySelector('[data-f="' + f + '"]'); if (x) x.textContent = text; };
  function poll(el) {
    const id = el.getAttribute('data-watch');
    fetch('/api/admin/scan/' + encodeURIComponent(id), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((j) => {
        const inst = j.instance && j.instance.status;
        const st = (j.scan && j.scan.status) || inst || 'unknown';
        set(el, 'status', inst && inst !== st ? st + ' (workflow ' + inst + ')' : st);
        const p = j.progress || {};
        set(el, 'calls', (p.callsDone == null ? 0 : p.callsDone) + ' / ' + (p.callsTotal == null ? '?' : p.callsTotal) + ' calls' + (p.callsOk == null ? '' : ' (' + p.callsOk + ' ok)'));
        set(el, 'extract', (p.extractionsDone || 0) + ' extracted');
        set(el, 'cost', money(p.costUsd) + ' so far');
        const ul = el.querySelector('[data-f="errors"]');
        if (ul) ul.replaceChildren(...(p.errors || []).slice(0, 5).map((e) => { const li = document.createElement('li'); li.textContent = e; return li; }));
        if (j.instance && j.instance.error) set(el, 'hint', 'Workflow error: ' + j.instance.error);
        const a = el.querySelector('[data-f="report"]');
        if (a && j.reportUrl) { a.href = j.reportUrl; a.hidden = false; }
        if (DONE.has(inst) || (!inst && DONE.has(st))) {
          el.classList.add('is-done');
          if (!(j.instance && j.instance.error)) set(el, 'hint', 'Finished. Reload the page to update the tables.');
          return;
        }
        setTimeout(() => poll(el), 5000);
      })
      .catch((e) => { set(el, 'hint', 'Status unavailable (' + e.message + '), retrying'); setTimeout(() => poll(el), 15000); });
  }
  document.querySelectorAll('[data-watch]').forEach(poll);
${OUTREACH_JS}

  const pingBtn = document.getElementById('ping-btn');
  const pingOut = document.getElementById('ping-out');
  if (pingBtn && pingOut) {
    pingBtn.addEventListener('click', () => {
      pingBtn.disabled = true;
      pingOut.replaceChildren();
      const li = (t) => { const x = document.createElement('li'); x.textContent = t; return x; };
      pingOut.append(li('Checking…'));
      fetch('/api/admin/ping', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then((j) => {
          const rows = Object.entries(j.results || j).filter(([, v]) => v && typeof v === 'object' && 'ok' in v);
          pingOut.replaceChildren(...rows.map(([k, v]) => li((v.ok ? '✓ ' : '✗ ') + k + (v.ok ? '' : ': ' + (v.error || 'failed')) + (v.latencyMs != null ? ' (' + v.latencyMs + ' ms)' : ''))));
        })
        .catch((e) => pingOut.replaceChildren(li('Check failed (' + e.message + ')')))
        .finally(() => { pingBtn.disabled = false; });
    });
  }

  const form = document.getElementById('run-form');
  const out = document.getElementById('run-estimate');
  if (form && out) {
    let per = {};
    try { per = JSON.parse(form.getAttribute('data-per-call') || '{}'); } catch (e) {}
    const update = () => {
      const engines = [...form.querySelectorAll('input[name="engines"]:checked')].map((i) => i.value);
      const runs = Number(form.elements.runs.value) || 1;
      const qs = Number(form.elements.questions.value) || 5;
      const calls = qs * runs;
      const total = engines.reduce((s, e) => s + (per[e] || 0) * calls, 0) + (per.extract || 0) * calls * engines.length;
      out.textContent = 'Estimated cost: $' + total.toFixed(2) + ' (' + engines.length * calls + ' calls, typical usage)';
    };
    form.addEventListener('change', update);
    update();
    form.addEventListener('submit', (ev) => {
      if (!form.querySelector('input[name="engines"]:checked')) { ev.preventDefault(); out.textContent = 'Pick at least one engine.'; }
    });
  }
})();
`;
