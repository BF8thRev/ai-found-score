// Which website builder a site is made with (shared/platform-detect.js), the scanner storing it
// (scanner/owner-checks.js checkSite → siteCheck.platform), and the lookup for reports scanned before
// that (src/lib/site-platform.js). The HTML below is trimmed from what each builder really serves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../../../shared/platform-detect.js';
import { checkSite } from '../../../scanner/owner-checks.js';
import { lookupPlatform, withPlatform, cachedPlatform, needsPlatform } from '../site-platform.js';

import { HTML, page } from './fixtures/builder-pages.js';

test('detectPlatform: each builder from its homepage', () => {
  const cases = [
    ['wix', 'Wix', HTML.wix], ['squarespace', 'Squarespace', HTML.squarespace], ['wordpress', 'WordPress', HTML.wordpress],
    ['wordpress', 'WordPress', HTML.wordpressNoGenerator], ['wordpress-com', 'WordPress.com', HTML.wordpressCom],
    ['shopify', 'Shopify', HTML.shopify], ['godaddy', 'GoDaddy Website Builder', HTML.godaddy], ['webflow', 'Webflow', HTML.webflow],
    ['square', 'Square Online', HTML.square], ['duda', 'Duda', HTML.duda], ['hubspot', 'HubSpot', HTML.hubspot],
    ['framer', 'Framer', HTML.framer], ['google-sites', 'Google Sites', HTML.googleSites],
  ];
  for (const [id, name, html] of cases) {
    const p = detectPlatform(html, {}, 'https://www.acme.com/');
    assert.ok(p, `${id} found`);
    assert.deepEqual([p.id, p.name], [id, name], id);
    assert.ok(['high', 'medium'].includes(p.confidence));
    assert.ok(p.evidence.length >= 1 && p.evidence.every((e) => typeof e === 'string'));
  }
  assert.equal(detectPlatform(HTML.wix, {}, 'https://acme.com').confidence, 'high');
});

test('detectPlatform: nothing recognised is null; empty input is safe', () => {
  assert.equal(detectPlatform(HTML.plain, {}, 'https://acme.com/'), null);
  assert.equal(detectPlatform('', null, ''), null);
  assert.equal(detectPlatform(undefined, undefined, 'not a url'), null);
});

test('detectPlatform: response headers and free addresses count', () => {
  assert.equal(detectPlatform(HTML.plain, { Server: 'Pepyaka/1.19.10' }).id, 'wix');
  assert.equal(detectPlatform(HTML.plain, new Headers({ 'x-shopid': '123' })).id, 'shopify');
  assert.equal(detectPlatform(HTML.plain, { server: 'Squarespace' }).id, 'squarespace');
  assert.equal(detectPlatform(HTML.plain, {}, 'https://acme.wixsite.com/plumbing').id, 'wix');
  assert.equal(detectPlatform(HTML.plain, {}, 'https://acmeplumbing.wordpress.com/').id, 'wordpress-com');
});

test('detectPlatform: an embedded widget from another builder does not win', () => {
  // A WordPress site with a Shopify buy button and product image.
  const html = HTML.wordpress.replace('</body>', '<img src="https://cdn.shopify.com/s/files/1/0001/products/x.jpg"></body>');
  assert.equal(detectPlatform(html, {}, 'https://acme.com/').id, 'wordpress');
  // One weak signal is not enough.
  assert.equal(detectPlatform(page('', '<div data-framer-name="x"></div>'), {}, ''), null);
});

// ---- the scanner stores it ----
const res = (body, init = {}) => new Response(body, { status: 200, ...init });
function siteFetch(html, headers = {}) {
  const urls = [];
  const f = async (url) => {
    const u = String(url);
    urls.push(u);
    if (/\/robots\.txt$/.test(u)) return res('User-agent: *\nDisallow:');
    if (/\/(llms\.txt|sitemap\.xml)$/.test(u)) return new Response('', { status: 404 });
    if (/^https:\/\/acme\.com\/$/.test(u)) return res(html, { headers: { 'Content-Type': 'text/html', ...headers } });
    return new Response('', { status: 404 });
  };
  f.urls = urls;
  return f;
}

