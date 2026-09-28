// /admin email arm: the funnel table (zeros when empty, same counts as Prospects), the read-only
// Prospects table + timeline, and the "Log a sent email" / "Add a prospect" routes (gated, CSRF-checked,
// never sending anything). Supabase is an in-memory fake behind globalThis.fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminRequest } from '../routes.js';
import { renderDashboard } from '../page.js';
import { signSession, SESSION_COOKIE } from '../session.js';
import { emailFunnelRows, parseSentForm, parseProspectForm, groupTimeline, STAGES } from '../outreach.js';

const SECRET = 'test-admin-token-1234567890';
const ORIGIN = 'https://aifoundscore.com';
const BIZ = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'Abcdefghij_klmnop-123';
const BEARER = { Authorization: `Bearer ${SECRET}` };
const FORM_H = { 'Content-Type': 'application/x-www-form-urlencoded' };
const ENV = { ADMIN_TOKEN: SECRET, SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' };

// A tiny PostgREST: GET <table>?… returns tables[table] (id=eq / business_id=eq filters applied), POST appends.
function fakeSupabase(tables = {}) {
  const writes = [];
  const impl = async (url, init = {}) => {
    const u = new URL(String(url));
    const table = u.pathname.replace('/rest/v1/', '');
    if ((init.method || 'GET') === 'POST') {
      const body = JSON.parse(init.body);
      writes.push({ table, body });
      (tables[table] ||= []).push({ id: `id-${writes.length}`, ...body });
      return new Response(JSON.stringify([{ id: `id-${writes.length}` }]), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    let rows = tables[table] || [];
    for (const [k, v] of u.searchParams) {
      const m = /^eq\.(.*)$/.exec(v);
      if (m && k !== 'select') rows = rows.filter((r) => String(r[k]) === m[1]);
      const il = /^ilike\.(.*)$/.exec(v);
      if (il) rows = rows.filter((r) => String(r[k]).toLowerCase() === il[1].replace(/\\/g, '').toLowerCase());
    }
    return Response.json(rows);
  };
  return { impl, writes, tables };
}
async function withFetch(fake, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fake.impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}
const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
  const url = new URL(path, ORIGIN);
  return handleAdminRequest(new Request(url, { method, headers, body, redirect: 'manual' }), url, env);
};
const form = (o) => new URLSearchParams(o).toString();

// ---- pure pieces ----------------------------------------------------------------------------

test('emailFunnelRows: the email arm is always there (zeros), with stage-to-stage rates', () => {
  const [z] = emailFunnelRows([]);
  assert.equal(z.arm, 'email');
  assert.deepEqual(Object.values(z.counts), [0, 0, 0, 0, 0, 0]);
  assert.ok(Object.values(z.rates).every((r) => r === null));
  const [r] = emailFunnelRows([{ arm: 'email', sent: 20, opened: 10, clicked: 4, snapshot_started: 2, snapshot_completed: 2, paid: 1, unsubscribed: 1 }]);
  assert.equal(r.rates.opened, 0.5);
  assert.equal(r.rates.clicked, 0.4);
  assert.equal(r.rates.paid, 0.5);
  assert.equal(r.unsubscribed, 1);
  assert.equal(emailFunnelRows(null).length, 1);
});

test('parseSentForm / parseProspectForm: validation', () => {
  assert.equal(parseSentForm({ business_id: BIZ, campaign: 'test20-a', email: 'Owner@X.com' }).row.email, 'owner@x.com');
  assert.equal(parseSentForm({ business_id: 'nope', campaign: 'x' }).ok, false);
  assert.equal(parseSentForm({ business_id: BIZ, campaign: '' }).ok, false);
  assert.equal(parseSentForm({ business_id: BIZ, campaign: 'a*b' }).ok, false, 'no wildcards');
  assert.equal(parseSentForm({ business_id: BIZ, campaign: 'c', email: 'not-an-email' }).ok, false);
  assert.equal(parseProspectForm({ name: 'Acme', town: 'Hicksville' }).ok, true);
  assert.equal(parseProspectForm({ name: 'Acme' }).ok, false);
  assert.equal(parseProspectForm({ town: 'Hicksville' }).ok, false);
});

test('groupTimeline: by token, oldest first', () => {
  const g = groupTimeline([{ token: 'a', kind: 'clicked', at: '2026-09-28T12:00:00Z' }, { token: 'a', kind: 'sent', at: '2026-09-28T10:00:00Z' }, { kind: 'x' }]);
  assert.deepEqual(g.get('a').map((e) => e.kind), ['sent', 'clicked']);
  assert.equal(g.size, 1);
});

// ---- the page -------------------------------------------------------------------------------

const PROSPECTS = [
  { token: TOKEN, business: 'Hilltop Plumbing & Heating', town: 'Hicksville', arm: 'email', campaign: 'test20-a', email: 'o@h.com', stage: 'clicked', stage_rank: 2, last_event: 'clicked', last_event_at: '2026-09-28T15:05:00Z', report_token: null },
  { token: 'Zzzzzzzzzzzzzzzzzzzzz1', business: 'Werner <Plumbing>', town: 'Bethpage', arm: 'email', campaign: 'test20-a', stage: 'sent', stage_rank: 0, last_event: 'sent', last_event_at: '2026-09-28T14:00:00Z' },
];
const TIMELINE = [
  { token: TOKEN, kind: 'sent', at: '2026-09-28T14:00:00Z' },
  { token: TOKEN, kind: 'opened', at: '2026-09-28T15:00:00Z' },
  { token: TOKEN, kind: 'clicked', at: '2026-09-28T15:05:00Z', detail: '/' },
];
const render = (data, errors = {}, opts = {}) => renderDashboard({ configured: true, data, errors }, { nonce: 'n', engineIds: ['chatgpt'], ...opts });
// What v_email_funnel computes from v_email_prospects (reached = stage_rank >= i).
const funnelFrom = (rows) => [{ arm: 'email', ...Object.fromEntries(STAGES.map((s, i) => [s.key, rows.filter((r) => r.stage_rank >= i).length])) }];

test('page: with nothing logged the email arm shows zeros, not errors; the mail arm is untouched', () => {
  const mail = [{ arm: 'mail', recipients: 1, visited: 1, leads: 0, paying: 0, revenue_usd: 0, visit_rate: 1, pay_rate: 0 }];
  const html = render({ funnel: mail, emailFunnel: [], prospects: [], timeline: [], prospectBusinesses: [] });
  const funnel = html.slice(html.indexOf('id="funnel"'), html.indexOf('id="prospects"'));
  assert.match(funnel, /<td><b>mail<\/b><\/td><td class="n">1<\/td><td class="n">1<\/td><td class="n">0<\/td><td class="n">0<\/td><td class="n">\$0\.00<\/td><td class="n">100%<\/td><td class="n">0%<\/td>/, 'mail row exactly as before');
  assert.match(funnel, /<b>email<\/b><\/td>(<td class="n">0(<div class="small">—<\/div>)?<\/td>){6}<td class="n">0<\/td>/);
  assert.ok(!/class="err"/.test(funnel));
  assert.match(html, /No emails logged yet/);
});

test('page: funnel counts match the Prospects table; Prospects is read-only; timeline per row', () => {
  const html = render({ emailFunnel: funnelFrom(PROSPECTS), prospects: PROSPECTS, timeline: TIMELINE, prospectBusinesses: [] });
  const funnel = html.slice(html.indexOf('<h3>Email arm</h3>'), html.indexOf('id="prospects"'));
  const cells = [...funnel.matchAll(/<td class="n">(\d+)/g)].map((m) => Number(m[1]));
  const byStage = STAGES.map((s, i) => PROSPECTS.filter((p) => STAGES.findIndex((x) => x.key === p.stage) >= i).length);
  assert.deepEqual(cells.slice(0, 6), byStage, 'funnel = prospects at or past each stage');
  const section = html.slice(html.indexOf('<section id="prospects">'), html.indexOf('<section id="log-email">'));
  assert.equal((section.match(/<tr class="pick"/g) || []).length, 2);
  assert.ok(!/<form|type="submit"|method="post"/i.test(section), 'no forms or submit buttons in Prospects');
  assert.equal((section.match(/<button/g) || []).length, 1, 'only the drawer close button');
  assert.match(section, /Werner &lt;Plumbing&gt;/, 'escaped');
  const tl = section.slice(section.indexOf(`<template data-timeline="${TOKEN}">`));
  assert.ok(tl.indexOf('Email sent') < tl.indexOf('Opened') && tl.indexOf('Opened') < tl.indexOf('Clicked a link'));
});

test('page: a failed read shows its error in that section only', () => {
  const html = render({ prospects: [] }, { emailFunnel: 'v_email_funnel not found — apply supabase/v12_email_tracking.sql' });
  assert.match(html, /apply supabase\/v12_email_tracking\.sql/);
  assert.match(html, /<section id="money">/);
});

// ---- routes ---------------------------------------------------------------------------------

test('routes: log a sent email → one sent row, redirect, then the page shows links + footer (and never loads the pixel)', async () => {
  const db = fakeSupabase({
    businesses: [{ id: BIZ, name: 'Hilltop Plumbing & Heating', town: 'Hicksville' }],
    scan_results: [{ business_id: BIZ, report_token: 'rep123' }],
    email_events: [],
  });
  await withFetch(db, async () => {
    const r = await call(ENV, '/admin/email/sent', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ business_id: BIZ, campaign: 'test20-a', email: 'owner@hilltop.com' }) });
    assert.equal(r.status, 303);
    const loc = new URL(r.headers.get('Location'));
    const token = loc.searchParams.get('sent');
    assert.match(token, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(loc.hash, '#log-email');
    const rows = db.writes.filter((w) => w.table === 'email_events');
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { arm: rows[0].body.arm, event: rows[0].body.event, campaign: rows[0].body.campaign, town: rows[0].body.town, report_token: rows[0].body.report_token, token: rows[0].body.token },
      { arm: 'email', event: 'sent', campaign: 'test20-a', town: 'Hicksville', report_token: 'rep123', token },
    );
    assert.equal(db.writes.length, 1, 'nothing else written');

    // Same business + campaign again: same token, no new row.
    const again = await call(ENV, '/admin/email/sent', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ business_id: BIZ, campaign: 'TEST20-A' }) });
    assert.equal(new URL(again.headers.get('Location')).searchParams.get('sent'), token);
    assert.equal(db.writes.length, 1);

    // The page after the redirect (the view row is faked from the sent row).
    db.tables.v_email_prospects = [{ token, business: 'Hilltop Plumbing & Heating', campaign: 'test20-a', arm: 'email', stage: 'sent', stage_rank: 0, report_token: 'rep123' }];
    const page = await call(ENV, `/admin?sent=${token}#log-email`, { headers: BEARER });
    assert.equal(page.status, 200);
    const html = await page.text();
    const snip = html.slice(html.indexOf('<div class="snippet">'), html.indexOf('<form class="grid" method="post" action="/admin/email/sent">'));
    assert.match(snip, /Nothing was emailed/);
    assert.ok(snip.includes(`https://aifoundscore.com/e/click?token=${token}&amp;to=https%3A%2F%2Faifoundscore.com%2F`));
    assert.ok(snip.includes('report%2Frep123'), 'their report link too');
    assert.ok(snip.includes(`https://aifoundscore.com/stop?ref=${token}`));
    assert.ok(snip.includes('120 Terminal Drive, Plainview, NY 11803'));
    assert.ok(!/<img[^>]+e\/open/.test(html), 'the tracking image is never rendered on /admin');
  });
});

