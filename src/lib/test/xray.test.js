// The $49 AI Visibility X-Ray: tier mapping, the competitor gap sheet, the fix checklist, and
// the server-side lock that withholds both until paid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TIER_BY_CENTS, tierForSession } from '../stripe.js';
import { lockReport, reportBody } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { buildGapSheet, buildFixChecklist, xraySections, xrayOffered, validateReport } from '../../../shared/report-v2.js';

const v2 = MOCK_REPORTS['sample-001'];
const clone = (x) => JSON.parse(JSON.stringify(x));

test('TIER_BY_CENTS: 4900 is the X-Ray; retired tiers still record', () => {
  assert.equal(TIER_BY_CENTS[4900], 'xray');
  assert.equal(TIER_BY_CENTS[2900], 'snapshot');
  assert.equal(TIER_BY_CENTS[5900], 'before_after');
  assert.equal(tierForSession({ amount_total: 4900 }), 'xray');
  assert.equal(tierForSession({ amount_total: 6800 }), 'xray', '$49 audit + $19 re-check add-on');
  assert.equal(tierForSession({ amount_total: 4900, metadata: { tier: 'overhaul' } }), 'overhaul');
  assert.equal(tierForSession({ amount_total: 1234 }), 'unknown');
});

// A tiny hand-made report: two competitors, one named once (never shown), sources with and without the owner.
function miniReport() {
  const ans = (id, names) => {
    let text = 'Try ';
    const businessesNamed = names.map(([name, entityId, isYou]) => {
      const pos = text.length;
      text += `${name}, `;
      return { name, pos, entityId, ...(isYou ? { isYou: true } : {}) };
    });
    return { id, questionId: 'q1', engine: 'chatgpt', run: 1, text, businessesNamed, namedYou: names.some((n) => n[2]), citations: [] };
  };
  return {
    version: 2,
    business: { name: 'Otter Plumbing', website: 'https://otterplumbing.example.com' },
    answers: [
      ans('a1', [['Tidewater Plumbing Co.', 'e1'], ['Kessler Bros', 'e2']]),
      ans('a2', [['Kessler Bros', 'e2'], ['Tidewater Plumbing Co.', 'e1']]),
      ans('a3', [['Tidewater Plumbing Co.', 'e1'], ['Otter Plumbing', null, true]]),
      ans('a4', [['Lonely Drain', 'e3']]),
    ],
    entities: [
      { id: 'e1', name: 'Tidewater Plumbing Co.', aliases: ['Tidewater Plumbing'], named: 3, first: 2, answerIds: ['a1', 'a2', 'a3'] },
      { id: 'e2', name: 'Kessler Bros', named: 2, first: 1, answerIds: ['a1', 'a2'] },
      { id: 'e3', name: 'Lonely Drain', named: 1, first: 1, answerIds: ['a4'] },
    ],
    sources: [
      // Lists Tidewater first, owner not listed → a gap for Tidewater.
      { domain: 'localpages.example.com', url: 'https://localpages.example.com/p', citedIn: ['a1'], youListed: false, topListed: 'Tidewater Plumbing' },
      // Lists Kessler second (listing names read), owner not listed → a gap for Kessler at #2.
      { domain: 'bestof.example.com', url: 'https://bestof.example.com/x', citedIn: ['a2'], youListed: false, topListed: 'Someone Else', listed: ['Someone Else', 'Kessler Bros.'] },
      // Lists Tidewater but the owner IS listed → not a gap.
      { domain: 'guide.example.com', url: 'https://guide.example.com/', citedIn: ['a3'], youListed: true, topListed: 'Tidewater Plumbing Co.' },
      // Not checked → never a gap.
      { domain: 'unchecked.example.com', url: 'https://unchecked.example.com/', citedIn: ['a1'], youListed: null, topListed: 'Kessler Bros' },
      // The owner's own site never counts, even if it were marked not listed.
      { domain: 'otterplumbing.example.com', url: 'https://otterplumbing.example.com/', citedIn: ['a3'], youListed: false, topListed: 'Tidewater Plumbing Co.' },
    ],
    issues: [
      { kind: 'lost_question', severity: 'high', title: 'Fix A', steps: ['x'] },
      { kind: 'not_listed', severity: 'medium', title: 'Fix B' },
      { kind: 'baseline_gbp', severity: 'low', title: 'Fill in your Google Business Profile' },
    ],
  };
}

test('gap sheet: only competitors proven by 2+ answers, counts recomputed from answers', () => {
  const r = miniReport();
  r.entities[1].named = 99; // stored counts are not trusted
  const g = buildGapSheet(r);
  assert.equal(g.answers, 4);
  assert.deepEqual(g.competitors.map((c) => c.name), ['Tidewater Plumbing Co.', 'Kessler Bros']);
  const [tide, kess] = g.competitors;
  assert.deepEqual([tide.named, tide.first, tide.answerIds], [3, 2, ['a1', 'a2', 'a3']]);
  assert.deepEqual([kess.named, kess.first, kess.answerIds], [2, 1, ['a1', 'a2']]);
});