test('checkSite: stores siteCheck.platform (null when no builder is recognised)', async () => {
  const wix = await checkSite('acme.com', { fetchImpl: siteFetch(HTML.wix) });
  assert.equal(wix.platform.id, 'wix');
  assert.equal(wix.platform.name, 'Wix');
  const sq = await checkSite('acme.com', { fetchImpl: siteFetch(HTML.plain, { Server: 'Squarespace' }) });
  assert.equal(sq.platform.id, 'squarespace', 'the server header is read');
  const plain = await checkSite('acme.com', { fetchImpl: siteFetch(HTML.plain) });
  assert.ok(Object.hasOwn(plain, 'platform'));
  assert.equal(plain.platform, null);
});

// ---- reports scanned before: one lookup, cached ----
function fakeCache() {
  const m = new Map();
  return { m, match: async (req) => (m.has(req.url) ? m.get(req.url).clone() : undefined), put: async (req, r) => { m.set(req.url, r.clone()); } };
}
const OLD = { business: { name: 'Acme', website: 'https://acme.com/' }, siteCheck: { url: 'https://acme.com', reachable: true } };

test('lookupPlatform / withPlatform: fetches the homepage once as our crawler, then the cache answers', async () => {
  const cache = fakeCache();
  let calls = 0;
  let seen = null;
  const fetchImpl = async (url, init) => { calls++; seen = { url: String(url), init }; return res(HTML.squarespace, { headers: { 'Content-Type': 'text/html' } }); };
  assert.equal(needsPlatform(OLD), true);
  const r = await withPlatform(OLD, { fetchImpl, cache });
  assert.equal(r.siteCheck.platform.id, 'squarespace');
  assert.equal(OLD.siteCheck.platform, undefined, 'the stored report is not changed');
  assert.equal(seen.url, 'https://acme.com/');
  assert.match(seen.init.headers['User-Agent'], /AIFoundScoreBot/);
  assert.equal(seen.init.redirect, 'follow');
  assert.ok(seen.init.signal, 'with a timeout');
  const again = await withPlatform(OLD, { fetchImpl, cache });
  assert.equal(again.siteCheck.platform.id, 'squarespace');
  assert.equal(calls, 1, 'the second time comes from the cache');
  // Already stored (even as null): no fetch at all.
  assert.equal(needsPlatform({ ...OLD, siteCheck: { ...OLD.siteCheck, platform: null } }), false);
  assert.equal(needsPlatform({ business: {} }), false, 'no website check, nothing to look up');
});

test('withPlatform: a site that fails to load leaves the report as it was, never throws', async () => {
  const boom = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await withPlatform(OLD, { fetchImpl: boom, cache: null });
  assert.equal(r.siteCheck.platform, null, 'looked up, nothing found');
  const s = await withPlatform(OLD, { fetchImpl: async () => new Response('nope', { status: 503 }), cache: null });
  assert.equal(s.siteCheck.platform, null);
  assert.equal(await lookupPlatform('https://www.facebook.com/acme', { fetchImpl: boom, cache: null }), null, 'not their own site');
});

test('cachedPlatform: the report page reads the cache only and looks it up afterwards', async () => {
  const cache = fakeCache();
  const later = [];
  let calls = 0;
  const fetchImpl = async () => { calls++; return res(HTML.wix); };
  const first = await cachedPlatform(OLD, { cache, fetchImpl, waitUntil: (p) => later.push(p) });
  assert.equal(first.siteCheck.platform, undefined, 'not known yet: generic steps this time');
  await Promise.all(later);
  assert.equal(calls, 1);
  const second = await cachedPlatform(OLD, { cache, fetchImpl, waitUntil: (p) => later.push(p) });
  assert.equal(second.siteCheck.platform.id, 'wix');
  assert.equal(calls, 1);
});