test('routes: the sent form refuses bad input and unknown businesses; no row written', async () => {
  const db = fakeSupabase({ businesses: [], scan_results: [], email_events: [] });
  await withFetch(db, async () => {
    const bad = await call(ENV, '/admin/email/sent', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ business_id: 'x', campaign: 'c' }) });
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /Pick a business/);
    const unknown = await call(ENV, '/admin/email/sent', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ business_id: BIZ, campaign: 'c' }) });
    assert.equal(unknown.status, 422);
    assert.match(await unknown.text(), /isn’t in the database/);
    assert.equal(db.writes.length, 0);
  });
});

test('routes: add a prospect (exact name already there → no copy)', async () => {
  const db = fakeSupabase({ businesses: [{ id: BIZ, name: 'Werner Plumbing' }] });
  await withFetch(db, async () => {
    const r = await call(ENV, '/admin/prospects', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ name: 'Acme Heating', town: 'Plainview', trade: 'hvac' }) });
    assert.equal(r.status, 303);
    assert.match(r.headers.get('Location'), /prospect=added#log-email$/);
    assert.deepEqual(db.writes[0], { table: 'businesses', body: { name: 'Acme Heating', trade: 'hvac', town: 'Plainview', website: null, phone: null, address: null } });
    const dup = await call(ENV, '/admin/prospects', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ name: 'Werner Plumbing', town: 'Bethpage' }) });
    assert.match(dup.headers.get('Location'), /prospect=exists/);
    assert.equal(db.writes.length, 1);
    assert.equal((await call(ENV, '/admin/prospects', { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: form({ name: 'No Town' }) })).status, 422);
  });
});

