// The newer website checks (llms.txt, https, title/description/H1, FAQ schema, service and town
// pages, PageSpeed) and Google reviews vs the competitors AI named most (scanner/owner-checks.js),
// plus their place in the report (buildReport, buildGapSheet, validateReport). Fully offline:
// every fetch is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readMeta, metaCheck, tradeWords, tradeNoun, mentionsAny, readLinks, countPages, isLlmsTxt,
  httpRedirectsToHttps, parsePageSpeed, checkSpeed, checkSite, siteIssues, suggestMeta, llmsTxtSkeleton,
  faqJsonLd, placeReviews, lookupCompetitorReviews, reviewsIssue, reviewLink, runOwnerChecks,
  PLACES_URL, PAGESPEED_URL, REVIEW_FIELDS, MAX_REVIEW_LOOKUPS,
} from '../owner-checks.js';
import { resolveKeys } from '../config.js';
import { buildReport } from '../extract/build.js';
import { validateReport, buildGapSheet, xraySections, lintText } from '../../shared/report-v2.js';
import { MOCK_REPORTS } from '../../src/mock/sample-reports.js';

const BIZ = { name: 'Acme Plumbing', trade: 'plumbing', town: 'Massapequa', state: 'NY', phone: '(516) 555-0142', website: 'acme.com' };

// ---------------------------------------------------------------------------
// title, description, H1
// ---------------------------------------------------------------------------

test('readMeta: title, meta description (either attribute order), first H1; entities decoded', () => {
  const m = readMeta(`<html><head><title> Acme &amp; Sons &#8211; Plumbers </title>
    <meta content="Emergency plumber in Massapequa, NY." name="description">
    <meta name="og:description" content="nope"></head>
    <body><h1 class="x">Your <b>local</b> plumber</h1><h1>Second</h1></body></html>`);
  assert.equal(m.title, 'Acme & Sons – Plumbers');
  assert.equal(m.description, 'Emergency plumber in Massapequa, NY.');
  assert.equal(m.h1, 'Your local plumber');
  assert.deepEqual(readMeta('<p>nothing</p>'), { title: '', description: '', h1: '' });
  assert.equal(readMeta("<meta name='description' content='Single quotes'>").description, 'Single quotes');
});

test('tradeWords / tradeNoun: the owner word, the TRADES noun and its aliases', () => {
  const w = tradeWords('plumbing');
  assert.ok(w.includes('plumbing') && w.includes('plumber'));
  assert.ok(tradeWords('HVAC').includes('air conditioning'));
  assert.deepEqual(tradeWords(''), []);
  assert.deepEqual(tradeWords('pool cleaning'), ['pool cleaning'], 'unknown trade: just the owner word');
  assert.equal(tradeNoun('plumbing'), 'plumber');
  assert.equal(tradeNoun('mechanic'), 'auto repair shop');
});

test('mentionsAny: whole words, plurals, hyphens in URLs; no partial-word hits', () => {
  assert.equal(mentionsAny('Top Plumbers on Long Island', ['plumber']), true);
  assert.equal(mentionsAny('/services/water-heater-repair', ['water heater']), true);
  assert.equal(mentionsAny('/north-babylon-laundromat', ['North Babylon']), true);
  assert.equal(mentionsAny('Roofing', ['roof']), false, '"roof" is not a whole word in "Roofing"');
  assert.equal(mentionsAny('', ['x']), false);
});

test('metaCheck: says the trade and the town (title, description or H1); null when unknown', () => {
  const html = '<title>Acme Plumbing</title><h1>Serving Massapequa since 1990</h1>';
  const m = metaCheck(html, BIZ);
  assert.equal(m.mentionsTrade, true);
  assert.equal(m.mentionsTown, true);
  const bare = metaCheck('<title>Acme</title>', BIZ);
  assert.equal(bare.mentionsTrade, false);
  assert.equal(bare.mentionsTown, false);
  const unknown = metaCheck('<title>Acme</title>', {});
  assert.equal(unknown.mentionsTrade, null);
  assert.equal(unknown.mentionsTown, null);
});

