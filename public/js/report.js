// Fetches its data from GET /api/report/[id] and renders it.
// The Worker rewrites /report/<id> to /report.html; the id comes from the URL.
// Unpaid reports arrive with `locked: true` and the fix details already
// removed server-side; this page only draws the blurred stand-ins.
// `version: 2` reports use renderV2 (the searched-answers report); anything
// else is a legacy v1 report and renders exactly as it always has.
document.addEventListener('DOMContentLoaded', async () => {
  const id = window.location.pathname.split('/').filter(Boolean).pop() || 'sample-001';
  const root = document.getElementById('report-root');
  const preview = new URLSearchParams(window.location.search).get('preview');

  let report;
  try {
    const res = await fetch('/api/report/' + encodeURIComponent(id) + (preview ? '?preview=' + encodeURIComponent(preview) : ''));
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

// ---------- v1 (legacy, no `version`): rendered exactly as before ----------
function renderV1(root, report) {

  const b = report.business;
  const locked = !!report.locked;
  const paid = !locked && !report.sample; // real report that's been unlocked
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
        ${locked ? unlockPanel() : ''}
      </section>

      <section class="report-section">
        <h2>The bottom line</h2>
        <p>${escapeHtml(report.summary)}</p>
      </section>

      ${paid ? `
      <div class="cta-band">
        <h2>Want it handled?</h2>
        <p>We fix your listings on all five sites, re-scan, and show you the before and after.</p>
        <p><a class="btn" data-tier="before_after" href="#">Fix it for me — $59</a></p>
        <p class="fine"><a data-tier="full_year" href="#">Full Year $69</a> (plus monthly re-checks) · <a data-tier="listing_fix" href="#">Listing cleanup $199</a></p>
        <p class="fine"><a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></p>
      </div>` : `
      <div class="cta-band">
        <h2>See exactly what to fix</h2>
        <p>Every issue explained, with step-by-step fixes you can hand to anyone. One payment of $29. No subscription.</p>
        <p><a class="btn big" data-tier="snapshot" href="#">Unlock the full report — $29</a></p>
        <p class="fine">Rather we do it? <a data-tier="before_after" href="#">We fix it — $59</a> · <a data-tier="full_year" href="#">Full Year $69</a> · <a data-tier="listing_fix" href="#">Listing cleanup $199</a></p>
        <p class="fine">Secure checkout by Stripe. One-time payment. <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></p>
      </div>`}

      ${report.sample ? '' : leadForm('bottom')}
    </div>`;

}

// Stand-in text for withheld details. It says what's behind the blur, never
// a fake finding, and is hidden from screen readers.
function blurred(text) {
  return `<p class="locked-text" aria-hidden="true">${escapeHtml(text)}</p><p class="locked-note">🔒 In the full report</p>`;
}

function unlockPanel() {
  return `
    <div class="unlock-panel">
      <p><strong>The fixes are in the full report.</strong> What’s wrong on each listing and how to fix it, step by step.</p>
      <a class="btn" data-tier="snapshot" href="#">Unlock for $29</a>
    </div>`;
}

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
// Preferred column order only. Columns come from the engines that actually
// answered (plus method.engines order for anything not listed here).
const ENGINE_COLUMNS = ['chatgpt', 'gemini', 'google_ai_mode', 'perplexity', 'claude'];
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
// so the page says "25 searches". With more runs it says "50 answers from 25 searches".
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
    unit: multi ? 'answers' : 'searches', // "7 of 25 searches"
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
    baselineV2(report, t),
    report.sample ? '' : leadForm('top'),
    shortVersionV2({ t, N, cw, intents, lostIntents, wonIntents, intentLabel, proven, answers, zero, allNamed, nobodyTwice, generalAdvice }),
    nobodyTwice ? '' : whoAiNamesV2({ b, t, N, cw, proven }),
    gridV2({ questions, answers, engines, failedNote }),
    sourcesV2({ report, b, aById, lostAnswerIds, ownDomain, cw }),
    factsV2({ report, b, aById }),
    listingsV2({ listings, badListings }),
    // Named in every answer: Full Year only, so no $29 unlock panel either.
    issuesV2({ issues, locked, noPaywall: noFixes || allNamed }),
    offerV2({ paid, locked, allNamed, noFixes, missingSources, badListings, cw }),
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

// 6. What AI says about you: exact quotes, differs first.
function factsV2({ report, b, aById }) {
  const order = { differs: 0, match: 1 };
  const facts = (report.aiFacts || []).slice().sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2));
  if (!facts.length) return '';
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
      <p class="sub">Facts the AI stated about ${escapeHtml(b.name)}, quoted exactly and checked against your website and listings.</p>
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

// 8. What to fix: titles free, steps locked until paid (removed server-side).
function issuesV2({ issues, locked, noPaywall }) {
  if (!issues.length) return '';
  return `
    <section class="report-section">
      <h2>What to fix, in order</h2>
      <p class="sub">Start at the top.</p>
      ${issues.map((issue) => `
        <div class="issue-card">
          <span class="badge ${escapeHtml(issue.severity)}">${escapeHtml(severityLabel(issue.severity))}</span>
          <h3>${escapeHtml(issue.title)}</h3>
          ${issue.locked
            ? blurred('What this is, and the exact steps to fix it, written so anyone on your team can do it.')
            : `${issue.description ? `<p>${escapeHtml(issue.description)}</p>` : ''}${
              (issue.steps || []).length ? `<ol class="r2-steps">${issue.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : ''}`}
        </div>`).join('')}
      ${locked && !noPaywall ? unlockPanel() : ''}
    </section>`;
}

// 9. Offer: names the specific sites the fix covers.
function offerV2({ paid, locked, allNamed, noFixes, missingSources, badListings, cw }) {
  const legal = '<p class="fine">Secure checkout by Stripe. One-time payment. <a href="/terms">Terms</a> · <a href="/refunds">Refunds</a></p>';
  // Named in every answer, or nothing to fix: Full Year only, even if a listing mismatch exists.
  if (allNamed || noFixes) {
    return `
      <div class="cta-band">
        <h2>Keep it this way</h2>
        <p>${allNamed ? `Every ${cw.one} named you. ` : 'We found no listing to fix and no cited site missing you. '}We run the same ${cw.sameSearches} every month for a year and email you when a competitor starts getting named over you.</p>
        <p><a class="btn" data-tier="full_year" href="#">Full Year — $69</a></p>
        <p class="fine">No subscription. We can’t promise what AI will say. We can show you exactly what changed.</p>
        ${legal}
      </div>`;
  }
  const sites = [...new Set(missingSources.map((s) => s.domain))];
  const platforms = badListings.map((l) => l.platform);
  const parts = [];
  if (sites.length) parts.push(`get you onto ${listJoin(sites.map(escapeHtml))}`);
  if (platforms.length) parts.push(`fix your ${listJoin(platforms.map(escapeHtml))} ${plural(platforms.length, 'listing', 'listings')}`);
  const listedLine = sites.length ? ' You’ll be listed on every site we name, or you get your money back.' : '';
  return `
    <div class="cta-band">
      <h2>${sites.length ? 'Get onto the sites AI is reading' : 'Fix what AI is reading'}</h2>
      <p>We ${parts.join(' and ')}, then run the same ${cw.sameSearches} again in 30 days and show you both results.${listedLine}</p>
      <p><a class="btn big" data-tier="before_after" href="#">Fix it and re-check — $59</a></p>
      <p class="fine">${locked && !paid ? '<a data-tier="snapshot" href="#">Fix steps — $29</a> · ' : ''}<a data-tier="full_year" href="#">Full Year $69</a> (plus monthly re-checks) · <a data-tier="listing_fix" href="#">Full listing build $199</a></p>
      <p class="fine">No sales call. We can’t promise what AI will say. We can show you exactly what changed.</p>
      ${legal}
    </div>`;
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
    'We asked through each assistant’s official or commercial service, with web search on. Those answers can differ from the app on your phone.',
    listings.length ? '' : 'Listing consistency was not checked in this report.',
    'AI answers change; this is a snapshot.',
  ].filter(Boolean);
  return `<div class="r2-method"><b>How we searched.</b> ${parts.join(' ')}</div>`;
}
