// AI Found Score (shared/report-v2.js computeVisibilityScore) and its place in the served report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisibilityScore, SCORE_WEIGHTS } from '../../../shared/report-v2.js';
import { reportBody } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';

const ans = (namedYou, namedYouFirst = false) => ({ namedYou, namedYouFirst });
const base = (o = {}) => ({ version: 2, business: { website: 'https://www.acme.com/x' }, answers: [ans(true, true), ans(true), ans(false), ans(false)], aiFacts: [], sources: [], ...o });

test('weights add to 100', () => {
  assert.equal(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('named and first only: scaled to 100 over the parts we could check', () => {
  const r = base({ business: {} });
  const s = computeVisibilityScore(r);
  // named 2/4 * 50 + first 1/4 * 25 = 31.25 of 75 -> 42
  assert.equal(s.score, 42);
  assert.deepEqual(s.parts.map((p) => p.key), ['named', 'first']);
});

test('facts count only checked ones; own site counts only when cited', () => {
  const r = base({
    aiFacts: [{ status: 'match' }, { status: 'differs' }, { status: 'not stated' }],
    sources: [{ domain: 'acme.com', citedIn: ['a1'] }],
  });
  const s = computeVisibilityScore(r);
  const facts = s.parts.find((p) => p.key === 'facts');
  assert.equal(facts.detail, '1 of 2 facts checked');
  assert.equal(s.parts.find((p) => p.key === 'ownSite').value, 1);
  // 25 + 6.25 + 7.5 + 10 = 48.75 -> 49
  assert.equal(s.score, 49);
});

test('no answers -> no score', () => {
  assert.equal(computeVisibilityScore({ answers: [] }), null);
});

test('served reports carry the score, locked or not', () => {
  const r = MOCK_REPORTS['sample-001'];
  assert.equal(reportBody(r, false).score.score, computeVisibilityScore(r).score);
  assert.equal(reportBody(r, true).score.score, computeVisibilityScore(r).score);
});
