// shared/platform-detect.js — which website builder a site is made with, read off its homepage.
//
//   detectPlatform(html, headers, url) → { id, name, confidence: 'high' | 'medium', evidence: [string], seo? } | null
//   (seo: 'yoast' when a WordPress site runs Yoast SEO)
//
// Pure: no fetch. The scanner calls it on the homepage it already loaded (scanner/owner-checks.js
// checkSite → siteCheck.platform); the Fix Kit calls it on reports scanned before that existed
// (src/lib/site-platform.js). The ids match the playbooks in shared/platforms.js.
//
// Each builder leaves fingerprints it can't easily hide: a <meta name="generator">, the host its files
// are served from (static.wixstatic.com, cdn.shopify.com, /wp-content/), a response header, or a script
// global. Each signal has a weight; the builder with the most wins, and it must reach MIN_SCORE. A
// generator tag or a builder-only header alone is enough ("high"); one asset host is "medium". A page
// that only embeds another builder's widget (a Shopify buy button on a WordPress site) scores lower
// than the builder it's actually made with. Nothing found: null, and the caller keeps its generic text.

const MIN_SCORE = 4;
const HIGH_SCORE = 8;

// [id, name, signals]. A signal: { re, w, why } tested on the HTML, or { header, re, w, why } on a header.
const RULES = [
  ['wix', 'Wix', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Wix\.com/i, w: 10, why: 'generator: Wix.com' },
    { re: /\bstatic\.wixstatic\.com\b/i, w: 5, why: 'files on static.wixstatic.com' },
    { re: /\bstatic\.parastorage\.com\b/i, w: 4, why: 'scripts on static.parastorage.com' },
    { header: 'x-wix-request-id', re: /./, w: 8, why: 'header: x-wix-request-id' },
    { header: 'server', re: /^Pepyaka/i, w: 8, why: 'server: Pepyaka (Wix)' },
  ]],
  ['squarespace', 'Squarespace', [
    { re: /<!--\s*This is Squarespace\.\s*-->/i, w: 10, why: 'comment: This is Squarespace.' },
    { re: /\bstatic1\.squarespace\.com\b/i, w: 5, why: 'files on static1.squarespace.com' },
    { re: /\bassets\.squarespace\.com\b/i, w: 4, why: 'scripts on assets.squarespace.com' },
    { re: /\bSQUARESPACE_CONTEXT\b/, w: 6, why: 'script: Static.SQUARESPACE_CONTEXT' },
    { header: 'server', re: /^Squarespace/i, w: 8, why: 'server: Squarespace' },
  ]],
  ['wordpress-com', 'WordPress.com', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\.com["']/i, w: 12, why: 'generator: WordPress.com' },
  ]],
  ['wordpress', 'WordPress', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["']WordPress \d/i, w: 10, why: 'generator: WordPress' },
    { re: /\/wp-content\/(themes|plugins|uploads)\//i, w: 6, why: 'files in /wp-content/' },
    { re: /\/wp-includes\//i, w: 5, why: 'files in /wp-includes/' },
    { re: /<link[^>]+rel=["']https:\/\/api\.w\.org\/["']/i, w: 6, why: 'link: api.w.org (WordPress REST API)' },
    { header: 'link', re: /api\.w\.org/i, w: 6, why: 'header: link api.w.org' },
  ]],
  ['shopify', 'Shopify', [
    { re: /\bShopify\.theme\s*=/, w: 8, why: 'script: Shopify.theme' },
    { re: /\/\/cdn\.shopify\.com\/s\/files\//i, w: 5, why: 'files on cdn.shopify.com' },
    { re: /<link[^>]+href=["'][^"']*\/cdn\/shop\//i, w: 4, why: 'files in /cdn/shop/' },
    { header: 'x-shopid', re: /./, w: 9, why: 'header: x-shopid' },
    { header: 'powered-by', re: /Shopify/i, w: 9, why: 'header: powered-by Shopify' },
    { header: 'x-shopify-stage', re: /./, w: 9, why: 'header: x-shopify-stage' },
  ]],
  ['godaddy', 'GoDaddy Website Builder', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*(Go ?Daddy Website Builder|Starfield Technologies)/i, w: 10, why: 'generator: GoDaddy Website Builder' },
    { re: /\bimg\d?\.wsimg\.com\/isteam\//i, w: 6, why: 'images on img1.wsimg.com/isteam (GoDaddy Website Builder)' },
  ]],
  ['webflow', 'Webflow', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["']Webflow["']/i, w: 10, why: 'generator: Webflow' },
    { re: /<html[^>]+data-wf-(site|page)=/i, w: 8, why: 'html: data-wf-site' },
    { re: /\b(assets-global|cdn\.prod)\.website-files\.com\b/i, w: 5, why: 'files on website-files.com' },
  ]],
  ['square', 'Square Online', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Square Online/i, w: 10, why: 'generator: Square Online' },
    { re: /\bcdn\d*\.editmysite\.com\b/i, w: 6, why: 'files on editmysite.com (Square Online / Weebly)' },
  ]],
  ['weebly', 'Weebly', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*Weebly/i, w: 10, why: 'generator: Weebly' },
    { re: /\b_W\.configDomain\b|\bweebly\.com\/weebly\//i, w: 5, why: 'script: Weebly site config' },
    // Weebly and Square Online share editmysite.com: equal here, so a Weebly-only signal decides.
    { re: /\bcdn\d*\.editmysite\.com\b/i, w: 6, why: 'files on editmysite.com (Square Online / Weebly)' },
  ]],
  ['duda', 'Duda', [
    { re: /\b(l?irp|irt)\.cdn-website\.com\b/i, w: 6, why: 'files on cdn-website.com (Duda)' },
    { re: /\bid=["']dmRoot["']|\bdmAPI\b/, w: 5, why: 'script: dmAPI / dmRoot (Duda)' },
  ]],
  ['hubspot', 'HubSpot', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["']HubSpot["']/i, w: 10, why: 'generator: HubSpot' },
    { header: 'x-hs-content-id', re: /./, w: 8, why: 'header: x-hs-content-id' },
    { re: /\bhubspotusercontent[\w-]*\.net\/hubfs\//i, w: 4, why: 'files on hubspotusercontent (HubFS)' },
  ]],
  ['framer', 'Framer', [
    { re: /<meta[^>]+name=["']generator["'][^>]+content=["']Framer\b/i, w: 10, why: 'generator: Framer' },
    { re: /\bframerusercontent\.com\b/i, w: 5, why: 'files on framerusercontent.com' },
    { re: /\bdata-framer-[a-z-]+=/i, w: 3, why: 'html: data-framer-*' },
  ]],
  ['google-sites', 'Google Sites', [
    { re: /\bgstatic\.com\/atari\//i, w: 8, why: 'scripts on gstatic.com/atari (Google Sites)' },
  ]],
];

export const PLATFORM_NAMES = Object.freeze(Object.fromEntries(RULES.map(([id, name]) => [id, name])));

// Headers as a Headers object, a Map or a plain object → lower-case name → value.
function headerGetter(headers) {
  if (!headers) return () => '';
  if (typeof headers.get === 'function') return (k) => headers.get(k) || '';
  const low = {};
  for (const [k, v] of Object.entries(headers)) low[String(k).toLowerCase()] = String(v ?? '');
  return (k) => low[k] || '';
}

export function detectPlatform(html, headers, url) {
  const h = String(html || '').slice(0, 2_000_000);
  const get = headerGetter(headers);
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch { host = ''; }
  const scores = [];
  for (const [id, name, signals] of RULES) {
    let score = 0;
    const evidence = [];
    for (const s of signals) {
      const hit = s.header ? s.re.test(get(s.header)) : s.re.test(h);
      if (hit) { score += s.w; evidence.push(s.why); }
    }
    // The address itself: a free subdomain is the builder for certain.
    const hostIs = {
      wix: /\.(wixsite|wixstudio)\.com$/, squarespace: /\.squarespace\.com$/, 'wordpress-com': /\.wordpress\.com$/,
      shopify: /\.myshopify\.com$/, webflow: /\.webflow\.io$/, square: /\.square\.site$/, weebly: /\.weebly\.com$/,
      framer: /\.framer\.(website|app|ai)$/, 'google-sites': /^sites\.google\.com$/, hubspot: /\.hs-sites\.com$/,
    }[id];
    if (hostIs && hostIs.test(host)) { score += 10; evidence.push(`address: ${host}`); }
    if (score) scores.push({ id, name, score, evidence });
  }
  // WordPress.com runs WordPress: when both match, it's WordPress.com.
  const wpcom = scores.find((s) => s.id === 'wordpress-com');
  if (wpcom) {
    const wp = scores.find((s) => s.id === 'wordpress');
    if (wp) { wpcom.score += wp.score; wpcom.evidence.push(...wp.evidence); wp.score = 0; }
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best || best.score < MIN_SCORE) return null;
  const out = { id: best.id, name: best.name, confidence: best.score >= HIGH_SCORE ? 'high' : 'medium', evidence: best.evidence.slice(0, 4) };
  // WordPress with Yoast SEO: its menus are known (shared/platforms.js `needs: 'yoast'`).
  if (/^wordpress/.test(best.id) && /<!--\s*This site is optimized with the Yoast SEO|class=["']yoast-schema-graph/i.test(h)) out.seo = 'yoast';
  return out;
}
