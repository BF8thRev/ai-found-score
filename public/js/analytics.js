// AI Found Score analytics + ad-readiness.
// - window.dataLayer is the event bus for the GTM container (GA4 config tag inside GTM handles pageviews).
// - Ad-pixel placeholders below: paste IDs when ad accounts exist; loaders no-op while empty.
(function () {
  window.dataLayer = window.dataLayer || [];
  var params = new URLSearchParams(window.location.search);
  var arm = params.get('arm') || '';

  // Cold-email token: /e/click lands here with utm_content=<token>. Kept for the tab so the lead,
  // request and purchase events carry it (an exact email -> lead -> purchase join in GA4). It is our
  // own random key, never a name, email or report token, so only token-shaped values are kept.
  var EMAIL_TOKEN_KEY = 'afs_email_token';
  var EMAIL_TOKEN_RE = /^[A-Za-z0-9_-]{12,64}$/;
  var landedToken = params.get('utm_medium') === 'cold_email' ? params.get('utm_content') || '' : '';
  if (EMAIL_TOKEN_RE.test(landedToken)) {
    try { sessionStorage.setItem(EMAIL_TOKEN_KEY, landedToken); } catch (err) {}
  }
  window.afsEmailToken = function () {
    var t = '';
    try { t = sessionStorage.getItem(EMAIL_TOKEN_KEY) || ''; } catch (err) {}
    return EMAIL_TOKEN_RE.test(t) ? t : undefined;
  };

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
  var TIER_PRICE = { xray: 49, competitor_breakdown: 25, be_the_answer: 499, snapshot: 29, before_after: 59, full_year: 69, listing_fix: 199 };
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
    // The token is the private link to a paid report: never sent as its own field.
    window.dataLayer.push({ event: 'report_view', arm: arm });
  }

  // Successful purchase landing: tier/value from ?tier= and price table.
  if (path === '/success' || path === '/success/') {
    // v = dollars charged (after credit, with add-ons; src/lib/checkout.js success_url), else list price.
    // transaction_id = the Checkout Session, so a reload of this page isn't a second purchase.
    var tier = params.get('tier') || '';
    var charged = Number(params.get('v'));
    var sessionId = params.get('session_id') || '';
    var seen = false;
    try { seen = !!sessionId && sessionStorage.getItem('afs_purchase_' + sessionId) === '1'; } catch (err) {}
    if (!seen) {
      window.dataLayer.push({
        event: 'purchase',
        transaction_id: sessionId || undefined,
        tier: tier,
        arm: arm,
        value: isFinite(charged) && params.get('v') !== null ? charged : TIER_PRICE[tier] || 0,
        currency: 'USD',
        email_token: window.afsEmailToken(),
      });
      try { if (sessionId) sessionStorage.setItem('afs_purchase_' + sessionId, '1'); } catch (err) {}
    }
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

  // Homepage offer ladder: which tier people reach for, while checkout isn't wired there.
  // The choice is remembered for the tab so the free-report request can carry it.
  var OFFER_PRICE = { free_snapshot: 0, full_audit: 49, be_the_answer: 499 };
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-offer]') : null;
    if (!el) return;
    var o = el.getAttribute('data-offer');
    window.dataLayer.push({ event: 'offer_click', offer: o, value: OFFER_PRICE[o] || 0, currency: 'USD', arm: arm });
    try { sessionStorage.setItem('afs_offer', o); } catch (err) {}
  });
})();
