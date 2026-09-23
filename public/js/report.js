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
    root.innerHTML = '<div class="wrap"><p style="padding:60px 0">Sorry — we could not find that report. Please check the link and try again.</p></div>';
    return;
  }

  document.title = `Your AI Found Score report — ${escapeHtml(report.business.name)}`;

  const b = report.business;
  const named = report.aiResults.filter((r) => r.named).length;
  const total = report.aiResults.length;
  const badListings = report.listings.filter((l) => l.status === 'mismatch');

  root.innerHTML = `
    <section class="report-header">
      <div class="wrap">
        ${report.sample ? '<div class="sample-banner"><strong>Sample report.</strong> This shows what a real report looks like, using a fictional plumbing company. Your report would have your business’s details.</div>' : ''}
        <h1>${escapeHtml(b.name)}</h1>
        <p class="biz-meta">${escapeHtml(b.trade)} · ${escapeHtml(b.address)}, ${escapeHtml(b.city)}, ${escapeHtml(b.state)} ${escapeHtml(b.zip)} · ${escapeHtml(b.phone)}</p>
        <p class="fine">Report generated ${escapeHtml(report.generatedAt)}</p>
      </div>
    </section>

    <div class="wrap">
      <div class="score-card">
        <div class="score-ring" style="background: conic-gradient(var(--amber) ${report.score}%, rgba(255,255,255,.2) 0)">
          <div class="inner">${report.score}</div>
        </div>
        <div>
          <h2>Your AI Found Score: ${report.score} out of 100 — ${escapeHtml(report.scoreLabel)}</h2>
          <p>${escapeHtml(report.scoreExplanation)}</p>
        </div>
      </div>

      <section class="report-section">
        <h2>Question 1: Do AI assistants recommend you?</h2>
        <p class="sub">${named} out of ${total} assistants mentioned ${escapeHtml(b.name)} by name.</p>
        ${report.aiResults.map((r) => `
          <div class="assistant-card">
            <span class="badge ${r.named ? 'named' : 'not-named'}">${r.named ? '✓ Mentioned you' : '✗ Did not mention you'}</span>
            <h3>${escapeHtml(r.assistant)}</h3>
            <blockquote>${escapeHtml(r.quote)}</blockquote>
            <p class="note">${escapeHtml(r.note)}</p>
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>Question 2: Do your listings agree?</h2>
        <p class="sub">${badListings.length} of ${report.listings.length} listings have a problem.</p>
        ${report.listings.map((l) => `
          <div class="listing-card">
            <span class="badge ${l.status}">${l.status === 'match' ? '✓ All correct' : '✗ Needs fixing'}</span>
            <h3>${escapeHtml(l.platform)}</h3>
            <p>${escapeHtml(l.details)}</p>
            <dl class="listing-fields">
              <dt>Name:</dt><dd>${escapeHtml(l.fields.name)}</dd>
              <dt>Phone:</dt><dd>${escapeHtml(l.fields.phone)}</dd>
              <dt>Hours:</dt><dd>${escapeHtml(l.fields.hours)}</dd>
            </dl>
          </div>`).join('')}
      </section>

      <section class="report-section">
        <h2>What to fix, in order</h2>
        <p class="sub">Start at the top — the first items lose you the most customers.</p>
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
        <h2>Want us to fix it for you?</h2>
        <p>We handle the listings, you get the customers. One-time payment, no subscription.</p>
        <p>
          <a class="btn" data-tier="listing_fix" href="#">Fix my listings — $199</a>
        </p>
        <p class="fine">Prefer to do it yourself? <a data-tier="snapshot" href="#">Get the step-by-step Snapshot — $29</a> · <a data-tier="before_after" href="#">Before &amp; After — $59</a> · <a data-tier="full_year" href="#">Full Year — $69</a></p>
      </div>
    </div>`;
});

function severityLabel(s) {
  return { high: 'Fix first', medium: 'Fix soon', low: 'Minor' }[s] || s;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
