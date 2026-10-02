// Fetches its data from GET /api/report/[id] and renders it.
// The Worker rewrites /report/<id> to /report.html; the id comes from the URL.
// Unpaid reports arrive with `locked: true` and the fix details already
// removed server-side; this page only draws the blurred stand-ins.
// `version: 2` reports use renderV2 (the searched-answers report); anything
// else is a legacy v1 report. A free-report request whose report is still being made gets a
// 202 {status, business?, hasEmail?} and renders the "in progress" page (renderPending), which
// re-checks every 30 s.
// ?offer=xray or ?offer=be_the_answer (links from emails and the homepage) scrolls to that plan's
// buy button and highlights it (focusOffer).
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
      renderPending(root, id, j);
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
  wireOfferScroll(root);
  wireStickyCta(root);
  setHeaderForReport(root, report);
  wireOfferTotal(root);
  focusOffer(root, new URLSearchParams(window.location.search).get('offer'));

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
// GET /api/report/<token> answers 202 {status, business?: {name, town, state}, hasEmail?} until the
// report is saved. status: 'running' | 'queued' | 'failed' (failed after its automatic retry; we re-run
// it) | 'paid' (a paid full audit is being made). Anything else is treated as 'running'.
// Re-checks every 30 seconds and reloads once the report (or anything other than 202) is there.
// Re-check cadence: quick at first (a free scan is quick), then slower.
const PENDING_POLL_MS = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 15000, 15000, 15000, 15000];
const PENDING_POLL_LAST_MS = 30000;
const PENDING_STATUSES = ['running', 'queued', 'failed', 'paid', 'cancelled'];
const LIVE_KEY = 'afs_live';
const LIVE_WAIT_MS = 50000;

function pendingCopy(status, hasEmail) {
  if (status === 'queued') {
    return { h: 'Your report is in line.', p: `Ready by ${nextBusinessDay()}. This page updates when it’s ready, so you can bookmark it.`, spin: true };
  }
  if (status === 'failed') {
    return {
      h: 'Something went wrong making your report.',
      p: hasEmail
        ? 'We’ve been alerted and we’ll re-run it. You’ll get an email when it’s ready.'
        : 'We’ve been alerted and we’ll re-run it. Leave your email below and we’ll send it when it’s ready.',
      spin: false,
    };
  }
  if (status === 'cancelled') {
    return { h: 'This report request was closed.', p: 'Want to see what AI says about your business? <a href="/#request">Get a free report</a>. It takes a minute.', spin: false, html: true };
  }
  if (status === 'paid') {
    return { h: 'Your full audit is being made.', p: 'It fills in as the answers come back. This page updates on its own.', spin: true };
  }
  return { h: 'We’re asking the AI assistants now.', p: 'It fills in as the answers come back. This page updates on its own, so you can bookmark it.', spin: true };
}

