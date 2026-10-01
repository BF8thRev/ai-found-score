// The one-step free-report flow (Oct 2026): website first, the name / area / kind prefilled from
// the site, one press, then the report page shows the live answer, the questions and the progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { parseArea } from '../report-request.js';
import { requestKey, FREE_ENGINE_TIMEOUT_MS } from '../auto-scan.js';

const PUBLIC = new URL('../../../public/', import.meta.url);
const index = readFileSync(new URL('index.html', PUBLIC), 'utf8');

test('the hero form is one step: website first, then name, area and kind; town and ZIP are hidden', () => {
  const form = /<form class="hero-form" id="request-form"[\s\S]*?<\/form>/.exec(index)[0];
  const names = [...form.matchAll(/<input name="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['website', 'business_name', 'area', 'zip', 'state', 'trade_other', 'company_url']);
  assert.match(form, /<input name="zip" type="hidden">/);
  assert.match(form, /id="site-note"/, 'what the site check read is shown under the website box');
  assert.doesNotMatch(form, /What kind of business is it\?/, 'no error-styled follow-up question');
  assert.equal((form.match(/type="submit"/g) || []).length, 1);
  // The script hands the visitor to their report page with what the live answer needs.
  assert.match(index, /sessionStorage\.setItem\('afs_live'/);
  assert.match(index, /location\.assign\(path\)/);
});

test('parseArea: a town, "Town, ST", an area, or a ZIP', () => {
  assert.deepEqual(parseArea('Stamford, CT'), { town: 'Stamford', state: 'CT' });
  assert.deepEqual(parseArea('Long Island'), { town: 'Long Island' });
  assert.deepEqual(parseArea('11758'), { zip: '11758' });
  assert.deepEqual(parseArea('11758-1234'), { zip: '11758' });
  assert.deepEqual(parseArea(''), {});
});

test('POST /api/request (router, no-JS form post): the area box stands in for town and state', async () => {
  const w = await worker();
  const saved = [];
  const realFetch = globalThis.fetch;
  // The site gate's fetch of the website, and the Supabase insert of the request row.
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input);
    if (u.startsWith('https://pr73.com/')) return new Response('<title>PR 73</title>', { headers: { 'Content-Type': 'text/html' } });
    if (u.includes('/rest/v1/report_requests') && init.method === 'POST') { saved.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    return new Response('nf', { status: 404 });
  };
  const env = { SUPABASE_URL: 'https://db.example.com', SUPABASE_ANON_KEY: 'anon' };
  const post = (fields) => w.fetch(new Request('https://aifoundscore.com/api/request', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual',
  }), env, { waitUntil() {} });
  try {
    let res = await post({ business_name: 'PR 73', website: 'pr73.com', area: 'New York City, NY', trade_other: 'pr agency' });
    assert.equal(res.status, 303);
    assert.equal(new URL(res.headers.get('Location')).search, '?request=ok');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].town, 'New York City', 'the state goes to the scan (report_requests has no state column)');
    assert.equal(saved[0].zip ?? null, null);
    assert.equal(saved[0].trade, 'PR agency');
    res = await post({ business_name: 'PR 73', website: 'pr73.com', area: '11758' });
    assert.equal(new URL(res.headers.get('Location')).search, '?request=error', 'a bare ZIP with no town is not enough without the page script');
    assert.equal(saved.length, 1);
    res = await post({ business_name: 'PR 73', website: 'pr73.com', area: 'Long Island', town: 'Massapequa', state: 'NY' });
    assert.equal(saved[1].town, 'Massapequa', 'a town the page filled wins over the box');
  } finally { globalThis.fetch = realFetch; }
});

test('dedupe key: the ZIP when there is one, else the typed area; a free scan waits 60 s per engine, not 120', () => {
  assert.equal(requestKey({ name: 'PR 73', zip: '10001', town: 'New York City' }), 'pr 73|10001');
  assert.equal(requestKey({ name: 'PR 73', town: 'Long Island' }), 'pr 73|long island');
  assert.notEqual(requestKey({ name: 'PR 73', town: 'Massapequa' }), requestKey({ name: 'PR 73', town: 'Long Island' }));
  assert.equal(FREE_ENGINE_TIMEOUT_MS, 60_000);
});

