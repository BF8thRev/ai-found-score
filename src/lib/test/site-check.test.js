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
  assert.deepEqual(await checkWebsite('otterplumbing.com', { fetchImpl: page(200) }), { ok: true, url: 'https://otterplumbing.com/' });
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
