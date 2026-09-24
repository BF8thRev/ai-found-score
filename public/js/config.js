// Site-wide config — the ONE file where later wiring happens.
// Replace the "#" placeholders with real Stripe Payment Links when ready.
// Each Payment Link: after-payment redirect
// https://aifoundscore.com/success?tier=<key>&session_id={CHECKOUT_SESSION_ID}

const STRIPE_LINKS = {
  snapshot: '#',       // Snapshot — $29 one-time (unlocks the report)
  before_after: '#',   // Before & After — $59 one-time
  full_year: '#',       // Full Year — $69 one-time
  listing_fix: '#',     // Listing-fix upsell — $199 one-time
};

// Attach buy links to every [data-tier] element under root. On a report
// page, pass the report token: it rides to Stripe as client_reference_id
// so the webhook can tie the payment to the business and its test arm.
// If a link is still "#", the button shows a "coming soon" note instead.
function wireCheckout(root, token) {
  root.querySelectorAll('[data-tier]').forEach((el) => {
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    const tier = el.getAttribute('data-tier');
    const base = STRIPE_LINKS[tier];
    if (base && base !== '#') {
      const u = new URL(base);
      if (token) u.searchParams.set('client_reference_id', token);
      el.setAttribute('href', u.toString());
      // Lets /success link back to the (now unlocked) report.
      el.addEventListener('click', () => {
        try { localStorage.setItem('afs_checkout', JSON.stringify({ token, tier })); } catch {}
      });
    } else {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        alert('Checkout opens soon. Email hello@aifoundscore.com and we’ll hold your spot.');
      });
    }
  });
}
window.wireCheckout = wireCheckout;

// Static pages. The report page calls wireCheckout itself after it renders.
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('report-root')) wireCheckout(document, null);
});