test('routes: the new forms are gated and CSRF-checked like the rest', async () => {
  const db = fakeSupabase({ businesses: [{ id: BIZ, name: 'X' }], email_events: [] });
  await withFetch(db, async () => {
    for (const path of ['/admin/email/sent', '/admin/prospects']) {
      const body = form({ business_id: BIZ, campaign: 'c', name: 'Y', town: 'Z' });
      assert.equal((await call({ ...ENV, ADMIN_TOKEN: ' ' }, path, { method: 'POST', headers: FORM_H, body })).status, 404, 'no ADMIN_TOKEN');
      const anon = await call(ENV, path, { method: 'POST', headers: { ...FORM_H, Origin: ORIGIN }, body });
      assert.equal(anon.status, 303);
      assert.equal(new URL(anon.headers.get('Location')).pathname, '/admin', 'to the sign-in page');
      const cookie = `${SESSION_COOKIE}=${await signSession(SECRET)}`;
      const csrf = await call(ENV, path, { method: 'POST', headers: { ...FORM_H, Cookie: cookie, Origin: 'https://evil.example' }, body });
      assert.equal(csrf.status, 403);
      assert.equal((await call(ENV, path, { headers: BEARER })).status, 303, 'GET goes back to the page');
    }
    assert.equal(db.writes.length, 0);
  });
});
