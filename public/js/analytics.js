// AI Found Score analytics + ad-readiness.
// - window.dataLayer is the event bus for the GTM container (GA4 config tag inside GTM handles pageviews).
// - Ad-pixel placeholders below: paste IDs when ad accounts exist; loaders no-op while empty.
(function () {
  window.dataLayer = window.dataLayer || [];
  var params = new URLSearchParams(window.location.search);
  var arm = params.get('arm') || '';

  // --- Ad-pixel placeholders (do NOT invent IDs) ---
  // paste IDs when ad accounts exist; loaders no-op while empty
  var GOOGLE_ADS_ID = ''; // e.g. 'AW-123456789'
  var META_PIXEL_ID = ''; // e.g. '123456789012345'

  // Google Ads tag: only injected when GOOGLE_ADS_ID is non-empty.
  if (GOOGLE_ADS_ID) {
    var g = document.createElement('script');
    g.async = true;
    g.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(GOOGLE_ADS_ID);
    document.head.appendChild(g);
    window.dataLayer.push({ event: 'ads_loaded', provider: 'google_ads' });
  }

  // Meta Pixel base code: only injected when META_PIXEL_ID is non-empty.
  if (META_PIXEL_ID) {
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v; s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
    window.dataLayer.push({ event: 'ads_loaded', provider: 'meta_pixel' });
  }

  // --- Conversion events ---
  var TIER_PRICE = { xray: 49, snapshot: 29, before_after: 59, full_year: 69, listing_fix: 199 };
  var CTA_ID = {
    xray: 'xray_49',
    snapshot: 'snapshot_29',
    before_after: 'before_after_59',
    full_year: 'full_year_69',
    listing_fix: 'listing_fix_199',
  };

  var path = window.location.pathname;

  // Report page visit: token from URL path, arm from ?arm=.
  if (path.indexOf('/report/') === 0) {
    var token = path.split('/').filter(Boolean).pop() || '';
    window.dataLayer.push({ event: 'report_view', report_token: token, arm: arm });
  }

  // Successful purchase landing: tier/value from ?tier= and price table.
  if (path === '/success' || path === '/success/') {
    var tier = params.get('tier') || '';
    window.dataLayer.push({
      event: 'purchase',
      tier: tier,
      arm: arm,
      value: TIER_PRICE[tier] || 0,
      currency: 'USD',
    });
  }

  // Every pricing/CTA click + checkout start (delegated so report.js-rendered
  // buttons are covered too). Fires even while Stripe links are placeholders.
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-tier]') : null;
    if (!el) return;
    var t = el.getAttribute('data-tier');
    window.dataLayer.push({ event: 'cta_click', cta_id: CTA_ID[t] || t, tier: t, arm: arm });
    window.dataLayer.push({ event: 'begin_checkout', tier: t, arm: arm });
  });
})();
