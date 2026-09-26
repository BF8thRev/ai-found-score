// The owner's website + Google listing checks (scanner/owner-checks.js) and their place in the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseRobots, blocksHome, readHomePage, checkSite, pickPlace, compareListing, ownerIssues,
  runOwnerChecks, formatPhone, siteUrl, PLACES_URL,
} from '../owner-checks.js';
import { buildReport } from '../extract/build.js';
import { validateReport } from '../../shared/report-v2.js';

const HOME = `<html><head><title>Acme Plumbing</title>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Acme"},
{"@type":"Plumber","name":"Acme Plumbing","telephone":"+1 516-555-0142","address":{"streetAddress":"12 Main St","addressLocality":"Massapequa","addressRegion":"NY","postalCode":"11758"}}]}</script>
</head><body><a href="tel:5165550142">Call</a></body></html>`;

function site({ robots = 'User-agent: *\nDisallow: /admin\nSitemap: https://acme.com/sitemap.xml', home = HOME, places = null } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    if (u === PLACES_URL) return places ? Response.json(places) : new Response('no', { status: 403 });
    if (u.endsWith('/robots.txt')) return robots == null ? new Response('', { status: 404 }) : new Response(robots);
    if (u.endsWith('/sitemap.xml')) return new Response('<urlset/>');
    if (u === 'https://acme.com/') return new Response(home, { headers: { 'content-type': 'text/html' } });
    return new Response('', { status: 404 });
  };
  f.calls = calls;
  return f;
}

test('robots.txt: specific group wins over *, longest rule wins, empty Disallow allows', () => {
  const g = parseRobots('User-agent: *\nDisallow:\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\nAllow: /');
  assert.equal(blocksHome(g, 'GPTBot'), true);
  assert.equal(blocksHome(g, 'ClaudeBot'), true);
  assert.equal(blocksHome(g, 'PerplexityBot'), false, 'Allow: / on a tie wins');
  assert.equal(blocksHome(g, 'Googlebot'), false);
  assert.equal(blocksHome(parseRobots('User-agent: *\nDisallow: /private'), 'GPTBot'), false);
  assert.equal(blocksHome(parseRobots('User-agent: *\nDisallow: /'), 'Bingbot'), true);
});

test('home page: schema of any business type, else tel: links and page text', () => {
  const p = readHomePage(HOME);
  assert.equal(p.schema.name, 'Acme Plumbing');
  assert.equal(p.phone, '(516) 555-0142');
  assert.equal(p.address, '12 Main St, Massapequa, NY 11758');
  const plain = readHomePage('<p>Call 631.254.0914 or visit 1502 Deer Park Ave.</p>');
  assert.equal(plain.schema, null);
  assert.equal(plain.phone, '(631) 254-0914');
  assert.equal(plain.address, '1502 Deer Park Ave');
  assert.equal(formatPhone('+1 (516) 555 0142'), '(516) 555-0142');
});

test('social pages are not crawled as the owner website', () => {
  assert.equal(siteUrl('facebook.com/acme'), null);
  assert.equal(siteUrl('https://www.yelp.com/biz/acme'), null);
  assert.equal(siteUrl('acme.com').origin, 'https://acme.com');
});

test('checkSite: blocked AI crawlers, schema, sitemap, phone and address', async () => {
  const sc = await checkSite('acme.com', { fetchImpl: site({ robots: 'User-agent: GPTBot\nDisallow: /\nUser-agent: *\nDisallow:' }) });
  assert.deepEqual(sc.robots.blocked.map((b) => b.agent), ['GPTBot']);
  assert.equal(sc.schema.found, true);
  assert.equal(sc.sitemap, true, 'found at /sitemap.xml when robots.txt names none');
  assert.deepEqual(sc.onSite, { phone: '(516) 555-0142', address: '12 Main St, Massapequa, NY 11758' });
});

test('Google place: website match beats name match', () => {
  const places = [
    { displayName: { text: 'Acme Plumbing' }, websiteUri: 'https://other.com' },
    { displayName: { text: 'Acme Plumbing & Heating LLC' }, websiteUri: 'https://www.acme.com/contact' },
  ];
  assert.equal(pickPlace(places, { name: 'Acme Plumbing', website: 'acme.com' }), places[1]);
  assert.equal(pickPlace(places, { name: 'Acme Plumbing' }), places[0]);
  assert.equal(pickPlace(places, { name: 'Zeta Roofing' }), null);
});