// ---------------------------------------------------------------------------
// internal links
// ---------------------------------------------------------------------------

test('readLinks: same-site pages only, one per path, assets and anchors skipped', () => {
  const html = `<a href="/services/drain-cleaning">Drain cleaning</a>
    <a href="https://www.acme.com/services/drain-cleaning/">dup</a>
    <a href='/about'>About</a>
    <a href="https://facebook.com/acme">FB</a>
    <a href="#top">Top</a><a href="tel:5165550142">Call</a><a href="mailto:a@acme.com">Mail</a>
    <a href="/">Home</a><a href="/menu.pdf">Menu</a>
    <a href="/areas/massapequa-park">Massapequa Park</a>
    <a href="/service-area">Where we work</a>`;
  const links = readLinks(html, 'https://acme.com/');
  assert.deepEqual(links.map((l) => l.path), ['/services/drain-cleaning', '/about', '/areas/massapequa-park', '/service-area']);
  assert.equal(links[0].text, 'Drain cleaning');
  assert.deepEqual(readLinks(html, 'not a url'), []);
});

test('countPages: service pages (says "service" or the trade) and town pages (town, nearby town, service area)', () => {
  const links = [
    { path: '/services/drain-cleaning', text: 'Drain cleaning' },
    { path: '/water-heaters', text: 'Plumber for water heaters' },
    { path: '/about', text: 'About us' },
    { path: '/areas/massapequa-park', text: 'Massapequa Park' },
    { path: '/where', text: 'Areas we serve' },
    { path: '/seaford', text: 'Seaford' },
  ];
  assert.deepEqual(countPages(links, { ...BIZ, nearbyTown: 'Seaford' }), { internalLinks: 6, servicePages: 2, townPages: 3 });
  assert.deepEqual(countPages([], BIZ), { internalLinks: 0, servicePages: 0, townPages: 0 });
});

// ---------------------------------------------------------------------------
// llms.txt, https, PageSpeed
// ---------------------------------------------------------------------------

test('isLlmsTxt: a real text file counts; empty, HTML or a failed fetch does not', () => {
  assert.equal(isLlmsTxt({ ok: true, contentType: 'text/plain', text: '# Acme\n> Plumber' }), true);
  assert.equal(isLlmsTxt({ ok: true, contentType: '', text: '# Acme' }), true);
  assert.equal(isLlmsTxt({ ok: true, contentType: 'text/html; charset=utf-8', text: '# Acme' }), false);
  assert.equal(isLlmsTxt({ ok: true, contentType: 'text/plain', text: '<!DOCTYPE html><html>' }), false);
  assert.equal(isLlmsTxt({ ok: true, contentType: 'text/plain', text: '   ' }), false);
  assert.equal(isLlmsTxt({ ok: false, status: 404, text: '' }), false);
  assert.equal(isLlmsTxt(null), false);
});

/** A fake fetch from a { url: Response | () => Response } map; anything else 404. */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    const r = routes[u];
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(u, init);
    if (r) return r.clone ? r.clone() : r;
    return new Response('not found', { status: 404 });
  };
  f.calls = calls;
  return f;
}
const redirect = (to, status = 301) => new Response('', { status, headers: { location: to } });

test('httpRedirectsToHttps: follows a chain by hand; plain http → false; errors → null', async () => {
  const chain = fakeFetch({ 'http://acme.com/': redirect('http://www.acme.com/'), 'http://www.acme.com/': redirect('https://www.acme.com/') });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: chain }), true);
  assert.ok(chain.calls.every((c) => c.init.redirect === 'manual'));
  const plain = fakeFetch({ 'http://acme.com/': new Response('<html>hi</html>') });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: plain }), false);
  const relative = fakeFetch({ 'http://acme.com/': redirect('/home'), 'http://acme.com/home': new Response('ok') });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: relative }), false);
  const down = fakeFetch({ 'http://acme.com/': new TypeError('fetch failed') });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: down }), null);
  const forbidden = fakeFetch({ 'http://acme.com/': new Response('no', { status: 403 }) });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: forbidden }), null);
  const loop = fakeFetch({ 'http://acme.com/': redirect('http://acme.com/') });
  assert.equal(await httpRedirectsToHttps('http://acme.com/', { fetchImpl: loop, maxHops: 2 }), false);
});

