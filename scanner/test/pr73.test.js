// The "PR 73" paid report (Oct 2 2026): the owner typed "PR 73", the website and Google say "PR73".
//   1. The Google lookup searched only "PR 73" and said there was no listing. Now: other spellings and
//      the website's own, at most MAX_PLACE_SEARCHES calls, and a place with the owner's website matches
//      whatever its name.
//   2. The lists AI cited (clutch.co, communicationsmatch.com, ...) were never read ("Not checked yet"):
//      only home-service directories were. Now every cited list is read the way the site allows, and each
//      is listed / not listed / couldn't check (with the reason). Never "not listed" without reading it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGooglePlace, pickPlace, placeQueries, runOwnerChecks, robotsAllows, parseRobots, brandOnSite, MAX_PLACE_SEARCHES, PLACES_URL,
} from '../owner-checks.js';
import { nameVariants, spellingOnSite } from '../extract/normalize.js';
import { checkListingPage, buildSources, looksLikeList, addUrlFor, MIN_READABLE_TEXT } from '../extract/sources.js';
import { siteSpelling } from '../extract/fixes.js';
import { validateReport } from '../../shared/report-v2.js';
import { buildActionPlan } from '../../shared/action-plan.js';
import { BUSINESS, HOME, SCAN, PR73_PLACE, fakeWeb, buildPr73Report } from './fixtures/pr73.js';

const ENV = { GOOGLE_PLACES_API_KEY: 'test-key' };

// ---- 1. Google: name variants and website matching ----

test('name variants: the spacing between letters and digits, and "&" / "and"; same letters only', () => {
  assert.deepEqual(nameVariants('PR 73'), ['PR 73', 'PR73']);
  assert.deepEqual(nameVariants('PR73'), ['PR73', 'PR 73']);
  assert.deepEqual(nameVariants('Smith & Sons'), ['Smith & Sons', 'Smith and Sons']);
  assert.deepEqual(nameVariants('Harbor Lane PR'), ['Harbor Lane PR']);
  // The website's spelling goes first; a different brand on the site only last.
  assert.deepEqual(placeQueries('PR 73', { name: 'PR73', related: true }), ['PR73']);
  assert.deepEqual(placeQueries('PR 73', { name: 'Integrated Comms', related: false }), ['PR73', 'Integrated Comms']);
});

test('the website’s brand: the title’s last part, compared with the typed name', () => {
  assert.deepEqual(brandOnSite(HOME, 'PR 73'), { name: 'PR73', from: 'title', related: true, differs: true, consistent: true });
  assert.equal(brandOnSite(HOME, 'PR73').differs, false, 'same spelling: nothing to flag');
  // The site writes both: not "consistent", so the typed name stays the default.
  assert.equal(spellingOnSite([{ name: 'PR73', from: 'title' }], 'PR 73', 'Call PR 73 today').consistent, false);
  // og:site_name and schema count too.
  assert.equal(brandOnSite('<meta property="og:site_name" content="Mega Wash &amp; Dry"><title>Home</title>', 'Mega Wash and Dry').name, 'Mega Wash & Dry');
});

test('Google: "PR 73" finds nothing, "PR73" finds the listing; 2 calls, stops at the first match', async () => {
  const web = fakeWeb();
  const g = await findGooglePlace(BUSINESS, ENV, { fetchImpl: web, brand: Promise.resolve({ name: 'PR73', related: true }) });
  assert.equal(g.ok, true);
  assert.equal(g.place.id, 'place-pr73');
  assert.deepEqual(web.placesQueries(), ['PR 73, New York City, NY 10001', 'PR73, New York City, NY 10001']);
  assert.equal(g.searches, 2);
});

