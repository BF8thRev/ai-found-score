// Be the Answer: directory checklist, Google posts, monthly scheduling, the plan API and the breakdown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { directoriesFor, directoryPaste, directoryChecklistTxt, googlePosts, googlePostsTxt, GOOGLE_POST_MAX, PLAN_MAX_TOWNS } from '../plan.js';
import { validateDetails, prefillDetails } from '../fix-kit.js';
import { planMonthDue, townBusiness, MONTH_DAYS } from '../auto-scan.js';
import { handlePlan, validateTown } from '../plan-route.js';
import { reportBody } from '../lock.js';
import { buildCompetitorBreakdown } from '../../../shared/report-v2.js';
import { lintText } from '../../../shared/report-v2.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { monthlyEmail } from '../email.js';
import { topCompetitor, competitorAlert } from '../notify.js';

const v2 = MOCK_REPORTS['sample-001'];
const details = validateDetails({ ...prefillDetails(v2), googleReviewUrl: 'https://g.page/r/abc/review' }).details;
const DAY = 86400_000;

test('directory checklist: 30+ sites for every trade, each with an https link; paste text uses confirmed details only', () => {
  for (const trade of ['plumbing', 'hvac', 'electrical', 'roofing', 'landscaping', 'cleaning', 'auto_repair', 'laundromat', 'bakery']) {
    const sites = directoriesFor(trade);
    assert.ok(sites.length >= 30, `${trade}: ${sites.length} sites`);
    assert.equal(new Set(sites.map((s) => s.name)).size, sites.length, `${trade}: no repeats`);
    for (const s of sites) assert.match(s.url, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//);
  }
  const p = directoryPaste(details);
  assert.equal(p.name, details.name);
  assert.equal(p.phone, details.phone);
  const txt = directoryChecklistTxt(details);
  assert.match(txt, /PASTE THIS/);
  assert.match(txt, /Google Business Profile: https:\/\/business\.google\.com\//);
  assert.deepEqual(lintText(txt).map((h) => h.match), []);
});

test('Google posts: 12, one a month from the start month, under Google\'s limit, only confirmed details', () => {
  const posts = googlePosts(details, { start: new Date('2026-11-15T00:00:00Z') });
  assert.equal(posts.length, 12);
  assert.equal(posts[0].month, 'November 2026');
  assert.equal(posts[2].month, 'January 2027');
  for (const p of posts) {
    assert.ok(p.text.length > 20 && p.text.length <= GOOGLE_POST_MAX);
    assert.ok(!/\$\d|%|discount|guarantee|licensed|insured/i.test(p.text), `no invented claims: ${p.text}`);
    assert.deepEqual(lintText(p.text).map((h) => h.match), [], p.text);
  }
  assert.ok(posts.some((p) => p.text.includes('https://g.page/r/abc/review')), 'the review link is used when given');
  assert.match(googlePostsTxt(details), /12 posts/);
});

test('planMonthDue: months 1..12 from the payment, within the catch-up window', () => {
  const paid = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(planMonthDue(paid, paid + 10 * DAY), 0);
  assert.equal(planMonthDue(paid, paid + MONTH_DAYS * DAY), 1);
  assert.equal(planMonthDue(paid, paid + (MONTH_DAYS + 5) * DAY), 1, 'a missed day catches up');
  assert.equal(planMonthDue(paid, paid + (MONTH_DAYS + 20) * DAY), 0, 'too late to catch up');
  assert.equal(planMonthDue(paid, paid + 12 * MONTH_DAYS * DAY), 12);
  assert.equal(planMonthDue(paid, paid + 13 * MONTH_DAYS * DAY), 0, 'the plan is over');
});

test('townBusiness: the same business, asked about another town; no id, so it never compares against the plan\'s own report', () => {
  const b = townBusiness({ id: 'b1', name: 'Otter', trade: 'plumbing', town: 'Massapequa', state: 'NY', zip: '11758', nearbyTown: 'Seaford', address: '1 Main St' }, { town: 'Wantagh', state: 'NY', zip: null });
  assert.equal(b.town, 'Wantagh');
  assert.equal(b.id, undefined);
  assert.equal(b.nearbyTown, undefined);
  assert.equal(b.address, '1 Main St');
  assert.equal(JSON.parse(JSON.stringify(b)).zip, undefined);
});

test('validateTown', () => {
  assert.equal(validateTown({ town: 'Wantagh', state: 'ny', zip: '11793' }).town.state, 'NY');
  assert.equal(validateTown({ town: '', state: 'NY' }).ok, false);
  assert.equal(validateTown({ town: 'X', state: 'Zz' }).ok, false);
  assert.equal(validateTown({ town: 'X', state: 'NY', zip: '12' }).ok, false);
});

const req = (path, init) => [new Request(`https://x.test${path}`, init), new URL(`https://x.test${path}`)];
const post = (path, body) => req(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function deps({ tiers = ['be_the_answer'], towns = [], saved = { details } } = {}) {
  const inserted = [];
  const started = [];
  let n = 0;
  return {
    inserted, started,
    deps: {
      mockReports: MOCK_REPORTS,
      getReport: async (env, t) => (t === 'nope' ? null : { ...v2, id: t, sample: undefined }),
      getPaidTiers: async () => tiers,
      getFixKitDetails: async () => saved,
      readPlanTowns: async () => towns,
      readPlanBusiness: async () => v2.business,
      planStartedAt: async () => '2026-10-01T00:00:00Z',
      insertTown: async (env, row) => { inserted.push(row); },
      startTownScan: async (env, x) => { started.push(x); return { ok: true }; },
      newToken: () => `town_token_${++n}_xxxxxxxxxx`,
      rateLimit: async () => null,
    },
  };
}

test('plan API: Be the Answer only; checklist and posts from the confirmed details', async () => {
  assert.equal((await handlePlan(...req('/api/plan/nope'), {}, deps().deps)).status, 404);
  assert.equal((await handlePlan(...req('/api/plan/real_tok'), {}, deps({ tiers: ['xray'] }).deps)).status, 402);
  const body = await (await handlePlan(...req('/api/plan/real_tok'), {}, deps().deps)).json();
  assert.equal(body.paid, true);
  assert.equal(body.confirmed, true);
  assert.equal(body.maxTowns, PLAN_MAX_TOWNS);
  assert.equal(body.towns.length, 1);
  assert.equal(body.towns[0].main, true);
  assert.ok(body.directories.length >= 30);
  assert.equal(body.posts.length, 12);
  assert.equal(body.posts[0].month, 'October 2026', 'posts start the month the plan started');
  const unconfirmed = await (await handlePlan(...req('/api/plan/real_tok'), {}, deps({ saved: null }).deps)).json();
  assert.equal(unconfirmed.confirmed, false);
  assert.equal(unconfirmed.paste, null);
  assert.deepEqual(unconfirmed.posts, []);
  const sample = await (await handlePlan(...req('/api/plan/sample-001'), {}, { mockReports: MOCK_REPORTS })).json();
  assert.equal(sample.sample, true);
  assert.equal(sample.posts.length, 12);
});

test('plan API: add towns up to 3 in all, each with its own token and a first scan; no repeats', async () => {
  const d = deps();
  const r = await (await handlePlan(...post('/api/plan/real_tok', { towns: [{ town: 'Wantagh', state: 'NY', zip: '11793' }] }), {}, d.deps)).json();
  assert.equal(r.ok, true);
  assert.equal(r.towns.length, 2);
  assert.equal(d.inserted[0].report_token, 'real_tok');
  assert.equal(d.inserted[0].town, 'Wantagh');
  assert.equal(d.started[0].business.town, 'Wantagh');
  assert.equal(d.started[0].townToken, d.inserted[0].town_token);
  // Repeats and the report's own town are refused.
  const dup = await handlePlan(...post('/api/plan/real_tok', { towns: [{ town: v2.business.town, state: v2.business.state }] }), {}, deps().deps);
  assert.equal(dup.status, 422);
  // At most 3 towns in all.
  const full = deps({ towns: [{ town: 'A', state: 'NY', town_token: 'ta' }, { town: 'B', state: 'NY', town_token: 'tb' }] });
  assert.equal((await handlePlan(...post('/api/plan/real_tok', { towns: [{ town: 'C', state: 'NY' }] }), {}, full.deps)).status, 422);
  assert.equal(full.inserted.length, 0);
  // Not on the plan: nothing added.
  const unpaid = deps({ tiers: ['xray'] });
  assert.equal((await handlePlan(...post('/api/plan/real_tok', { towns: [{ town: 'C', state: 'NY' }] }), {}, unpaid.deps)).status, 402);
});

test('Competitor Breakdown: top 3, a word-for-word sentence, up to 3 edges; only when paid for, never locked', () => {
  const bd = buildCompetitorBreakdown(v2);
  assert.ok(bd.competitors.length > 0 && bd.competitors.length <= 3);
  for (const c of bd.competitors) {
    assert.ok(c.edges.length <= 3);
    if (c.quote) assert.ok(v2.answers.some((a) => a.text.replace(/\*\*/g, '').includes(c.quote.text)), `quote is word for word: ${c.quote.text}`);
  }
  assert.match(bd.competitors[0].edges[0], /Google reviews to your/);
  assert.equal(reportBody(v2, true).breakdown, undefined, 'the audit alone does not carry it');
  assert.ok(reportBody(v2, true, { breakdown: true }).breakdown.competitors.length);
  assert.equal(reportBody(v2, false, { breakdown: true }).breakdown, undefined, 'never on a locked report');
});

test('monthly email: what changed, the competitor alert, the next 3 fixes and the plan link', () => {
  const env = { SITE_URL: 'https://aifoundscore.com' };
  const m = monthlyEmail(env, {
    token: 'town1', planToken: 'tok', name: 'Otter Plumbing', town: 'Wantagh',
    totals: { namedYou: 6, answers: 15 }, before: { namedYou: 4, answers: 15 },
    next3: ['Fix A', 'Fix B', 'Fix C'], alert: { now: 'Tidewater Plumbing Co.', before: 'Kessler Bros.' },
  });
  assert.match(m.subject, /Heads up: AI now names Tidewater Plumbing Co\. most in Wantagh/);
  assert.match(m.text, /4 of 15.*6 of 15.*progress/s);
  assert.match(m.text, /1\. Fix A/);
  assert.match(m.text, /report\/town1/);
  assert.match(m.text, /plan\/tok/);
  assert.deepEqual(lintText(m.text).map((h) => h.match), []);
  assert.equal(topCompetitor([{ name: 'Me', isYou: true, named: 9 }, { name: 'A', named: 3, first: 1 }, { name: 'B', named: 3, first: 2 }, { name: 'C', named: 1 }]), 'B');
  assert.equal(topCompetitor([{ name: 'C', named: 1 }]), null);
});

test('competitor alert: only a real change of leader, never a tie flipping order or a first reading', () => {
  const A3 = { name: 'Alpha Plumbing', named: 3, first: 1 };
  const B3 = { name: 'Beta Plumbing', named: 3, first: 1 };
  const C4 = { name: 'Gamma Plumbing', named: 4, first: 2 };
  assert.deepEqual(competitorAlert([C4, A3], [A3, B3]), { now: 'Gamma Plumbing', before: 'Alpha Plumbing' });
  assert.equal(competitorAlert([B3, A3], [A3]), null, 'Alpha is still tied for the lead');
  assert.equal(competitorAlert([A3], [A3, B3]), null, 'Beta dropped out of a tie: not a new leader');
  assert.equal(competitorAlert([C4], [{ name: 'Once Only', named: 1 }]), null, 'last time had no clear leader');
  assert.equal(competitorAlert([], [A3]), null);
  assert.equal(topCompetitor([B3, A3]), 'Alpha Plumbing', 'ties resolve the same way every time');
});

test('monthly email: a new town gets its own opener, and the month\'s Google post rides along', () => {
  const env = { SITE_URL: 'https://aifoundscore.com' };
  const t = monthlyEmail(env, { token: 'town1', planToken: 'tok', name: 'Otter Plumbing', town: 'Seaford', totals: { namedYou: 2, answers: 15 }, before: null, newTown: true });
  assert.match(t.subject, /Your new town/);
  assert.doesNotMatch(t.text, /asked the AI assistants again/);
  assert.match(t.text, /Seaford/);
  const m = monthlyEmail(env, {
    token: 'tok', planToken: 'tok', name: 'Otter Plumbing', town: 'Wantagh', totals: { namedYou: 6, answers: 15 }, before: { namedYou: 6, answers: 15 },
    post: { title: 'Who we are', text: 'Otter Plumbing is a plumber serving Wantagh. Call 516-555-0100.' },
  });
  assert.match(m.text, /Google post/);
  assert.match(m.text, /Otter Plumbing is a plumber serving Wantagh/);
  assert.deepEqual(lintText(m.text).map((h) => h.match), []);
  assert.deepEqual(lintText(t.text).map((h) => h.match), []);
});
