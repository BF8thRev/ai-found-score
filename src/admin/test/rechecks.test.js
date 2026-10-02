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

test('baselines compare only scans that asked the same searches (ids and wording): small-firm questions', async () => {
  const { getBaseline } = await import('../../../scanner/store.js');
  const five = [
    { id: 'q1', intent: 'best', text: "What's the best pr agency in New York City, NY?" },
    { id: 'q2', intent: 'urgent', text: 'Pr agency open now near New York City NY' },
    { id: 'q3', intent: 'job', text: 'Can you recommend a pr agency in New York City NY?' },
    { id: 'q4', intent: 'trust', text: 'Pr agency with good reviews near New York City, NY' },
    { id: 'q5', intent: 'price', text: 'Affordable pr agency near New York City NY' },
  ];
  const seven = [...five, { id: 'q6', intent: 'small', text: "What's a good boutique PR agency in New York City, NY for a small company?" }, { id: 'q7', intent: 'niche', text: 'Which PR agency in New York City, NY specializes in integrated communications?' }];
  const rows = [
    { scan_id: 'paid-old', scanned_at: '2026-09-30', generatedAt: '2026-09-30', totals: { namedYou: 0 }, questions: five },
    { scan_id: 'free', scanned_at: '2026-09-29', generatedAt: '2026-09-29', totals: { namedYou: 0 }, questions: five.slice(0, 3) },
  ];
  const env = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc' };
  let url = '';
  const fetchImpl = async (u) => { url = String(u); return Response.json(rows); };
  // A 7-question audit run on a link whose earlier audit asked 5: no before/after (different searches).
  assert.equal(await getBaselineByToken(env, 'tok', { excludeScanId: 'new', questions: seven, fetchImpl }), null);
  assert.match(url, /report-%3Equestions|report->questions/);
  // A re-check of that old audit asks its 5 word for word: compared with it.
  assert.deepEqual(await getBaselineByToken(env, 'tok', { excludeScanId: 'recheck', questions: five, fetchImpl }), { generatedAt: '2026-09-30', totals: { namedYou: 0 } });
  // Same ids, different wording is not the same search.
  const reworded = five.map((q) => (q.id === 'q2' ? { ...q, text: 'Top rated PR agency in New York City, NY' } : q));
  assert.equal(await getBaselineByToken(env, 'tok', { questions: reworded, fetchImpl }), null);
  // The business-wide baseline follows the same rule (the free 3 never the audit's baseline).
  const biz = '11111111-1111-4111-8111-111111111111';
  assert.equal(await getBaseline(env, biz, { excludeScanId: 'paid-old', questions: five, fetchImpl }), null);
  assert.deepEqual(await getBaseline(env, biz, { questions: five.slice(0, 3), fetchImpl }), { generatedAt: '2026-09-29', totals: { namedYou: 0 } });
  assert.equal(await getBaseline(env, biz, { questions: seven, fetchImpl }), null);
  // A stored report without a question list can't be shown to be like for like.
  assert.equal(await getBaseline(env, biz, { questions: five, fetchImpl: async () => Response.json([{ scan_id: 'x', scanned_at: '2026-09-01', totals: { namedYou: 1 } }]) }), null);
});