// The next weekday after today, New York time: "Monday, Sep 28". Holidays aren't counted.
function nextBusinessDay(now = new Date()) {
  const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(ny.getFullYear(), ny.getMonth(), ny.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function pendingState(j) {
  const b = j && j.business && typeof j.business === 'object' ? j.business : null;
  const qs = Array.isArray(j && j.questions) ? j.questions.filter((q) => q && q.text).map((q) => ({ id: String(q.id || ''), text: String(q.text) })) : [];
  const p = j && j.progress && Number(j.progress.total) > 0 ? { done: Math.max(0, Number(j.progress.done) || 0), total: Number(j.progress.total) } : null;
  return {
    status: PENDING_STATUSES.includes(j && j.status) ? j.status : 'running',
    business: b && b.name ? b : null,
    hasEmail: !!(j && j.hasEmail),
    questions: qs,
    progress: p,
  };
}

/** What the homepage handed over for this token (sessionStorage, this tab only), or null. */
function liveHandoff(token) {
  try {
    const d = JSON.parse(sessionStorage.getItem(LIVE_KEY) || 'null');
    return d && d.token === token ? d : null;
  } catch { return null; }
}
function saveHandoff(d) { try { sessionStorage.setItem(LIVE_KEY, JSON.stringify(d)); } catch { /* ignore */ } }

function progressLine(p) {
  if (!p) return '';
  const n = Math.min(p.done, p.total);
  return `<p class="r2-pending-progress" data-done="${n}" data-total="${p.total}">${n} of ${p.total} answers in</p>`;
}

function renderPending(root, token, j, prev = null) {
  const st = pendingState(j);
  // Once they've given an email on this page, keep the box hidden even if the next check lags.
  if (prev && prev.hasEmail) st.hasEmail = true;
  if (!st.business && prev && prev.business) st.business = prev.business;
  if (!st.questions.length && prev && prev.questions) st.questions = prev.questions;
  const c = pendingCopy(st.status, st.hasEmail);
  const b = st.business;
  const where = b ? [b.town, b.state].filter(Boolean).join(', ') : '';
  const live = st.status === 'cancelled' ? null : liveHandoff(token);
  // The first question is asked live (below); the list shows the others, numbered on from 2.
  const rest = live && st.questions.length > 1 ? st.questions.slice(1) : st.questions;
  document.title = b ? `AI Found Score — ${b.name}` : 'AI Found Score — your report is on its way';
  root.innerHTML = `
    <div class="wrap page-msg r2-pending" data-status="${escapeHtml(st.status)}">
      ${b ? `<p class="r2-pending-biz">${escapeHtml(b.name)}${where ? ` · ${escapeHtml(where)}` : ''}</p>` : ''}
      ${c.spin ? '<p class="r2-pending-mark" aria-hidden="true"></p>' : ''}
      <h1>${escapeHtml(c.h)}</h1>
      <p>${c.html ? c.p : escapeHtml(c.p)}</p>
      ${st.status === 'running' ? progressLine(st.progress) : ''}
      ${live ? `<section class="r2-live" id="r2-live" aria-live="polite">
        <p class="r2-live-wait" id="r2-live-wait">Asking AI right now: <strong>${escapeHtml(live.question || 'your first question')}</strong></p>
        <div class="r2-live-out" id="r2-live-out" hidden></div>
      </section>` : ''}
      ${rest.length ? `<section class="r2-pending-qs">
        <h2>${live ? `${rest.length} more question${rest.length === 1 ? '' : 's'} in your report` : 'What we\u2019re asking'}</h2>
        <ol class="rq-list" style="counter-reset: rq ${live ? 1 : 0}">${rest.map((q) => `<li>${escapeHtml(q.text)}</li>`).join('')}</ol>
      </section>` : ''}
      ${st.status === 'cancelled' ? '' : `<p class="fine" role="status">This page updates on its own. You can close it and come back to the same link.</p>
      ${st.hasEmail ? '' : leadForm('pending')}`}
    </div>`;
  root.querySelectorAll('form.lead-form').forEach((f) => f.addEventListener('submit', async (e) => {
    if (await submitLead(e, token, { pending: true })) st.hasEmail = true;
  }));
  if (live) mountLive(root, live);
  let tick = 0;
  const check = async () => {
    try {
      const res = await fetch('/api/report/' + encodeURIComponent(token), { cache: 'no-store' });
      if (res.status === 202) {
        const next = pendingState(await res.json().catch(() => ({})));
        // Re-draw only when something shown changes, so a half-typed email isn't wiped.
        const bizChanged = !!next.business && !st.business;
        const qsChanged = next.questions.length > 0 && !st.questions.length;
        const emailNow = next.hasEmail && !st.hasEmail && !root.querySelector('.lead-form input[name="email"]')?.value;
        if (next.status !== st.status || bizChanged || qsChanged || emailNow) {
          renderPending(root, token, { ...next, hasEmail: next.hasEmail || st.hasEmail }, st);
          return;
        }
        // Progress changes in place (no re-draw, no lost focus).
        const line = root.querySelector('.r2-pending-progress');
        if (next.progress && line) { line.textContent = `${Math.min(next.progress.done, next.progress.total)} of ${next.progress.total} answers in`; line.dataset.done = String(next.progress.done); }
        else if (next.progress && !line && st.status === 'running') root.querySelector('h1')?.insertAdjacentHTML('afterend', progressLine(next.progress));
      } else {
        location.reload();
        return;
      }
    } catch { /* offline for a moment: try again next time */ }
    setTimeout(check, PENDING_POLL_MS[tick++] || PENDING_POLL_LAST_MS);
  };
  setTimeout(check, PENDING_POLL_MS[tick++] || PENDING_POLL_LAST_MS);
}

// The live answer on the pending page: one question to one assistant (POST /api/live-preview with
// the token the homepage got after the bot check). The answer is third-party text: it only ever
// goes into the page through textContent. Kept in sessionStorage so a reload shows it again.
// LIVE is the answer's state across re-draws of the pending page (a poll that changes the status
// rebuilds the markup): one POST per token, and the answer is painted into whatever markup is
// there when it lands.
const LIVE = { token: '', status: 'idle', data: null };
function mountLive(root, live) {
  if (LIVE.token !== live.token) Object.assign(LIVE, { token: live.token, status: 'idle', data: null });
  if (LIVE.status !== 'done' && live.answer && typeof live.answer === 'object') Object.assign(LIVE, { status: 'done', data: live.answer });
  if (LIVE.status === 'done') { paintLive(root, live, LIVE.data); return; }
  if (LIVE.status === 'failed') { liveFailed(root); return; }
  if (LIVE.status === 'running') return;
  runLivePreview(root, live);
}
function liveFailed(root) {
  const wait = root.querySelector('#r2-live-wait');
  if (wait) wait.textContent = 'No live answer just now. Every answer is in your report below when it\u2019s ready.';
}
function paintLive(root, live, d) {
  const wait = root.querySelector('#r2-live-wait');
  const out = root.querySelector('#r2-live-out');
  if (!wait || !out) return;
  {
    wait.hidden = true;
    out.hidden = false;
    out.textContent = '';
    const named = document.createElement('p');
    named.className = 'r2-live-named ' + (d.named ? 'yes' : 'no');
    named.textContent = d.named ? 'Your name is in this answer.' : 'We didn\u2019t see your name in this answer. Check it yourself below.';
    const head = document.createElement('p');
    head.className = 'r2-live-head';
    head.textContent = `AI\u2019s answer, word for word \u00b7 ${new Date(d.askedAt || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    const q = document.createElement('p');
    q.className = 'r2-live-q';
    q.textContent = `\u201c${String(d.question || live.question || '')}\u201d`;
    const box = document.createElement('blockquote');
    box.className = 'r2-live-answer';
    const clean = typeof d.display === 'string' && d.display && Array.isArray(d.displayRanges);
    const text = String(clean ? d.display : d.answer);
    const ranges = clean ? d.displayRanges : (Array.isArray(d.ranges) ? d.ranges : []);
    let at = 0;
    for (const r of ranges) {
      const s = Number(r && r[0]); const e = Number(r && r[1]);
      if (!(s >= at && e > s && e <= text.length)) continue;
      if (s > at) box.appendChild(document.createTextNode(text.slice(at, s)));
      const m = document.createElement('mark'); m.textContent = text.slice(s, e); box.appendChild(m);
      at = e;
    }
    if (at < text.length) box.appendChild(document.createTextNode(text.slice(at)));
    const note = document.createElement('p');
    note.className = 'r2-live-note';
    const cites = Array.isArray(d.citations) ? d.citations.map(String) : [];
    note.textContent = `${cites.length ? 'Websites it cited: ' + cites.join(', ') + '. ' : 'It didn\u2019t cite any websites. '}Asked through ${String(d.assistant || 'the assistant')}, with web search on. Answers change from day to day.`;
    out.append(named, head, q, box, note);
  }
}
async function runLivePreview(root, live) {
  if (!live.preview_token || !live.request_id) { LIVE.status = 'failed'; const w = root.querySelector('#r2-live-wait'); if (w) w.hidden = true; return; }
  LIVE.status = 'running';
  try { if (window.dataLayer) window.dataLayer.push({ event: 'live_preview_start' }); } catch { /* ignore */ }
  let d = null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), LIVE_WAIT_MS);
    const res = await fetch('/api/live-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ request_id: live.request_id, question_id: 'q1', token: live.preview_token }),
    });
    clearTimeout(timer);
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok === true && typeof j.answer === 'string' && j.answer) d = j;
  } catch { /* no live answer: the report has every answer */ }
  if (!d) {
    // No live answer (daily cap, every engine down): one calm line, the report has every answer.
    LIVE.status = 'failed';
    liveFailed(root);
    try { if (window.dataLayer) window.dataLayer.push({ event: 'live_preview_failed' }); } catch { /* ignore */ }
    return;
  }
  Object.assign(LIVE, { status: 'done', data: d });
  saveHandoff({ ...live, answer: d });
  paintLive(root, live, d);
  try { if (window.dataLayer) window.dataLayer.push({ event: 'live_preview_answer', named: !!d.named }); } catch { /* ignore */ }
}

// The header button. On a report page "Get my free report" is redundant: it becomes "Check another business".
// The report page's header carries one button, by state (public/report.html): the $49 audit on a real
// report that has the offer, "Get my free report" on an example, nothing otherwise (pending, paid, no
// offer). After the top band scrolls away it also shows the business and score. Phones use the bottom
// bar instead (CSS hides this button there).
function setHeaderForReport(root, report) {
  const cta = document.querySelector('.site-header [data-hdr-cta]');
  const ctx = document.querySelector('.site-header [data-hdr-ctx]');
  const band = root.querySelector('[data-offer-band]');
  if (cta) {
    if (isDemoReport(report)) {
      cta.textContent = 'Get my free report';
      cta.setAttribute('href', '/#request');
      cta.hidden = false;
    } else if (band) {
      cta.textContent = ctaLabel(report);
      cta.setAttribute('href', '#offer');
      cta.hidden = false;
      cta.addEventListener('click', (e) => {
        e.preventDefault();
        band.scrollIntoView({ behavior: 'smooth', block: 'start' });
        band.querySelector('[data-tier]')?.focus({ preventScroll: true });
      });
      if (typeof IntersectionObserver !== 'undefined') {
        new IntersectionObserver((en) => { cta.style.visibility = en[0].isIntersecting ? 'hidden' : ''; }, { threshold: 0.1 }).observe(band);
      }
    } else {
      cta.hidden = true;
    }
  }
  const sc = report.score;
  if (ctx && report.business && sc && Number.isFinite(Number(sc.score))) {
    const n = Math.max(0, Math.min(100, Math.round(Number(sc.score))));
    const band3 = n >= 70 ? 'strong' : n >= 40 ? 'mixed' : 'weak';
    const name = document.createElement('b');
    name.textContent = report.business.name;
    const chip = document.createElement('span');
    chip.className = `chip ${band3}`;
    chip.textContent = `${n} / 100`;
    ctx.replaceChildren(name, chip);
    if (typeof window.addEventListener === 'function') {
      const onScroll = () => { ctx.hidden = !(window.scrollY > 320); };
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }
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

      ${bottomLead(report)}
    </div>`;

}

// Stand-in text for withheld details. It says what's behind the blur, never
// a fake finding, and is hidden from screen readers.
function blurred(text) {
  return `<p class="locked-text" aria-hidden="true">${escapeHtml(text)}</p><p class="locked-note">🔒 In the full report</p>`;
}

// The one paid tier on sale: the $49 AI Visibility Audit (tier key `xray`, kept from its old X-Ray name). The Fix Kit
// comes with it (src/lib/fix-kit.js FIX_KIT_TIERS). Only rendered when tierOn('xray') and the report has at least
// MIN_FIX_ITEMS fixes specific to this business, general advice not counted (the refund promise).
const XRAY = {
  name: 'AI Visibility Audit',
  price: '$49 one-time',
  what: 'We ask all 5 customer questions again on every AI assistant we check, and you get every answer word for word, every website AI cited, exactly what’s wrong on your website and Google listing, every fix step by step with copy-paste text, your Fix Kit (ready-to-install files for whoever runs your website), the competitor gap sheet, your fix checklist, and a free re-scan 30 days later to see what changed.',
  promise: 'Fewer than 3 problems specific to your business? Your money back.',
  button: 'Get my audit — $49',
};

// Teaser under "What to fix": one sentence and a link down to the offer band, the page's one buy button.
function unlockPanel() {
  return `
    <div class="unlock-panel">
      <p><strong>Every problem, by name, with the exact fix.</strong> Step by step, with text you can copy and paste, in the ${XRAY.name}. ${XRAY.promise}</p>
      <a class="btn" href="#offer" data-scroll-offer>Show me the fixes</a>
    </div>`;
}

// Phones only (CSS): a bottom bar that scrolls to the offer band, shown once the reader is past the
// first screen and hidden while the offer band itself is on screen.
function ctaWord(report) {
  const n = Number(report && report.score && report.score.score);
  return Number.isFinite(n) && n >= 70 ? 'See what to improve' : 'Show me the fixes';
}

function ctaLabel(report) {
  return `${ctaWord(report)} — ${XRAY.price.split(' ')[0]}`;
}

function stickyCtaV2(report) {
  return `<div class="r2-sticky" data-sticky-cta hidden><a class="btn ob-btn" href="#offer" data-scroll-offer>${escapeHtml(ctaLabel(report))}</a></div>`;
}

function wireStickyCta(root) {
  const bar = root.querySelector('[data-sticky-cta]');
  const band = root.querySelector('[data-offer-band]');
  if (!bar || !band || typeof IntersectionObserver === 'undefined') return;
  let past = false;
  let inBand = false;
  const sync = () => {
    const show = past && !inBand;
    bar.hidden = !show;
    document.body.classList.toggle('has-sticky', show);
  };
  const onScroll = () => { past = window.scrollY > 500; sync(); };
  new IntersectionObserver((e) => { inBand = e[0].isIntersecting; sync(); }, { threshold: 0.1 }).observe(band);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// "See what the audit includes" and similar links: scroll to the offer band instead of a second checkout.
function wireOfferScroll(root) {
  root.addEventListener('click', (e) => {
    const k = e.target.closest('a[data-scroll-keep]');
    if (k) {
      const box = root.querySelector('#keep');
      if (!box) return;
      e.preventDefault();
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      box.querySelector('input[type=email]')?.focus({ preventScroll: true });
      return;
    }
    const a = e.target.closest('a[data-scroll-offer]');
    if (!a) return;
    const band = root.querySelector('[data-offer-band]');
    if (!band) return;
    e.preventDefault();
    band.scrollIntoView({ behavior: 'smooth', block: 'start' });
    band.querySelector('[data-tier]')?.focus({ preventScroll: true });
  });
}

// ?offer=xray | ?offer=be_the_answer: scroll to that plan's buy button and highlight it. Falls back to
// the offer band when that plan isn't offered on this report. Runs after the tier filters above.
function focusOffer(root, offer) {
  if (offer !== 'xray' && offer !== 'be_the_answer') return;
  const btn = root.querySelector(`[data-tier="${offer}"]`);
  const target = btn ? (btn.closest('[data-offer-band], .r2-upsell') || btn) : root.querySelector('[data-offer-band]');
  if (!target) return;
  if (btn) btn.classList.add('r2-offer-focus');
  requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}

// At most one email box on a ready report, at the bottom: free reports only, and only when the request
// has no email on file yet (hasEmail from the API; the address itself is never sent to the page).
function bottomLead(report) {
  if (report.sample || !report.locked || report.hasEmail) return '';
  return leadForm('bottom');
}

// Trust row next to every buy button. Only claims that are true of every checkout: Stripe's hosted
// page takes the card (we never see it), the plan's own money-back promise, a one-time payment with no
// renewal (src/lib/checkout.js mode=payment), and public data only. Card brands are Stripe's defaults.
const ICON = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  once: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
};
function trustRow({ promise, once = 'One-time payment. No subscription.', next = [] } = {}) {
  return `
      <ul class="trust-row">
        <li>${ICON.lock}Secure checkout by Stripe</li>
        <li>${ICON.shield}${escapeHtml(promise)}</li>
        <li>${ICON.once}${escapeHtml(once)}</li>
        <li>${ICON.key}No logins, ever</li>
      </ul>
      <p class="trust-cards" aria-label="Cards accepted"><span>VISA</span><span>MASTERCARD</span><span>AMEX</span><span>DISCOVER</span></p>
      ${next.length ? `<ol class="trust-next" aria-label="What happens after you pay">${next.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>` : ''}
      <p class="trust-foot">We never see your card. Questions first? <a href="mailto:hello@aifoundscore.com">hello@aifoundscore.com</a> · <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></p>`;
}

// The offer band. `lead` is an optional first sentence (edge states: named everywhere, nothing missing).
function xrayOffer(lead = '', { breakdown = true } = {}) {
  // The $25 Competitor Breakdown rides along as a checkbox (config.js wireCheckout sends ticked add-ons),
  // only when someone was named often enough to compare (checkout refuses it otherwise).
  const addon = breakdown && tierOn('competitor_breakdown')
    ? '<p class="r2-addon"><label><input type="checkbox" data-addon="competitor_breakdown"> Add the Competitor Breakdown, +$25: a scorecard of what the top 3 businesses AI picks over you have that you don’t, and what to copy first.</label></p>'
    : '';
  return `
    <div class="cta-band r2-xray-offer" id="offer" data-offer-band>
      <h2>${XRAY.name} — ${XRAY.price}.</h2>
      <p>${lead ? `${lead} ` : ''}${XRAY.what} ${XRAY.promise}</p>
      ${addon}
      <p><a class="btn big" data-tier="xray" href="#">${XRAY.button}</a></p>
      ${trustRow({
        promise: 'Money back if we find fewer than 3 problems',
        next: [
          'Pay on Stripe’s secure page.',
          'Your report unlocks right away: every answer, every fix, your Fix Kit.',
          'We ask every AI assistant again and email you when it’s done.',
          'In 30 days we re-scan for free and show you what changed.',
        ],
      })}
    </div>`;
}

// Be the Answer, offered on every paid report that isn't on the plan (the 30-day re-check is the
// moment it lands best). Checkout prices it at $499 minus what this report has already paid.
function recheckOffer(report) {
  const subject = encodeURIComponent('Be the Answer: ' + (report.business?.name || ''));
  return `
    <div class="r2-upsell">
      <p><strong>Want us to keep watching?</strong> Be the Answer ($499): a re-scan every month for a year in up to 3 towns you serve, an email each month with what changed and your next 3 fixes, an alert when a new competitor takes the top spot, the Competitor Breakdown, your directory checklist and 12 Google posts. Everything you’ve paid us counts toward it.</p>
      ${tierOn('be_the_answer')
        ? `<a class="btn-secondary" data-tier="be_the_answer" href="#">Get Be the Answer</a> <span class="r2-muted">Checkout shows your price after credit.</span>${trustRow({ promise: 'Full refund in the first 60 days', once: 'One payment for the year. No auto-renew.' })}`
        : `<a class="btn-secondary" href="mailto:hello@aifoundscore.com?subject=${subject}">Tell me when it opens</a>`}
    </div>`;
}

// The Fix Kit comes with every paid audit (src/lib/fix-kit.js FIX_KIT_TIERS): the owner confirms
// their details on /fix-kit/<token> and downloads the files. Only on paid reports.
function fixKitIncluded(report) {
  // A Be the Answer town report shares its plan's Fix Kit.
  const kitUrl = '/fix-kit/' + encodeURIComponent(String((report.plan && report.plan.token) || report.id || ''));
  return `
    <div class="cta-band r2-xray-offer">
      <h2>Your Fix Kit is included.</h2>
      <p>You check your business details, and we build the files for you: robots.txt, llms.txt, schema code, an FAQ page, your Google profile text and a review QR code, with a one-page guide for whoever runs your website.</p>
      <p><a class="btn big" href="${kitUrl}">Get my Fix Kit</a></p>
    </div>`;
}

// The paid report's first section: every fix as one ordered checklist, biggest impact first
// (shared/action-plan.js, built by the Worker and sent only when paid). Each step says why it
// matters and who does it; "How to do it" holds the steps and the text to paste. Ticks and the
// progress count are saved in this browser. The Fix Kit link sits at the top: it's already paid for.
const AP_IMPACT = { high: 'Biggest impact', medium: 'Next', low: 'Quick extra' };
const AP_WHO = { you: 'You can do this', web: 'For whoever runs your website', both: 'You, with your web person' };
function actionPlanV2(report) {
  const plan = report.xray && report.xray.actionPlan;
  const items = ((plan && plan.items) || []).filter((i) => i && i.title && i.id);
  if (!items.length) return '';
  const name = (report.business && report.business.name) || 'your business';
  const key = 'afs_plan_' + String(report.id || '');
  let ticked = {};
  try { ticked = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { ticked = {}; }
  const done = items.filter((i) => ticked[i.id]).length;
  const firstOpen = items.findIndex((i) => !ticked[i.id]);
  const pct = (n) => Math.round((100 * n) / items.length);
  const kitUrl = '/fix-kit/' + encodeURIComponent(String((report.plan && report.plan.token) || report.id || ''));
  const kit = isDemoReport(report) ? '' : `
      <div class="ap-kit">
        <p><strong>Your Fix Kit is ready, and it’s included.</strong> Confirm your details once and we build the files several steps below ask for (FAQ code, business code, llms.txt, your Google text), with a one-page guide for whoever runs your website.</p>
        <a class="btn" href="${kitUrl}">Open my Fix Kit</a>
      </div>`;
  const sites = (list) => ((list || []).length ? `
          <ul class="ap-sites">${list.map((s) => `<li><span class="badge ${s.status === 'missing' ? 'mismatch' : 'low'}">${s.status === 'missing' ? 'Not on it' : 'Check'}</span>${s.type === 'award' ? ' <span class="ap-type">Industry list</span>' : ''} <a href="${safeHref(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(s.domain)}</a>${(s.engines || []).length ? ` <span class="r2-muted">read by ${escapeHtml(listJoin(s.engines))}</span>` : ''}</li>`).join('')}</ul>` : '');
  // Wired once the page is in the DOM: save a tick, strike the step through, update the count.
  setTimeout(() => {
    const root = typeof document.getElementById === 'function' ? document.getElementById('action-plan') : null;
    if (!root) return;
    root.querySelectorAll('input[data-ap]').forEach((box) => box.addEventListener('change', () => {
      let cur = {};
      try { cur = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { cur = {}; }
      cur[box.dataset.ap] = box.checked;
      try { localStorage.setItem(key, JSON.stringify(cur)); } catch { /* storage blocked: ticks just don't persist */ }
      const li = box.closest('li');
      if (li) li.classList.toggle('done', box.checked);
      const n = root.querySelectorAll('input[data-ap]:checked').length;
      const out = root.querySelector('[data-ap-count]');
      if (out) out.textContent = String(n);
      const bar = root.querySelector('.ap-bar i');
      if (bar) bar.style.width = `${pct(n)}%`;
    }));
  }, 0);
  return `
    <section class="report-section ap" id="action-plan" aria-label="Your action plan">
      <h2>Your action plan</h2>
      <p class="sub">${items.length} ${plural(items.length, 'step', 'steps')} to get ${escapeHtml(name)} named by AI, biggest impact first. Do them in order and tick each one off.</p>
      <div class="ap-progress"><span><b data-ap-count>${done}</b> of ${items.length} done</span><div class="ap-bar" aria-hidden="true"><i style="width:${pct(done)}%"></i></div></div>
      ${kit}
      <ol class="ap-list">${items.map((i, n) => `
        <li class="ap-item${ticked[i.id] ? ' done' : ''}" id="step-${n + 1}">
          <div class="ap-head">
            <label class="ap-tick"><input type="checkbox" data-ap="${escapeHtml(i.id)}"${ticked[i.id] ? ' checked' : ''} aria-label="Step ${n + 1} done"></label>
            <div class="ap-main">
              <div class="ap-meta"><span class="ap-num">Step ${n + 1}</span><span class="badge ${escapeHtml(i.impact)}">${escapeHtml(AP_IMPACT[i.impact] || AP_IMPACT.medium)}</span><span class="ap-who">${escapeHtml(AP_WHO[i.who] || AP_WHO.you)}</span></div>
              <h3>${escapeHtml(i.title)}</h3>
              ${i.why ? `<p class="ap-why"><b>Why it matters:</b> ${escapeHtml(i.why)}</p>` : ''}
            </div>
          </div>
          ${sites(i.sites)}
          <details class="ap-how"${n === firstOpen ? ' open' : ''}>
            <summary>How to do it</summary>
            ${(i.steps || []).length ? `<ol class="r2-steps">${i.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}
            ${copyBlocksV2(i.copyText)}
          </details>
        </li>`).join('')}
      </ol>
      <p class="r2-muted ap-foot">Below this plan: the evidence behind it (what AI said, who it named, and what we found on your website).</p>
    </section>`;
}

// Be the Answer: this report is on a plan. Link to the plan page (towns, directory checklist, Google posts).
function planPanel(report) {
  const url = '/plan/' + encodeURIComponent(String(report.plan.token || ''));
  return `
    <div class="r2-upsell">
      <p><strong>${report.plan.town ? 'This town is part of your Be the Answer plan.' : 'You’re on Be the Answer.'}</strong> We re-scan every month and email you what changed, with your next 3 fixes. Your towns, directory checklist and Google posts are on your plan page.</p>
      <a class="btn-secondary" href="${url}">Open my plan</a>
    </div>`;
}

// Real reports linked from the public pages as examples ("See a real report"): never sold from.
// Same list as SHOWCASE_TOKENS in src/lib/checkout.js (the server refuses checkout for these too).
const SHOWCASE_TOKENS = ['mega-wash-and-dry', 'vbeonkpiYROpBEiAi74kVQ'];
// The sample reports a visitor can switch between (href is the readable link; SHOWCASE_ALIASES there).
const SAMPLE_REPORTS = [
  { id: 'mega-wash-and-dry', name: 'Mega Wash & Dry', kind: 'Laundromat', href: '/report/mega-wash-and-dry' },
  { id: 'vbeonkpiYROpBEiAi74kVQ', name: 'Glenn Wayne Bakery', kind: 'Bakery', href: '/report/glenn-wayne-bakery' },
];
function samplesStrip(report) {
  if (!SHOWCASE_TOKENS.includes(String(report.id || ''))) return '';
  const tabs = SAMPLE_REPORTS.map((r) => r.id === report.id
    ? `<span class="sample-tab on" aria-current="page">${escapeHtml(r.name)} <small>${escapeHtml(r.kind)}</small></span>`
    : `<a class="sample-tab" href="${r.href}">${escapeHtml(r.name)} <small>${escapeHtml(r.kind)}</small></a>`).join('');
  return `<nav class="sample-switch" aria-label="Sample reports"><span class="sample-switch-k">Real sample reports, shown with each owner&rsquo;s permission:</span>${tabs}</nav>`;
}
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

// The one email box on a page. 'pending': the report is still being made, so the email goes on the
// request and the "report ready" email reaches it (POST /api/lead attaches it; nothing is sent now).
// 'bottom': the bottom of a free report, "keep a copy" (the report link by email).
function leadForm(where) {
  const pending = where === 'pending';
  return `
    <form class="lead-form" data-where="${where}" novalidate>
      <label for="lead-email-${where}">${pending ? 'Email me when it’s ready' : where === 'strip' ? 'Not ready? We’ll email you this report so you can come back to it.' : 'Not ready? Keep a copy.'}</label>
      <div class="lead-row">
        <input id="lead-email-${where}" name="email" type="email" required autocomplete="email" placeholder="you@yourbusiness.com">
        <input class="hp" name="company_url" tabindex="-1" autocomplete="off" aria-hidden="true">
        <button class="btn-secondary" type="submit">${pending ? 'Email me' : 'Email me this report'}</button>
      </div>
      <p class="lead-status" role="status"></p>
    </form>`;
}

// → true once saved.
async function submitLead(e, token, { pending = false } = {}) {
  e.preventDefault();
  const f = e.currentTarget;
  const status = f.querySelector('.lead-status');
  const btn = f.querySelector('button');
  const email = f.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    status.textContent = 'Please enter a valid email.';
    status.className = 'lead-status error';
    return false;
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
    status.textContent = pending || data.attached
      ? `Done. We’ll email ${email} when your report is ready.`
      : `Done. We’ll send the link to ${email}.`;
    status.className = 'lead-status ok';
    f.querySelector('.lead-row').hidden = true;
    f.querySelector('label')?.setAttribute('hidden', '');
    // Never the report token: it is the private link to the report. email_token is the cold-email key.
    window.dataLayer?.push({ event: 'generate_lead', email_token: window.afsEmailToken?.() });
    return true;
  } catch (err) {
    status.textContent = err.message;
    status.className = 'lead-status error';
    btn.disabled = false;
    return false;
  }
}

// Render only the listing fields that have a value. Empty fields are dropped, never guessed.
function fields(f) {
  const rows = [['Name', f?.name], ['Phone', f?.phone], ['Address', f?.address], ['Hours', f?.hours]]
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
// Mirror of MIN_FIX_ITEMS in shared/report-v2.js: the $49 audit is offered only with this many fixes
// specific to the business (isGenericFix there: baseline_* kinds, or `generic` on a locked report).
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

// A trade is stored as the work ("plumbing"); this is the businesses that do it ("plumbers").
const TRADE_PEOPLE = { plumbing: 'plumbers', roofing: 'roofers', painting: 'painters', landscaping: 'landscapers', cleaning: 'cleaners', moving: 'movers', electrical: 'electricians', electric: 'electricians' };

function tradePlural(trade) {
  const t = String(trade || 'business').toLowerCase();
  if (TRADE_PEOPLE[t]) return TRADE_PEOPLE[t];
  if (/(s|sh|ch|x)$/.test(t)) return t + 'es';
  if (/[^aeiou]y$/.test(t)) return t.slice(0, -1) + 'ies';
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
// A directory or "top firms" list AI listed as if it were a business ("Clutch"): never a competitor.
// Same list as DIRECTORY_NAME_RE in shared/report-v2.js.
const DIRECTORY_NAME_RE = /^(?:the\s+)?(?:clutch(?:\.co)?|manifest|yelp|angi(?:'?s list)?|angie'?s list|thumbtack|bbb|better business bureau|homeadvisor|upcity|designrush|goodfirms|expertise(?:\.com)?|sortlist|agency spotter|o'?dwyer'?s?|prweek|provoke(?: media)?|google(?: maps)?|nextdoor|tripadvisor|yellow ?pages|houzz|porch|avvo|justia|martindale(?:-hubbell)?|findlaw|healthgrades|zocdoc)$/i;
function provenEntities(report) {
  return (report.entities || [])
    .filter((e) => !e.isYou && !DIRECTORY_NAME_RE.test(String(e.name || '').trim().replace(/[.,]+$/, '')) && (e.answerIds || []).length >= 2 && e.named >= 2)
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
  // A locked report's fixes are untitled stand-ins (src/lib/lock.js): still counted.
  const severity = { high: 0, medium: 0, low: 0 };
  for (const i of issues) if (i && (i.title || i.locked) && i.severity in severity) severity[i.severity]++;
  const specificFixCount = issues.filter((i) => i && (i.title || i.locked) && !(i.generic === true || /^baseline_/.test(String(i.kind || '')))).length;
  // The $49 audit is offered only on a locked report with at least MIN_FIX_ITEMS fixes specific to
  // this business (the refund promise; same rule as xrayOffered() in shared/report-v2.js).
  const xrayOk = locked && !paid && specificFixCount >= MIN_FIX_ITEMS && tierOn('xray');
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
  const intentLabel = (x) => INTENT_LABELS[x.intent] || x.intent || x.q.text;

  // Edge states (docs/BUILD_PLAN.md "Edge states").
  const unsureN = answers.filter((a) => a.ownerMatch === 'unsure').length;
  const zero = N > 0 && t.namedYou === 0 && unsureN < N;
  const allNamed = N > 0 && t.namedYou === N;
  const nobodyTwice = proven.length === 0;
  // Same rule as edgeState() in shared/report-v2.js.
  const missingSources = (report.sources || []).filter((s) => s.youListed === false);
  const missingCount = report.sourcesSummary ? num(report.sourcesSummary.missingYou) : missingSources.length;

  const sec = {
    verdict: verdictV2(report, { t, N, cw, proven, zero, allNamed, b, engineList }),
    hero: heroV2(report, { answers, aById, qById, t, cw, engineList, proven, provenIds, zero, b }),
    baseline: baselineV2(report, t),
    plan: report.plan ? planPanel(report) : '',
    recheck: paid && !report.plan && !isDemoReport(report) ? recheckOffer(report) : '',
    strip: offerStripV2({ report, severity, xrayOk, count: issues.length }),
    who: nobodyTwice ? '' : whoAiNamesV2({ report, b, t, N, cw, proven }),
    sources: sourcesV2({ report, b, aById, lostAnswerIds, ownDomain, cw }),
    facts: factsV2({ report, b, aById }),
    site: siteV2(report),
    listings: listingsV2({ listings, badListings }),
    issues: issuesV2({ issues, locked, xrayOk, name: b.name, specificCount: specificFixCount, where: xrayOk ? fixWhereV2({ report, b }) : '' }),
    xray: xrayV2({ report, aById, cw, N }),
    breakdown: report.breakdown ? breakdownV2(report) : '',
    fixkit: paid && !isDemoReport(report) ? fixKitIncluded(report) : '',
    offer: offerV2({ report, b, aById, t, N, zero, lostIntents, intentLabel, proven, badListings, missingCount, severity, specificFixCount, xrayOk, hasCompetitors: !nobodyTwice }),
    answers: answersV2({ questions, answers, failedNote }),
    method: methodV2({ report, method, engines, failed, questions, N, cw, listings }),
  };
  // A free report with the offer is a sales page: the result, who took the calls, and the offer come first,
  // the reference material (listings, every answer) after the buy button. Everything else keeps the
  // findings-first order.
  // A paid report with an action plan is a to-do list: the score, then the plan (which replaces the
  // fix list, the checklist and the Fix Kit band), then the evidence, and anything for sale last.
  // Sample reports show it too: they show a buyer exactly what the audit gives them.
  const hasPlan = !locked && !!(report.xray && report.xray.actionPlan && (report.xray.actionPlan.items || []).length);
  sec.actionPlan = hasPlan ? actionPlanV2(report) : '';
  sec.breakdownUpsell = hasPlan ? breakdownUpsell(report) : '';
  const order = xrayOk
    ? ['verdict', 'who', 'strip', 'hero', 'baseline', 'plan', 'recheck', 'facts', 'issues', 'xray', 'breakdown', 'fixkit', 'offer', 'answers', 'method']
    : hasPlan
      ? ['verdict', 'baseline', 'plan', 'actionPlan', 'hero', 'who', 'xray', 'breakdown', 'sources', 'site', 'listings', 'facts', 'answers', 'method', 'breakdownUpsell', 'recheck', 'offer']
      : ['verdict', 'hero', 'baseline', 'plan', 'recheck', 'who', 'sources', 'facts', 'site', 'listings', 'issues', 'xray', 'breakdown', 'fixkit', 'offer', 'answers', 'method'];

  root.innerHTML = [
    headerV2(report, b, scoreV2(report)),
    '<div class="wrap r2">',
    report.fullScanPending ? fullScanNote() : '',
    ...order.map((k) => sec[k]),
    xrayOk ? '' : bottomLead(report),
    reportTools(),
    xrayOk ? stickyCtaV2(report) : '',
    '</div>',
  ].join('');

  // Grid marks (and "read the answer" links) open their answer in section 10.
  root.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-open]');
    if (!link) return;
    const d = document.getElementById('ans-' + link.dataset.open);
    if (!d) return;
    e.preventDefault();
    openAnswer(d);
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try { history.replaceState(null, '', '#ans-' + link.dataset.open); } catch {}
  });
  const hash = location.hash.match(/^#ans-(.+)$/);
  if (hash) {
    const d = document.getElementById('ans-' + hash[1]);
    if (d) { openAnswer(d); d.scrollIntoView({ block: 'start' }); }
  }
}

function headerV2(report, b, scoreHtml = '') {
  return `
    <section class="report-header r2-band">
      <div class="wrap r2">
        ${report.sample ? '<div class="sample-banner"><strong>Sample report.</strong> A fictional business, fictional competitors and made-up answers. Yours shows your real searches, word for word.</div>' : ''}
        ${samplesStrip(report)}
        <div class="r2-band-grid${scoreHtml ? '' : ' noscore'}">
          <div class="r2-band-id">
            <p class="r2-band-k">AI Found Score report for</p>
            <h1>${escapeHtml(b.name)}</h1>
            <p class="fine">Checked ${escapeHtml(fmtDate(report.generatedAt))}</p>
          </div>
          ${scoreHtml}
        </div>
      </div>
    </section>`;
}

// Paid, and the full scan (every question, every assistant we have) is still running.
function fullScanNote() {
  return `
    <div class="r2-note r2-fullscan" role="status">
      <strong>Your full audit is on its way.</strong> We’re asking all 5 customer questions on every AI assistant we check.
      This page fills in with the new answers as they come back. Everything below is already yours.
    </div>`;
}

// 1. Hero: one real search, and who it named, in the order AI named them.
const HERO_ROWS = 3;
function heroV2(report, { answers, aById, qById, t, cw, engineList, proven, provenIds, zero, b }) {
  const h = aById[report.headline?.answerId] || answers[0];
  if (!h) return '';
  const q = qById[h.questionId] || { text: '' };
  const named = [...(h.businessesNamed || [])].sort((x, y) => num(x.pos) - num(y.pos));
  const youAt = named.findIndex(isYouNamed);
  const youKnown = youAt >= 0 || h.namedYou === true;
  const cut = youAt >= HERO_ROWS ? HERO_ROWS - 1 : HERO_ROWS; // the owner's own row is always shown
  const shownNames = named.slice(0, cut);
  const li = (n, i) => `<li${isYouNamed(n) ? ' class="me"' : ''}><span class="pos">${i + 1}</span><span class="nm">${escapeHtml(n.name)}${isYouNamed(n) ? ' (you)' : ''}</span></li>`;
  const rows = shownNames.map(li);
  if (youAt >= cut) rows.push(li(named[youAt], youAt));
  const hidden = named.length - shownNames.length - (youAt >= cut ? 1 : 0);
  if (hidden > 0) rows.push(`<li class="more"><span class="pos">…</span><span class="nm">and ${hidden} more</span></li>`);
  if (youAt < 0 && h.namedYou === true) rows.push(`<li class="me"><span class="pos">✓</span><span class="nm">${escapeHtml(b.name)} (you)</span></li>`);
  if (!youKnown) {
    rows.push(h.ownerMatch === 'unsure'
      ? `<li class="unsure"><span class="pos">?</span><span class="nm">${escapeHtml(b.name)}<em>We couldn’t tell</em></span></li>`
      : `<li class="not"><span class="pos">✕</span><span class="nm">${escapeHtml(b.name)}<em>Not mentioned</em></span></li>`);
  }
  const eng = escapeHtml(engineName(h.engine));
  const head = h.namedYou
    ? (h.namedYouFirst ? `${eng} mentioned you first:` : `${eng} mentioned you, but not first:`)
    : !named.length
      ? (h.ownerMatch === 'unsure' ? `We couldn’t tell whether ${eng} mentioned you.` : `${eng} didn’t recommend any business.`)
      : `${eng} recommended:`;
  return `
    <div class="r2-hero">
      <div class="k">What ${eng} told a customer who asked</div>
      <div class="q">“${escapeHtml(q.text)}”</div>
      <p class="a">${head}</p>
      <ol class="r2-hero-list">${rows.join('')}</ol>
      <p class="r2-hero-read"><a href="#ans-${escapeHtml(h.id)}" data-open="${escapeHtml(h.id)}">Read the whole answer</a></p>
    </div>`;
}

// "6 times" / "once": how often we asked.
function N_TIMES(n) { return n === 1 ? '1 time' : `${n} times`; }

// The 5-second answer, first on the page: one literal verdict line next to the AI Found Score.
// "Named" is a literal name match in the answer text, so the line only says what the answers did.
// The top competitor is the most-named business with proof (named in 2+ answers, provenEntities).
function verdictV2(report, { t, N, cw, proven, zero, allNamed, b = {}, engineList = '' }) {
  if (!N) return '';
  const asked = N === 1 ? 'We asked AI once.' : `We asked AI ${N} times.`;
  const answers = report.answers || [];
  const allUnsure = answers.length > 0 && answers.every((a) => a.ownerMatch === 'unsure');
  const unsureSome = answers.filter((a) => a.ownerMatch === 'unsure').length;
  const you = allUnsure
    ? `${asked} We couldn’t tell whether it mentioned you.`
    : zero
      ? (unsureSome
        ? `${asked} It didn’t mention you in ${N - unsureSome}, and we couldn’t tell in ${unsureSome}.`
        : `${asked} It never mentioned you.`)
      : allNamed
        ? `${asked} It mentioned you every time.`
        : `${asked} It mentioned you ${t.namedYou === 1 ? 'once' : `${t.namedYou} times`}.`;
  const top = proven[0];
  const them = top && num(top.named) > 0 && !allNamed
    ? ` <span class="r2-rival">${escapeHtml(top.name)}</span> came up ${num(top.named) === 1 ? 'once' : `${num(top.named)} times`}.`
    : '';
  const state = zero ? 'zero' : allNamed ? 'all' : 'some';
  const boxes = answers.map((a) => (a.ownerMatch === 'unsure'
    ? '<i class="unsure" title="Not sure">?</i>'
    : a.namedYou ? '<i class="yes" title="Mentioned you">✓</i>' : '<i class="no" title="Did not mention you">✕</i>')).join('');
  const where = b.town || b.city ? ` near ${escapeHtml(b.town || b.city)}` : '';
  const ask = engineList ? `<p class="r2-verdict-ask">We asked ${escapeHtml(engineList)} for ${escapeHtml(tradePlural(b.trade))}${where}.</p>` : '';
  return `
    <section class="r2-verdict ${state}" aria-label="Your result">
      <div class="r2-verdict-main">
        <p class="r2-verdict-k">Your result</p>
        <p class="r2-verdict-line">${you}${them}</p>
        ${ask}
        <div class="r2-boxes" role="img" aria-label="${N_TIMES(N)} we asked: ${t.namedYou} mentioned you">${boxes}</div>
        <p class="r2-verdict-key">One box per answer: <b class="y">✓ mentioned you</b> <b class="n">✕ didn’t</b>${allUnsure || answers.some((a) => a.ownerMatch === 'unsure') ? ' <b class="u">? not sure</b>' : ''}</p>
      </div>
    </section>`;
}

// The AI Found Score: computed by the Worker from this report's own answers
// (shared/report-v2.js computeVisibilityScore). Shown in the verdict; the weights sit behind "How we score".
function scoreV2(report) {
  const sc = report.score;
  if (!sc || !Array.isArray(sc.parts) || !Number.isFinite(Number(sc.score))) return '';
  const n = Math.max(0, Math.min(100, Math.round(Number(sc.score))));
  const band = n >= 70 ? 'strong' : n >= 40 ? 'mixed' : 'weak';
  const pill = { strong: 'Strong', mixed: 'Fair', weak: 'Low' }[band];
  const bandText = { strong: 'AI recommends you often.', mixed: 'AI recommends you sometimes.', weak: 'AI almost never recommends you.' }[band];
  const rows = sc.parts.map((p) => `
        <li><span class="k">${escapeHtml(p.label)}</span><span class="v">${escapeHtml(p.detail)}</span><span class="w">${num(Math.round(p.weight * p.value))} / ${num(p.weight)}</span></li>`).join('');
  return `
    <div class="r2-score ${band}" role="group" aria-label="AI Found Score ${n} out of 100, ${pill}">
      <p class="r2-sc-k">Your AI Found Score</p>
      <p class="r2-sc-num"><b>${n}</b><span>/100</span><em class="r2-sc-pill">${pill}</em></p>
      <div class="r2-sc-meter" style="--n:${n}" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="r2-sc-scale" aria-hidden="true"><span>Low</span><span>Fair</span><span>Strong</span></div>
      <p class="r2-sc-verdict">${bandText}</p>
      <details class="r2-score-how">
        <summary>How we score</summary>
        <p class="r2-score-note">Our own 0 to 100 measure, not a rating from any AI company.</p>
        <ul class="r2-score-parts">${rows}
        </ul>
        <p class="r2-score-note">Computed only from the answers in this report. A part we couldn&rsquo;t check is left out and the rest are scaled to 100. AI answers change, so the score can too.</p>
      </details>
    </div>`;
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

// A slim offer right under the result, so a reader who is convinced doesn't have to scroll to the
// offer band. Only where the offer band exists (xrayOk); the promise is the real one (XRAY.promise).
function offerStripV2({ report, severity, xrayOk, count }) {
  if (!xrayOk || !count) return '';
  const first = num(severity && severity.high);
  // Not ready to buy? Same email box as the bottom of the offer, one screen from the top.
  const lead = !report.sample && !report.hasEmail ? `<div class="r2-strip-lead" id="keep-top">${leadForm('strip')}</div>` : '';
  return `
    <aside class="r2-strip" aria-label="Get the fixes">
      <div class="r2-strip-main">
        <div class="r2-strip-t">
          <b>${count} ${plural(count, 'problem', 'problems')} found${first ? `, ${first} to fix first.` : '.'}</b>
          <span>${escapeHtml(XRAY.promise)}</span>
        </div>
        <a class="btn" href="#offer" data-scroll-offer>${escapeHtml(ctaLabel(report))}</a>
      </div>
      ${lead}
    </aside>`;
}

// 3. Who AI names: businesses named in 2+ answers. Owner always shown.
function whoAiNamesV2({ report, b, t, N, cw, proven }) {
  const pct = (n) => (N ? Math.round((n / N) * 1000) / 10 : 0);
  const row = (name, named, first, you) => `
    <div class="r2-row${you ? ' you' : ''}${you && !named ? ' none' : ''}">
      <span class="nm">${escapeHtml(name)}${you ? ' (you)' : ''}</span>
      <span class="c">${named} ${plural(named, 'mention', 'mentions')}${first ? ` · ${first} first` : ''}</span>
      <div class="t" aria-hidden="true"><i class="first" style="width:${pct(first)}%"></i><i class="named" style="width:${pct(named - first)}%"></i></div>
    </div>`;
  // Businesses named only once are left out of the bars (a one-off may be noise) but still counted.
  const provenIds = new Set(proven.map((e) => e.id));
  const once = (report.entities || []).filter((e) => !e.isYou && !provenIds.has(e.id)).length;
  return `
    <section class="report-section" id="who">
      <h2>Who got the call instead</h2>
      <p class="sub">Businesses AI recommended more than once. The dark part of each bar is how often it was the first pick.</p>
      <div class="r2-bars">
        ${row(b.name, t.namedYou, t.firstYou, true)}
        ${proven.map((e) => row(e.name, num(e.named), num(e.first), false)).join('')}
      </div>
      ${once ? `<p class="r2-once">+ ${once} other ${plural(once, 'business', 'businesses')} named once each.</p>` : ''}
    </section>`;
}

// Opens an answer and any closed group around it, so links to an answer always land on something visible.
function openAnswer(d) {
  for (let p = d; p; p = p.parentElement) if (p.tagName === 'DETAILS') p.open = true;
}

function markFor(a) {
  if (a.ownerMatch === 'unsure' && !a.namedYou) return { cls: 'u', txt: '?', label: 'Unsure, not counted' };
  if (a.namedYouFirst) return { cls: 'y', txt: '✓★', label: 'Named you first' };
  if (a.namedYou) return { cls: 'y', txt: '✓', label: 'Named you' };
  return { cls: 'x', txt: '✗', label: 'Didn’t name you' };
}

// 4. Every search: question × engine; each run is a mark that opens its answer.
function shortUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, ''); } catch { return String(u || ''); }
}

function safeHref(u) {
  return /^https?:\/\//i.test(String(u || '')) ? escapeHtml(u) : '#';
}

// 5. Why they got named instead: sources cited in answers the owner lost.
// The sites cited in answers a locked report still shows in full (the headline answer keeps its citations).
function citedDomainsV2(answers, ownDomain) {
  const seen = new Set();
  const engs = new Set();
  const domains = [];
  for (const a of answers || []) {
    for (const c of a.citations || []) {
      const d = String((c && c.domain) || '').replace(/^www\./, '').toLowerCase();
      if (!d || d === ownDomain || seen.has(d)) continue;
      seen.add(d);
      engs.add(a.engine);
      domains.push(d);
    }
  }
  if (!domains.length) return '';
  const label = engs.size === 1 ? `Websites ${engineName([...engs][0])} used in the answer above` : 'Websites used in the answers above';
  return `
      <p class="r2-cited-k">${escapeHtml(label)}</p>
      <ul class="r2-cited">${domains.slice(0, 4).map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`;
}

function sourcesV2({ report, b, aById, lostAnswerIds, ownDomain, cw }) {
  // Locked: the cited sites are the audit's; only the tally is sent (src/lib/lock.js).
  const sum = report.sourcesSummary;
  if (report.locked && sum) {
    if (!num(sum.cited)) return '';
    return `
    <section class="report-section">
      <h2>Why they got named instead</h2>
      <p class="sub">AI used ${num(sum.cited)} ${plural(num(sum.cited), 'website', 'websites')} to build the answers that didn’t mention you.${num(sum.missingYou) ? ` <strong>${num(sum.missingYou)} of them list other ${escapeHtml(tradePlural(b.trade))} and not you.</strong>` : ''}</p>
      ${citedDomainsV2(report.answers, ownDomain)}
      <div class="listing-card">${blurred('Which sites leave you out, who each lists first, and the link to each.')}</div>
    </section>`;
  }
  const order = (s) => (s.youListed === false ? 0 : s.youListed == null ? 1 : 2);
  const list = (report.sources || [])
    .map((s) => ({ ...s, lostIn: (s.citedIn || []).filter((id) => lostAnswerIds.has(id)) }))
    .filter((s) => s.lostIn.length && s.domain !== ownDomain)
    .sort((a, c) => order(a) - order(c) || c.lostIn.length - a.lostIn.length);
  if (!list.length) return '';
  const card = (s) => {
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
  };
  // With an action plan, the sites we couldn't read sit behind one line: the plan's "lists" step
  // already names the ones worth checking.
  const folded = !!(report.xray && report.xray.actionPlan) ? list.filter((s) => s.youListed == null) : [];
  const shown = list.filter((s) => !folded.includes(s));
  return `
    <section class="report-section">
      <h2>Why they got named instead</h2>
      <p class="sub">The sites the AI cited in the ${cw.unit} that didn’t name you, and whether you’re on them.</p>
      ${shown.map(card).join('')}
      ${folded.length ? `<details class="r2-fold"><summary>${num(folded.length)} ${plural(folded.length, 'site', 'sites')} AI cited that we couldn’t read for listings</summary>${folded.map(card).join('')}</details>` : ''}
    </section>`;
}

// A locked report's listing check as one line inside the website section: which listing, that it doesn't match.
function listingLineV2(listings) {
  const bad = (listings || []).filter((l) => l && l.status === 'mismatch');
  if (!bad.length) return '';
  const names = listJoin(bad.map((l) => escapeHtml(l.platform || 'A')));
  return `<p class="r2-site-listing"><span aria-hidden="true">✗</span> Your ${names} ${plural(bad.length, 'listing doesn’t', 'listings don’t')} match your website, or we couldn’t find ${plural(bad.length, 'it', 'them')}. When sources disagree, AI can repeat the wrong details.</p>`;
}

// Where the problems are, on a free report with the offer: up to three short lines under the severity tiles.
// Nothing here is withheld data: a tally, a pass/fail count, a listing platform and its status.
function fixWhereV2({ report, b }) {
  const rows = [];
  const sc = report.siteCheck;
  if (sc && sc.url && sc.locked) {
    const failedN = Math.max(0, num(sc.checks) - num(sc.passed));
    if (!sc.reachable) rows.push('<b>Your website:</b> we couldn’t load it, and AI can’t read a site that doesn’t load.');
    else if (failedN) rows.push(`<b>Your website:</b> ${failedN} of ${num(sc.checks)} checks failed, so it’s harder for AI to read.`);
  }
  const bad = (report.listings || []).filter((l) => l && l.status === 'mismatch');
  if (bad.length) rows.push(`<b>Your ${listJoin(bad.map((l) => escapeHtml(l.platform || 'A')))} ${plural(bad.length, 'listing', 'listings')}:</b> ${plural(bad.length, 'doesn’t', 'don’t')} match your website, or we couldn’t find ${plural(bad.length, 'it', 'them')}.`);
  const sum = report.sourcesSummary;
  if (sum && num(sum.cited) && num(sum.missingYou)) rows.push(`<b>The pages AI reads:</b> ${num(sum.missingYou)} of the ${num(sum.cited)} we checked ${plural(num(sum.missingYou), 'lists', 'list')} other ${escapeHtml(tradePlural(b.trade))} and not you.`);
  if (!rows.length) return '';
  return `<ul class="r2-fixwhere">${rows.map((r) => `<li><span aria-hidden="true">✗</span><span>${r}</span></li>`).join('')}</ul>`;
}

// One segment per check: green passed, red failed. Says nothing about which checks (locked).
function siteMeterV2(total, passed) {
  const n = Math.min(Math.max(total, 0), 30);
  const ok = Math.min(Math.max(passed, 0), n);
  const segs = Array.from({ length: n }, (_, i) => `<i${i < ok ? '' : ' class="f"'}></i>`).join('');
  return `<div class="r2-meter" style="--n:${n}" role="img" aria-label="${ok} of ${n} checks passed">${segs}</div>`;
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
    ? (listings.length === 1 ? 'We found 1 listing, and it matches your website.' : `All ${listings.length} listings agree.`)
    : `${badListings.length} of ${listings.length} listings need a fix. When your listings disagree, AI can repeat the wrong one.`;
  return `
    <section class="report-section">
      <h2>Your listings</h2>
      <p class="sub">${sub}</p>
      ${listings.map((l) => `
        <div class="listing-card">
          <span class="badge ${l.status === 'match' ? 'match' : l.status === 'unchecked' ? 'found' : 'mismatch'}">${l.status === 'match' ? '✓ Correct' : l.status === 'unchecked' ? 'Found' : '✗ Needs a fix'}</span>
          <h3>${escapeHtml(l.platform)}</h3>
          ${l.locked ? '' : `${l.details ? `<p>${escapeHtml(l.details)}</p>` : ''}${fields(l.fields)}`}
        </div>`).join('')}
    </section>`;
}

// Can AI read the owner's website? (scanner/owner-checks.js checkSite: robots.txt, schema, sitemap,
// phone and address on the page, plus the rows in siteMoreRowsV2.) Public page reads only.
function siteV2(report) {
  const sc = report.siteCheck;
  if (!sc || !sc.url) return '';
  // Locked: a pass/fail tally only; which checks failed is in the audit (src/lib/lock.js).
  if (sc.locked) {
    const failedN = Math.max(0, num(sc.checks) - num(sc.passed));
    const verdict = !sc.reachable
      ? '<li class="bad"><span aria-hidden="true">✗</span> We couldn’t load your website. AI can’t read a site that doesn’t load.</li>'
      : failedN
        ? `<li class="bad"><span aria-hidden="true">✗</span> ${failedN} of ${num(sc.checks)} website checks failed. They make your site harder for AI to read.</li>`
        : `<li class="ok"><span aria-hidden="true">✓</span> All ${num(sc.checks)} checks passed.</li>`;
    return `
    <section class="report-section r2-site">
      <h2>Can AI read your website?</h2>
      <p class="sub">We read <a href="${escapeHtml(sc.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(sc.url.replace(/^https?:\/\//, ''))}</a> the way an AI assistant would.</p>
      ${sc.reachable && num(sc.checks) > 0 ? siteMeterV2(num(sc.checks), num(sc.passed)) : ''}
      <ul class="r2-site-list">${verdict}</ul>
      ${sc.reachable && failedN ? `<p class="r2-site-lock">🔒 Which ${failedN === 1 ? 'one' : failedN} failed, and the exact fix for ${failedN === 1 ? 'it' : 'each'}, is in the audit.</p>` : ''}
      ${listingLineV2(report.listings)}
    </section>`;
  }
  const row = (ok, text) => `<li class="${ok ? 'ok' : 'bad'}"><span aria-hidden="true">${ok ? '✓' : '✗'}</span> ${text}</li>`;
  const blocked = (sc.robots && sc.robots.blocked) || [];
  const rows = !sc.reachable
    ? [row(false, 'We couldn’t load your website. AI can’t read a site that doesn’t load.')]
    : [
      row(!blocked.length, blocked.length
        ? `Your robots.txt blocks ${escapeHtml(blocked.map((b) => b.who).join(', '))}.`
        : 'AI assistants are allowed to read your site.'),
      row(!!(sc.schema && sc.schema.found), sc.schema && sc.schema.found ? 'Business details are marked up for search engines and AI (schema).' : 'No business markup (schema) that tells AI your name, phone and address.'),
      row(!!(sc.onSite && sc.onSite.phone), sc.onSite && sc.onSite.phone ? `Your phone number is on the page: ${escapeHtml(sc.onSite.phone)}.` : 'We couldn’t find your phone number on the page.'),
      row(!!(sc.onSite && sc.onSite.address), sc.onSite && sc.onSite.address ? `Your address is on the page: ${escapeHtml(sc.onSite.address)}.` : 'We couldn’t find your street address on the page.'),
      row(!!sc.sitemap, sc.sitemap ? 'A sitemap helps crawlers find every page.' : 'No sitemap, so crawlers may miss pages.'),
      ...siteMoreRowsV2(sc, row),
    ];
  return `
    <section class="report-section r2-site">
      <h2>Can AI read your website?</h2>
      <p class="sub">We read <a href="${escapeHtml(sc.url)}" rel="noopener nofollow" target="_blank">${escapeHtml(sc.url.replace(/^https?:\/\//, ''))}</a> the way an AI assistant would.</p>
      <ul class="r2-site-list">${rows.join('')}</ul>
    </section>`;
}

// The newer website checks (https, llms.txt, title / description / heading, FAQ schema, service and
// town pages, phone speed). Every field is optional: a missing one (an older report, or a locked
// report that only carries pass/fail) renders no row. Text fields may be a string or just true/false.
function siteMoreRowsV2(sc, row) {
  const out = [];
  const isBool = (v) => typeof v === 'boolean';
  const h = sc.https && typeof sc.https === 'object' ? sc.https : null;
  if (h && h.loads === false) out.push(row(false, 'Your site doesn’t load over a secure https:// address.'));
  else if (h && h.loads === true) {
    out.push(h.redirects === false
      ? row(false, 'Your site loads over https://, but the plain http:// address doesn’t forward to it.')
      : row(true, 'Your site loads over a secure https:// address.'));
  }
  if (isBool(sc.llmsTxt)) {
    out.push(row(sc.llmsTxt, sc.llmsTxt
      ? 'Your site has an llms.txt file, a short summary written for AI tools.'
      : 'No llms.txt file (a newer, optional summary written for AI tools).'));
  }
  const m = sc.meta && typeof sc.meta === 'object' ? sc.meta : null;
  if (m) {
    if (typeof m.title === 'string' || isBool(m.title)) {
      out.push(m.title
        ? row(true, typeof m.title === 'string' ? `Page title: “${escapeHtml(m.title)}”.` : 'Your homepage has a page title.')
        : row(false, 'Your homepage has no page title.'));
    }
    if (typeof m.description === 'string' || isBool(m.description)) {
      out.push(row(!!m.description, m.description
        ? 'Your homepage has a meta description (the summary under your link in search results).'
        : 'No meta description (the summary under your link in search results).'));
    }
    if (isBool(m.mentionsTrade)) {
      out.push(row(m.mentionsTrade, m.mentionsTrade
        ? 'Your title and main heading say what you do.'
        : 'Your title, description and main heading don’t say what you do.'));
    }
    if (isBool(m.mentionsTown)) {
      out.push(row(m.mentionsTown, m.mentionsTown
        ? 'Your title and main heading say where you work.'
        : 'Your title, description and main heading don’t say where you work.'));
    }
  }
  if (isBool(sc.faqSchema)) {
    out.push(row(sc.faqSchema, sc.faqSchema
      ? 'Questions and answers are marked up for search engines and AI (FAQ schema).'
      : 'No FAQ schema on your homepage.'));
  }
  const p = sc.pages && typeof sc.pages === 'object' ? sc.pages : null;
  if (p) {
    const pagesRow = (v, what) => {
      if (typeof v === 'number') {
        return row(v > 0, v > 0
          ? `Your homepage links to ${num(v)} ${plural(v, 'page', 'pages')} about ${what}.`
          : `Your homepage doesn’t link to a page about ${what}.`);
      }
      if (isBool(v)) return row(v, v ? `Your homepage links to pages about ${what}.` : `Your homepage doesn’t link to a page about ${what}.`);
      return '';
    };
    const a = pagesRow(p.servicePages, 'your services');
    const b = pagesRow(p.townPages, 'the towns you serve');
    if (a) out.push(a);
    if (b) out.push(b);
  }
  const sp = sc.speed && typeof sc.speed === 'object' ? sc.speed : null;
  if (sp && typeof sp.score === 'number') {
    const s = Math.round(sp.score);
    out.push(row(s >= 50, `Google’s speed score on phones: ${num(s)} out of 100 (${s >= 90 ? 'fast' : s >= 50 ? 'could be faster' : 'slow'}).`));
  }
  return out;
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
function issuesV2({ issues, locked, xrayOk, name = '', specificCount = null, where = '' }) {
  if (!issues.length) return '';
  // Locked: how many fixes and how serious; the titles are the fix, so they're the audit's.
  if (issues.every((i) => i && i.locked && !i.title)) {
    const bySev = {};
    for (const i of issues) bySev[i.severity || 'low'] = (bySev[i.severity || 'low'] || 0) + 1;
    const order = ['high', 'medium', 'low'];
    const sevs = [...order.filter((k) => bySev[k]), ...Object.keys(bySev).filter((k) => !order.includes(k))];
    return `
    <section class="report-section">
      <h2>What to fix</h2>
      <p class="sub">We found <strong>${issues.length} ${plural(issues.length, 'problem', 'problems')}</strong> you can fix.${specificCount !== null && specificCount < issues.length ? ` ${specificCount} ${plural(specificCount, 'is', 'are')} specific to ${escapeHtml(name || 'your business')}. The rest are general tips.` : ''}</p>
      <div class="r2-fixtiles">${sevs.map((k) => `<div class="r2-fixtile ${escapeHtml(k)}"><div class="n">${num(bySev[k])}</div><div class="l">${escapeHtml(severityLabel(k).toLowerCase())}</div></div>`).join('')}</div>
      ${where}
      <ol class="r2-locked-list" aria-label="Problems found, details in the audit">
        ${issues.slice(0, 2).map((i, n) => `<li><span class="badge ${escapeHtml(i.severity || 'low')}">${escapeHtml(severityLabel(i.severity || 'low'))}</span><span class="bar" style="width:${[78, 64, 86, 58, 72, 66][n]}%" aria-hidden="true"></span><span class="lock" aria-hidden="true">🔒</span></li>`).join('')}
      </ol>
      ${issues.length > 2 ? `<p class="r2-muted r2-locked-more">and ${issues.length - 2} more.</p>` : ''}
      ${xrayOk ? '' : '<p class="r2-muted">Each problem by name, with the exact steps to fix it, is in the full report.</p>'}
    </section>`;
  }
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
// report carries just `xray: {locked: true}`, and nothing is shown.
function xrayV2({ report, aById, cw, N }) {
  const x = report.xray;
  if (!x) return '';
  // Locked: the gap sheet and checklist are listed in the offer band, not shown as blurred stand-ins.
  if (x.locked) return '';
  const gap = x.gapSheet || { competitors: [] };
  const comps = (gap.competitors || []).filter((c) => c && c.name);
  const proof = (ids) => {
    const links = (ids || []).filter((id) => aById[id]).slice(0, 8)
      .map((id) => { const a = aById[id]; const lbl = INTENT_LABELS[a.intent] ? ` (${INTENT_LABELS[a.intent]})` : ''; return `<a href="#ans-${escapeHtml(id)}" data-open="${escapeHtml(id)}">${escapeHtml(engineName(a.engine) + lbl)}</a>`; });
    return links.length ? `<p class="r2-muted">Read the answers: ${links.join(' · ')}</p>` : '';
  };
  const anyGap = comps.some((c) => (c.sources || []).length);
  // Google reviews (looked up at scan time): "4.8★ from 212 Google reviews (you: 4.6★ from 38)".
  const revText = (r) => {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.count)) return '';
    const n = `${num(r.count)} Google ${plural(r.count, 'review', 'reviews')}`;
    return typeof r.rating === 'number' && r.count > 0 ? `${r.rating.toFixed(1)}★ from ${n}` : n;
  };
  const yr = gap.youReviews;
  const youRev = !yr || !Number.isInteger(yr.count) ? ''
    : yr.count === 0 ? 'no reviews yet'
      : typeof yr.rating === 'number' ? `${yr.rating.toFixed(1)}★ from ${num(yr.count)}` : `${num(yr.count)} ${plural(yr.count, 'review', 'reviews')}`;
  const reviewsLine = (c) => {
    const t = revText(c.reviews);
    return t ? `<p class="r2-reviews">${escapeHtml(t)}${youRev ? ` <span class="r2-muted">(you: ${escapeHtml(youRev)})</span>` : ''}</p>` : '';
  };
  const card = (c) => {
    const srcs = (c.sources || []).filter((s) => s && s.domain);
    return `
      <div class="listing-card r2-gap">
        <h3>${escapeHtml(c.name)}</h3>
        <p>Named in ${num(c.named)} of ${num(N)} ${cw.unit}${num(c.first) ? `, first in ${num(c.first)}` : ', never first'}.</p>
        ${reviewsLine(c)}
        ${srcs.length
          ? `<p><strong>Sites AI cited that list them and not you:</strong></p>
             <ul class="r2-gap-list">${srcs.map((s) => `<li><a href="${safeHref(s.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(s.domain)}</a>${num(s.position) ? ` <span class="r2-muted">(listed #${num(s.position)})</span>` : ''}</li>`).join('')}</ul>`
          : '<p class="r2-muted">We found no sites AI cited that list them and not you.</p>'}
        ${proof(c.answerIds)}
      </div>`;
  };
  const cards = comps.map(card).join('');
  const checkedNote = num(gap.sourcesChecked) === 0
    ? 'None of the sites AI cited could be read for their listings, so no gaps could be checked.'
    : anyGap ? '' : 'We found no sites AI cited that list them and not you.';
  // With an action plan, the plan is the checklist and the $25 offer moves to the end of the page
  // (breakdownUpsell). The gap sheet stays only when it found a gap: nine "found nothing" cards aren't evidence.
  if (x.actionPlan && (x.actionPlan.items || []).length) {
    if (!anyGap) return '';
    return `
    <section class="report-section r2-xray">
      <h2>Competitor gap sheet</h2>
      <p class="sub">The businesses AI named in at least 2 of the ${num(N)} ${cw.unit}, and the sites AI cited that list them and not you.</p>
      ${comps.filter((c) => (c.sources || []).some((s) => s && s.domain)).map(card).join('')}
    </section>`;
  }
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
      ${comps.length && !report.breakdown && !report.plan && !isDemoReport(report) ? `<div class="r2-upsell"><p><strong>See what they have that you don’t.</strong> The Competitor Breakdown ($25) is a scorecard of what the top 3 businesses AI names instead of you show that you don’t: a page for your town, how they price, licenses, awards, reviews and directories. It shows how many of those you match, a “do these first” list in the order to copy them, what AI said about each one word for word, and the pages AI read for them.</p>${tierOn('competitor_breakdown') ? `<a class="btn-secondary" data-tier="competitor_breakdown" href="#">Get my Competitor Breakdown — $25</a>${trustRow({ promise: 'Ready the moment you pay' })}` : `<a class="btn-secondary" href="mailto:hello@aifoundscore.com?subject=${encodeURIComponent('Competitor Breakdown: ' + (report.business?.name || ''))}">Get my Competitor Breakdown — $25</a>`}</div>` : ''}
      <h2 class="r2-xray-h2">Your fix checklist</h2>
      <p class="sub">${checklist.length} ${plural(checklist.length, 'fix', 'fixes')}, in order. Ticks are saved in this browser.</p>
      <ul class="r2-check">${checklist.map((i, n) => {
        const k = escapeHtml(`${n}:${i.title}`.slice(0, 120));
        return `<li><label><input type="checkbox" data-check="${k}"${ticked[`${n}:${i.title}`.slice(0, 120)] ? ' checked' : ''}> <span>${escapeHtml(i.title)}</span></label></li>`;
      }).join('')}</ul>
    </section>`;
}

// The $25 Competitor Breakdown offer on a paid report with an action plan: at the end of the page,
// after everything the owner already paid for. Same rules as the offer inside the gap sheet.
function breakdownUpsell(report) {
  const comps = ((report.xray && report.xray.gapSheet && report.xray.gapSheet.competitors) || []).filter((c) => c && c.name);
  if (!comps.length || report.breakdown || report.plan || isDemoReport(report)) return '';
  return `
    <div class="r2-upsell">
      <p><strong>Want to see what ${escapeHtml(listJoin(comps.slice(0, 3).map((c) => c.name)))} have that you don’t?</strong> The Competitor Breakdown ($25) is a scorecard of what the top 3 businesses AI names instead of you show that you don’t: a page for your town, how they price, licenses, awards, reviews and directories, with a “do these first” list in the order to copy them.</p>
      ${tierOn('competitor_breakdown')
        ? `<a class="btn-secondary" data-tier="competitor_breakdown" href="#">Get my Competitor Breakdown — $25</a>`
        : `<a class="btn-secondary" href="mailto:hello@aifoundscore.com?subject=${encodeURIComponent('Competitor Breakdown: ' + (report.business?.name || ''))}">Get my Competitor Breakdown — $25</a>`}
    </div>`;
}

// 8c. Competitor Breakdown ($25 add-on; in Be the Answer). Built by the Worker from this report's own
// data (shared/report-v2.js buildCompetitorBreakdown) and sent only when paid for (or on the sample).
function breakdownV2(report) {
  const bd = report.breakdown || {};
  const comps = (bd.competitors || []).filter((c) => c && c.name);
  const you = bd.you || {};
  if (!comps.length) {
    return `
    <section class="report-section r2-xray">
      <h2>Competitor Breakdown</h2>
      <p class="sub">No other business was named in 2 or more answers, so there is nobody to match this time.</p>
    </section>`;
  }
  const m = bd.match || null;
  const rev = (r) => (r && Number.isInteger(r.count) ? `${typeof r.rating === 'number' && r.count > 0 ? `${r.rating.toFixed(1)}★ from ` : ''}${num(r.count)} Google ${plural(r.count, 'review', 'reviews')}` : 'not found on Google');
  const kindLabel = { 'town-page': 'Their page for your town', site: 'Their website', directory: 'Directory', community: 'Community thread', other: 'Other page' };

  // A. The scorecard: what each top business shows, and you. A tick has evidence behind it; a dash only means "not seen in this scan".
  const scorecard = m && m.rows.length ? `
      <p class="r2-match-score"><b>You match ${num(m.youCount)} of ${num(m.total)}.</b> The top ${comps.length === 1 ? 'business' : comps.length} match ${escapeHtml(String(m.avgRivals))} of ${num(m.total)} on average.</p>
      <div class="r2-match-wrap"><table class="r2-match">
        <thead><tr><th scope="col">What we saw</th>${comps.map((c) => `<th scope="col" class="m">${escapeHtml(c.name)}</th>`).join('')}<th scope="col" class="m you">You</th></tr></thead>
        <tbody>${m.rows.map((r) => `<tr><th scope="row">${escapeHtml(r.label)}</th>${r.rivals.map((x) => `<td class="m">${x.has ? '<span class="y" aria-label="Seen">✓</span>' : '<span class="n" aria-label="Not seen">–</span>'}</td>`).join('')}<td class="m you">${r.you ? '<span class="y" aria-label="Seen">✓</span>' : '<span class="n" aria-label="Not seen">–</span>'}</td></tr>`).join('')}</tbody>
      </table></div>` : '';

  // B. Do these first: the rows you lack, most rivals first, each with one plain action.
  const first = m && m.first.length ? `
      <h3 class="r2-match-h">Do these first</h3>
      <ol class="r2-first">${m.first.map((f) => `<li><b>${escapeHtml(f.label)}</b><span>${escapeHtml(f.action)}</span><em>${num(f.rivalCount)} of ${comps.length} ${plural(comps.length, 'business', 'businesses')} ${f.rivalCount === 1 ? 'has' : 'have'} it</em></li>`).join('')}</ol>` : '';

  // C. How AI describes each one, word for word, and the pages AI cited for them.
  const describe = comps.map((c) => {
    const says = (c.says || []).map((x) => `<li><span class="tag">${escapeHtml(x.label)}</span><q>${escapeHtml(x.text)}</q><span class="src">As ${escapeHtml(engineName(x.engine))} wrote it</span></li>`).join('');
    const pages = (c.pages || []).map((p2) => `<li><span class="tag">${escapeHtml(kindLabel[p2.kind] || 'Page')}</span><a href="${safeHref(p2.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(shortUrl(p2.url))}</a></li>`).join('');
    if (!says && !pages) return '';
    return `
      <div class="listing-card r2-gap">
        <h3>${escapeHtml(c.name)}</h3>
        ${says ? `<p><strong>What AI said about them:</strong></p><ul class="r2-says">${says}</ul>` : ''}
        ${pages ? `<p><strong>Pages AI cited for them:</strong></p><ul class="r2-says">${pages}</ul>` : ''}
      </div>`;
  }).join('');
  const describeBlock = describe ? `<h3 class="r2-match-h">What AI says about them, and the pages it read</h3>${describe}` : '';

  // D. One by one: their numbers next to yours, the question they win, what they have that you don't.
  const cards = comps.map((c) => `
      <div class="listing-card r2-gap">
        <h3>${escapeHtml(c.name)}</h3>
        <table class="r2-table"><thead><tr><th></th><th>${escapeHtml(c.name)}</th><th>You</th></tr></thead><tbody>
          <tr><td>Named</td><td>${num(c.named)} of ${num(you.answers)}</td><td>${num(you.named)} of ${num(you.answers)}</td></tr>
          <tr><td>Named first</td><td>${num(c.first)}</td><td>${num(you.first)}</td></tr>
          <tr><td>Google reviews</td><td>${escapeHtml(rev(c.reviews))}</td><td>${escapeHtml(rev(you.reviews))}</td></tr>
        </tbody></table>
        ${c.quote ? `<p><strong>What ${escapeHtml(engineName(c.quote.engine))} said${c.quote.question ? ` when asked “${escapeHtml(c.quote.question)}”` : ''}:</strong></p><blockquote class="r2-quote">${escapeHtml(c.quote.text)}</blockquote>` : ''}
        ${(c.winsQuestions || []).length ? `<p><strong>Questions where AI named them and not you:</strong></p><ul class="r2-gap-list">${c.winsQuestions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>` : ''}
        ${(c.edges || []).length
          ? `<p><strong>What they have that you don’t:</strong></p><ol class="r2-gap-list">${c.edges.map((e2) => `<li>${escapeHtml(e2)}</li>`).join('')}</ol>`
          : '<p class="r2-muted">We found nothing they have that you don’t in this scan.</p>'}
      </div>`).join('');
  return `
    <section class="report-section r2-xray r2-matchlist">
      <h2>Competitor Breakdown</h2>
      <p class="sub">${m ? `What the ${comps.length === 1 ? 'business' : `${comps.length} businesses`} AI names instead of you have that you don’t, in the order to copy them.` : `The ${comps.length === 1 ? 'business' : `${comps.length} businesses`} AI names instead of you, one by one.`}</p>
      ${scorecard}
      ${first}
      ${describeBlock}
      <h3 class="r2-match-h">One by one</h3>
      ${cards}
      <p class="r2-match-note">Built from the answers and the pages AI cited in this scan. A dash means we didn’t see it there, not that it doesn’t exist. These are things that appear next to businesses AI recommends. We can’t promise that copying them changes what AI says.</p>
    </section>`;
}

// 9. Offer: the $49 AI Visibility X-Ray, the only tier on sale (OFFERED_TIERS in config.js has 'xray').
// The offer band on a v2 report. Only on a locked report with at least MIN_FIX_ITEMS fixes specific to the
// business (xrayOk; the refund promise). It leads with what this report actually found (never a claim the
// report can't back), then what $49 buys, the refund promise, and the one email box for anyone not ready.
// Sample and showcase reports never link to Stripe (isDemoReport, at the top of this file).
function offerV2({ report, b, aById, t, N, zero, lostIntents, intentLabel, proven, badListings, missingCount, severity, specificFixCount, xrayOk, hasCompetitors }) {
  if (!xrayOk) return '';
  const name = escapeHtml(b.name || 'your business');
  const town = escapeHtml(b.town || b.city || 'your area');
  const top = proven[0] ? escapeHtml(proven[0].name) : '';

  // Headline: the outcome they want, in their words.
  const winning = !zero && !lostIntents.length && N > 0 && t.namedYou / N >= 0.6;
  const trade = escapeHtml(String(b.trade || 'business').toLowerCase());
  const title = zero ? (top ? `Take the call back from <span class="ob-rival">${top}</span>.` : `Get AI to recommend ${name}.`)
    : winning ? `Stay the ${trade} AI recommends in ${town}.`
      : `Be the ${trade} AI recommends in ${town}.`;
  const wrongPhone = (report.aiFacts || []).find((x) => x && x.status === 'differs' && x.field === 'phone');

  const addon = hasCompetitors && tierOn('competitor_breakdown') ? `
          <label class="ob-addon">
            <input type="checkbox" data-addon="competitor_breakdown" data-addon-price="25">
            <span><b>Add the Competitor Breakdown <em>+$25</em></b>A scorecard of what the top 3 businesses AI picks over you have that you don’t, and what to copy first.</span>
          </label>` : '';
  // What they get, in numbers the free report already shows. Nothing here names a fix or a step.
  const totalFixes = num(severity.high) + num(severity.medium) + num(severity.low);
  const first = num(severity.high);
  const gets = [
    totalFixes ? `All ${totalFixes} problems by name${first ? ` (${first} to fix first)` : ''}.` : 'Every problem, by name.',
    'The exact steps to fix each one, in plain words.',
    'Files to paste in: your FAQ page, your Google listing text and a review QR code.',
    N ? `All ${N} AI ${plural(N, 'answer', 'answers')} word for word, and a free re-scan in 30 days.` : 'A free re-scan in 30 days.',
  ];
  const cost = zero
    ? `We asked ${N} ${plural(N, 'time', 'times')}. You got 0 mentions.`
    : N ? `AI mentioned you in ${t.namedYou} of ${N} ${plural(N, 'answer', 'answers')}.` : '';
  return `
    <section class="offer-band ob-navy" id="offer" data-offer-band aria-labelledby="offer-title">
      <p class="ob-eyebrow">Your next step</p>
      <h2 id="offer-title">${title}</h2>
      ${cost ? `<p class="ob-cost">${cost}</p>` : ''}
      <ul class="ob-get">${gets.map((g) => `<li>${g}</li>`).join('')}</ul>
      <p class="ob-easy">Paste the files in, or hand them to whoever runs your website. Opens the moment you pay.</p>
      ${wrongPhone ? `<p class="ob-urgent">If ${escapeHtml(wrongPhone.aiSays)} isn’t a number you answer, every customer who gets it from ${escapeHtml(engineName(aById[wrongPhone.answerId]?.engine))} is a call you miss.</p>` : ''}
      <a class="btn big ob-btn" data-tier="xray" href="#" data-base-price="49">${escapeHtml(ctaWord(report))} — $<span data-total>49</span></a>
      <p class="ob-promise">${ICON.shield}<span><b>The 3-problem promise:</b> fewer than 3 problems specific to ${name}? Email us within 30 days for your money back.</span></p>
      ${addon}
      <p class="ob-small">${ICON.lock}Secure Stripe checkout. No subscription. No logins.${report.sample ? '' : ' <a class="ob-sample" href="/report/sample-001">See a sample report first</a>'}</p>
    </section>`;
}

// Offer band add-on checkbox → the buy button shows the total.
function wireOfferTotal(root) {
  root.querySelectorAll('[data-offer-band]').forEach((band) => {
    const out = band.querySelector('[data-total]');
    const btn = band.querySelector('[data-base-price]');
    if (!out || !btn) return;
    band.addEventListener('change', (e) => {
      if (!e.target.matches('input[data-addon]')) return;
      const extra = [...band.querySelectorAll('input[data-addon]:checked')].reduce((n, x) => n + num(x.dataset.addonPrice), 0);
      out.textContent = String(num(btn.dataset.basePrice) + extra);
    });
  });
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
function answersV2({ questions, answers, failedNote = '' }) {
  if (!answers.length) return '';
  const runs = Math.max(1, ...answers.map((a) => a.run || 1));
  const groups = questions.map((q) => {
    const qa = answers.filter((a) => a.questionId === q.id);
    if (!qa.length) return '';
    const counted = qa.filter((a) => a.ownerMatch !== 'unsure');
    const named = counted.filter((a) => a.namedYou === true).length;
    const lost = counted.length > 0 && named * 2 <= counted.length;
    const verdict = counted.length
      ? `<p class="r2-qv ${lost ? 'lost' : 'won'}"><span class="r2-verdict-badge">${lost ? '✕ Lost' : '✓ Won'}</span> AI mentioned you in ${named} of ${counted.length} ${plural(counted.length, 'answer', 'answers')}.</p>`
      : '';
    return `
      <h3 class="r2-q">“${escapeHtml(q.text)}”</h3>
      ${verdict}
      <details class="r2-qans"><summary>Read the ${qa.length} ${plural(qa.length, 'answer', 'answers')}</summary>
      ${qa.map((a) => {
        const m = markFor(a);
        const cites = (a.citations || []).filter((c) => c && c.url);
        if (a.locked) {
          const named = (a.businessesNamed || []).filter((n) => n && n.name && !isYouNamed(n)).map((n) => escapeHtml(n.name));
          return `
        <details class="r2-ans" id="ans-${escapeHtml(a.id)}">
          <summary><span class="eng">${escapeHtml(engineName(a.engine))}${runs > 1 ? ` · run ${num(a.run) || 1}` : ''}</span><span class="mk ${m.cls}">${m.txt}</span><span class="lbl">${m.label}</span></summary>
          <div class="body">
            ${named.length ? `<p>It named ${listJoin(named)}.</p>` : '<p>It didn’t name any other business.</p>'}
            ${blurred('The full answer, word for word, and every website it cited.')}
          </div>
        </details>`;
        }
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
      }).join('')}
      </details>`;
  }).join('');
  const hasUnsure = answers.some((a) => a.ownerMatch === 'unsure' && !a.namedYou);
  return `
    <details class="report-section r2-allans">
      <summary><h2>Every question, every answer</h2><span class="r2-allans-n">${answers.length} ${plural(answers.length, 'answer', 'answers')}</span></summary>
      <p class="sub">✓ mentioned you (★ first) · ✗ didn’t${hasUnsure ? ' · ? unsure, not counted' : ''}. ${answers.some((a) => a.locked)
        ? 'Tap to open. The answer at the top of this report is here word for word; every other answer, and the websites it cited, is in the audit.'
        : 'Word for word, as the AI returned it. Business names in bold, yours highlighted. Tap to open.'}</p>
      ${failedNote ? `<p class="r2-note">${escapeHtml(failedNote)}</p>` : ''}
      ${groups}
    </details>`;
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
  return `<details class="r2-method"><summary>How we searched</summary><p>${parts.join(' ')}</p></details>`;
}