test('Google: a place with the owner’s website matches whatever its name, on the first call', async () => {
  const other = { ...PR73_PLACE, displayName: { text: 'Integrated Communications Group LLC' } };
  const web = fakeWeb({ places: () => [{ id: 'x', displayName: { text: 'PR 73 Lounge' }, websiteUri: 'https://lounge.example.com' }, other] });
  const g = await findGooglePlace(BUSINESS, ENV, { fetchImpl: web });
  assert.deepEqual(g.place, other);
  assert.equal(g.searches, 1);
  // By name: any spelling of the same letters ("PR73" for "PR 73"); another name never.
  const pr73 = { displayName: { text: 'PR73' } };
  assert.equal(pickPlace([pr73], { name: 'PR 73' }), pr73);
  assert.equal(pickPlace([{ displayName: { text: 'Integrated Comms' } }], { name: 'PR 73' }), null);
});

test('Google: no listing under any spelling → bounded calls, and the details name each spelling tried', async () => {
  const web = fakeWeb({ places: () => [] });
  const r = await runOwnerChecks(BUSINESS, ENV, { fetchImpl: web });
  assert.ok(web.placesQueries().length <= MAX_PLACE_SEARCHES);
  assert.deepEqual(web.placesQueries(), ['PR 73, New York City, NY 10001', 'PR73, New York City, NY 10001']);
  assert.equal(r.listings[0].details, "We couldn't find a Google Maps listing for PR 73 or PR73 near New York City.");
  // A failed first call stops there.
  const down = async (url, init) => (String(url) === PLACES_URL ? new Response('no', { status: 500 }) : web(url, init));
  const calls = [];
  const g = await findGooglePlace(BUSINESS, ENV, { fetchImpl: async (u, i) => { calls.push(String(u)); return down(u, i); } });
  assert.equal(g.ok, false);
  assert.equal(calls.filter((u) => u === PLACES_URL).length, 1);
});

test('runOwnerChecks (the scan’s path): the website’s spelling finds the listing; "PR73" on Google isn’t a name mismatch', async () => {
  const web = fakeWeb();
  const r = await runOwnerChecks(BUSINESS, ENV, { fetchImpl: web });
  assert.equal(r.siteCheck.brand.name, 'PR73');
  assert.equal(r.listings[0].platform, 'Google');
  assert.notEqual(r.listings[0].details.startsWith("We couldn't find"), true);
  assert.equal(r.listings[0].url, 'https://maps.google.com/?cid=73');
  assert.ok(!r.issues.some((i) => i.kind === 'google_missing'));
  assert.ok(!r.issues.some((i) => i.kind === 'listing_differs' && /name/.test(i.title)), 'PR73 and PR 73 are one name');
  assert.equal(r.google.searches, 2);
});

// ---- 2. the lists AI cited: listed / not listed / couldn't check ----

const OWNER = { name: 'PR 73', website: 'https://www.pr73.com' };
const long = (s) => `<html><body>${s} ${'Firms listed by specialty and client reviews. '.repeat(10)}</body></html>`;

test('listing page: listed by name (any spelling), by a link to the website, or not listed', () => {
  const byName = checkListingPage(long('<h2>PR73</h2> Integrated communications.'), OWNER, { pageUrl: 'https://dir.example.com/x' });
  assert.deepEqual([byName.youListed, byName.listedBy], [true, 'name']);
  const byLink = checkListingPage(long('<a href="/go?to=https%3A%2F%2Fwww.pr73.com%2F">Visit site</a> <a href="/company/seventy-three">Seventy Three</a>'), OWNER, { pageUrl: 'https://dir.example.com/x' });
  assert.deepEqual([byLink.youListed, byLink.listedBy], [true, 'website']);
  const profile = checkListingPage(long('<a href="/company/pr73">PR73</a>'), OWNER, { pageUrl: 'https://dir.example.com/list' });
  assert.equal(profile.profileUrl, 'https://dir.example.com/company/pr73');
  const not = checkListingPage(long('<ol><li>Brightline Communications</li><li>Kestrel PR</li></ol>'), OWNER, { pageUrl: 'https://dir.example.com/x' });
  assert.deepEqual([not.youListed, not.listedBy, not.checkReason], [false, null, undefined]);
  // "PR" alone, or "73" alone, is never a match.
  assert.equal(checkListingPage(long('Top PR firms with 73 clients'), OWNER).youListed, false);
  // A Facebook page as the "website": a link to Facebook proves nothing.
  assert.equal(checkListingPage(long('<a href="https://www.facebook.com/someoneelse">Facebook</a>'), { name: 'Zed Co', website: 'https://facebook.com/zedco' }).youListed, false);
});

