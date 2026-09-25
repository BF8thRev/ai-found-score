// Fetches its data from GET /api/report/[id] and renders it.
// The Worker rewrites /report/<id> to /report.html; the id comes from the URL.
// Unpaid reports arrive with `locked: true` and the fix details already
// removed server-side; this page only draws the blurred stand-ins.
// `version: 2` reports use renderV2 (the searched-answers report); anything
// else is a legacy v1 report. A free-report request whose report is still being made gets a
// 202 {status} and renders the "in progress" page (renderPending), which re-checks every 30 s.
// The only paid tier offered is the $49 AI Visibility X-Ray (tier `xray`, see XRAY below).
document.addEventListener('DOMContentLoaded', async () => {
  const id = window.location.pathname.split('/').filter(Boolean).pop() || 'sample-001';
  const root = document.getElementById('report-root');
  const preview = new URLSearchParams(window.location.search).get('preview');

  let report;
  try {
    const res = await fetch('/api/report/' + encodeURIComponent(id) + (preview ? '?preview=' + encodeURIComponent(preview) : ''));
    // A free-report request whose scan is queued or running: 202 {status}. Show "in progress".
    if (res.status === 202) {
      const j = await res.json().catch(() => ({}));
      renderPending(root, id, j.status === 'queued' ? 'queued' : 'running');
      return;
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'not found' : res.status === 503 ? 'not ready' : 'error');
    report = await res.json();
  } catch (e) {
    root.innerHTML = e.message === 'not found'
      ? `<div class="wrap page-msg">
          <h1>We couldn’t find that report.</h1>
          <p>If you typed the code from a postcard, check it and try again: letters and numbers only, like <strong>aifoundscore.com/r/K7M2QX</strong>.</p>
          <p>Still stuck? Email <a href="mailto:hello@aifoundscore.com?subject=Find%20my%20report">hello@aifoundscore.com</a> with your business name, or <a href="/#request">request a fresh report</a>.</p>
        </div>`
      : e.message === 'not ready'
      ? '<div class="wrap page-msg"><h1>This report isn’t ready yet.</h1><p>We’re still checking it. Try again later today. Questions? Email <a href="mailto:hello@aifoundscore.com">hello@aifoundscore.com</a>.</p></div>'
      : '<div class="wrap page-msg"><h1>Something went wrong.</h1><p>Reload the page in a minute. If it keeps happening, email <a href="mailto:hello@aifoundscore.com">hello@aifoundscore.com</a>.</p></div>';
    return;
  }

  document.title = `AI Found Score — ${report.business.name}`;

  if (report.version === 2) renderV2(root, report);
  else renderV1(root, report);

  // Never show a buy button or link for a tier that isn't on sale (OFFERED_TIERS, config.js).
  root.querySelectorAll('[data-tier]').forEach((el) => { if (!tierOn(el.getAttribute('data-tier'))) el.remove(); });
  // Sample and showcase reports are examples: a buy button there would charge a visitor for a report
  // that isn't theirs (no token, or someone else's). Send them to the free-report form instead.
  if (isDemoReport(report)) {
    root.querySelectorAll('[data-tier]').forEach((el) => {
      el.removeAttribute('data-tier');
      el.setAttribute('href', '/#request');
    });
  }
  wireReportTools(root, report);
  window.wireCheckout?.(root, report.sample ? null : report.id);
  root.querySelectorAll('form.lead-form').forEach((f) => f.addEventListener('submit', (e) => submitLead(e, report.id)));

  // One server-side visit per render, after the JS has run. Link scanners
  // that only fetch the HTML never get here.
  if (!report.sample) {
    const body = JSON.stringify({ token: report.id, referrer: document.referrer || '' });
    try {
      if (!navigator.sendBeacon?.('/api/visit', new Blob([body], { type: 'application/json' }))) {
        fetch('/api/visit', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
      }
    } catch {}
  }
});

// ---------- A report that is still being made (free-report request) ----------
// GET /api/report/<token> answers 202 {status: 'running'|'queued'} until the report is saved.
// Re-checks every 30 seconds and reloads once the report (or anything other than 202) is there.
const PENDING_POLL_MS = 30000;
const PENDING_COPY = {
  running: {
    h: 'We’re asking the AI assistants now.',
    p: 'This page updates when your report is ready — bookmark it.',
  },
  queued: {
    h: 'Your report is in line.',
    p: 'We’ll ask the AI assistants soon. This page updates when your report is ready — bookmark it.',
  },
};

function renderPending(root, token, status) {
  const c = PENDING_COPY[status] || PENDING_COPY.running;
  document.title = 'AI Found Score — your report is on its way';
  root.innerHTML = `
    <div class="wrap page-msg r2-pending" data-status="${escapeHtml(status)}">
      <p class="r2-pending-mark" aria-hidden="true"></p>
      <h1>${escapeHtml(c.h)}</h1>
      <p>${escapeHtml(c.p)}</p>
      <p class="fine" role="status">We check again every 30 seconds. You can close this page and come back to the same link.</p>
      ${leadForm('top')}
    </div>`;
  root.querySelectorAll('form.lead-form').forEach((f) => f.addEventListener('submit', (e) => submitLead(e, token)));
  const check = async () => {
    try {
      const res = await fetch('/api/report/' + encodeURIComponent(token), { cache: 'no-store' });
      if (res.status === 202) {
        const j = await res.json().catch(() => ({}));
        const next = j.status === 'queued' ? 'queued' : 'running';
        if (next !== status) { renderPending(root, token, next); return; }
      } else {
        location.reload();
        return;
      }
    } catch { /* offline for a moment: try again next time */ }
    setTimeout(check, PENDING_POLL_MS);
  };
  setTimeout(check, PENDING_POLL_MS);
}

// ---------- v1 (legacy, no `version`): rendered exactly as before ----------
function renderV1(root, report) {

  const b = report.business;
  const locked = !!report.locked;
  // The $49 X-Ray is never sold on a v1 report: its gap sheet and checklist are built only for
  // v2 reports (src/lib/lock.js reportBody), so a v1 buyer wouldn't get what the offer promises.
  const xrayOk = false;
  const named = report.aiResults.filter((r) => r.named).length;
  const total = report.aiResults.length;
  const badListings = report.listings.filter((l) => l.status === 'mismatch');
  const listingsSub = badListings.length === 0
    ? `All ${report.listings.length} listings agree.`
    : `${badListings.length} of ${report.listings.length} listings need a fix.`;
  const meta = [b.trade, [b.address, b.city, b.state, b.zip].filter(Boolean).join(', ').replace(/, (\d{5})$/, ' $1'), b.phone]
    .filter(Boolean).map(escapeHtml).join(' · ');

  root.innerHTML = `
    <section class="report-header">
      <div class="wrap">
        ${report.sample ? '<div class="sample-banner"><strong>Sample report.</strong> A fictional plumbing company. Yours would show your details.</div>' : ''}
        <h1>${escapeHtml(b.name)}</h1>
        <p class="biz-meta">${meta}</p>
        <p class="fine">Scanned ${escapeHtml(report.generatedAt)}</p>
      </div>
    </section>

    <div class="wrap">
      <div class="score-card">
        <div class="score-ring" style="background: conic-gradient(var(--amber) ${report.score}%, rgba(255,255,255,.2) 0)">
          <div class="inner">${report.score}</div>
        </div>
        <div>
          <h2>AI Found Score: ${report.score} of 100 — ${escapeHtml(report.scoreLabel)}</h2>
          <p>${escapeHtml(report.scoreExplanation)}</p>
        </div>
      </div>

      ${report.sample ? '' : leadForm('top')}

      <section class="report-section">
        <h2>Does AI name you?</h2>
        <p class="sub">${named} of ${total} assistants named ${escapeHtml(b.name)}.</p>
        ${report.aiResults.map((r) => `
          <div class="assistant-card">
            <span class="badge ${r.named ? 'named' : 'not-named'}">${r.named ? '✓ Named you' : '✗ Didn’t name you'}</span>
            <h3>${escapeHtml(r.assistant)}</h3>
            ${r.quote ? `<blockquote>${escapeHtml(r.quote)}</blockquote>` : ''}
            <p class="note">${escapeHtml(r.note)}</p>
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>Do your listings agree?</h2>
        <p class="sub">${listingsSub}</p>
        ${report.listings.map((l) => `
          <div class="listing-card">
            <span class="badge ${l.status}">${l.status === 'match' ? '✓ Correct' : '✗ Needs a fix'}</span>
            <h3>${escapeHtml(l.platform)}</h3>
            ${l.locked
              ? blurred('What this listing shows, what it should say, and where to change it.')
              : `<p>${escapeHtml(l.details)}</p>${fields(l.fields)}`}
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>What to fix, in order</h2>
        <p class="sub">Start at the top.</p>
        ${report.issues.map((issue) => `
          <div class="issue-card">
            <span class="badge ${issue.severity}">${severityLabel(issue.severity)}</span>
            <h3>${escapeHtml(issue.title)}</h3>
            ${issue.locked
              ? blurred('Why this costs you calls, and the exact steps to fix it, written so anyone on your team can do it.')
              : `<p>${escapeHtml(issue.description)}</p>`}
          </div>`).join('')}
        ${xrayOk ? unlockPanel() : ''}
      </section>

      <section class="report-section">
        <h2>The bottom line</h2>
        <p>${escapeHtml(report.summary)}</p>
      </section>

      ${xrayOk ? xrayOffer() : ''}

      ${report.sample ? '' : leadForm('bottom')}
    </div>`;

}

// Stand-in text for withheld details. It says what's behind the blur, never
// a fake finding, and is hidden from screen readers.
function blurred(text) {
  return `<p class="locked-text" aria-hidden="true">${escapeHtml(text)}</p><p class="locked-note">🔒 In the full report</p>`;
}

// The one paid tier on sale: the $49 AI Visibility Audit (tier key `xray`, kept from its old X-Ray name). Only rendered when
// tierOn('xray') and the report has at least MIN_FIX_ITEMS fixes (the refund promise).
const XRAY = {
  name: 'AI Visibility Audit',
  price: '$49 one-time',
  what: 'Everything in this report unlocked: every fix step by step with copy-paste text, the competitor gap sheet, and your fix checklist.',
  promise: 'If we can’t show you 3 things to fix, it’s free.',
  button: 'Get my audit — $49',
};

function unlockPanel() {
  return `
    <div class="unlock-panel">
      <p><strong>The fix steps are in the ${XRAY.name}.</strong> ${XRAY.what} ${XRAY.promise}</p>
      <a class="btn" data-tier="xray" href="#">${XRAY.button}</a>
    </div>`;
}

// The offer band. `lead` is an optional first sentence (edge states: named everywhere, nothing missing).
function xrayOffer(lead = '') {
  return `
    <div class="cta-band r2-xray-offer">
      <h2>${XRAY.name} — ${XRAY.price}.</h2>
      <p>${lead ? `${lead} ` : ''}${XRAY.what} ${XRAY.promise}</p>
      <p><a class="btn big" data-tier="xray" href="#">${XRAY.button}</a></p>
      <p class="fine">Secure checkout by Stripe. One-time payment, no subscription. <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></p>
    </div>`;
}

// Real reports linked from the public pages as examples ("See a real report"): never sold from.
const SHOWCASE_TOKENS = ['mega-wash-and-dry'];
function isDemoReport(report) {
  return !!report.sample || SHOWCASE_TOKENS.includes(String(report.id || ''));
}

// Tiers on sale (public/js/config.js OFFERED_TIERS). Without config.js, nothing is for sale.
function tierOn(tier) {
  return typeof window.tierOffered === 'function' ? window.tierOffered(tier) : false;
}

// Share + Save as PDF, and the copy buttons on fix steps. One delegated listener.
function reportTools() {
  return `
    <div class="r2-tools" role="group" aria-label="Share or save this report">
      <button type="button" class="btn-secondary" data-action="share">Share this report</button>
      <button type="button" class="btn-secondary" data-action="print">Save as PDF</button>
      <span class="r2-tools-status" role="status"></span>
    </div>`;
}

function reportUrl() {
  // The shareable link: this page without ?preview or #hash.
  return location.origin + location.pathname;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

// Closed <details> hide their content in print; open every answer while printing.
function openAllForPrint() {
  const closed = [...document.querySelectorAll('details:not([open])')];
  closed.forEach((d) => { d.open = true; d.dataset.printOpened = '1'; });
}
function restoreAfterPrint() {
  document.querySelectorAll('details[data-print-opened]').forEach((d) => { d.open = false; delete d.dataset.printOpened; });
}

function wireReportTools(root, report) {
  const status = root.querySelector('.r2-tools-status');
  const say = (msg) => { if (status) status.textContent = msg; };
  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action], button[data-copy]');
    if (!btn) return;
    if (btn.dataset.copy != null) {
      const text = COPY_STORE[Number(btn.dataset.copy)];
      if (text == null) return;
      const ok = await copyText(text);
      const was = btn.textContent;
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      setTimeout(() => { btn.textContent = was; }, 1800);
      return;
    }
    if (btn.dataset.action === 'print') {
      openAllForPrint();
      window.print();
      return;
    }
    if (btn.dataset.action === 'share') {
      const url = reportUrl();
      const title = `AI Found Score — ${report.business?.name || 'report'}`;
      if (navigator.share) {
        try { await navigator.share({ title, url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
      }
      say((await copyText(url)) ? 'Link copied. Paste it anywhere to share.' : url);
    }
  });
  window.addEventListener('beforeprint', openAllForPrint);
  window.addEventListener('afterprint', restoreAfterPrint);
}

// Text behind each copy button (kept out of HTML attributes, so nothing needs escaping twice).
const COPY_STORE = [];

function leadForm(where) {
  return `
    <form class="lead-form" data-where="${where}" novalidate>
      <label for="lead-email-${where}">${where === 'top' ? 'Want this in your inbox?' : 'Not ready? Keep a copy.'}</label>
      <div class="lead-row">
        <input id="lead-email-${where}" name="email" type="email" required autocomplete="email" placeholder="you@yourbusiness.com">
        <input class="hp" name="company_url" tabindex="-1" autocomplete="off" aria-hidden="true">
        <button class="btn-secondary" type="submit">Email me this report</button>
      </div>
      <p class="lead-status" role="status"></p>
    </form>`;
}

async function submitLead(e, token) {
  e.preventDefault();
  const f = e.currentTarget;
  const status = f.querySelector('.lead-status');
  const btn = f.querySelector('button');
  const email = f.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    status.textContent = 'Please enter a valid email.';
    status.className = 'lead-status error';
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch('/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, email, company_url: f.company_url.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not save that. Try again.');
    status.textContent = `Done. We’ll send the link to ${email}.`;
    status.className = 'lead-status ok';
    f.querySelector('.lead-row').hidden = true;
    window.dataLayer?.push({ event: 'generate_lead', report_token: token });
  } catch (err) {
    status.textContent = err.message;
    status.className = 'lead-status error';
    btn.disabled = false;
  }
}

// Render only the listing fields that have a value. Empty fields are dropped, never guessed.
function fields(f) {
  const rows = [['Name', f?.name], ['Phone', f?.phone], ['Hours', f?.hours]]
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}:</dt><dd>${escapeHtml(v)}</dd>`)
    .join('');
  return rows ? `<dl class="listing-fields">${rows}</dl>` : '';
}

function severityLabel(s) {
  return { high: 'Fix first', medium: 'Fix soon', low: 'Minor' }[s] || s;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- v2: every search, every answer ----------
// Every section reads from the report JSON. Copy is fixed strings with
// slots; nothing here writes a claim the data doesn't hold. Totals are
// recomputed from `answers` for display (the Worker has already refused to
// serve a report whose stored totals disagree).

const ENGINE_NAMES = { chatgpt: 'ChatGPT', gemini: 'Gemini', google_ai_mode: 'Google AI Mode', perplexity: 'Perplexity', claude: 'Claude' };
// Mirror of MIN_FIX_ITEMS in shared/report-v2.js: the $49 X-Ray is offered only with this many fixes.
const MIN_FIX_ITEMS = 3;
// Preferred column order only. Columns come from the engines that actually
// answered (plus method.engines order for anything not listed here).
const ENGINE_COLUMNS = ['chatgpt', 'claude', 'gemini', 'google_ai_mode', 'perplexity'];
const INTENT_LABELS = { best: 'best', urgent: 'urgent', job: 'a specific job', trust: 'good reviews', price: 'cheapest' };
const FIELD_LABELS = { hours: 'Hours', phone: 'Phone', price: 'Price', address: 'Address', services: 'Services', name: 'Name', website: 'Website' };

function engineName(id) { return ENGINE_NAMES[id] || String(id || 'AI assistant'); }

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function plural(n, one, many) { return n === 1 ? one : many; }

// Numbers from the report go into HTML unescaped, so force them to be numbers.
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function tradePlural(trade) {
  const t = String(trade || 'business').toLowerCase();
  if (/(s|sh|ch|x)$/.test(t)) return t + 'es';
  return t + 's';
}

function computeTotalsV2(answers) {
  return {
    answers: answers.length,
    namedYou: answers.filter((a) => a.namedYou === true).length,
    firstYou: answers.filter((a) => a.namedYouFirst === true).length,
  };
}

// A competitor is shown only with proof: named in 2+ stored answers.
function provenEntities(report) {
  return (report.entities || [])
    .filter((e) => !e.isYou && (e.answerIds || []).length >= 2 && e.named >= 2)
    .sort((a, b) => b.named - a.named || b.first - a.first);
}

// Mirror of intentResults() in shared/report-v2.js (the browser can't import
// shared/). Keep the two identical: an intent is lost when the owner was named in
// half or fewer of that intent's answers (named × 2 <= counted). Answers with an
// `unsure` owner match are left out of both counts; an intent with no counted
// answers is neither lost nor won. Grouped by intent, in question order.
function intentResultsV2(report) {
  const answers = report.answers || [];
  const questions = report.questions || [];
  const intentOf = (a) => a.intent || (questions.find((q) => q.id === a.questionId) || {}).intent;
  const ordered = questions.length ? questions.map((q) => q.intent) : answers.map(intentOf);
  const out = [];
  for (const intent of ordered) {
    if (!intent || out.some((x) => x.intent === intent)) continue;
    const counted = answers.filter((a) => intentOf(a) === intent && a.ownerMatch !== 'unsure');
    const named = counted.filter((a) => a.namedYou === true).length;
    out.push({
      intent,
      answers: counted.length,
      named,
      lost: counted.length > 0 && named * 2 <= counted.length,
      q: questions.find((q) => q.intent === intent) || { intent, text: intent },
      answerIds: counted.map((a) => a.id),
    });
  }
  return out;
}

// What we call the things we count. A search is one question asked on one
// assistant. With one run per search (the default), each search is one answer,
// so the page says "15 searches". With more runs it says "30 answers from 15 searches".
function countWords(report) {
  const answers = report.answers || [];
  const method = report.method || {};
  const runs = num(method.runs) || Math.max(1, ...answers.map((a) => num(a.run) || 1));
  const searches = new Set(answers.map((a) => `${a.questionId}|${a.engine}`)).size;
  const N = answers.length;
  const multi = runs > 1;
  return {
    runs,
    searches,
    unit: multi ? 'answers' : 'searches', // "7 of 15 searches"
    one: multi ? 'answer' : 'search', // "every search named you"
    total: multi ? `${N} answers from ${searches} searches` : `${N} ${plural(N, 'search', 'searches')}`,
    sameSearches: `${searches} ${plural(searches, 'search', 'searches')}`,
  };
}

function isYouNamed(n) { return !!n && (n.isYou === true || n.entityId === 'you'); }

function renderV2(root, report) {
  const b = report.business || {};
  const answers = report.answers || [];
  const questions = report.questions || [];
  const qById = Object.fromEntries(questions.map((q) => [q.id, q]));
  const aById = Object.fromEntries(answers.map((a) => [a.id, a]));
  const method = report.method || {};
  const failed = (method.enginesFailed || []).filter(Boolean);
  const t = computeTotalsV2(answers);
  const N = t.answers;
  const proven = provenEntities(report);
  const provenIds = new Set(proven.map((e) => e.id));
  const locked = !!report.locked;
  const paid = !locked && !report.sample;
  const listings = report.listings || [];
  const issues = report.issues || [];
  const badListings = listings.filter((l) => l.status === 'mismatch');
  // Unsure owner matches are never counted as "didn't name you".
  const lostAnswerIds = new Set(answers.filter((a) => !a.namedYou && a.ownerMatch !== 'unsure').map((a) => a.id));
  const cw = countWords(report);
  const fixCount = issues.filter((i) => i && i.title).length;
  // The $49 X-Ray is offered only on a locked report with at least MIN_FIX_ITEMS fixes (the refund promise).
  const xrayOk = locked && !paid && fixCount >= MIN_FIX_ITEMS && tierOn('xray');
  const ownDomain = String(b.website || '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();

  // Engines in column order: known engines that answered, then any others.
  const answered = [...new Set([...Object.keys(method.engines || {}), ...answers.map((a) => a.engine)])]
    .filter((e) => answers.some((a) => a.engine === e));
  const engines = [...ENGINE_COLUMNS.filter((e) => answered.includes(e)), ...answered.filter((e) => !ENGINE_COLUMNS.includes(e))];
  const engineList = listJoin(engines.map(engineName));
  const failedNote = failed.length
    ? `${listJoin(failed.map(engineName))} didn’t respond, so ${failed.length === 1 ? 'its column is' : 'their columns are'} left out.`
    : '';

  // Per-question results, same rule as intentResults() in shared/report-v2.js.
  const intents = intentResultsV2(report);
  const lostIntents = intents.filter((x) => x.lost);
  const wonIntents = intents.filter((x) => x.answers > 0 && !x.lost);
  const intentLabel = (x) => INTENT_LABELS[x.intent] || x.intent || x.q.text;

  // Edge states (docs/BUILD_PLAN.md "Edge states").
  const zero = N > 0 && t.namedYou === 0;
  const allNamed = N > 0 && t.namedYou === N;
  const nobodyTwice = proven.length === 0;
  // Same rule as edgeState() in shared/report-v2.js.
  const missingSources = (report.sources || []).filter((s) => s.youListed === false);
  const noFixes = badListings.length === 0 && missingSources.length === 0;
  const generalAdvice = answers.filter((a) => !(a.businessesNamed || []).length).length;

  const trade = b.trade ? b.trade[0].toUpperCase() + b.trade.slice(1) : '';
  const place = [b.address, b.town || b.city, [b.state, b.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const meta = [trade, place, b.phone].filter(Boolean).map(escapeHtml).join(' · ');

  root.innerHTML = [
    headerV2(report, b, meta),
    '<div class="wrap r2">',
    heroV2(report, { answers, aById, qById, t, cw, engineList, proven, provenIds, zero, b }),
    scoreV2(report),
    baselineV2(report, t),
    report.sample ? '' : leadForm('top'),
    shortVersionV2({ t, N, cw, intents, lostIntents, wonIntents, intentLabel, proven, answers, zero, allNamed, nobodyTwice, generalAdvice }),
    nobodyTwice ? '' : whoAiNamesV2({ b, t, N, cw, proven }),
    gridV2({ questions, answers, engines, failedNote }),
    sourcesV2({ report, b, aById, lostAnswerIds, ownDomain, cw }),
    factsV2({ report, b, aById }),
    listingsV2({ listings, badListings }),
    issuesV2({ issues, locked, xrayOk }),
    xrayV2({ report, aById, cw, N }),
    offerV2({ allNamed, noFixes, cw, fixCount, xrayOk }),
    answersV2({ questions, answers }),
    methodV2({ report, method, engines, failed, questions, N, cw, listings }),
    report.sample ? '' : leadForm('bottom'),
    '</div>',
  ].join('');

  // Grid marks (and "read the answer" links) open their answer in section 10.
  root.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-open]');
    if (!link) return;
    const d = document.getElementById('ans-' + link.dataset.open);
    if (!d) return;
    e.preventDefault();
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { history.replaceState(null, '', '#ans-' + link.dataset.open); } catch {}
  });
  const hash = location.hash.match(/^#ans-(.+)$/);
  if (hash) {
    const d = document.getElementById('ans-' + hash[1]);
    if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
  }
}

function headerV2(report, b, meta) {
  return `
    <section class="report-header">
      <div class="wrap r2">
        ${report.sample ? '<div class="sample-banner"><strong>Sample report.</strong> A fictional business, fictional competitors and made-up answers. Yours shows your real searches, word for word.</div>' : ''}
        <h1>${escapeHtml(b.name)}</h1>
        <p class="biz-meta">${meta}</p>
        <p class="fine">Checked ${escapeHtml(fmtDate(report.generatedAt))}</p>
        ${reportTools()}
      </div>
    </section>`;
}

// 1. Hero: one real search, and who it named.
function heroV2(report, { answers, aById, qById, t, cw, engineList, proven, provenIds, zero, b }) {
  const h = aById[report.headline?.answerId] || answers[0];
  if (!h) return '';
  const q = qById[h.questionId] || { text: '' };
  const others = (h.businessesNamed || []).filter((n) => !isYouNamed(n));
  const shown = others.filter((n) => provenIds.has(n.entityId)).map((n) => escapeHtml(n.name));
  const unshown = others.length - shown.length;
  const otherText = (n) => `${n} other ${plural(n, 'business', 'businesses')}`;
  let namedLine;
  if (h.namedYou) {
    namedLine = h.namedYouFirst
      ? `It named ${escapeHtml(b.name)} first.`
      : `It named ${escapeHtml(b.name)}, but not first.`;
  } else if (shown.length) {
    namedLine = `It named ${listJoin(unshown ? [...shown, otherText(unshown)] : shown)}.`;
  } else if (unshown) {
    namedLine = `It named ${otherText(unshown)}.`;
  } else {
    namedLine = 'It didn’t name any business.';
  }
  const top = proven[0];
  const topLine = top && num(top.first) > 0 ? ` ${escapeHtml(top.name)} was named first in ${num(top.first)}.` : '';
  const tally = zero
    ? '<b>You came up in 0.</b>'
    : `<b>You came up in ${t.namedYou} and were named first in ${t.firstYou}.</b>`;
  return `
    <div class="r2-hero">
      <div class="k">We searched ${escapeHtml(engineName(h.engine))} for</div>
      <div class="q">“${escapeHtml(q.text)}”</div>
      <p class="a">${namedLine} <a href="#ans-${escapeHtml(h.id)}" data-open="${escapeHtml(h.id)}">Read the answer</a></p>
      ${h.namedYou ? '' : '<p class="miss">It didn’t name you.</p>'}
      <div class="more">We ran ${cw.sameSearches} like this on ${escapeHtml(engineList)}${cw.runs > 1 ? `, ${cw.runs} times each: ${num(t.answers)} answers` : ''}. ${tally}${topLine}</div>
    </div>`;
}

// The AI Found Score: computed by the Worker from this report's own answers
// (shared/report-v2.js computeVisibilityScore). The footnote says exactly how.
function scoreV2(report) {
  const sc = report.score;
  if (!sc || !Array.isArray(sc.parts) || !Number.isFinite(Number(sc.score))) return '';
  const n = Math.max(0, Math.min(100, Math.round(Number(sc.score))));
  const band = n >= 70 ? 'strong' : n >= 40 ? 'mixed' : 'weak';
  const bandText = { strong: 'AI finds you often.', mixed: 'AI finds you sometimes.', weak: 'AI rarely finds you.' }[band];
  const rows = sc.parts.map((p) => `
        <li><span class="k">${escapeHtml(p.label)}</span><span class="v">${escapeHtml(p.detail)}</span><span class="w">${num(Math.round(p.weight * p.value))} / ${num(p.weight)}</span></li>`).join('');
  return `
    <section class="report-section r2-score" aria-label="AI Found Score">
      <div class="r2-score-top">
        <div class="r2-score-ring ${band}" style="--pct:${n}"><span>${n}</span><small>of 100</small></div>
        <div>
          <h2>AI Found Score<sup>*</sup></h2>
          <p class="sub">${bandText}</p>
        </div>
      </div>
      <ul class="r2-score-parts">${rows}
      </ul>
      <p class="r2-score-note">* The AI Found Score is our own internal measure, not a rating from any AI company. We compute it only from the answers in this report: how often you were named (50%), named first (25%), whether the facts AI stated about you were right (15%) and whether AI cited your website (10%). A part we couldn&rsquo;t check is left out and the rest are scaled to 100. AI answers change, so the score can change from scan to scan.</p>
    </section>`;
}

// Step 6: before/after strip when this scan has a baseline.
function baselineV2(report, t) {
  const base = report.baseline;
  if (!base || !base.totals) return '';
  const bt = base.totals;
  return `
    <section class="report-section r2-baseline" aria-label="Before and after">
      <h2>Before and after</h2>
      <p class="sub">The same searches, run again.</p>
      <div class="r2-ba">
        <div class="r2-ba-box"><div class="l">${escapeHtml(fmtDate(base.generatedAt))}</div><div class="n">${num(bt.namedYou)} of ${num(bt.answers)}</div><div class="l">named you · first in ${num(bt.firstYou)}</div></div>
        <div class="r2-ba-arrow" aria-hidden="true">→</div>
        <div class="r2-ba-box now"><div class="l">${escapeHtml(fmtDate(report.generatedAt))}</div><div class="n">${t.namedYou} of ${t.answers}</div><div class="l">named you · first in ${t.firstYou}</div></div>
      </div>
    </section>`;
}

// 2. The short version: three tiles and one sentence.
function shortVersionV2({ t, N, cw, intents, lostIntents, wonIntents, intentLabel, proven, answers, zero, allNamed, nobodyTwice, generalAdvice }) {
  const bq = (x) => `<b>“${escapeHtml(intentLabel(x))}”</b>`;
  const bqn = (x) => `${bq(x)} (${x.named} of ${x.answers})`;
  const lostTile = lostIntents.length
    ? `<div class="n">${lostIntents.length}</div><div class="l">${plural(lostIntents.length, 'question', 'questions')} you lost: ${listJoin(lostIntents.map((x) => `“${escapeHtml(intentLabel(x))}”`))}</div>`
    : '<div class="n">0</div><div class="l">questions you lost</div>';
  let line = '';
  if (allNamed) {
    line = `You’re in good shape. Every ${cw.one} named you.`;
  } else if (!zero && lostIntents.length && wonIntents.length) {
    // Who takes the owner's place: the proven name most often in the lost questions' misses.
    const lostIds = new Set(lostIntents.flatMap((x) => x.answerIds));
    const lostAns = answers.filter((a) => lostIds.has(a.id) && !a.namedYou);
    const counts = proven.map((e) => ({ e, n: lostAns.filter((a) => (e.answerIds || []).includes(a.id)).length }))
      .filter((x) => x.n > 0).sort((a, c) => c.n - a.n);
    const taker = counts[0] ? `, and ${escapeHtml(counts[0].e.name)} is the name that takes your place` : '';
    line = `You’re in good shape when people ask for ${listJoin(wonIntents.map(bq))}. You lose ground when they ask for ${listJoin(lostIntents.map(bqn))}${taker}.`;
  } else if (!zero && !lostIntents.length) {
    line = 'For every question, more than half the answers named you.';
  }
  const advice = nobodyTwice && generalAdvice > 0
    ? `<p class="r2-line">AI gave general advice without naming anyone in ${generalAdvice} of ${N} ${cw.unit}.</p>` : '';
  return `
    <section class="report-section">
      <h2>The short version</h2>
      <div class="r2-tiles">
        <div class="r2-tile"><div class="n">${t.namedYou} of ${N}</div><div class="l">${cw.unit} named you</div></div>
        <div class="r2-tile"><div class="n">${t.firstYou} of ${N}</div><div class="l">${cw.unit} named you first</div></div>
        <div class="r2-tile">${lostTile}</div>
      </div>
      ${intents.some((x) => x.answers > 1) ? '<p class="r2-muted">A question counts as lost when half or fewer of its answers named you.</p>' : ''}
      ${line ? `<p class="r2-line">${line}</p>` : ''}
      ${advice}
    </section>`;
}

// 3. Who AI names: businesses named in 2+ answers. Owner always shown.
function whoAiNamesV2({ b, t, N, cw, proven }) {
  const pct = (n) => (N ? Math.round((n / N) * 1000) / 10 : 0);
  const row = (name, named, first, you) => `
    <div class="r2-row${you ? ' you' : ''}">
      <span class="nm">${escapeHtml(name)}${you ? ' (you)' : ''}</span>
      <span class="c">${named} named${first ? ` · ${first} first` : ''}</span>
      <div class="t" aria-hidden="true"><i class="first" style="width:${pct(first)}%"></i><i class="named" style="width:${pct(named - first)}%"></i></div>
    </div>`;
  return `
    <section class="report-section">
      <h2>Who AI names for ${escapeHtml(tradePlural(b.trade))} near ${escapeHtml(b.town || b.city || 'you')}</h2>
      <p class="sub">Every business named in at least 2 of the ${N} ${cw.unit}. Dark bar = named first.</p>
      <div class="r2-bars">
        ${row(b.name, t.namedYou, t.firstYou, true)}
        ${proven.map((e) => row(e.name, num(e.named), num(e.first), false)).join('')}
      </div>
      <div class="r2-legend"><span>Named first</span><span class="n">Named, not first</span></div>
    </section>`;
}

function markFor(a) {
  if (a.ownerMatch === 'unsure' && !a.namedYou) return { cls: 'u', txt: '?', label: 'Unsure, not counted' };
  if (a.namedYouFirst) return { cls: 'y', txt: '✓★', label: 'Named you first' };
  if (a.namedYou) return { cls: 'y', txt: '✓', label: 'Named you' };
  return { cls: 'x', txt: '✗', label: 'Didn’t name you' };
}

// 4. Every search: question × engine; each run is a mark that opens its answer.
function gridV2({ questions, answers, engines, failedNote }) {
  const runs = Math.max(1, ...answers.map((a) => a.run || 1));
  const hasUnsure = answers.some((a) => a.ownerMatch === 'unsure' && !a.namedYou);
  const cell = (q, e) => {
    const cellAns = answers.filter((a) => a.questionId === q.id && a.engine === e).sort((x, y) => (x.run || 1) - (y.run || 1));
    if (!cellAns.length) return '<td class="m"><span class="mk none">–</span></td>';
    return `<td class="m">${cellAns.map((a) => {
      const m = markFor(a);
      return `<a class="mk ${m.cls}" href="#ans-${escapeHtml(a.id)}" data-open="${escapeHtml(a.id)}" aria-label="${escapeHtml(engineName(e))}, run ${num(a.run) || 1}: ${m.label}. Open the answer.">${m.txt}</a>`;
    }).join('')}</td>`;
  };
  const runNote = runs > 1 ? ` · Each search ran ${runs} times, one mark per run` : '';
  return `
    <section class="report-section">
      <h2>Every search, every assistant</h2>
      <p class="sub">✓ named you (★ = first) · ✗ didn’t${hasUnsure ? ' · ? unsure, not counted' : ''}${runNote}. Tap a mark to read that answer.</p>
      ${failedNote ? `<p class="r2-note">${escapeHtml(failedNote)}</p>` : ''}
      <div class="r2-grid-wrap"><table class="r2-grid">
        <thead><tr><th scope="col">What we searched</th>${engines.map((e) => `<th scope="col" class="m">${escapeHtml(engineName(e))}</th>`).join('')}</tr></thead>
        <tbody>${questions.map((q) => `<tr><th scope="row">${escapeHtml(q.text)}</th>${engines.map((e) => cell(q, e)).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </section>`;
}

function shortUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return String(u || ''); }
}

function safeHref(u) {
  return /^https?:\/\//i.test(String(u || '')) ? escapeHtml(u) : '#';
}

// 5. Why they got named instead: sources cited in answers the owner lost.
function sourcesV2({ report, b, aById, lostAnswerIds, ownDomain, cw }) {
  const order = (s) => (s.youListed === false ? 0 : s.youListed == null ? 1 : 2);
  const list = (report.sources || [])
    .map((s) => ({ ...s, lostIn: (s.citedIn || []).filter((id) => lostAnswerIds.has(id)) }))
    .filter((s) => s.lostIn.length && s.domain !== ownDomain)
    .sort((a, c) => order(a) - order(c) || c.lostIn.length - a.lostIn.length);
  if (!list.length) return '';
  const cards = list.map((s) => {
    const col = (e) => { const i = ENGINE_COLUMNS.indexOf(e); return i < 0 ? 99 : i; };
    const engs = [...new Set(s.lostIn.map((id) => aById[id]?.engine))].sort((x, y) => col(x) - col(y)).map(engineName);
    const badge = s.youListed === false
      ? '<span class="badge mismatch">You’re not listed</span>'
      : s.youListed === true
        ? `<span class="badge match">You’re listed${num(s.youPosition) ? ` at #${num(s.youPosition)}` : ''}</span>`
        : '<span class="badge low">Not checked</span>';
    const facts = [`Cited in ${s.lostIn.length} ${s.lostIn.length === 1 ? cw.one : cw.unit} that didn’t name you (${escapeHtml(listJoin(engs))}).`];
    if (s.topListed && s.topListed !== b.name) facts.push(`<strong>${escapeHtml(s.topListed)}</strong> is listed first on that page.`);
    if (s.youListed === false) facts.push(`${escapeHtml(b.name)} isn’t on it.`);
    return `
      <div class="listing-card">
        ${badge}
        <h3>${escapeHtml(s.domain)}</h3>
        <p>${facts.join(' ')}</p>
        <p class="r2-src"><a href="${safeHref(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(shortUrl(s.url))}</a></p>
      </div>`;
  }).join('');
  return `
    <section class="report-section">
      <h2>Why they got named instead</h2>
      <p class="sub">The sites the AI cited in the ${cw.unit} that didn’t name you, and whether you’re on them.</p>
      ${cards}
    </section>`;
}

// 6b. How AI describes you: short phrases quoted exactly from answers that named you.
function descriptorsV2({ report, aById }) {
  const ds = (report.ownerDescriptors || []).filter((d) => d && d.quote && aById[d.answerId]).slice(0, 6);
  if (!ds.length) return '';
  return `
      <div class="r2-desc">
        <h3>How AI describes you</h3>
        <ul>${ds.map((d) => {
          const a = aById[d.answerId];
          return `<li><q>${escapeHtml(d.quote)}</q> <span class="r2-muted">${escapeHtml(engineName(a.engine))} · <a href="#ans-${escapeHtml(a.id)}" data-open="${escapeHtml(a.id)}">See the answer</a></span></li>`;
        }).join('')}</ul>
      </div>`;
}

// 6. What AI says about you: exact quotes, differs first.
function factsV2({ report, b, aById }) {
  const order = { differs: 0, match: 1 };
  const all = (report.aiFacts || []).slice().sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2));
  // Only differs/match cards, unless nothing was checkable; capped (the builder already
  // keeps one per field and engine, this guards reports stored before it did).
  const checked = all.filter((f) => f.status === 'differs' || f.status === 'match');
  const facts = (checked.length ? checked : all).slice(0, 8);
  const described = descriptorsV2({ report, aById });
  if (!facts.length && !described) return '';
  const cards = facts.map((f) => {
    const a = aById[f.answerId];
    const badge = f.status === 'differs' ? '<span class="badge mismatch">Doesn’t match</span>'
      : f.status === 'match' ? '<span class="badge match">Correct</span>'
        : '<span class="badge low">Not on your site or listings</span>';
    return `
      <div class="listing-card">
        ${badge}
        <h3>${escapeHtml(FIELD_LABELS[f.field] || f.field)}</h3>
        <p>${escapeHtml(engineName(a?.engine))} said: <q>${escapeHtml(f.aiSays)}</q>${a ? ` <a href="#ans-${escapeHtml(a.id)}" data-open="${escapeHtml(a.id)}">See the answer</a>` : ''}</p>
        ${f.sourceSays ? `<p class="r2-muted">Your website and listings say: ${escapeHtml(f.sourceSays)}</p>` : ''}
      </div>`;
  }).join('');
  return `
    <section class="report-section">
      <h2>What AI says about you</h2>
      <p class="sub">${facts.length ? `Facts the AI stated about ${escapeHtml(b.name)}, quoted exactly and checked against your website and listings.` : `How the AI described ${escapeHtml(b.name)}, quoted exactly.`}</p>
      ${described}
      ${cards}
    </section>`;
}

