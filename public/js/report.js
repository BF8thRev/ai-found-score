// Fetches its data from GET /api/report/[id] and renders it.
// The Worker rewrites /report/<id> to /report.html; the id comes from the URL.
document.addEventListener('DOMContentLoaded', async () => {
  const id = window.location.pathname.split('/').filter(Boolean).pop() || 'sample-001';
  const root = document.getElementById('report-root');

  let report;
  try {
    const res = await fetch('/api/report/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('not found');
    report = await res.json();
  } catch {
    root.innerHTML = '<div class="wrap"><p style="padding:60px 0">We couldn’t find that report. Check the link and try again.</p></div>';
    return;
  }

  document.title = `AI Found Score — ${report.business.name}`;

  const b = report.business;
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
            <p>${escapeHtml(l.details)}</p>
            ${fields(l.fields)}
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>What to fix, in order</h2>
        <p class="sub">Start at the top.</p>
        ${report.issues.map((issue) => `
          <div class="issue-card">
            <span class="badge ${issue.severity}">${severityLabel(issue.severity)}</span>
            <h3>${escapeHtml(issue.title)}</h3>
            <p>${escapeHtml(issue.description)}</p>
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>The bottom line</h2>
        <p>${escapeHtml(report.summary)}</p>
      </section>

      <div class="cta-band">
        <h2>Want it handled?</h2>
        <p>We fix your listings on all five sites. One payment. No subscription.</p>
        <p>
          <a class="btn" data-tier="listing_fix" href="#">Fix my listings — $199</a>
        </p>
        <p class="fine">Do it yourself: <a data-tier="snapshot" href="#">Snapshot $29</a> · <a data-tier="before_after" href="#">Before &amp; After $59</a> · <a data-tier="full_year" href="#">Full Year $69</a></p>
      </div>
    </div>`;
});

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