test('listing page: a bot wall or an empty shell is "couldn’t check", never "not listed"', () => {
  const wall = checkListingPage('<html><title>Just a moment...</title><div id="cf-chl-widget"></div></html>', OWNER);
  assert.deepEqual([wall.youListed, wall.checkReason], [null, 'blocked']);
  const shell = checkListingPage('<html><body><div id="app"></div><script>load()</script></body></html>', OWNER);
  assert.deepEqual([shell.youListed, shell.checkReason], [null, 'empty']);
  assert.ok(MIN_READABLE_TEXT >= 200);
});

test('which cited pages are read: lists and directories, never social sites or wires; add-your-business links we checked', () => {
  assert.equal(looksLikeList('clutch.co', 'https://clutch.co/pr-firms/new-york'), true);
  assert.equal(looksLikeList('blog.example.com', 'https://blog.example.com/best-pr-firms'), true);
  assert.equal(looksLikeList('reddit.com', 'https://reddit.com/r/pr/best'), false);
  assert.equal(looksLikeList('prnewswire.com', 'https://prnewswire.com/top-news'), false);
  assert.equal(looksLikeList('kestrelpr.example.com', 'https://kestrelpr.example.com/about'), false);
  assert.equal(addUrlFor('www.goodfirms.co'), 'https://www.goodfirms.co/get-listed');
  // Clutch turns our crawler away; its sign-up page comes from shared/directories.js (checked on clutch.co).
  assert.equal(addUrlFor('clutch.co'), 'https://vendor.clutch.co/profile/create/basic');
  assert.equal(addUrlFor('publicrelationsdatabase.com'), null, 'not confirmed: no link');
});

test('buildSources: robots.txt obeyed, 403 and bot walls are "couldn’t check", read pages say listed or not', async () => {
  const web = fakeWeb();
  const answers = SCAN.calls.map((c, i) => ({ id: `a${i + 1}`, namedYou: false, citations: c.citations }));
  const sources = await buildSources({ answers, business: BUSINESS, fetchImpl: web, names: ['PR73'] });
  const by = (d) => sources.find((s) => s.domain === d);
  const cm = by('communicationsmatch.com');
  assert.deepEqual([cm.youListed, cm.listedBy, cm.profileUrl, cm.addUrl],
    [true, 'website', 'https://www.communicationsmatch.com/company/pr73', 'https://www.communicationsmatch.com/account/registration']);
  const prd = by('publicrelationsdatabase.com');
  assert.deepEqual([prd.youListed, prd.checked], [false, true]);
  const clutch = by('clutch.co');
  assert.deepEqual([clutch.youListed, clutch.checkReason, clutch.checkError], [null, 'blocked', 'HTTP 403']);
  assert.deepEqual([by('themanifest.com').youListed, by('themanifest.com').checkReason], [null, 'blocked']);
  const gf = by('goodfirms.co');
  assert.deepEqual([gf.youListed, gf.addUrl], [false, 'https://www.goodfirms.co/get-listed']);
  const dr = by('designrush.com');
  assert.deepEqual([dr.youListed, dr.checkReason], [null, 'robots']);
  assert.ok(!web.calls.some((c) => c.u.includes('designrush.com/agency')), 'a page robots.txt closes is never fetched');
  // Our own user agent, and one robots.txt per site.
  const page = web.calls.find((c) => c.u.includes('publicrelationsdatabase.com/best'));
  assert.match(page.init.headers['User-Agent'], /AIFoundScoreBot/);
  assert.equal(web.calls.filter((c) => c.u === 'https://clutch.co/robots.txt').length, 1);
  // maxFetch bounds the reads.
  const few = fakeWeb();
  await buildSources({ answers, business: BUSINESS, fetchImpl: few, maxFetch: 2 });
  assert.equal(few.calls.filter((c) => !c.u.endsWith('/robots.txt')).length, 2);
});

