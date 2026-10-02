// The "PR 73" paid report through the real routes (src/worker.js): /api/report/<token> and the page that
// renders it (public/js/report.js), and /api/fix-kit/<token>. Two stored reports:
//   - a new scan (scanner/test/fixtures/pr73.js, built offline by the scanner): each list AI cited says
//     "You’re not on it" (with the directory's add link), "You’re listed — check the details" (with the
//     profile) or "Not checked yet" (with why);
//   - a report stored before Oct 2 2026 (no list checks, no siteCheck.brand): nothing is fetched at serve
//     time; only the spelling is read off the stored homepage title and description.
// The name: the website writes "PR73", the request said "PR 73". One spelling everywhere, and a plain ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { buildPr73Report } from '../../../scanner/test/fixtures/pr73.js';
import { officeReport } from './fixtures/office-report.js';
import { lintText } from '../../../shared/report-v2.js';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const TOKEN = 'pR73tokenAbCdEfGhIjKl1';
const reply = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** The real Worker, a fake Supabase holding `stored` (paid: an xray payment); `seen` logs every outside request. */
async function withWorker(stored, fn) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    seen.push(u.href);
    if (u.pathname === '/rest/v1/rpc/report_unlocked') return reply(true);
    if (u.pathname === '/rest/v1/scan_results') return reply([{ version: 2, report: stored, scanned_at: '2026-10-01T17:51:00Z' }]);
    if (u.pathname === '/rest/v1/payments') return reply([{ tier: 'xray', amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' }]);
    return reply([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service', ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call = (path) => worker.fetch(new Request(`https://aifoundscore.com${path}`), env, { waitUntil() {} });
    await fn(call, seen);
  } finally {
    globalThis.fetch = real;
  }
}

function render(report) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(src, ctx);
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  ctx.renderV2(root, report);
  return root.innerHTML;
}
const planOf = (html) => { const i = html.indexOf('id="action-plan"'); assert.ok(i >= 0); return html.slice(i, html.indexOf('</section>', i)); };
const siteRow = (plan, domain) => { const m = plan.match(new RegExp(`<li><span class="badge[^"]*">[^<]*</span>(?:(?!</li>).)*>${domain.replace(/\./g, '\\.')}</a>(?:(?!</li>).)*</li>`, 's')); assert.ok(m, `row for ${domain}`); return m[0]; };

test('GET /api/report/<token>, a new scan: each list says listed, not on it, or not checked (with why)', async () => {
  const { report, validation } = await buildPr73Report();
  assert.deepEqual(validation.errors, []);
  await withWorker(report, async (call, seen) => {
    const res = await call(`/api/report/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.locked, false);
    const lists = body.xray.actionPlan.items.find((i) => i.id === 'lists');
    assert.deepEqual(lists.sites.map((s) => s.status), ['missing', 'missing', 'check', 'check', 'check', 'listed']);
    const plan = planOf(render(body));
    // Not on it: we read the page. GoodFirms has an add link we checked; the other doesn't.
    const gf = siteRow(plan, 'goodfirms.co');
    assert.match(gf, /<span class="badge mismatch">You’re not on it<\/span>/);
    assert.match(gf, /<a class="ap-add" href="https:\/\/www\.goodfirms\.co\/get-listed"[^>]*>Add your company<\/a>/);
    assert.doesNotMatch(siteRow(plan, 'publicrelationsdatabase.com'), /Add your/);
    // Listed: the domain links to the profile we saw.
    const cm = siteRow(plan, 'communicationsmatch.com');
    assert.match(cm, /<span class="badge match">You’re listed — check the details<\/span>/);
    assert.match(cm, /href="https:\/\/www\.communicationsmatch\.com\/company\/pr73"/);
    // Couldn't check: the reason, never "not on it".
    assert.match(siteRow(plan, 'clutch.co'), /Not checked yet<\/span>.*\(the site blocks automated checks\)/s);
    assert.match(siteRow(plan, 'designrush.com'), /Not checked yet<\/span>.*\(the site asks crawlers not to read this page\)/s);
    // One name in the plan, and the plain ask to pick one.
    assert.match(plan, /Your website writes “PR73” and your report request said “PR 73” — pick one and use it everywhere\./);
    assert.match(plan, /Business name: PR73/);
    assert.doesNotMatch(plan, /Business name: PR 73/);
    // Our copy has no banned words.
    assert.deepEqual(lintText(plan.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')).map((h) => h.word), []);
    // Serving it reads the stored report only: nothing fetched from the cited sites, nothing written.
    assert.ok(seen.every((u) => u.startsWith('https://sb.example/')), seen.join('\n'));
  });
});

// A report stored before the list checks: every cited list unread, no siteCheck.brand. Shaped like the
// live PR 73 report (office fixture, renamed), made to pass the serve gate.
function storedBeforeOct2() {
  const r = officeReport();
  r.business = { ...r.business, name: 'PR 73', website: 'https://www.pr73.com' };
  r.siteCheck = { ...r.siteCheck, url: 'https://www.pr73.com', meta: { ...r.siteCheck.meta, title: 'Integrated Communications, PR & Media Relations | PR73', description: 'PR73 is an integrated communications and media relations firm in New York City.' } };
  for (const e of r.entities) e.first = r.answers.filter((a) => a.businessesNamed[0] && a.businessesNamed[0].entityId === e.id).length;
  r.headline = { ...r.headline, answerId: 'a1' };
  r.method.window = '5:49 PM to 5:51 PM ET';
  return r;
}

test('GET /api/report/<token>, a report stored before: the spelling is fixed from its stored title; lists stay "Not checked yet"', async () => {
  await withWorker(storedBeforeOct2(), async (call, seen) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const lists = body.xray.actionPlan.items.find((i) => i.id === 'lists');
    for (const s of lists.sites) assert.equal(s.status, 'check', 'never read: never "not on it"');
    assert.ok(lists.sites.every((s) => !s.reason), 'no reason we don’t have');
    const plan = planOf(render(body));
    assert.match(plan, /<span class="badge low">Not checked yet<\/span>/);
    assert.doesNotMatch(plan, /You’re not on it|You’re listed/);
    assert.match(plan, /Your website writes “PR73” and your report request said “PR 73” — pick one and use it everywhere\./);
    assert.match(plan, /Business name: PR73/);
    assert.ok(seen.every((u) => u.startsWith('https://sb.example/')), 'no serve-time fetch of the cited sites');
  });
});

test('GET /api/fix-kit/<token>: the kit uses the website’s spelling and flags it under "Check these details"', async () => {
  await withWorker(storedBeforeOct2(), async (call) => {
    const res = await call(`/api/fix-kit/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.details.name, 'PR73');
    assert.deepEqual(body.kit.notes.map((n) => n.field), ['name']);
    assert.match(body.kit.notes[0].note, /^Your website writes “PR73” and your report request said “PR 73” — pick one and use it everywhere\. We used “PR73”, as your website does\./);
    assert.match(body.kit.readme, /- Check: Business name\. Your website writes “PR73”/);
    // The FAQ is written with the same name.
    const faq = body.kit.jobs.find((j) => j.id === 'faq').files.find((f) => f.path === 'faq-page.txt').content;
    assert.match(faq, /PR73/);
    assert.doesNotMatch(faq, /PR 73/);
  });
});

test('the Fix Kit page shows the note on the name row', () => {
  const script = readFileSync(new URL('../../../public/js/fix-kit.js', import.meta.url), 'utf8');
  assert.match(script, /kit\.notes/);
  assert.match(script, /notes\[r\[0\]\]\.note/);
});