test('parsePageSpeed: performance score 0-1 → 0-100; anything else null', () => {
  assert.equal(parsePageSpeed({ lighthouseResult: { categories: { performance: { score: 0.414 } } } }), 41);
  assert.equal(parsePageSpeed({ lighthouseResult: { categories: { performance: { score: 1 } } } }), 100);
  assert.equal(parsePageSpeed({ lighthouseResult: { categories: { performance: { score: null } } } }), null);
  assert.equal(parsePageSpeed({ error: { code: 403 } }), null);
  assert.equal(parsePageSpeed(null), null);
});

test('checkSpeed: no key → no call; PAGESPEED_API_KEY first, else the Places key; failures → null', async () => {
  const psi = (score) => () => Response.json({ lighthouseResult: { categories: { performance: { score } } } });
  const calls = [];
  const f = async (url, init) => { calls.push(String(url)); return psi(0.62)(url, init); };
  assert.equal(await checkSpeed('https://acme.com/', {}, { fetchImpl: f }), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(await checkSpeed('https://acme.com/', { PAGESPEED_API_KEY: 'psi', GOOGLE_PLACES_API_KEY: 'places' }, { fetchImpl: f }), { score: 62, strategy: 'mobile' });
  const u = new URL(calls[0]);
  assert.equal(u.origin + u.pathname, PAGESPEED_URL);
  assert.equal(u.searchParams.get('key'), 'psi');
  assert.equal(u.searchParams.get('strategy'), 'mobile');
  assert.equal(u.searchParams.get('category'), 'performance');
  assert.equal(u.searchParams.get('url'), 'https://acme.com/');
  await checkSpeed('https://acme.com/', { GOOGLE_PLACES_API_KEY: 'places' }, { fetchImpl: f });
  assert.equal(new URL(calls[1]).searchParams.get('key'), 'places');
  assert.equal(await checkSpeed('https://acme.com/', { PAGESPEED_API_KEY: 'k' }, { fetchImpl: async () => new Response('forbidden', { status: 403 }) }), null);
  // A slow PageSpeed run is skipped at the timeout, never waited on forever.
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  assert.equal(await checkSpeed('https://acme.com/', { PAGESPEED_API_KEY: 'k' }, { fetchImpl: hang, timeoutMs: 20 }), null);
  assert.equal(resolveKeys({ PSI_API_KEY: 'x' }).pagespeedKey, 'x');
});

// ---------------------------------------------------------------------------
// checkSite: every new field
// ---------------------------------------------------------------------------

const GOOD_HOME = `<html><head><title>Acme Plumbing | Plumber in Massapequa, NY</title>
<meta name="description" content="Acme Plumbing is a plumber serving Massapequa, NY.">
<script type="application/ld+json">[{"@type":"Plumber","name":"Acme Plumbing","telephone":"516-555-0142","address":"12 Main St, Massapequa, NY 11758"},
{"@type":"FAQPage","mainEntity":[]}]</script></head>
<body><h1>Massapequa plumber</h1><a href="/services">Services</a><a href="/service-area">Service area</a><a href="/about">About</a></body></html>`;

test('checkSite: llms.txt, https + redirect, meta, FAQ schema, pages and speed', async () => {
  const f = fakeFetch({
    'https://acme.com/': new Response(GOOD_HOME, { headers: { 'content-type': 'text/html' } }),
    'https://acme.com/robots.txt': new Response('User-agent: *\nDisallow:\nSitemap: https://acme.com/sitemap.xml'),
    'https://acme.com/llms.txt': new Response('# Acme Plumbing\n> Plumber in Massapequa', { headers: { 'content-type': 'text/plain' } }),
    'http://acme.com/': redirect('https://acme.com/'),
    [`${PAGESPEED_URL}?url=${encodeURIComponent('https://acme.com/')}&strategy=mobile&category=performance&key=k`]: Response.json({ lighthouseResult: { categories: { performance: { score: 0.93 } } } }),
  });
  const sc = await checkSite('acme.com', { fetchImpl: f, business: BIZ, env: { PAGESPEED_API_KEY: 'k' } });
  assert.equal(sc.reachable, true);
  assert.equal(sc.llmsTxt, true);
  assert.deepEqual(sc.https, { loads: true, redirects: true });
  assert.equal(sc.meta.title, 'Acme Plumbing | Plumber in Massapequa, NY');
  assert.equal(sc.meta.mentionsTrade, true);
  assert.equal(sc.meta.mentionsTown, true);
  assert.equal(sc.faqSchema, true);
  assert.deepEqual(sc.pages, { internalLinks: 3, servicePages: 2, townPages: 1 });
  assert.deepEqual(sc.speed, { score: 93, strategy: 'mobile' });
  assert.deepEqual(siteIssues({ siteCheck: sc, business: BIZ }), [], 'a site that passes every check gets no fixes');
});

test('checkSite: https down but http works → reachable over http, https.loads false; no key → speed null', async () => {
  const f = fakeFetch({
    'https://acme.com/': new TypeError('cert error'),
    'http://acme.com/': new Response('<title>Acme</title>', { headers: { 'content-type': 'text/html' } }),
    'http://acme.com/llms.txt': new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }),
  });
  const sc = await checkSite('acme.com', { fetchImpl: f, business: BIZ });
  assert.equal(sc.reachable, true);
  assert.equal(sc.url, 'http://acme.com');
  assert.deepEqual(sc.https, { loads: false, redirects: null });
  assert.equal(sc.llmsTxt, false, 'an HTML page at /llms.txt is not an llms.txt');
  assert.equal(sc.faqSchema, false);
  assert.equal(sc.speed, null);
  assert.ok(!f.calls.some((c) => c.u.startsWith(PAGESPEED_URL)));
  const kinds = siteIssues({ siteCheck: sc, business: BIZ }).map((i) => i.kind);
  assert.deepEqual(kinds, ['site_no_https', 'site_no_llms_txt', 'site_title_meta', 'site_no_faq_schema', 'site_thin_pages']);
});

