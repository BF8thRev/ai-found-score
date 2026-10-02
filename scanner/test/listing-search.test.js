// Listed or not, through Google (paid tiers only): scanner/extract/listing-search.js. Directories that turn
// our page reads away (clutch.co, themanifest.com: 403 / bot wall) are looked up through Gemini's Google
// Search grounding. "Listed" only on evidence from the search itself on the directory's own domain.
// Every lookup here is a fake: no API is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptListing, namesBusiness, listingSearchPrompt, searchListings, searchable, listingSearchFor, geminiListingSearch,
  MAX_LISTING_SEARCHES, LISTING_SEARCH_TRIGGERS,
} from '../extract/listing-search.js';
import { joinHints, buildSources } from '../extract/sources.js';
import { DIRECTORIES, JOIN_TYPES, JOIN_LABELS, directoryFor, joinFor } from '../../shared/directories.js';
import { listingUsageRow, listingIdSeed, scanTotals } from '../../src/admin/scan-core.js';
import { BUSINESS, fakeListingSearch, buildPr73Report } from './fixtures/pr73.js';

const PR73 = { name: 'PR 73', website: 'https://www.pr73.com', town: 'New York City', state: 'NY' };
const NAMES = ['PR73'];

// ---- acceptance rules ----

test('accept: a grounding citation on the directory whose path names the business → listed', () => {
  const r = acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text: 'https://clutch.co/profile/pr73', citations: [{ url: 'https://clutch.co/profile/pr73' }] });
  assert.deepEqual(r, { status: 'listed', url: 'https://clutch.co/profile/pr73', via: 'citation' });
  // Any spelling ("pr-73"), a slug that starts with the name, or a page title that names it.
  assert.equal(namesBusiness('https://clutch.co/profile/pr-73', '', PR73, NAMES), true);
  assert.equal(namesBusiness('https://www.yelp.com/biz/pr73-new-york', '', PR73, NAMES), true);
  assert.equal(namesBusiness('https://clutch.co/profile/123', 'PR73 Reviews | Clutch.co', PR73, NAMES), true);
  // A subdomain of the directory counts.
  assert.equal(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, citations: [{ url: 'https://www.clutch.co/profile/pr73' }] }).status, 'listed');
});

test('accept: off-domain, a rival’s profile, a list page, or "PR" alone → not found', () => {
  const no = (citations, text = '') => acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text, citations }).status;
  // A made-up URL off the directory's domain (look-alike host, the owner's own site): never accepted.
  assert.equal(no([{ url: 'https://clutch-reviews.example.com/profile/pr73' }], 'https://clutch-reviews.example.com/profile/pr73'), 'not_found');
  assert.equal(no([{ url: 'https://www.pr73.com/' }], 'https://www.pr73.com/'), 'not_found');
  assert.equal(no([{ url: 'https://notclutch.co/profile/pr73' }]), 'not_found');
  // On Clutch, but another firm, or a list page ("/pr-firms" is not "pr73").
  assert.equal(no([{ url: 'https://clutch.co/profile/brightline-communications' }, { url: 'https://clutch.co/pr-firms/new-york' }]), 'not_found');
  // NONE, and nothing cited.
  assert.equal(no([], 'NONE'), 'not_found');
});

test('accept: a URL only in the reply counts only when the search itself cited that directory', () => {
  const text = 'Here it is: https://clutch.co/profile/pr73.';
  // The search read Clutch (a list page): the reply's profile URL is accepted.
  assert.deepEqual(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text, citations: [{ url: 'https://clutch.co/pr-firms/new-york' }] }),
    { status: 'listed', url: 'https://clutch.co/profile/pr73', via: 'answer' });
  // A grounding redirect we couldn't follow still carries the site's domain.
  assert.equal(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text, citations: [{ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/x', domain: 'clutch.co' }] }).status, 'listed');
  // The search never touched Clutch: the model made the URL up.
  assert.equal(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text, citations: [{ url: 'https://www.pr73.com/' }] }).status, 'not_found');
  assert.equal(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text, citations: [] }).status, 'not_found');
});

test('the prompt names every spelling, the website and the directory, and asks for URL or NONE', () => {
  const p = listingSearchPrompt({ directory: 'www.clutch.co', business: PR73, names: NAMES });
  assert.match(p, /"PR 73" or "PR73"/);
  assert.match(p, /website pr73\.com/);
  assert.match(p, /on clutch\.co\./);
  assert.match(p, /NONE/);
});

// ---- which directories, how many, what it costs ----