test('compare: phone differs -> mismatch with both numbers; all agree -> match', () => {
  const truth = { phone: '(516) 555-0142', address: '12 Main St, Massapequa, NY 11758', source: 'website' };
  const place = { displayName: { text: 'Acme Plumbing' }, nationalPhoneNumber: '(516) 555-0199', formattedAddress: '12 Main St, Massapequa, NY 11758, USA' };
  const bad = compareListing(place, truth, { name: 'Acme Plumbing' });
  assert.equal(bad.status, 'mismatch');
  assert.deepEqual(bad.diffs, ['phone']);
  assert.match(bad.details, /Google shows \(516\) 555-0199; your website says \(516\) 555-0142/);
  const good = compareListing({ ...place, nationalPhoneNumber: '516-555-0142' }, truth, { name: 'Acme Plumbing' });
  assert.equal(good.status, 'match');
  assert.equal(compareListing(null, truth, { name: 'Acme', town: 'Massapequa' }).status, 'mismatch');
  assert.equal(compareListing(place, { source: 'owner' }, { name: 'Acme Plumbing' }).status, 'unchecked');
});

test('issues: robots block, missing phone on site, Google phone mismatch', () => {
  const siteCheck = { url: 'https://acme.com', reachable: true, robots: { blocked: [{ agent: 'GPTBot', who: 'ChatGPT (training)' }] }, onSite: { phone: '', address: '12 Main St' } };
  const google = { diffs: ['phone'], details: 'Google shows X; your website says Y.' };
  const out = ownerIssues({ siteCheck, google, business: { name: 'Acme' }, truth: { phone: '(516) 555-0142', source: 'website' } });
  assert.deepEqual(out.map((i) => i.kind), ['site_blocks_ai', 'site_missing_nap', 'listing_differs']);
  assert.match(out[0].copyText[0].text, /User-agent: GPTBot\nAllow: \//);
  assert.equal(out[2].copyText[0].text, '(516) 555-0142');
});

test('runOwnerChecks: no Places key -> website only, no listings', async () => {
  const r = await runOwnerChecks({ name: 'Acme Plumbing', website: 'acme.com' }, {}, { fetchImpl: site() });
  assert.equal(r.google.ok, false);
  assert.deepEqual(r.listings, []);
  assert.equal(r.facts.phone, '(516) 555-0142');
  assert.ok(!r.issues.some((i) => i.kind === 'site_missing_nap'));
});

test('buildReport: listings, siteCheck and owner fixes land in a valid report', async () => {
  const scan = JSON.parse(readFileSync(new URL('./fixtures/megawash-live/scan.json', import.meta.url), 'utf8'));
  const places = { places: [{ displayName: { text: 'Acme Plumbing' }, nationalPhoneNumber: '(516) 555-0199', formattedAddress: '12 Main St, Massapequa, NY 11758, USA', websiteUri: 'https://acme.com', googleMapsUri: 'https://maps.google.com/?cid=1' }] };
  const fetchImpl = site({ places });
  const { report } = await buildReport({
    scan, business: { name: 'Acme Plumbing', website: 'acme.com', town: 'Massapequa', state: 'NY', zip: '11758', trade: 'plumbing' },
    env: { GOOGLE_PLACES_API_KEY: 'test' }, fetchImpl, proposalsByAnswer: {}, id: 'owner-checks-test',
  });
  const placesCall = fetchImpl.calls.find((c) => c.u === PLACES_URL);
  assert.equal(placesCall.init.headers['X-Goog-Api-Key'], 'test');
  assert.equal(report.siteCheck.schema.found, true);
  assert.equal(report.listings[0].platform, 'Google');
  assert.equal(report.listings[0].status, 'mismatch');
  assert.ok(report.issues.some((i) => i.kind === 'listing_differs'));
  assert.equal(report.business.facts.phone, '(516) 555-0142');
  const v = validateReport(report);
  assert.ok(!v.errors.some((e) => /siteCheck|listing|site_|google_/.test(e)), v.errors.join('\n'));
});