test('gap sheet: sites AI cited that list them and not you (topListed, aliases, listing names read)', () => {
  const g = buildGapSheet(miniReport());
  const [tide, kess] = g.competitors;
  assert.deepEqual(tide.sources, [{ domain: 'localpages.example.com', url: 'https://localpages.example.com/p', position: 1 }]);
  assert.deepEqual(kess.sources, [{ domain: 'bestof.example.com', url: 'https://bestof.example.com/x', position: 2 }]);
  // guide (owner listed), unchecked (null) and the owner's own site are never gaps.
  const all = g.competitors.flatMap((c) => c.sources.map((s) => s.domain));
  for (const d of ['guide.example.com', 'unchecked.example.com', 'otterplumbing.example.com']) assert.ok(!all.includes(d), d);
  assert.equal(g.sourcesChecked, 3);
  // A bare trade word on a page is not a listing of a competitor.
  const r = miniReport();
  r.sources = [{ domain: 'x.example.com', url: 'https://x.example.com/', citedIn: ['a1'], youListed: false, topListed: 'Plumbing', listed: ['Plumbing', 'Bros'] }];
  assert.ok(buildGapSheet(r).competitors.every((c) => c.sources.length === 0));
});

test('gap sheet: none found is empty, not guessed', () => {
  const r = miniReport();
  r.sources = r.sources.map((s) => ({ ...s, youListed: true }));
  const g = buildGapSheet(r);
  assert.equal(g.competitors.length, 2);
  assert.ok(g.competitors.every((c) => c.sources.length === 0));
  // An entity whose answer ids don't all exist is not proven; nobody named twice → no competitors.
  r.answers = r.answers.slice(3);
  assert.deepEqual(buildGapSheet(r).competitors, []);
});

test('gap sheet on the sample: Tidewater and Kessler each have one cited site missing the owner', () => {
  const g = buildGapSheet(v2);
  const by = Object.fromEntries(g.competitors.map((c) => [c.name, c.sources.map((s) => s.domain)]));
  assert.deepEqual(by['Tidewater Plumbing Co.'], ['localpages.example.com']);
  assert.deepEqual(by['Kessler Bros. Plumbing'], ['bestof-li.example.com']);
  assert.ok(g.competitors.every((c) => c.named >= 2 && c.answerIds.length >= 2));
});

test('fix checklist: every issue title in order, baseline fixes included', () => {
  const r = miniReport();
  assert.deepEqual(buildFixChecklist(r).map((i) => i.title), ['Fix A', 'Fix B', 'Fill in your Google Business Profile']);
  assert.equal(xrayOffered(r), true);
  r.issues = r.issues.slice(0, 2);
  assert.equal(xrayOffered(r), false);
});

test('lock: the X-Ray sections are withheld until paid; unlocked reports carry them', () => {
  const open = reportBody(v2, true);
  assert.equal(open.locked, false);
  assert.ok(open.xray.gapSheet.competitors.length >= 2);
  assert.equal(open.xray.checklist.length, v2.issues.length);
  assert.deepEqual(open.xray, xraySections(v2));

  const locked = reportBody(v2, false);
  assert.deepEqual(locked.xray, { locked: true });
  const body = JSON.stringify(locked);
  assert.ok(!body.includes('gapSheet') && !body.includes('checklist'));
  // Even a stored report that somehow carried X-Ray data never passes it through the lock.
  const tainted = { ...clone(v2), xray: xraySections(v2), gapSheet: { x: 1 }, checklist: [1] };
  const l2 = lockReport(tainted);
  assert.deepEqual(l2.xray, { locked: true });
  assert.equal(l2.gapSheet, undefined);
  assert.equal(l2.checklist, undefined);
  assert.equal(validateReport(l2).ok, true);
  // The listing names read on cited pages feed only the gap sheet: dropped while locked.
  const withListed = clone(v2);
  withListed.sources = (withListed.sources || []).map((s) => ({ ...s, listed: ['Someone Else'] }));
  const l3 = lockReport(withListed);
  assert.deepEqual(l3.sources, [], 'cited sites belong to the audit: a locked report carries only their count');
  assert.ok(!JSON.stringify(l3).includes('Someone Else'));
  assert.ok(reportBody(withListed, true).sources.every((s) => Array.isArray(s.listed)));
});

test('lock: v1 reports get no X-Ray', () => {
  assert.equal(reportBody(MOCK_REPORTS['sample-v1'], true).xray, undefined);
  assert.equal(reportBody(MOCK_REPORTS['sample-v1'], false).xray, undefined);
});