test('searchListings: only directories we couldn’t read, one lookup per domain, capped, in parallel with a limit', async () => {
  const domains = ['clutch.co', 'themanifest.com', 'yelp.com', 'yellowpages.com', 'manta.com', 'designrush.com', 'goodfirms.co', 'upcity.com', 'sortlist.com', 'agencyspotter.com'];
  const sources = [
    ...domains.map((d, i) => ({ domain: d, url: `https://${d}/list-${i}`, citedIn: ['a1'], youListed: null })),
    { domain: 'clutch.co', url: 'https://clutch.co/other', citedIn: ['a1'], youListed: null }, // same domain: one lookup
    { domain: 'bbb.org', url: 'https://bbb.org/x', citedIn: ['a1'], youListed: false }, // read: not searched
    { domain: 'odwyerpr.com', url: 'https://odwyerpr.com/x', citedIn: ['a1'], youListed: null }, // entered by submission: no profile
    { domain: 'someblog.example.com', url: 'https://someblog.example.com/best-pr', citedIn: ['a1'], youListed: null }, // an article
    { domain: 'houzz.com', url: 'https://houzz.com/x', citedIn: ['a9'], youListed: null }, // only in an answer that named them
  ];
  let inFlight = 0;
  let peak = 0;
  const seen = [];
  const search = async ({ directory }) => {
    seen.push(directory);
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (directory === 'goodfirms.co') throw new Error('socket hang up');
    if (directory === 'manta.com') return { ok: false, error: 'HTTP 503', costUsd: 0 };
    return { ok: true, text: 'NONE', citations: [], costUsd: 0.015, searches: 1, model: 'gemini-test' };
  };
  const calls = [];
  const r = await searchListings({ sources, business: PR73, names: NAMES, search, lostIds: new Set(['a1']), onCall: (c) => calls.push(c) });
  assert.equal(MAX_LISTING_SEARCHES, 8);
  assert.equal(r.lookups, 8);
  assert.equal(seen.length, 8);
  assert.equal(new Set(seen).size, 8);
  assert.ok(peak <= 4 && peak > 1, `parallel, at most 4 at once (peak ${peak})`);
  assert.ok(!seen.some((d) => ['bbb.org', 'odwyerpr.com', 'someblog.example.com', 'houzz.com'].includes(d)));
  assert.equal(seen[0], 'clutch.co', 'cited most in lost answers goes first');
  // Cost: 6 billed lookups at $0.015 (the failures cost nothing here), each handed to onCall for scan_usage.
  assert.equal(r.costUsd, 0.09);
  assert.equal(calls.length, 8);
  // Each source on a searched domain gets the verdict; failures are "error", never "not found".
  assert.deepEqual(sources.filter((s) => s.domain === 'clutch.co').map((s) => s.searchCheck.status), ['not_found', 'not_found']);
  assert.equal(sources.find((s) => s.domain === 'goodfirms.co').searchCheck.status, 'error');
  // Past the cap (8): not looked up, left as "couldn't check".
  assert.equal(sources.find((s) => s.domain === 'yelp.com').searchCheck, undefined);
  assert.equal(sources.find((s) => s.domain === 'manta.com').searchCheck.status, 'error');
  assert.equal(sources.find((s) => s.domain === 'clutch.co').youListed, null, 'not found in search is never "not listed"');
  assert.equal(sources.find((s) => s.domain === 'bbb.org').searchCheck, undefined);
  // No search function (a free scan): nothing happens.
  assert.deepEqual(await searchListings({ sources: [{ domain: 'yelp.com', citedIn: ['a1'], youListed: null }], business: PR73, search: null }), { lookups: 0, costUsd: 0, calls: [] });
  assert.equal(searchable('www.clutch.co'), true);
  assert.equal(searchable('provokemedia.com'), false);
  assert.equal(searchable('reddit.com'), false);
});

test('only the paid tiers search: the paid audit, its re-check, Be the Answer monthly; never a free report', () => {
  const env = { GEMINI_API_KEY: 'test-key' };
  assert.deepEqual([...LISTING_SEARCH_TRIGGERS], ['paid', 'recheck', 'monthly']);
  for (const t of ['paid', 'recheck', 'monthly']) assert.equal(typeof listingSearchFor({ trigger: t, env }), 'function', t);
  for (const t of ['request', 'admin', undefined, '']) assert.equal(listingSearchFor({ trigger: t, env }), null, String(t));
  assert.equal(listingSearchFor({ trigger: 'paid', env: {} }), null, 'no Gemini key: no lookup');
});

