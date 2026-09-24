// Fetches its data from GET /api/report/[id] and renders it.
// The Worker rewrites /report/<id> to /report.html; the id comes from the URL.
// Unpaid reports arrive with `locked: true` and the fix details already
// removed server-side; this page only draws the blurred stand-ins.
document.addEventListener('DOMContentLoaded', async () => {
  const id = window.location.pathname.split('/').filter(Boolean).pop() || 'sample-001';
  const root = document.getElementById('report-root');
  const preview = new URLSearchParams(window.location.search).get('preview');

  let report;
  try {
    const res = await fetch('/api/report/' + encodeURIComponent(id) + (preview ? '?preview=' + encodeURIComponent(preview) : ''));
    if (!res.ok) throw new Error(res.status === 404 ? 'not found' : 'error');
    report = await res.json();
  } catch (e) {
    root.innerHTML = e.message === 'not found'
      ? `<div class="wrap page-msg">
          <h1>We couldn’t find that report.</h1>
          <p>If you typed the code from a postcard, check it and try again: letters and numbers only, like <strong>aifoundscore.com/r/K7M2QX</strong>.</p>
          <p>Still stuck? Email <a href="mailto:hello@aifoundscore.com?subject=Find%20my%20report">hello@aifoundscore.com</a> with your business name, or <a href="/#request">request a fresh report</a>.</p>
        </div>`
      : '<div class="wrap page-msg"><h1>Something went wrong.</h1><p>Reload the page in a minute. If it keeps happening, email <a href="mailto:hello@aifoundscore.com">hello@aifoundscore.com</a>.</p></div>';
    return;
  }

  document.title = `AI Found Score — ${report.business.name}`;

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
      </div>` : `
      <div class="cta-band">
        <h2>See exactly what to fix</h2>
        <p>Every issue explained, with step-by-step fixes you can hand to anyone. One payment of $29. No subscription.</p>
        <p><a class="btn big" data-tier="snapshot" href="#">Unlock the full report — $29</a></p>
        <p class="fine">Rather we do it? <a data-tier="before_after" href="#">We fix it — $59</a> · <a data-tier="full_year" href="#">Full Year $69</a> · <a data-tier="listing_fix" href="#">Listing cleanup $199</a></p>
      </div>`}

      ${report.sample ? '' : leadForm('bottom')}
    </div>`;

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