test('checkSite: unreachable site → new fields empty, never an error', async () => {
  const sc = await checkSite('acme.com', { fetchImpl: fakeFetch({}), business: BIZ, env: { PAGESPEED_API_KEY: 'k' } });
  assert.equal(sc.reachable, false);
  assert.equal(sc.meta, null);
  assert.equal(sc.pages, null);
  assert.equal(sc.faqSchema, null);
  assert.equal(sc.speed, null);
  assert.equal(sc.llmsTxt, false);
  assert.deepEqual(siteIssues({ siteCheck: sc, business: BIZ }), []);
});

// ---------------------------------------------------------------------------
// site fixes
// ---------------------------------------------------------------------------

const BAD_SITE = {
  url: 'https://acme.com', reachable: true, robots: { found: true, blocked: [] }, sitemap: true,
  schema: { found: true, types: ['Plumber'] }, onSite: { phone: '(516) 555-0142', address: '12 Main St' },
  llmsTxt: false, https: { loads: true, redirects: false },
  meta: { title: 'Home', description: '', h1: '', mentionsTrade: false, mentionsTown: false },
  faqSchema: false, pages: { internalLinks: 4, servicePages: 0, townPages: 2 }, speed: { score: 31, strategy: 'mobile' },
};

test('siteIssues: one fix per failing check, with honest copy and copy-paste text', () => {
  const out = siteIssues({ siteCheck: BAD_SITE, business: BIZ });
  const byKind = Object.fromEntries(out.map((i) => [i.kind, i]));
  assert.deepEqual(out.map((i) => i.kind), ['site_http_no_redirect', 'site_no_llms_txt', 'site_title_meta', 'site_no_faq_schema', 'site_thin_pages', 'site_slow']);
  assert.ok(out.every((i) => i.severity !== 'high'), 'a blocked AI crawler stays the only high website fix');
  assert.equal(byKind.site_title_meta.severity, 'medium');
  assert.match(byKind.site_title_meta.title, /don’t say what you do and where you work/);
  assert.equal(byKind.site_title_meta.copyText[0].text, 'Acme Plumbing | Plumber in Massapequa, NY');
  assert.match(byKind.site_no_llms_txt.copyText[0].text, /^# Acme Plumbing\n\n> Acme Plumbing is a plumber serving Massapequa, NY\./);
  assert.equal(JSON.parse(byKind.site_no_faq_schema.copyText[0].text)['@type'], 'FAQPage');
  assert.match(byKind.site_slow.title, /31 out of 100/);
  assert.match(byKind.site_thin_pages.title, /pages about your services$/);
  // Our copy: no banned words anywhere.
  for (const i of out) {
    for (const s of [i.title, i.description, ...(i.steps || []), ...(i.copyText || []).flatMap((c) => [c.label, c.text])]) {
      assert.deepEqual(lintText(s), [], s);
    }
  }
  // Only the description missing: a low fix with no title suggestion.
  const descOnly = siteIssues({ siteCheck: { ...BAD_SITE, llmsTxt: true, https: { loads: true, redirects: true }, faqSchema: true, pages: null, speed: { score: 70 }, meta: { title: 'Acme Plumbing Massapequa', description: '', h1: 'x', mentionsTrade: true, mentionsTown: true } }, business: BIZ });
  assert.deepEqual(descOnly.map((i) => [i.kind, i.severity]), [['site_title_meta', 'low']]);
  assert.deepEqual(descOnly[0].copyText.map((c) => c.label), ['Suggested meta description']);
  // Fields that were never checked raise nothing (an older siteCheck).
  assert.deepEqual(siteIssues({ siteCheck: { url: 'https://acme.com', reachable: true, onSite: {} }, business: BIZ }), []);
});

test('suggestMeta / llmsTxtSkeleton / faqJsonLd: built from the owner details only', () => {
  assert.deepEqual(suggestMeta(BIZ, '(516) 555-0142'), {
    title: 'Acme Plumbing | Plumber in Massapequa, NY',
    description: 'Acme Plumbing is a plumber serving Massapequa, NY and nearby towns. Call (516) 555-0142.',
  });
  assert.equal(suggestMeta({ name: 'Volt Co', trade: 'electrician' }).description, 'Volt Co is an electrician.');
  assert.match(llmsTxtSkeleton(BIZ, BAD_SITE), /- Phone: \(516\) 555-0142\n- Address: 12 Main St\n- Website: https:\/\/acme\.com\//);
  const faq = JSON.parse(faqJsonLd(BIZ, '(516) 555-0142'));
  assert.deepEqual(faq.mainEntity.map((x) => x.name), ['What does Acme Plumbing do?', 'What areas does Acme Plumbing serve?', 'How do I contact Acme Plumbing?']);
});

// ---------------------------------------------------------------------------
// Google reviews
// ---------------------------------------------------------------------------

test('placeReviews: rating to one decimal, count defaults to 0', () => {
  assert.deepEqual(placeReviews({ rating: 4.66, userRatingCount: 38 }), { rating: 4.7, count: 38 });
  assert.deepEqual(placeReviews({}), { rating: null, count: 0 });
  assert.deepEqual(placeReviews(null), { rating: null, count: 0 });
});

/** A fake Places API: answers each Text Search from `byQuery(textQuery, fieldMask)`. */
function placesFetch(byQuery) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u !== PLACES_URL) return new Response('not found', { status: 404 });
    const body = JSON.parse(init.body);
    calls.push({ q: body.textQuery, mask: init.headers['X-Goog-FieldMask'], key: init.headers['X-Goog-Api-Key'] });
    const r = byQuery(body.textQuery, init.headers['X-Goog-FieldMask']);
    return r instanceof Response ? r : Response.json({ places: r || [] });
  };
  f.calls = calls;
  return f;
}

