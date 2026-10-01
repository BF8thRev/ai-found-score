import test from 'node:test';
import assert from 'node:assert/strict';
import { checkName, checkWebsite, checkSubmission, handleSiteCheck, MESSAGES } from '../site-check.js';
import { handleReportRequest } from '../report-request.js';

const page = (status, body = '<html><title>Otter Plumbing</title></html>', type = 'text/html') =>
  async () => new Response(body, { status, headers: { 'Content-Type': type } });
const noHost = async () => { throw new TypeError('fetch failed'); };
const slow = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
const never = async () => { throw new Error('should not fetch'); };

test('names: real names pass, mashes and test strings do not', () => {
  for (const n of ['Otter Plumbing', 'A&B Plumbing', '123 Plumbing', 'JKL Construction', 'Joe\'s', 'Testa Pizza', 'Café Olé']) {
    assert.equal(checkName(n).ok, true, n);
  }
  for (const n of ['', 'x', '!!!', '42', 'zzzz', 'asdf', 'asdfgh', 'qwerty', 'test', 'Test 2', 'testing', 'n/a', 'none']) {
    const r = checkName(n);
    assert.equal(r.ok, false, n);
    assert.equal(r.field, 'business_name');
  }
});

test('website: a bad address fails without a fetch', async () => {
  for (const w of ['garage', 'garage.c', 'garage.123', 'localhost', '10.0.0.1', 'http://127.0.0.1', 'javascript:alert(1)', 'my site.com']) {
    const r = await checkWebsite(w, { fetchImpl: never });
    assert.equal(r.ok, false, w);
    assert.equal(r.reason, 'format', w);
  }
});

test('website: a site that answers passes, even behind a bot wall', async () => {
  // A page that answers passes, and what it says about the business comes back with it (the form prefills from it).
  assert.deepEqual(await checkWebsite('otterplumbing.com', { fetchImpl: page(200) }), { ok: true, url: 'https://otterplumbing.com/', name: 'Otter Plumbing', kind: 'plumbing', kindFrom: 'website' });
  assert.deepEqual(await checkWebsite('otterplumbing.com', { fetchImpl: page(200, '<p>hello</p>') }), { ok: true, url: 'https://otterplumbing.com/' });
  assert.equal((await checkWebsite('otterplumbing.com', { fetchImpl: page(403) })).ok, true);
  assert.equal((await checkWebsite('otterplumbing.com', { fetchImpl: page(503) })).ok, true);
});

test('website: no such site, origin down or parked fails', async () => {
  assert.equal((await checkWebsite('garage.com', { fetchImpl: noHost })).reason, 'unreachable');
  assert.equal((await checkWebsite('garage.com', { fetchImpl: page(530) })).reason, 'unreachable');
  assert.equal((await checkWebsite('garage.com', { fetchImpl: page(522) })).reason, 'unreachable');
  const parked = await checkWebsite('garage.com', { fetchImpl: page(200, '<h1>This domain is for sale!</h1>') });
  assert.equal(parked.reason, 'parked');
  assert.equal(parked.error, MESSAGES.parked);
});

test('website: a slow site is let through', async () => {
  const r = await checkWebsite('slowplumber.com', { fetchImpl: slow });
  assert.equal(r.ok, true);
  assert.equal(r.slow, true);
});

test('website: Facebook and Yelp pages need a page path, never a fetch', async () => {
  assert.equal((await checkWebsite('facebook.com/otterplumbing', { fetchImpl: never })).ok, true);
  assert.equal((await checkWebsite('https://www.yelp.com/biz/otter-plumbing', { fetchImpl: never })).ok, true);
  assert.equal((await checkWebsite('facebook.com', { fetchImpl: never })).reason, 'platform');
});

test('checkSubmission: name first, website optional', async () => {
  assert.equal((await checkSubmission({ name: 'asdf', website: 'otter.com' }, { fetchImpl: never })).field, 'business_name');
  assert.deepEqual(await checkSubmission({ name: 'Otter Plumbing', website: '' }, { fetchImpl: never }), { ok: true, url: null });
});

test('GET /api/site-check answers JSON', async () => {
  const res = await handleSiteCheck(new URL('https://x.test/api/site-check?website=garage&name=Otter'), { fetchImpl: never });
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.field, 'website');
});

test('POST /api/request turns away a made-up website before saving anything', async () => {
  let saved = false;
  const request = new Request('https://x.test/api/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business_name: 'Otter Plumbing', town: 'Massapequa', zip: '11758', website: 'garage.com' }),
  });
  const res = await handleReportRequest(request, new URL(request.url), {}, {
    siteFetchImpl: noHost,
    recordReportRequest: async () => { saved = true; },
    startRequestScan: async () => { throw new Error('should not scan'); },
  });
  assert.equal(res.status, 422);
  const j = await res.json();
  assert.equal(j.field, 'website');
  assert.equal(j.error, MESSAGES.unreachable);
  assert.equal(saved, false);
});

test('findZip: schema postalCode first, else the most frequent "Town, ST 12345"', async () => {
  const { findZip } = await import('../site-check.js');
  assert.equal(findZip('<script type="application/ld+json">{"postalCode": "11703"}</script><p>Deer Park, NY 11729</p>'), '11703');
  assert.equal(findZip('<p>Near Deer Park, NY 11729</p><footer>1800 Arctic Ave, Bohemia, NY 11716</footer><p>Bohemia, NY 11716</p>'), '11716');
  assert.equal(findZip('<p>Call 631-256-5140. Est. 12345 customers served</p>'), '');
  assert.deepEqual(await checkWebsite('glennwayne.com', { fetchImpl: page(200, '<footer>Bohemia, NY 11716</footer>') }), { ok: true, url: 'https://glennwayne.com/', zip: '11716', town: 'Bohemia', state: 'NY' });
});

