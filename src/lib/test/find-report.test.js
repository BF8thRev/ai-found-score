// "Lost your report link?" (Oct 2026): POST /api/find-report through the real router, and the pieces
// on the homepage and the report page that bring a returning visitor back to their report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));
async function worker() {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  return (await import('../../worker.js')).default;
}

const PUBLIC = new URL('../../../public/', import.meta.url);
const env = { SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc', RESEND_API_KEY: 're_test', SITE_URL: 'https://aifoundscore.com' };
const T1 = 'zDLK7Xwl4vsA3SaJ-FQr4w', T2 = 'Qq9aBcDeFgHiJkLmNoPqRs';

// Supabase answers the report_requests lookup; Resend records the emails.
function stubFetch(rows) {
  const sent = [], queries = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    if (u.includes('/rest/v1/report_requests')) { queries.push(u); return Response.json(rows); }
    if (u.startsWith('https://api.resend.com/emails')) { sent.push(JSON.parse(init.body)); return Response.json({ id: 'e1' }); }
    return new Response('nf', { status: 404 });
  };
  return { sent, queries, restore: () => { globalThis.fetch = real; } };
}
async function call(w, body) {
  const waits = [];
  const res = await w.fetch(new Request('https://aifoundscore.com/api/find-report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
}

test('POST /api/find-report (router): emails the report links for that address, newest first, one per token', async () => {
  const w = await worker();
  const s = stubFetch([
    { report_token: T1, business_name: 'Mega Wash & Dry' },
    { report_token: T1, business_name: 'Mega Wash & Dry' },
    { report_token: T2, business_name: 'Glenn Wayne Bakery' },
  ]);
  try {
    const res = await call(w, { email: ' Owner@Example.com ' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.match(s.queries[0], /email=eq\.owner%40example\.com/, 'the address is lower-cased and looked up exactly');
    assert.equal(s.sent.length, 1);
    assert.deepEqual(s.sent[0].to, ['owner@example.com']);
    assert.match(s.sent[0].text, new RegExp(`https://aifoundscore\.com/report/${T1}`));
    assert.match(s.sent[0].text, new RegExp(`Glenn Wayne Bakery: https://aifoundscore\.com/report/${T2}`));
    assert.equal((s.sent[0].text.match(new RegExp(T1, 'g')) || []).length, 2, 'T1 once as the button, once in the unsubscribe link; not twice as a report');
  } finally { s.restore(); }
});

test('POST /api/find-report (router): same answer and no email when nothing is on file, so an address can\'t be probed', async () => {
  const w = await worker();
  const found = stubFetch([{ report_token: T1, business_name: 'X' }]);
  let a;
  try { a = await (await call(w, { email: 'a@example.com' })).text(); } finally { found.restore(); }
  const none = stubFetch([]);
  try {
    const b = await (await call(w, { email: 'nobody@example.com' })).text();
    assert.equal(b, a);
    assert.equal(none.sent.length, 0);
  } finally { none.restore(); }
});

test('POST /api/find-report (router): a bad address is a 422, the hidden field sends nothing, a lookup failure still answers', async () => {
  const w = await worker();
  const s = stubFetch([{ report_token: T1, business_name: 'X' }]);
  try {
    assert.equal((await call(w, { email: 'not-an-email' })).status, 422);
    assert.equal((await call(w, { email: 'a@example.com', company_url: 'http://spam' })).status, 200);
    assert.equal(s.sent.length, 0);
    assert.equal(s.queries.length, 0, 'the honeypot never reaches the database');
    globalThis.fetch = async () => new Response('boom', { status: 500 });
    const res = await call(w, { email: 'a@example.com' });
    assert.equal(res.status, 200);
  } finally { s.restore(); }
});

test('the homepage has the lost-link form and the remembered-report card, and the report page saves the last report', () => {
  const index = readFileSync(new URL('index.html', PUBLIC), 'utf8');
  assert.match(index, /id="find-form"[^>]*action="\/api\/find-report"/);
  assert.match(index, /id="return-card"[^>]*hidden/);
  assert.match(index, /<script src="\/js\/my-report\.js/);
  const mine = readFileSync(new URL('js/my-report.js', PUBLIC), 'utf8');
  assert.match(mine, /fetch\('\/api\/find-report'/);
  assert.match(mine, /afs_last_report/);
  const report = readFileSync(new URL('js/report.js', PUBLIC), 'utf8');
  assert.match(report, /if \(!isDemoReport\(report\)\) rememberReport\(/, 'sample reports are never remembered');
  assert.match(report, /rememberReport\(id, j\.business/, 'a report still being made is remembered too');
  assert.match(report, /localStorage\.setItem\('afs_last_report'/);
});