test('lookupCompetitorReviews: "<name> <town> <state>", capped at 3, name must match, fails soft', async () => {
  const f = placesFetch((q) => {
    if (q.startsWith('Tidewater')) return [{ id: 't1', displayName: { text: 'Tidewater Plumbing Co.' }, rating: 4.8, userRatingCount: 212, googleMapsUri: 'https://maps.google.com/?cid=9' }];
    if (q.startsWith('Kessler')) return [{ displayName: { text: 'Some Other Business' }, rating: 5, userRatingCount: 3 }];
    if (q.startsWith('Broken')) return new Response('quota', { status: 429 });
    return [{ displayName: { text: q.replace(/ Massapequa NY$/, '') } }];
  });
  const names = ['Tidewater Plumbing Co.', 'Kessler Bros', 'Broken Pipe Inc', 'Fourth Plumbing'];
  const out = await lookupCompetitorReviews(names, BIZ, { GOOGLE_PLACES_API_KEY: 'k' }, { fetchImpl: f });
  assert.equal(f.calls.length, MAX_REVIEW_LOOKUPS);
  assert.deepEqual(f.calls.map((c) => c.q), ['Tidewater Plumbing Co. Massapequa NY', 'Kessler Bros Massapequa NY', 'Broken Pipe Inc Massapequa NY']);
  assert.ok(f.calls.every((c) => c.mask === REVIEW_FIELDS && c.key === 'k'));
  assert.deepEqual(out, [{ name: 'Tidewater Plumbing Co.', rating: 4.8, count: 212, placeUrl: 'https://maps.google.com/?cid=9' }]);
  assert.deepEqual(await lookupCompetitorReviews(names, BIZ, {}, { fetchImpl: f }), [], 'no key, no lookups');
  assert.equal(f.calls.length, MAX_REVIEW_LOOKUPS);
  const thrown = await lookupCompetitorReviews(['X Co'], BIZ, { GOOGLE_PLACES_API_KEY: 'k' }, { fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(thrown, []);
});

test('runOwnerChecks: the owner listing brings its rating, count and Place ID', async () => {
  const f = placesFetch(() => [{ id: 'ChIJacme', displayName: { text: 'Acme Plumbing' }, websiteUri: 'https://acme.com', rating: 4.6, userRatingCount: 38 }]);
  const r = await runOwnerChecks({ name: 'Acme Plumbing', town: 'Massapequa' }, { GOOGLE_PLACES_API_KEY: 'k' }, { fetchImpl: f });
  assert.deepEqual(r.reviews, { rating: 4.6, count: 38, placeId: 'ChIJacme' });
  assert.match(f.calls[0].mask, /places\.rating,places\.userRatingCount/);
  const none = await runOwnerChecks({ name: 'Acme Plumbing' }, {}, { fetchImpl: f });
  assert.equal(none.reviews, null);
});

test('reviewsIssue: under half the top competitor (10+ reviews) → a fix with the review link', () => {
  const reviews = { you: { rating: 4.6, count: 38 }, competitors: [{ name: 'Kessler Bros', rating: 4.7, count: 60 }, { name: 'Tidewater Plumbing Co.', rating: 4.8, count: 212 }] };
  const i = reviewsIssue({ reviews, placeId: 'ChIJacme', business: BIZ });
  assert.equal(i.kind, 'few_reviews');
  assert.equal(i.severity, 'medium');
  assert.ok(!/\d|Tidewater/.test(i.title), 'the title (free on a locked report) has no names or numbers');
  assert.match(i.description, /Tidewater Plumbing Co\. has 212 Google reviews, rated 4\.8★\. Acme Plumbing has 38, rated 4\.6★\./);
  assert.equal(i.copyText[0].text, reviewLink('ChIJacme'));
  assert.equal(reviewLink('ChIJacme'), 'https://search.google.com/local/writereview?placeid=ChIJacme');
  assert.match(i.copyText[1].text, /in Massapequa find us: https:\/\/search\.google\.com/);
  // No Place ID: steps point to the Business Profile, no copy text.
  const noId = reviewsIssue({ reviews, business: BIZ });
  assert.equal(noId.copyText, undefined);
  assert.match(noId.steps[1], /Ask for reviews/);
  // Half or more, a small competitor, or no owner listing: no fix.
  assert.equal(reviewsIssue({ reviews: { ...reviews, you: { rating: 4.9, count: 106 } }, business: BIZ }), null);
  assert.equal(reviewsIssue({ reviews: { you: { rating: 5, count: 2 }, competitors: [{ name: 'X Co', rating: 5, count: 9 }] }, business: BIZ }), null);
  assert.equal(reviewsIssue({ reviews: { you: null, competitors: reviews.competitors }, business: BIZ }), null);
  assert.equal(reviewsIssue({ reviews: null, business: BIZ }), null);
  for (const s of [i.title, i.description, ...i.steps, ...i.copyText.map((c) => c.text)]) assert.deepEqual(lintText(s), [], s);
});

// ---------------------------------------------------------------------------
// the report: gap sheet merge, validation, buildReport end to end
// ---------------------------------------------------------------------------

function miniReport(reviews) {
  const ans = (id, names) => {
    let text = 'Try ';
    const businessesNamed = names.map(([name, entityId]) => { const pos = text.length; text += `${name}, `; return { name, pos, entityId }; });
    return { id, questionId: 'q1', engine: 'chatgpt', run: 1, text, businessesNamed, namedYou: false, citations: [] };
  };
  return {
    business: { name: 'Otter Plumbing' },
    answers: [ans('a1', [['Tidewater Plumbing Co.', 'e1'], ['Kessler Bros', 'e2']]), ans('a2', [['Kessler Bros', 'e2'], ['Tidewater Plumbing Co.', 'e1']])],
    entities: [
      { id: 'e1', name: 'Tidewater Plumbing Co.', aliases: ['Tidewater Plumbing'], named: 2, first: 1, answerIds: ['a1', 'a2'] },
      { id: 'e2', name: 'Kessler Bros', named: 2, first: 1, answerIds: ['a1', 'a2'] },
    ],
    sources: [],
    ...(reviews !== undefined ? { reviews } : {}),
  };
}

test('buildGapSheet: competitors carry their Google reviews, the sheet carries yours', () => {
  const g = buildGapSheet(miniReport({ you: { rating: 4.6, count: 38 }, competitors: [{ name: 'Tidewater Plumbing', rating: 4.8, count: 212 }] }));
  const t = g.competitors.find((c) => c.id === 'e1');
  const k = g.competitors.find((c) => c.id === 'e2');
  assert.deepEqual(t.reviews, { rating: 4.8, count: 212 }, 'matched through an alias');
  assert.equal(k.reviews, undefined, 'not found on Google: no reviews field');
  assert.deepEqual(g.youReviews, { rating: 4.6, count: 38 });
  const noListing = buildGapSheet(miniReport({ you: null, competitors: [] }));
  assert.equal(noListing.youReviews, null);
  const older = buildGapSheet(miniReport(undefined));
  assert.ok(!('youReviews' in older), 'a report without reviews builds the same sheet as before');
  assert.ok(older.competitors.every((c) => !('reviews' in c)));
});

test('validateReport: reviews are optional; when present their shape and names are checked', () => {
  const v2 = JSON.parse(JSON.stringify(MOCK_REPORTS['sample-001']));
  assert.equal(validateReport(v2).ok, true, validateReport(v2).errors.join('\n'));
  const errs = (reviews) => validateReport({ ...v2, reviews }).errors.filter((e) => e.startsWith('reviews'));
  assert.deepEqual(errs(undefined), []);
  assert.deepEqual(errs(null), []);
  assert.deepEqual(errs({ you: null, competitors: [] }), []);
  assert.deepEqual(errs({ you: { rating: null, count: 0 }, competitors: [{ name: 'Tidewater Plumbing Co.', rating: 4.8, count: 212, placeUrl: 'https://maps.google.com/?cid=1' }] }), []);
  assert.equal(errs([]).length, 1);
  assert.equal(errs({ you: null }).length, 1, 'competitors must be an array');
  assert.match(errs({ you: { rating: 7, count: 3 }, competitors: [] })[0], /reviews\.you\.rating/);
  assert.match(errs({ you: { rating: 4, count: -1 }, competitors: [] })[0], /reviews\.you\.count/);
  assert.match(errs({ you: null, competitors: [{ name: 'Made Up Plumbing', rating: 5, count: 1 }] })[0], /not a competitor named in the answers/);
  assert.match(errs({ you: null, competitors: [{ name: 'Tidewater Plumbing Co.', rating: '4.8', count: 1 }] })[0], /rating/);
  assert.match(errs({ you: null, competitors: [{ name: 'Tidewater Plumbing Co.', rating: 4.8, count: 1.5 }] })[0], /count/);
  assert.match(errs({ you: null, competitors: [{ name: '' }] })[0], /name is empty/);
});


test('sample report: shows the new site rows and reviews, and the X-Ray merges them', () => {
  const s = MOCK_REPORTS['sample-001'];
  assert.equal(typeof s.siteCheck.speed.score, 'number');
  assert.ok(s.issues.some((i) => i.kind === 'few_reviews'));
  const g = xraySections(s).gapSheet;
  assert.ok(g.competitors.some((c) => c.reviews && c.reviews.count > 0));
  assert.deepEqual(g.youReviews, s.reviews.you);
});

test('buildReport: owner + top-competitor reviews land on the report, the gap sheet and a fix', async () => {
  const dir = new URL('./fixtures/megawash/', import.meta.url);
  const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const business = load('business.json');
  const f = placesFetch((q) => {
    if (q.startsWith('Mega Wash')) return [{ id: 'ChIJmega', displayName: { text: 'Mega Wash & Dry' }, websiteUri: 'https://megawashanddry.com', rating: 4.5, userRatingCount: 20 }];
    // Every competitor is "found" under the name searched.
    return [{ displayName: { text: q.replace(/ North Babylon NY$/, '') }, rating: 4.8, userRatingCount: 300 }];
  });
  const { report } = await buildReport({
    scan: load('scan.json'), business, proposalsByAnswer: load('proposals.json').proposals,
    env: { GOOGLE_PLACES_API_KEY: 'k' }, fetchImpl: f,
  });
  const expected = buildGapSheet({ ...report, reviews: undefined }).competitors.slice(0, 3).map((c) => c.name);
  assert.ok(expected.length >= 1, 'fixture has competitors named in 2+ answers');
  assert.deepEqual(report.reviews.you, { rating: 4.5, count: 20 });
  assert.deepEqual(report.reviews.competitors.map((c) => c.name), expected);
  assert.ok(report.reviews.competitors.every((c) => c.rating === 4.8 && c.count === 300));
  const reviewErrors = validateReport(report).errors.filter((e) => e.startsWith('reviews'));
  assert.deepEqual(reviewErrors, []);
  const fix = report.issues.find((i) => i.kind === 'few_reviews');
  assert.ok(fix, 'owner has 20 reviews vs 300: a fix');
  assert.equal(fix.copyText[0].text, reviewLink('ChIJmega'));
  const g = xraySections(report).gapSheet;
  assert.deepEqual(g.youReviews, { rating: 4.5, count: 20 });
  assert.ok(g.competitors.slice(0, expected.length).every((c) => c.reviews && c.reviews.count === 300));
});

test('buildReport: no Places key → no reviews field and no lookups', async () => {
  const dir = new URL('./fixtures/megawash/', import.meta.url);
  const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  const f = placesFetch(() => []);
  const { report } = await buildReport({
    scan: load('scan.json'), business: load('business.json'), proposalsByAnswer: load('proposals.json').proposals, env: {}, fetchImpl: f,
  });
  assert.equal(report.reviews, undefined);
  assert.equal(f.calls.length, 0);
});
