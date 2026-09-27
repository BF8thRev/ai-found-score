// Site-wide config: which plans are on sale, and the buy buttons (our checkout, src/lib/checkout.js).

// Plans on sale. The report page never renders a button or link for a tier that isn't listed here.
// Prices are set server-side per report (src/lib/checkout.js): the $49 audit (Fix Kit included), the
// $25 Competitor Breakdown (after the audit, or as a checkbox on the audit), and Be the Answer ($499
// minus what the owner already paid on that report). Retired tier keys (fix_kit, snapshot,
// before_after, full_year, listing_fix) still resolve in the webhook (src/lib/stripe.js TIER_BY_CENTS).
const OFFERED_TIERS = ['xray', 'competitor_breakdown', 'be_the_answer'];
window.OFFERED_TIERS = OFFERED_TIERS;
window.tierOffered = (tier) => OFFERED_TIERS.includes(tier);

// Wire every [data-tier] button under root to our checkout. On a report page, pass the report token:
// POST /api/checkout { token, tier, addons } answers { url } on Stripe's hosted page, and the browser
// goes there. Add-ons are ticked [data-addon] checkboxes inside the same [data-offer-band]. Without a
// token (homepage, static pages, the sample) a payment would unlock nothing, so the button starts the
// free report instead.
function wireCheckout(root, token) {
  root.querySelectorAll('[data-tier]').forEach((el) => {
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    const tier = el.getAttribute('data-tier');
    if (!token) {
      el.setAttribute('href', '/#request');
      return;
    }
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.dataset.busy) return;
      const band = el.closest('[data-offer-band]');
      const addons = band ? [...band.querySelectorAll('input[data-addon]:checked')].map((x) => x.getAttribute('data-addon')) : [];
      el.dataset.busy = '1';
      const label = el.textContent;
      el.textContent = 'Opening checkout…';
      fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, tier, addons }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((body) => {
          if (body && body.ok && body.url) {
            // Lets /success link back to the (now unlocked) report.
            try { localStorage.setItem('afs_checkout', JSON.stringify({ token, tier })); } catch {}
            location.href = body.url;
            return;
          }
          delete el.dataset.busy;
          el.textContent = label;
          alert((body && body.error) || 'Could not start checkout. Try again in a minute.');
        })
        .catch(() => {
          delete el.dataset.busy;
          el.textContent = label;
          alert('Could not reach us. Check your connection and try again.');
        });
    });
  });
}
window.wireCheckout = wireCheckout;

// Static pages. The report page calls wireCheckout itself after it renders.
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('report-root')) wireCheckout(document, null);
});