test('geminiListingSearch: one grounded Gemini call, redirects followed, searches and cost from the reply', async () => {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    sent.push({ u, init });
    if (u.endsWith(':generateContent')) {
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'https://clutch.co/profile/pr73' }] }, finishReason: 'STOP', groundingMetadata: {
          webSearchQueries: ['PR73 site:clutch.co'],
          groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'clutch.co' } }],
        } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
      });
    }
    if (u.includes('grounding-api-redirect')) return new Response(null, { status: 302, headers: { location: 'https://clutch.co/profile/pr73' } });
    return new Response('no', { status: 404 });
  };
  const search = geminiListingSearch({ env: { GEMINI_API_KEY: 'test-key' }, fetchImpl });
  const r = await search({ directory: 'clutch.co', prompt: listingSearchPrompt({ directory: 'clutch.co', business: PR73, names: NAMES }) });
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.match(body.contents[0].parts[0].text, /on clutch\.co/);
  assert.equal(r.ok, true);
  assert.equal(r.searches, 1);
  assert.equal(r.citations[0].url, 'https://clutch.co/profile/pr73');
  // 1 search at $0.014 list price + 100 in × $0.75/M + 20 out × $3.75/M.
  assert.equal(r.costUsd, 0.01415);
  assert.deepEqual(acceptListing({ directory: 'clutch.co', business: PR73, names: NAMES, text: r.text, citations: r.citations }).status, 'listed');
});

test('scan_usage: each lookup is a "listing" row with its searches and cost; the scan total counts it', () => {
  const row = listingUsageRow({ id: 'u1', scanId: '11111111-2222-4333-8444-555555555555', call: { domain: 'clutch.co', ok: true, costUsd: 0.0151, model: 'gemini-test', usage: { inputTokens: 120, outputTokens: 40 }, searches: 1 } });
  assert.deepEqual(
    [row.kind, row.provider, row.model, row.searches, row.cost_usd, row.input_tokens, row.output_tokens, row.answer_ref, row.ok],
    ['listing', 'google', 'gemini-test', 1, 0.0151, 120, 40, 'listing:clutch.co', true],
  );
  assert.equal(listingIdSeed('s1', 'clutch.co'), 's1:listing:clutch.co');
  assert.equal(listingIdSeed('s1', 'clutch.co', 2), 's1:listing:clutch.co:a2');
  const t = scanTotals({ calls: [{ ok: true, costUsd: 0.1 }], extractions: [{ ok: true, costUsd: 0.2 }], build: { valid: true, listingCostUsd: 0.0453 } });
  assert.equal(t.total_cost_usd, 0.3453);
});

// ---- the scan's path: buildReport with a paid-tier lookup ----

test('buildReport (paid): the 3 directories we couldn’t read are looked up; Clutch listed, Manifest not found, DesignRush’s made-up URL rejected', async () => {
  const search = fakeListingSearch();
  const usage = [];
  const { report, validation, listingSearch } = await buildPr73Report({ listingSearch: search, onListingSearch: (c) => usage.push(c) });
  assert.deepEqual(validation.errors, []);
  assert.deepEqual(search.asked.map((a) => a.directory).sort(), ['clutch.co', 'designrush.com', 'themanifest.com']);
  const by = (d) => report.sources.find((s) => s.domain === d);
  assert.deepEqual([by('clutch.co').youListed, by('clutch.co').listedBy, by('clutch.co').profileUrl, by('clutch.co').searchCheck.status], [true, 'search', 'https://clutch.co/profile/pr73', 'listed']);
  assert.deepEqual([by('themanifest.com').youListed, by('themanifest.com').searchCheck.status], [null, 'not_found']);
  assert.deepEqual([by('designrush.com').youListed, by('designrush.com').searchCheck.status], [null, 'not_found']);
  // Pages we read are never searched again.
  assert.equal(by('communicationsmatch.com').searchCheck, undefined);
  assert.equal(by('publicrelationsdatabase.com').searchCheck, undefined);
  assert.deepEqual(report.method.listingSearch, { engine: 'gemini', lookups: 3, max: 8 });
  assert.deepEqual(listingSearch, { calls: 3, costUsd: 0.0453 });
  assert.equal(usage.length, 3);
  // A build without the lookup (a free report): nothing searched, nothing marked.
  const free = await buildPr73Report();
  assert.equal(free.report.method.listingSearch, undefined);
  assert.ok(free.report.sources.every((s) => !s.searchCheck));
  assert.deepEqual(free.listingSearch, { calls: 0, costUsd: 0 });
});