// ---- through the real router ----
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));
async function worker() {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  return (await import('../../worker.js')).default;
}

test('GET /api/site-check (router) answers with the name and kind from the page when no name is given', async () => {
  const w = await worker();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith('https://pr73.com/')) return new Response('<title>PR 73 | Public Relations Agency</title>', { headers: { 'Content-Type': 'text/html' } });
    return new Response('nf', { status: 404 });
  };
  try {
    const res = await w.fetch(new Request('https://aifoundscore.com/api/site-check?website=pr73.com'), {}, { waitUntil() {} });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, url: 'https://pr73.com/', name: 'PR 73', kind: 'PR agency', kindFrom: 'website' });
  } finally { globalThis.fetch = realFetch; }
});

test('GET /api/report/<token> (router) while the scan runs: 202 with the questions and the progress', async () => {
  const w = await worker();
  const token = 'zDLK7Xwl4vsA3SaJ-FQr4w';
  const scanId = '45495e22-d837-4d70-a915-56680e756d9d';
  const tables = {
    scan_results: [],
    scans: [{ id: scanId, report_token: token, status: 'running', trigger: 'request', calls_total: 9, business_name: 'PR 73', business: { name: 'PR 73', town: 'New York City', state: 'NY', zip: '10001', trade: 'PR agency' }, created_at: '2026-10-01T17:49:15Z' }],
    scan_raw: [1, 2, 3].map((n) => ({ id: `r${n}`, scan_id: scanId })),
    report_requests: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    const table = u.pathname.split('/').pop();
    if (!(table in tables)) return new Response('nf', { status: 404 });
    const rows = tables[table].filter((r) => [...u.searchParams].every(([k, v]) => !v.startsWith('eq.') || String(r[k] ?? '') === decodeURIComponent(v.slice(3))));
    return Response.json(rows);
  };
  try {
    const env = { SUPABASE_URL: 'https://db.example.com', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'svc' };
    const res = await w.fetch(new Request(`https://aifoundscore.com/api/report/${token}`), env, { waitUntil() {} });
    assert.equal(res.status, 202);
    const j = await res.json();
    assert.equal(j.status, 'running');
    assert.deepEqual(j.business, { name: 'PR 73', town: 'New York City', state: 'NY' });
    assert.deepEqual(j.progress, { done: 3, total: 9 });
    assert.deepEqual(j.questions.map((q) => q.text), [
      "What's the best PR agency in New York City, NY?",
      'Top rated PR agency in New York City, NY',
      'Can you recommend a PR agency in New York City NY?',
    ]);
    assert.ok(!JSON.stringify(j).includes('10001'), 'the ZIP stays off the page');
  } finally { globalThis.fetch = realFetch; }
});

test('report.js pending page: questions and progress from the 202 body; a handoff only for its own token', () => {
  const src = readFileSync(new URL('js/report.js', PUBLIC), 'utf8');
  const store = { afs_live: JSON.stringify({ token: 'abc', request_id: 'r', preview_token: 't', question: 'Q1' }) };
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null }, window: { location: { search: '' } }, location: { search: '' },
    URLSearchParams, console, sessionStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  });
  vm.runInContext(src, ctx);
  const st = ctx.pendingState({ status: 'running', questions: [{ id: 'q1', text: 'A' }, { text: 'B' }, { id: 'q3' }], progress: { done: 4, total: 9 } });
  const plain = (v) => JSON.parse(JSON.stringify(v)); // objects made in the vm realm
  assert.deepEqual(plain(st.questions), [{ id: 'q1', text: 'A' }, { id: '', text: 'B' }]);
  assert.deepEqual(plain(st.progress), { done: 4, total: 9 });
  assert.equal(ctx.pendingState({ status: 'running' }).progress, null);
  assert.equal(ctx.pendingState({ status: 'running', progress: { done: 1, total: 0 } }).progress, null);
  assert.equal(ctx.liveHandoff('abc').question, 'Q1');
  assert.equal(ctx.liveHandoff('other'), null);
  assert.match(ctx.progressLine({ done: 12, total: 9 }), />9 of 9 answers in</, 'never more than the total');
  assert.match(src, /const PENDING_POLL_MS = \[5000, 5000/, 'quick re-checks at first');
});