// 7. Your listings: a possible reason. Same cards as v1.
function listingsV2({ listings, badListings }) {
  if (!listings.length) return '';
  const sub = badListings.length === 0
    ? `All ${listings.length} listings agree.`
    : `${badListings.length} of ${listings.length} listings need a fix. When your listings disagree, AI can repeat the wrong one.`;
  return `
    <section class="report-section">
      <h2>Your listings</h2>
      <p class="sub">${sub}</p>
      ${listings.map((l) => `
        <div class="listing-card">
          <span class="badge ${l.status === 'match' ? 'match' : 'mismatch'}">${l.status === 'match' ? '✓ Correct' : '✗ Needs a fix'}</span>
          <h3>${escapeHtml(l.platform)}</h3>
          ${l.locked
            ? blurred('What this listing shows, what it should say, and where to change it.')
            : `${l.details ? `<p>${escapeHtml(l.details)}</p>` : ''}${fields(l.fields)}`}
        </div>`).join('')}
    </section>`;
}

// Copy-paste blocks under a fix: plain text, or a code block (JSON-LD), each with a Copy button.
function copyBlocksV2(items) {
  return (items || []).filter((c) => c && c.label && typeof c.text === 'string' && c.text).map((c) => {
    const idx = COPY_STORE.push(c.text) - 1;
    const body = c.format === 'code'
      ? `<pre class="r2-code"><code>${escapeHtml(c.text)}</code></pre>`
      : `<div class="r2-copytext">${escapeHtml(c.text)}</div>`;
    return `
      <div class="r2-copy">
        <div class="r2-copy-head"><span>${escapeHtml(c.label)}</span><button type="button" class="btn-secondary r2-copy-btn" data-copy="${idx}">Copy</button></div>
        ${body}
      </div>`;
  }).join('');
}

