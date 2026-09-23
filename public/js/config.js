// Site-wide config — the ONE file where later wiring happens.
// Replace the "#" placeholders with real Stripe Payment Links when ready.

const STRIPE_LINKS = {
  snapshot: '#',       // Snapshot — $29 one-time
  before_after: '#',   // Before & After — $59 one-time
  full_year: '#',       // Full Year — $69 one-time
  listing_fix: '#',     // Listing-fix upsell — $199 one-time
};

// Attach buy links to any element with a data-tier attribute.
// If a link is still "#", the button shows a "coming soon" note instead of navigating.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-tier]').forEach((el) => {
    const tier = el.getAttribute('data-tier');
    const url = STRIPE_LINKS[tier];
    if (url && url !== '#') {
      el.setAttribute('href', url);
    } else {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        alert('Online checkout is being set up — please check back soon.');
      });
    }
  });
});
