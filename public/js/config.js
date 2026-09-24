// Site-wide config — the ONE file where later wiring happens.
// Replace the "#" placeholders with real Stripe Payment Links when ready.
// Each Payment Link: after-payment redirect
// https://aifoundscore.com/success?tier=<key>&session_id={CHECKOUT_SESSION_ID}

const STRIPE_LINKS = {
  // Keys are stable ids (analytics, webhook TIER_BY_CENTS); only the labels changed.
  snapshot: 'https://buy.stripe.com/28E00c7bth016jS8WN6Vq00',       // Fix steps — $29 one-time (unlocks the fix steps)
  before_after: 'https://buy.stripe.com/fZuaEQ8fx39b7nWf1b6Vq01',   // Fix it and re-check — $59 one-time
  full_year: '#',       // Full Year (off sale; its Stripe link is kept out of the page source) — $69 one-time
  listing_fix: '#',     // Full listing (off sale; its Stripe link is kept out of the page source) build — $199 one-time
};

// Tiers on sale right now. The report page never renders a button or link for a tier that
// isn't listed here. Known: 'snapshot', 'before_after', 'full_year', 'listing_fix'.
// Sep 2026: only Fix steps ($29) and Fix it and re-check ($59) are on sale.
const OFFERED_TIERS = ['snapshot', 'before_after'];
window.OFFERED_TIERS = OFFERED_TIERS;
window.tierOffered = (tier) => OFFERED_TIERS.includes(tier);

// Attach buy links to every [data-tier] element under root. On a report
// page, pass the report token: it rides to Stripe as client_reference_id
// so the webhook can tie the payment to the business and its test arm.
// If a link is still "#", the button shows a "coming soon" note instead.
function wireCheckout(root, token) {
  root.querySelectorAll('[data-tier]').forEach((el) => {
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    const tier = el.getAttribute('data-tier');
    // Every plan is bought for one report. Without a report token (homepage, static pages, the
    // sample) a payment would unlock nothing, so the button starts the free report instead.
    if (!token) {
      el.setAttribute('href', '/#request');
      return;
    }
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