test('robots.txt paths: longest rule wins, "*" and "$" patterns', () => {
  const g = parseRobots('User-agent: *\nDisallow: /*?\nAllow: /us/*/profile/*?\nDisallow: /search$\n\nUser-agent: AIFoundScoreBot\nDisallow: /private');
  assert.equal(robotsAllows(g, 'otherbot', '/search?q=x'), false);
  assert.equal(robotsAllows(g, 'otherbot', '/us/ny/profile/pr73?x=1'), true);
  assert.equal(robotsAllows(g, 'otherbot', '/search'), false);
  assert.equal(robotsAllows(g, 'otherbot', '/searching'), true);
  assert.equal(robotsAllows(g, 'aifoundscorebot', '/search?q=x'), true, 'our own group replaces "*"');
  assert.equal(robotsAllows(g, 'aifoundscorebot', '/private/x'), false);
  assert.equal(robotsAllows([], 'aifoundscorebot', '/anything'), true);
});

// ---- the scan, end to end ----

test('buildReport (PR 73): the Google listing is found, the lists are read, the report is valid', async () => {
  const { report, validation, web } = await buildPr73Report();
  assert.deepEqual(validation.errors, []);
  assert.equal(report.listings[0].url, 'https://maps.google.com/?cid=73');
  assert.ok(!report.issues.some((i) => i.kind === 'google_missing'));
  assert.equal(report.siteCheck.brand.name, 'PR73');
  assert.ok(web.placesQueries().length <= MAX_PLACE_SEARCHES);
  const status = Object.fromEntries(report.sources.map((s) => [s.domain, s.youListed]));
  assert.deepEqual(status, { 'clutch.co': null, 'communicationsmatch.com': true, 'publicrelationsdatabase.com': false, 'themanifest.com': null, 'goodfirms.co': false, 'designrush.com': null });
  // One spelling everywhere in the plan, and a plain ask to pick one.
  assert.deepEqual(siteSpelling(report), { typed: 'PR 73', site: 'PR73', consistent: true, use: 'PR73' });
  const lists = buildActionPlan(report).items.find((i) => i.id === 'lists');
  assert.deepEqual(lists.sites.map((s) => [s.domain, s.status]), [
    ['publicrelationsdatabase.com', 'missing'], ['goodfirms.co', 'missing'], ['clutch.co', 'check'], ['themanifest.com', 'check'], ['designrush.com', 'check'], ['communicationsmatch.com', 'listed'],
  ]);
  assert.match(lists.steps.join('\n'), /Your website writes “PR73” and your report request said “PR 73” — pick one and use it everywhere\./);
  assert.match(lists.copyText[0].text, /^Business name: PR73$/m);
  assert.doesNotMatch(JSON.stringify(lists.copyText), /PR 73/);
});

test('an answer that writes "PR73" names the owner "PR 73" (the same name without the space)', async () => {
  const { matchOwner } = await import('../extract/verify.js');
  const text = '**PR73** focuses on integrated communications.';
  assert.equal(matchOwner({ text, entry: { name: 'PR73', pos: 2 }, business: BUSINESS }), 'match');
  assert.equal(matchOwner({ text: '**PR 7** is a studio.', entry: { name: 'PR 7', pos: 2 }, business: BUSINESS }), 'none', 'a different name is never the owner');
  assert.equal(matchOwner({ text: '**PR** firms', entry: { name: 'PR', pos: 2 }, business: { name: 'P R' } }), 'none', 'too short to squash');
});