// ---- free to join: the table and our best read ----

test('directory table: every entry has a join type, a source on the date it was checked, and https links', () => {
  const need = ['clutch.co', 'themanifest.com', 'goodfirms.co', 'designrush.com', 'upcity.com', 'sortlist.com', 'agencyspotter.com',
    'communicationsmatch.com', 'publicrelationsdatabase.com', 'odwyerpr.com', 'provokemedia.com', 'prweek.com', 'yelp.com', 'bbb.org',
    'angi.com', 'homeadvisor.com', 'thumbtack.com', 'houzz.com', 'yellowpages.com', 'manta.com', 'nextdoor.com', 'business.google.com',
    'bingplaces.com', 'businessconnect.apple.com', 'facebook.com', 'avvo.com', 'justia.com', 'healthgrades.com', 'zocdoc.com',
    'tripadvisor.com', 'theknot.com'];
  for (const d of need) assert.ok(DIRECTORIES.some((x) => x.domain === d), d);
  assert.equal(new Set(DIRECTORIES.map((d) => d.domain)).size, DIRECTORIES.length, 'no duplicates');
  for (const d of DIRECTORIES) {
    assert.ok(JOIN_TYPES.includes(d.joinType), `${d.domain}: ${d.joinType}`);
    assert.match(d.source, /^https:\/\//, `${d.domain} source`);
    assert.equal(d.checked, '2026-10-02', `${d.domain} checked`);
    assert.ok(d.signUpUrl === null || /^https:\/\//.test(d.signUpUrl), `${d.domain} signUpUrl`);
    assert.ok(d.time === null || (typeof d.time === 'string' && !/minutes|rank/i.test(d.time)), `${d.domain} time`);
  }
  // Unverified is "unknown", with no label shown.
  assert.equal(directoryFor('publicrelationsdatabase.com').joinType, 'unknown');
  assert.equal(JOIN_LABELS.unknown, null);
  assert.equal(directoryFor('https://www.clutch.co/pr-firms/new-york').domain, 'clutch.co');
  assert.equal(directoryFor('lawyers.justia.com').domain, 'justia.com');
  assert.equal(directoryFor('example.com'), null);
  assert.deepEqual(joinFor('www.odwyerpr.com').label, 'Entry fee');
});

test('our best read of an uncatalogued page: a "get listed" link, and free or a fee', () => {
  const base = 'https://lists.example.com/pr/new-york';
  assert.deepEqual(joinHints('<a href="/add">Add your agency</a> <p>Listing is free of charge.</p>', base), { verdict: 'looks_free', url: 'https://lists.example.com/add', feeUrl: null });
  assert.deepEqual(joinHints('<a href="/submit">Submit your agency</a> <a href="/pricing">Pricing</a>', base), { verdict: 'has_fee', url: 'https://lists.example.com/submit', feeUrl: 'https://lists.example.com/pricing' });
  assert.equal(joinHints('<p>Entry fee: $350 per entry.</p>', base).verdict, 'has_fee');
  assert.deepEqual(joinHints('<a href="/claim">Claim your listing</a>', base), { verdict: 'unknown', url: 'https://lists.example.com/claim', feeUrl: null });
  assert.equal(joinHints('<p>Top PR firms in New York.</p>', base), null);
});

test('buildSources: a readable page we don’t catalogue keeps our best read; a catalogued one doesn’t', async () => {
  const pad = 'Firms listed by specialty and client reviews. '.repeat(10);
  const pages = {
    'https://lists.example.com/best-pr-firms': `<html><body><h1>Best PR firms</h1><a href="/get-listed">Get listed</a> It's free. ${pad}</body></html>`,
    'https://www.goodfirms.co/directory/pr': `<html><body><a href="/x">Get listed</a> ${pad}</body></html>`,
  };
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
    return pages[u] ? new Response(pages[u], { headers: { 'content-type': 'text/html' } }) : new Response('nf', { status: 404 });
  };
  const answers = [{ id: 'a1', namedYou: false, citations: Object.keys(pages).map((url) => ({ url })) }];
  const sources = await buildSources({ answers, business: BUSINESS, fetchImpl });
  assert.deepEqual(sources.find((s) => s.domain === 'lists.example.com').joinGuess, { verdict: 'looks_free', url: 'https://lists.example.com/get-listed', feeUrl: null });
  assert.equal(sources.find((s) => s.domain === 'goodfirms.co').joinGuess, undefined);
});