// 8. What to fix: titles free; descriptions, steps and copy text locked until paid
// (removed server-side, src/lib/lock.js).
function issuesV2({ issues, locked, xrayOk }) {
  if (!issues.length) return '';
  return `
    <section class="report-section">
      <h2>What to fix, in order</h2>
      <p class="sub">${issues.length} ${plural(issues.length, 'fix', 'fixes')}. Start at the top.</p>
      ${issues.map((issue) => `
        <div class="issue-card">
          <span class="badge ${escapeHtml(issue.severity)}">${escapeHtml(severityLabel(issue.severity))}</span>
          <h3>${escapeHtml(issue.title)}</h3>
          ${issue.locked
            ? blurred('What this is, the exact steps to fix it, and text you can copy and paste.')
            : `${issue.description ? `<p>${escapeHtml(issue.description)}</p>` : ''}${
              (issue.steps || []).length ? `<ol class="r2-steps">${issue.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}${
              copyBlocksV2(issue.copyText)}`}
        </div>`).join('')}
      ${xrayOk ? unlockPanel() : ''}
    </section>`;
}

// 8b. The X-Ray sections: competitor gap sheet + fix checklist. Built by the Worker from this
// report's own data (shared/report-v2.js xraySections) and sent only when unlocked; a locked
// report carries just `xray: {locked: true}`, so only the titles and a blurred stand-in show.
function xrayV2({ report, aById, cw, N }) {
  const x = report.xray;
  if (!x) return '';
  if (x.locked) {
    return `
    <section class="report-section r2-xray">
      <h2>Competitor gap sheet</h2>
      <div class="issue-card">${blurred('Each business AI named over you, how often it was named and named first, and the sites AI cited that list them and not you.')}</div>
      <h2 class="r2-xray-h2">Your fix checklist</h2>
      <div class="issue-card">${blurred('Every fix in this report as a checklist you can tick off as you go.')}</div>
    </section>`;
  }
  const gap = x.gapSheet || { competitors: [] };
  const comps = (gap.competitors || []).filter((c) => c && c.name);
  const proof = (ids) => {
    const links = (ids || []).filter((id) => aById[id]).slice(0, 8)
      .map((id) => { const a = aById[id]; const lbl = INTENT_LABELS[a.intent] ? ` (${INTENT_LABELS[a.intent]})` : ''; return `<a href="#ans-${escapeHtml(id)}" data-open="${escapeHtml(id)}">${escapeHtml(engineName(a.engine) + lbl)}</a>`; });
    return links.length ? `<p class="r2-muted">Read the answers: ${links.join(' · ')}</p>` : '';
  };
  const anyGap = comps.some((c) => (c.sources || []).length);
  const cards = comps.map((c) => {
    const srcs = (c.sources || []).filter((s) => s && s.domain);
    return `
      <div class="listing-card r2-gap">
        <h3>${escapeHtml(c.name)}</h3>
        <p>Named in ${num(c.named)} of ${num(N)} ${cw.unit}${num(c.first) ? `, first in ${num(c.first)}` : ', never first'}.</p>
        ${srcs.length
          ? `<p><strong>Sites AI cited that list them and not you:</strong></p>
             <ul class="r2-gap-list">${srcs.map((s) => `<li><a href="${safeHref(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(s.domain)}</a>${num(s.position) ? ` <span class="r2-muted">(listed #${num(s.position)})</span>` : ''}</li>`).join('')}</ul>`
          : '<p class="r2-muted">We found no sites AI cited that list them and not you.</p>'}
        ${proof(c.answerIds)}
      </div>`;
  }).join('');
  const checkedNote = num(gap.sourcesChecked) === 0
    ? 'None of the sites AI cited could be read for their listings, so no gaps could be checked.'
    : anyGap ? '' : 'We found no sites AI cited that list them and not you.';
  const checklist = (x.checklist || []).filter((i) => i && i.title);
  const checkKey = 'afs_check_' + String(report.id || '');
  let ticked = {};
  try { ticked = JSON.parse(localStorage.getItem(checkKey) || '{}') || {}; } catch { ticked = {}; }
  // Saved ticks live only in this browser (localStorage); wired once the page is in the DOM.
  setTimeout(() => {
    document.querySelectorAll('input[data-check]').forEach((box) => box.addEventListener('change', () => {
      try {
        const cur = JSON.parse(localStorage.getItem(checkKey) || '{}') || {};
        cur[box.dataset.check] = box.checked;
        localStorage.setItem(checkKey, JSON.stringify(cur));
      } catch { /* storage blocked: the ticks just don't persist */ }
    }));
  }, 0);
  return `
    <section class="report-section r2-xray">
      <h2>Competitor gap sheet</h2>
      <p class="sub">${comps.length
        ? `Every business AI named in at least 2 of the ${num(N)} ${cw.unit}, and the sites AI cited that list them and not you.`
        : `No other business was named in 2 or more of the ${num(N)} ${cw.unit}, so there is no competitor gap to show.`}</p>
      ${checkedNote && comps.length ? `<p class="r2-note">${escapeHtml(checkedNote)}</p>` : ''}
      ${cards}
      <h2 class="r2-xray-h2">Your fix checklist</h2>
      <p class="sub">${checklist.length} ${plural(checklist.length, 'fix', 'fixes')}, in order. Ticks are saved in this browser.</p>
      <ul class="r2-check">${checklist.map((i, n) => {
        const k = escapeHtml(`${n}:${i.title}`.slice(0, 120));
        return `<li><label><input type="checkbox" data-check="${k}"${ticked[`${n}:${i.title}`.slice(0, 120)] ? ' checked' : ''}> <span>${escapeHtml(i.title)}</span></label></li>`;
      }).join('')}</ul>
    </section>`;
}

// 9. Offer: the $49 AI Visibility X-Ray, the only tier on sale (OFFERED_TIERS in config.js has 'xray').
// Only on a locked report with at least MIN_FIX_ITEMS fixes (xrayOk; the refund promise). Edge states
// (named in every answer, or nothing missing) offer it too: the baseline fixes still apply.
// Sample and showcase reports never link to Stripe (isDemoReport, at the top of this file).
function offerV2({ allNamed, noFixes, cw, fixCount, xrayOk }) {
  if (!xrayOk) return '';
  if (allNamed || noFixes) {
    const lead = allNamed ? `Every ${cw.one} named you.` : 'We found no listing to fix and no cited site missing you.';
    return xrayOffer(`${lead} There are still ${num(fixCount)} things you can do to keep your details clear and consistent.`);
  }
  return xrayOffer();
}

// Answer text with business names bolded at their stored positions.
function answerHtml(a) {
  const text = String(a.text || '');
  const marks = (a.businessesNamed || [])
    .filter((n) => n && typeof n.name === 'string' && text.slice(n.pos, n.pos + n.name.length) === n.name)
    .sort((x, y) => x.pos - y.pos);
  let out = '';
  let at = 0;
  for (const n of marks) {
    if (n.pos < at) continue;
    out += escapeHtml(text.slice(at, n.pos));
    out += isYouNamed(n) ? `<mark>${escapeHtml(n.name)}</mark>` : `<b>${escapeHtml(n.name)}</b>`;
    at = n.pos + n.name.length;
  }
  return out + escapeHtml(text.slice(at));
}

// 10. Every answer: full text, collapsed, cited URLs under each.
function answersV2({ questions, answers }) {
  if (!answers.length) return '';
  const runs = Math.max(1, ...answers.map((a) => a.run || 1));
  const groups = questions.map((q) => {
    const qa = answers.filter((a) => a.questionId === q.id);
    if (!qa.length) return '';
    return `
      <h3 class="r2-q">“${escapeHtml(q.text)}”</h3>
      ${qa.map((a) => {
        const m = markFor(a);
        const cites = (a.citations || []).filter((c) => c && c.url);
        return `
        <details class="r2-ans" id="ans-${escapeHtml(a.id)}">
          <summary><span class="eng">${escapeHtml(engineName(a.engine))}${runs > 1 ? ` · run ${num(a.run) || 1}` : ''}</span><span class="mk ${m.cls}">${m.txt}</span><span class="lbl">${m.label}</span></summary>
          <div class="body">
            ${a.headlineUnstable ? '<p class="r2-note">We asked this search again and the second answer changed whether it named you, so we didn’t lead with it.</p>' : ''}
            <blockquote>${answerHtml(a)}</blockquote>
            ${cites.length
              ? `<p class="r2-src">Cited: ${cites.map((c) => `<a href="${safeHref(c.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(shortUrl(c.url))}</a>`).join(' · ')}</p>`
              : '<p class="r2-src">No sources cited.</p>'}
          </div>
        </details>`;
      }).join('')}`;
  }).join('');
  return `
    <section class="report-section">
      <h2>Read every answer</h2>
      <p class="sub">Word for word, as the AI returned it. Business names in bold, yours highlighted. Tap to open.</p>
      ${groups}
    </section>`;
}

// The headline re-ask (one run per assistant, so the search we lead with is checked once more).
function headlineLine(method) {
  const hc = method.headlineConfirm;
  if (!hc || method.headlineConfirmed == null) return '';
  if (hc.result === 'same') return `We asked the search at the top of this report a second time on ${escapeHtml(engineName(hc.engine))}; it gave the same result.`;
  if (hc.result === 'changed') return `The first search we picked to lead with gave a different result when we asked it again on ${escapeHtml(engineName(hc.engine))}, so this report leads with another one.`;
  return `We tried to ask the search at the top of this report a second time on ${escapeHtml(engineName(hc.engine))} and couldn’t confirm it.`;
}

// 11. How we searched. Always rendered.
function methodV2({ report, method, engines, failed, questions, N, cw, listings }) {
  const cfg = method.engines || {};
  const lines = engines.map((e) => {
    const c = cfg[e] || {};
    const how = [c.api, c.model ? `model ${c.model}` : ''].filter(Boolean).join(', ');
    return `${escapeHtml(engineName(e))}: ${how ? escapeHtml(how) + ', ' : ''}${c.loggedIn ? 'logged in' : 'not logged in'}.`;
  });
  const runs = cw.runs;
  const parts = [
    lines.join(' '),
    `${questions.length} ${plural(questions.length, 'question', 'questions')} phrased the way a local customer would ask, each asked ${runs === 1 ? 'once' : `${runs} times`} per assistant: ${cw.total} in all.`,
    `Asked ${escapeHtml(fmtDate(report.generatedAt))}${method.window ? ', ' + escapeHtml(method.window) : ''}.`,
    failed.length ? `${escapeHtml(listJoin(failed.map(engineName)))} didn’t respond, so ${plural(failed.length, 'it is', 'they are')} left out. We don’t fill the gap.` : '',
    headlineLine(method),
    'We asked through each assistant’s official or commercial service, with web search on. Those answers can differ from the app on your phone.',
    listings.length ? '' : 'Listing consistency was not checked in this report.',
    'AI answers change; this is a snapshot.',
  ].filter(Boolean);
  return `<div class="r2-method"><b>How we searched.</b> ${parts.join(' ')}</div>`;
}
