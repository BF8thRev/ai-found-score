// The 30-day re-check list on /admin (who to offer Be the Answer) and the token baseline it relies on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recheckVerdict } from '../page.js';
import { getBaselineByToken } from '../../../scanner/store.js';

test('recheckVerdict: better, worse or no change by share of answers that named them', () => {
  const t = (namedYou, answers) => ({ namedYou, answers });
  assert.equal(recheckVerdict({ before: t(3, 15), now: t(6, 15) }).label, 'Better');
  assert.equal(recheckVerdict({ before: t(6, 15), now: t(3, 15) }).label, 'Worse');
  assert.equal(recheckVerdict({ before: t(5, 15), now: t(5, 15) }).label, 'No change');
  assert.equal(recheckVerdict({ before: null, now: t(5, 15) }), null);
  assert.equal(recheckVerdict({ before: t(0, 0), now: t(5, 15) }), null);
});

test('getBaselineByToken: the newest earlier report with the same number of questions', async () => {
  const q = (n) => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}` }));
  const rows = [
    { scan_id: 'recheck', scanned_at: '2026-10-30', generatedAt: '2026-10-30', totals: { namedYou: 7 }, questions: q(5) },
    { scan_id: 'paid', scanned_at: '2026-09-30', generatedAt: '2026-09-30', totals: { namedYou: 4 }, questions: q(5) },
    { scan_id: 'free', scanned_at: '2026-09-29', generatedAt: '2026-09-29', totals: { namedYou: 1 }, questions: q(3) },
  ];
  let url = '';
  const fetchImpl = async (u) => { url = String(u); return Response.json(rows); };
  const env = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc' };
  assert.deepEqual(await getBaselineByToken(env, 'tok', { excludeScanId: 'recheck', questionCount: 5, fetchImpl }), { generatedAt: '2026-09-30', totals: { namedYou: 4 } });
  assert.match(url, /report_token=eq\.tok/);
  // The 5-question audit never uses the 3-question free report as its baseline.
  assert.equal(await getBaselineByToken(env, 'tok', { excludeScanId: 'paid', questionCount: 5, fetchImpl: async () => Response.json(rows.slice(1)) }), null);
});
