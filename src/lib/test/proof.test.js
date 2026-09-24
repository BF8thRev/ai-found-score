import test from 'node:test';
import assert from 'node:assert/strict';
import { computeProof, minScans, handleProof, DEFAULT_MIN_SCANS } from '../proof.js';

const row = (i, named, answers = 15, extra = {}) => ({
  business_id: `b${i}`, report_token: `tok${i}`, scanned_at: `2026-09-${String(10 + (i % 10)).padStart(2, '0')}T00:00:00Z`,
  totals: { answers, namedYou: named, firstYou: 0 }, ...extra,
});

test('minScans: default 20, env override', () => {
  assert.equal(minScans({}), DEFAULT_MIN_SCANS);
  assert.equal(minScans({ PROOF_MIN_SCANS: '5' }), 5);
  assert.equal(minScans({ PROOF_MIN_SCANS: 'x' }), 20);
  assert.equal(minScans({ PROOF_MIN_SCANS: '0' }), 20);
});

test('hidden below the threshold, shown at it', () => {
  const rows19 = Array.from({ length: 19 }, (_, i) => row(i, 0));
  assert.deepEqual(computeProof(rows19, { min: 20 }), { show: false });
  const rows20 = [...rows19, row(19, 9)];
  assert.deepEqual(computeProof(rows20, { min: 20 }), { show: true, checked: 20, namedMost: 1 });
});

test('"most" means more than half; latest report per business wins', () => {
  const rows = [
    row(1, 8, 15), // 8/15 -> most
    row(2, 7, 14), // exactly half -> not most
    { ...row(3, 15, 15), scanned_at: '2026-09-01T00:00:00Z' }, // older: named
    { ...row(3, 0, 15), scanned_at: '2026-09-20T00:00:00Z' }, // latest: not named
  ];
  assert.deepEqual(computeProof(rows, { min: 1 }), { show: true, checked: 3, namedMost: 1 });
});

test('samples and rows without a business or answers are not counted', () => {
  const rows = [
    row(1, 15, 15, { report_token: 'sample-001' }),
    row(2, 15, 15, { sample: true }),
    row(3, 15, 15, { business_id: null }),
    row(4, 0, 0),
    row(5, 1, 15),
  ];
  assert.deepEqual(computeProof(rows, { min: 1 }), { show: true, checked: 1, namedMost: 0 });
  assert.deepEqual(computeProof(rows, { min: 2 }), { show: false });
});

test('handler: hidden on read failure; cached', async () => {
  const store = new Map();
  const cache = { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); } };
  const req = new Request('https://aifoundscore.com/api/proof');
  let reads = 0;
  const readRows = async () => { reads++; return Array.from({ length: 25 }, (_, i) => row(i, i < 3 ? 10 : 0)); };
  const a = await (await handleProof(req, {}, { cache, readRows })).json();
  assert.deepEqual(a, { show: true, checked: 25, namedMost: 3 });
  await handleProof(req, {}, { cache, readRows });
  assert.equal(reads, 1, 'second call served from cache');

  const fail = await handleProof(req, {}, { cache: null, readRows: async () => { throw new Error('down'); } });
  assert.deepEqual(await fail.json(), { show: false });
  assert.match(fail.headers.get('Cache-Control'), /max-age=300/);
});