test('zipFromPlaces: only a Google listing with this same website counts; no key → no call', async () => {
  const { zipFromPlaces } = await import('../site-check.js');
  const calls = [];
  const placesFetch = async (u, init) => {
    calls.push(JSON.parse(init.body).textQuery);
    return Response.json({ places: [
      { formattedAddress: '12 Main St, Springfield, IL 62701, USA', websiteUri: 'https://otherbakery.com/' },
      { formattedAddress: '1800 Arctic Ave, Bohemia, NY 11716, USA', websiteUri: 'https://www.glennwayne.com/' },
    ] });
  };
  const env = { GOOGLE_PLACES_API_KEY: 'k' };
  assert.equal(await zipFromPlaces('Glenn Wayne Bakery', 'https://glennwayne.com/', env, { placesFetch }), '11716');
  assert.equal(await zipFromPlaces('Glenn Wayne Bakery', 'https://nomatch.com/', env, { placesFetch }), '');
  assert.equal(await zipFromPlaces('Glenn Wayne Bakery', 'https://www.facebook.com/gw', env, { placesFetch }), '');
  assert.equal(calls.length, 2);
  assert.equal(await zipFromPlaces('Glenn Wayne Bakery', 'https://glennwayne.com/', {}, { placesFetch }), '');
  assert.equal(calls.length, 2);
});

test('GET /api/site-check without a name: the website only, and what the page says the business is', async () => {
  const pr = async () => new Response('<title>PR 73 | Public Relations Agency</title><p>A boutique public relations agency in NYC.</p>', { headers: { 'Content-Type': 'text/html' } });
  const j = await (await handleSiteCheck(new URL('https://x.test/api/site-check?website=pr73.com&name='), { fetchImpl: pr, env: {} })).json();
  assert.deepEqual(j, { ok: true, url: 'https://pr73.com/', name: 'PR 73', kind: 'PR agency', kindFrom: 'website' });
  // A typed name is still checked, and says what the business is before the page does.
  const bad = await (await handleSiteCheck(new URL('https://x.test/api/site-check?website=pr73.com&name=asdf'), { fetchImpl: pr, env: {} })).json();
  assert.equal(bad.field, 'business_name');
  const typed = await (await handleSiteCheck(new URL('https://x.test/api/site-check?website=pr73.com&name=Smith+Dental'), { fetchImpl: pr, env: {} })).json();
  assert.equal(typed.kind, 'dentist');
  assert.equal(typed.kindFrom, 'name');
  assert.equal(typed.name, 'PR 73', 'the page name still comes back for the form to offer');
});

test('findPlace: town and state come with the ZIP; a street address is not a town', async () => {
  const { findPlace, placeFromPlaces } = await import('../site-check.js');
  assert.deepEqual(findPlace('<footer>1800 Arctic Ave, Bohemia, NY 11716</footer>'), { zip: '11716', town: 'Bohemia', state: 'NY' });
  assert.deepEqual(findPlace('<p>120 Terminal Drive Plainview, NY 11803</p>'), { zip: '11803', town: 'Plainview', state: 'NY' });
  assert.deepEqual(findPlace('<p>Located in beautiful Plainview, NY 11803</p>'), { zip: '11803', town: 'Plainview', state: 'NY' }, 'prose before the town is not the town');
  assert.deepEqual(findPlace('<p>Proudly serving Nassau County and Deer Park, New York 11729</p>'), { zip: '11729', town: 'Deer Park', state: 'NY' });
  assert.deepEqual(findPlace('<script type="application/ld+json">{"address":{"addressLocality":"Columbus","addressRegion":"Ohio","postalCode":"43215"}}</script>'), { zip: '43215', town: 'Columbus', state: 'OH' }, 'a full state name, not NY by default');
  assert.deepEqual(findPlace('<script type="application/ld+json">{"address":{"addressLocality":"Columbus","postalCode":"43215"}}</script>'), { zip: '43215', town: 'Columbus', state: '' }, 'no region → no state');
  assert.deepEqual(findPlace('<script type="application/ld+json">{"address":{"addressLocality":"Massapequa","addressRegion":"NY","postalCode":"11758"}}</script>'), { zip: '11758', town: 'Massapequa', state: 'NY' });
  assert.deepEqual(findPlace('<p>no address</p>'), { zip: '', town: '', state: '' });
  // The Google listing with this website: its name and town too.
  const placesFetch = async () => Response.json({ places: [{ formattedAddress: '1800 Arctic Ave, Bohemia, NY 11716, USA', websiteUri: 'https://www.glennwayne.com/', displayName: { text: 'Glenn Wayne Bakery' } }] });
  assert.deepEqual(await placeFromPlaces('Glenn Wayne', 'https://glennwayne.com/', { GOOGLE_PLACES_API_KEY: 'k' }, { placesFetch }), { zip: '11716', town: 'Bohemia', state: 'NY', name: 'Glenn Wayne Bakery' });
  assert.equal(await placeFromPlaces('Glenn Wayne', 'https://glennwayne.com/', {}, { placesFetch }), null);
});
