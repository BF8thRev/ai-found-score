// GET /api/zip: ZIP → town for the free-report form (src/lib/zip.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaces, handleZip } from '../zip.js';

const MASSAPEQUA = { places: [{ 'place name': 'Massapequa', 'state abbreviation': 'NY' }] };

test('parsePlaces: clean towns and real state codes only, no duplicates', () => {
  assert.deepEqual(parsePlaces(MASSAPEQUA), [{ town: 'Massapequa', state: 'NY' }]);
  assert.deepEqual(parsePlaces({ places: [{ 'place name': '<b>x</b>', 'state abbreviation': 'NY' }, { 'place name': 'Hicksville', 'state abbreviation': 'ZZ' }] }), []);
  assert.deepEqual(parsePlaces(null), []);
});

test('handleZip: looks up once, then answers from the cache', async () => {
  const store = new Map();
  const cache = { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } };
  let calls = 0;
  const fetchImpl = async (u) => { calls++; assert.equal(u, 'https://api.zippopotam.us/us/11758'); return Response.json(MASSAPEQUA); };
  const url = new URL('https://aifoundscore.com/api/zip?zip=11758');
  const a = await (await handleZip(url, { cache, fetchImpl })).json();
  assert.deepEqual(a, { ok: true, zip: '11758', places: [{ town: 'Massapequa', state: 'NY' }] });
  await handleZip(url, { cache, fetchImpl });
  assert.equal(calls, 1);
});

test('handleZip: bad ZIP is a 400; unknown ZIP or network failure is ok:false', async () => {
  assert.equal((await handleZip(new URL('https://x.test/api/zip?zip=12'), { cache: null })).status, 400);
  const notFound = await handleZip(new URL('https://x.test/api/zip?zip=00000'), { cache: null, fetchImpl: async () => new Response('{}', { status: 404 }) });
  assert.equal((await notFound.json()).ok, false);
  const down = await handleZip(new URL('https://x.test/api/zip?zip=11758'), { cache: null, fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await down.json()).ok, false);
  assert.match(down.headers.get('Cache-Control'), /max-age=60/);
});
