// The report page while a report is being made (who it's for, whether an email is on file, attaching
// an email to the request by token) and the ready page's opening verdict (public/js/report.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getRequestInfo, requestHasEmail, attachRequestEmailByToken } from '../db.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { reportBody } from '../lock.js';

const ENV = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc' };

// Fake Supabase REST: GET filters (eq., is.null, not.is.null), PATCH, POST.
function fakeDb(tables) {
  const calls = [];
  const match = (u) => (r) => {
    for (const [k, v] of u.searchParams) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (v.startsWith('eq.') && String(r[k] ?? '') !== decodeURIComponent(v.slice(3))) return false;
      if (v === 'is.null' && r[k] != null) return false;
      if (v === 'not.is.null' && r[k] == null) return false;
    }
    return true;
  };
  const f = async (input, init = {}) => {
    const u = new URL(String(input));
    const table = u.pathname.split('/').pop();
    const method = init.method || 'GET';
    calls.push({ method, table, url: String(input), body: init.body ? JSON.parse(init.body) : null });
    const rows = (tables[table] ||= []);
    if (method === 'GET') return Response.json(rows.filter(match(u)));
    if (method === 'PATCH') {
      const hit = rows.filter(match(u));
      const patch = JSON.parse(init.body);
      hit.forEach((r) => Object.assign(r, patch));
      return Response.json(hit.map((r) => ({ id: r.id })));
    }
    if (method === 'POST') { rows.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    return new Response('no', { status: 405 });
  };
  f.calls = calls;
  f.tables = tables;
  return f;
}

test('getRequestInfo: business from the scans row, hasEmail without the address', async () => {
  const f = fakeDb({
    scans: [{ report_token: 'tok123456', business: { name: 'Glenwayne Bakery', town: 'Bohemia', state: 'NY', zip: '11716' }, business_name: 'Glenwayne Bakery' }],
    report_requests: [{ id: 'r1', report_token: 'tok123456', email: 'owner@example.com' }],
  });
  const info = await getRequestInfo(ENV, 'tok123456', { fetchImpl: f });
  assert.deepEqual(info, { business: { name: 'Glenwayne Bakery', town: 'Bohemia', state: 'NY' }, hasEmail: true });
  assert.ok(!JSON.stringify(info).includes('owner@'), 'never returns the address');
  const none = await getRequestInfo(ENV, 'other-token', { fetchImpl: f });
  assert.deepEqual(none, { business: null, hasEmail: false });
  assert.equal(await requestHasEmail(ENV, 'tok123456', { fetchImpl: f }), true);
  assert.equal(await requestHasEmail(ENV, 'other-token', { fetchImpl: f }), false);
});

test('attachRequestEmailByToken fills the request tied to the token', async () => {
  const f = fakeDb({ report_requests: [{ id: 'r1', report_token: 'tok123456', email: null, business_name: 'X', town: 'Y' }] });
  const r = await attachRequestEmailByToken(ENV, { token: 'tok123456', email: 'a@b.com' }, { fetchImpl: f });
  assert.deepEqual(r, { id: 'r1' });
  assert.equal(f.tables.report_requests[0].email, 'a@b.com');
  assert.ok(f.tables.report_requests[0].email_added_at);
  assert.equal(f.tables.report_requests.length, 1);
});

test('attachRequestEmailByToken: already on file → no new row; no request row → a new one for the token', async () => {
  const same = fakeDb({ report_requests: [{ id: 'r1', report_token: 'tok123456', email: 'a@b.com' }] });
  assert.deepEqual(await attachRequestEmailByToken(ENV, { token: 'tok123456', email: 'a@b.com' }, { fetchImpl: same }), { id: 'r1' });
  assert.equal(same.tables.report_requests.length, 1);

  const f = fakeDb({ scans: [{ report_token: 'tok123456', business: { name: 'Glenwayne Bakery', town: 'Bohemia', trade: 'bakery', zip: '11716' } }], report_requests: [] });
  const r = await attachRequestEmailByToken(ENV, { token: 'tok123456', email: 'new@b.com' }, { fetchImpl: f, uuid: () => 'u-1' });
  assert.deepEqual(r, { id: 'u-1' });
  const row = f.tables.report_requests[0];
  assert.equal(row.report_token, 'tok123456');
  assert.equal(row.email, 'new@b.com');
  assert.equal(row.business_name, 'Glenwayne Bakery');
  assert.equal(row.town, 'Bohemia');
});

// ---- public/js/report.js, run in a bare VM (its top-level only registers a DOMContentLoaded listener) ----
function loadReportJs() {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null },
    window: { location: { search: '' } },
    location: { search: '' },
    URLSearchParams,
    console,
  });
  vm.runInContext(src, ctx);
  return ctx;
}

test('pending copy: a real time expectation per status', () => {
  const r = loadReportJs();
  assert.match(r.pendingCopy('running', false).p, /fills in as the answers come back/);
  assert.match(r.pendingCopy('queued', false).p, /^Ready by [A-Z][a-z]+day, [A-Z][a-z]{2} \d{1,2}\./);
  assert.match(r.pendingCopy('paid', false).h, /Your full audit is being made/);
  assert.match(r.pendingCopy('paid', false).p, /fills in as the answers come back/);
  assert.equal(r.pendingCopy('failed', true).p, 'We’ve been alerted and we’ll re-run it. You’ll get an email when it’s ready.');
  assert.doesNotMatch(r.pendingCopy('failed', false).p, /You’ll get an email/);
  assert.equal(r.pendingState({ status: 'weird' }).status, 'running');
  assert.equal(r.pendingState({ status: 'failed', hasEmail: true }).hasEmail, true);
});

test('next business day skips weekends (New York time)', () => {
  const r = loadReportJs();
  // Fri Sep 25 2026, noon in New York → Monday.
  assert.equal(r.nextBusinessDay(new Date('2026-09-25T16:00:00Z')), 'Monday, Sep 28');
  // Sun Sep 27 → Monday.
  assert.equal(r.nextBusinessDay(new Date('2026-09-27T16:00:00Z')), 'Monday, Sep 28');
  // Mon Sep 28 → Tuesday.
  assert.equal(r.nextBusinessDay(new Date('2026-09-28T16:00:00Z')), 'Tuesday, Sep 29');
});

test('ready report opens with one plain verdict line; the score sits in the top band', () => {
  const r = loadReportJs();
  const sample = Object.values(MOCK_REPORTS).find((x) => x.version === 2);
  assert.ok(sample, 'a v2 sample report');
  const report = reportBody(sample, false); // what GET /api/report sends a free report (score added)
  const t = r.computeTotalsV2(report.answers);
  const cw = r.countWords(report);
  const proven = r.provenEntities(report);
  const html = r.verdictV2(report, { t, N: t.answers, cw, proven, zero: t.namedYou === 0, allNamed: t.namedYou === t.answers });
  assert.match(html, new RegExp(`We asked AI ${t.answers} times\. It (never mentioned you|mentioned you (every time|(once|${t.namedYou} times)))\.`));
  if (proven[0] && t.namedYou < t.answers) assert.ok(html.includes(`<span class="r2-rival">${proven[0].name.replace(/&/g, '&amp;')}</span> came up ${proven[0].named === 1 ? 'once' : proven[0].named + ' times'}.`), 'names the top competitor');
  assert.doesNotMatch(html, /r2-score/, 'the score lives in the top band now');
  const band = r.headerV2(report, report.business, r.scoreV2(report));
  assert.match(band, /r2-sc-meter/);
  assert.match(band, /How we score/);
  assert.ok(!/guarantee|rank/i.test(html.replace(/<[^>]+>/g, ' ')));
});
