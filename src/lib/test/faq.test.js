// The FAQ built from what AI actually said in the scan (shared/faq.js): the questions customers asked,
// answers in the style AI quotes, the detail types AI cited for the businesses it picked, and the
// same FAQ in the Fix Kit (src/lib/fix-kit.js) and the paid report's action plan (shared/action-plan.js).
// Router-level: /api/fix-kit/<token> through the Worker's own fetch handler, for a paid report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { buildFaq, attributeTypes, faqJsonLd, faqPlainText, customerQuestion } from '../../../shared/faq.js';
import { buildActionPlan } from '../../../shared/action-plan.js';
import { lintText } from '../../../shared/report-v2.js';
import { prefillDetails, validateDetails, buildKit, reportFaq } from '../fix-kit.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { officeReport } from './fixtures/office-report.js';

const PLUMBER = MOCK_REPORTS['sample-001'];
const kitDetails = (report, over = {}) => validateDetails({ ...prefillDetails(report), ...over }).details;
const words = (s) => s.split(/\s+/).filter(Boolean).length;
// An answer with every [bracket] filled the way its example shows: what the owner would publish.
const finished = (it) => it.answer.replace(/\[[^\]]*e\.g\. “([^”]*)”\]/g, '$1');

// The PR agency fixture's answers say only "X is well known". Real ones read like these (the facts
// are the rivals'; only the TYPES may reach Harbor Lane's answers).
function prReport() {
  const r = officeReport();
  const extra = {
    a1: 'Kestrel PR specializes in tech and consumer brands. Brightline Communications is a boutique firm with senior-level attention on every account.',
    a2: 'Monarch Media Group, founded in 2005, is known for crisis communications. Clients include Fortune 500 companies.',
    a5: 'Kestrel PR works with startups and has won several industry awards for its campaigns.',
    a6: 'Brightline Communications has been in business for over 20 years.',
  };
  for (const a of r.answers) if (extra[a.id]) a.text += extra[a.id];
  return r;
}

test('attributeTypes: the detail types AI cited when it picked someone else, most mentioned first', () => {
  const types = attributeTypes(prReport()).map((a) => a.type);
  for (const t of ['specialty', 'clients', 'experience', 'team', 'results']) assert.ok(types.includes(t), t);
  assert.ok(!types.includes('price') && !types.includes('licensed'), 'nothing that wasn’t said');
  // An answer that named the owner is not a "winning" answer for someone else.
  const r = prReport();
  for (const a of r.answers) a.namedYou = true;
  assert.deepEqual(attributeTypes(r), []);
  // The plumber sample: prices, the team (family-owned, independent: the small-firm question) and reviews
  // come up when AI names other plumbers.
  const plumber = attributeTypes(PLUMBER).map((a) => a.type);
  assert.deepEqual(plumber.slice(0, 3), ['price', 'team', 'reviews']);
});

test('PR agency: the questions AI didn’t name them for, as customers ask them, then 2–4 more', () => {
  const r = prReport();
  const faq = buildFaq(r, kitDetails(r));
  assert.equal(faq.kind, 'professional');
  const qs = faq.items.map((i) => i.question);
  assert.deepEqual(qs.slice(0, 2), ["What's the best PR agency in New York City, NY?", 'Can you recommend a PR agency in New York City, NY?']);
  assert.ok(faq.items.slice(0, 2).every((i) => i.fromScan && i.lost));
  assert.ok(!qs.some((q) => /open now/i.test(q)), 'no "open now" for an office');
  const extra = faq.items.filter((i) => !i.fromScan);
  assert.ok(extra.length >= 2 && extra.length <= 4, `${extra.length} extra questions`);
  // The extra detail questions follow what AI cited for the rivals (not price or licenses).
  const extraTypes = extra.filter((i) => i.slot).map((i) => i.slot.type);
  assert.equal(extraTypes.length, 2);
  const cited = attributeTypes(r).map((a) => a.type);
  for (const t of extraTypes) assert.ok(cited.includes(t), t);
  assert.ok(qs.includes('Where is Harbor Lane PR based?'));
  assert.ok(qs.includes('How do I get started with Harbor Lane PR?'));
  // Each detail type is asked once.
  const slots = faq.items.filter((i) => i.slot).map((i) => i.slot.type);
  assert.equal(new Set(slots).size, slots.length);
});

test('PR agency: every answer opens with name, trade and place; plain, short, no claims we can’t back', () => {
  const r = prReport();
  const faq = buildFaq(r, kitDetails(r));
  for (const it of faq.items) {
    assert.match(it.answer, /^(Harbor Lane PR is a PR agency (based )?in New York City, NY|To get started with Harbor Lane PR, a PR agency in New York City, NY)/, it.question);
    assert.doesNotMatch(it.answer, /\b(best|top|leading|#1|premier|world-class|award-winning|guarantee)\b/i, it.answer);
    // The rivals' own facts never reach this business's answers.
    assert.doesNotMatch(it.answer, /Kestrel|Brightline|Monarch|2005|Fortune 500|tech and consumer|crisis/, it.answer);
    assert.ok(words(finished(it)) <= 90, `${words(finished(it))} words: ${it.question}`);
    assert.deepEqual(lintText(it.answer).map((h) => h.match), []);
  }
  // Their own homepage words, once.
  assert.equal(faq.items.filter((i) => i.answer.includes("Harbor Lane's integrated communications team")).length, 1);
  // No phone on the site: the answers point to the website and never invent one.
  assert.ok(faq.items.every((i) => !/Call /.test(i.answer)));
  assert.match(faq.items[0].answer, /Visit harborlanepr\.example\.com\.$/);
});

test('PR agency: what only the owner knows is ONE bracket per answer, with a concrete example; counted', () => {
  const r = prReport();
  const faq = buildFaq(r, kitDetails(r));
  const open = faq.items.filter((i) => !i.complete);
  assert.equal(faq.needs, open.length);
  assert.ok(faq.needs >= 3);
  for (const it of open) {
    assert.equal((it.answer.match(/\[/g) || []).length, 1, it.answer);
    assert.match(it.answer, /\[[^\]]+, e\.g\. “[^”]+”\]/);
  }
  assert.match(faq.items[0].answer, /\[What you specialize in, e\.g\. “We focus on/);
  // The FAQ code: finished answers only, word for word.
  const ld = faqJsonLd(faq.items);
  assert.deepEqual(ld.mainEntity.map((m) => m.name), faq.items.filter((i) => i.complete).map((i) => i.question));
  for (const m of ld.mainEntity) assert.doesNotMatch(m.acceptedAnswer.text, /[[\]]/);
  // The owner's sentence fills the bracket, and the answer joins the code.
  const filled = buildFaq(r, kitDetails(r, { faqFacts: { specialty: 'We focus on B2B software companies' } }));
  assert.match(filled.items[0].answer, /We focus on B2B software companies\. Visit/);
  assert.equal(filled.needs, faq.needs - 1);
  assert.equal(faqJsonLd(filled.items).mainEntity[0].name, filled.items[0].question);
});

test('plumber sample: the scan questions first (missed ones first), facts we have, prices and hours', () => {
  const d = kitDetails(PLUMBER);
  const faq = buildFaq(PLUMBER, d);
  assert.equal(faq.kind, 'trade');
  const scan = faq.items.filter((i) => i.fromScan);
  assert.equal(scan.length, PLUMBER.questions.length);
  const lost = scan.filter((i) => i.lost).length;
  assert.ok(scan.slice(0, lost).every((i) => i.lost) && scan.slice(lost).every((i) => !i.lost), 'missed first');
  const q = (re) => faq.items.find((i) => re.test(i.question));
  assert.ok(q(/^What's the best plumber in Massapequa, NY\?$/), 'real questions stay as asked');
  assert.ok(q(/^Which plumber near Massapequa has good reviews\?$/), 'search phrases become questions');
  assert.ok(q(/^Who can I call for an emergency plumber near Massapequa tonight\?$/));
  assert.ok(q(/^Who can replace a water heater in Massapequa, NY\?$/), '"Massapequa NY" → "Massapequa, NY"');
  // The price question uses the price on their site: complete, no bracket.
  const price = q(/How much does a plumber/);
  assert.match(price.answer, /Prices: \$79 service call\./);
  assert.ok(price.complete);
  assert.equal(faq.items.filter((i) => /charge\?$/.test(i.question)).length, 1, 'one price question');
  // The water heater question names the matching service.
  assert.match(q(/water heater/).answer, /that offers tank and tankless water heater installation/);
  assert.match(q(/emergency/).answer, /that offers 24\/7 emergency service\. Hours: Mon–Fri 8am–6pm/);
  for (const it of faq.items) {
    assert.match(it.answer, /^(Harborview Plumbing & Heating is a plumber in Massapequa, NY|To get started with Harborview Plumbing & Heating, a plumber in Massapequa, NY)/);
    assert.match(it.answer, /\(516\) 555-0148/);
    const n = words(finished(it));
    assert.ok(n >= 15 && n <= 90, `${n} words: ${it.question}`);
    assert.deepEqual(lintText(it.answer).map((h) => h.match), []);
  }
  assert.ok(faq.items.length <= PLUMBER.questions.length + 4);
});

test('customerQuestion: questions stay; phrases become what a customer would ask', () => {
  const o = { noun: 'plumber', town: 'Massapequa', state: 'NY', office: false };
  assert.equal(customerQuestion({ text: 'who is a good plumber', intent: 'best' }, o), 'Who is a good plumber?');
  assert.equal(customerQuestion({ text: 'Affordable plumber near Massapequa NY 11758', intent: 'price' }, o), 'How much does a plumber in Massapequa charge?');
  assert.equal(customerQuestion({ text: 'Top rated PR agency in Austin, TX', intent: 'urgent' }, { noun: 'PR agency', town: 'Austin', state: 'TX', office: true }), 'Who is a highly rated PR agency in Austin?');
});

test('the report and the kit never disagree: the action plan’s FAQ is the kit’s FAQ', () => {
  for (const r of [officeReport(), PLUMBER]) {
    const step = buildActionPlan(r).items.find((i) => i.id === 'faq');
    const kit = buildKit(kitDetails(r), r, { date: new Date(2026, 9, 2) });
    const txt = kit.files.find((f) => f.path === 'faq-page.txt').content;
    // The plan points to the kit's page and counts what it counts: same questions, same details to fill in.
    assert.equal(faqPlainText(reportFaq(r).items), faqPlainText(kit.faq.items));
    assert.ok(txt.includes(faqPlainText(kit.faq.items)));
    assert.deepEqual(step.kit, { file: 'questions', questions: kit.faq.items.length, fromScan: kit.faq.items.filter((i) => i.fromScan).length, needs: kit.faq.needs });
    assert.deepEqual(step.copyText, []);
  }
});

// ---- the real router: /fix-kit/<token> and /api/fix-kit/<token> for a paid report ----
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const TOKEN = 'kZp0wH3vY7aB2cD4eF6gHw';
const reply = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake Supabase: the office report, an xray payment, and a fix_kit_details row once saved. */
async function withWorker(fn, { tiers = ['xray'] } = {}) {
  const db = { saved: null, posts: [], assets: [] };
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.pathname === '/rest/v1/scan_results') return reply([{ version: 2, report: officeReport(), scanned_at: '2026-10-01T17:51:00Z' }]);
    if (u.pathname === '/rest/v1/payments') return reply(tiers.map((tier) => ({ tier, amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' })));
    if (u.pathname === '/rest/v1/fix_kit_details') {
      if ((init.method || 'GET') === 'POST') {
        const row = JSON.parse(init.body);
        db.posts.push(row);
        db.saved = { details: row.details, confirmed_at: row.confirmed_at, updated_at: row.updated_at };
        return new Response(null, { status: 201 });
      }
      return reply(db.saved ? [db.saved] : []);
    }
    return reply([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = {
      SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service',
      ASSETS: { fetch: async (req) => { db.assets.push(new URL(req.url).pathname); return new Response('<!doctype html><title>Your Fix Kit</title>', { headers: { 'Content-Type': 'text/html' } }); } },
    };
    const call = (path, init) => worker.fetch(new Request(`https://aifoundscore.com${path}`, init), env, { waitUntil() {} });
    await fn(call, db);
  } finally {
    globalThis.fetch = real;
  }
}

test('router: /fix-kit/<token> serves the Fix Kit page', async () => {
  await withWorker(async (call, db) => {
    const res = await call(`/fix-kit/${TOKEN}`);
    assert.equal(res.status, 200);
    assert.deepEqual(db.assets, ['/fix-kit']);
  });
});

test('router: a paid report opens on the kit already built: every file, the FAQ, what’s missing', async () => {
  await withWorker(async (call, db) => {
    const res = await call(`/api/fix-kit/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual([body.paid, body.confirmed], [true, false]);
    assert.equal(body.details.name, 'Harbor Lane PR', 'nothing saved yet: built from the report');
    const kit = body.kit;
    assert.deepEqual(kit.jobs.map((j) => j.id), ['faq', 'google', 'schema', 'llms']);
    const faqJob = kit.jobs[0];
    assert.deepEqual(faqJob.files.map((f) => f.path), ['faq-page.html', 'faq-page.txt']);
    assert.match(faqJob.files[0].content, /<h3>What&#39;s the best PR agency in New York City, NY\?<\/h3>/);
    assert.ok(kit.faq.needs >= 3, 'answers that need one detail are counted');
    assert.deepEqual(kit.missing.map((m) => m.field), ['phone', 'services']);
    assert.deepEqual(kit.done.map((x) => x.id), ['robots'], 'the site lets AI in: no robots.txt');
    assert.match(kit.readme, /WHAT’S LEFT TO DO, IN ORDER/);
    assert.equal(db.posts.length, 0);
  });
});

test('router: unpaid gets no kit', async () => {
  await withWorker(async (call) => {
    const body = await (await call(`/api/fix-kit/${TOKEN}`)).json();
    assert.equal(body.paid, false);
    assert.equal(body.kit, undefined);
    assert.equal((await call(`/api/fix-kit/${TOKEN}.zip`)).status, 402);
  }, { tiers: [] });
});

test('router: edit → rebuilt kit (not saved); ownership tick → saved → the zip downloads', async () => {
  await withWorker(async (call, db) => {
    const { details, kit } = await (await call(`/api/fix-kit/${TOKEN}`)).json();
    // The zip needs the ownership tick first.
    assert.equal((await call(`/api/fix-kit/${TOKEN}.zip`)).status, 409);
    const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // Filling in one FAQ detail and the phone rebuilds the kit; nothing is saved.
    const edit = { ...details, phone: '(212) 555-0100', faqFacts: { specialty: 'We focus on B2B software companies.' } };
    const pre = await call(`/api/fix-kit/${TOKEN}`, json({ preview: true, details: edit }));
    assert.equal(pre.status, 200);
    const p = await pre.json();
    assert.equal(p.kit.faq.needs, kit.faq.needs - 1);
    assert.deepEqual(p.kit.missing.map((m) => m.field), ['services']);
    assert.match(p.kit.jobs[0].files[0].content, /We focus on B2B software companies\./);
    assert.equal(db.posts.length, 0, 'a preview saves nothing');
    // No tick: refused.
    const noTick = await call(`/api/fix-kit/${TOKEN}`, json({ details: p.details }));
    assert.equal(noTick.status, 422);
    assert.deepEqual((await noTick.json()).errors.map((e) => e.field), ['confirm']);
    // The tick, with the details on screen: saved, then the zip.
    const ok = await call(`/api/fix-kit/${TOKEN}`, json({ confirm: true, details: p.details }));
    assert.equal(ok.status, 200);
    assert.equal(db.posts.length, 1);
    assert.equal(db.posts[0].details.faqFacts.specialty, 'We focus on B2B software companies.');
    const zip = await call(`/api/fix-kit/${TOKEN}.zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('Content-Type'), 'application/zip');
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    for (const f of ['README.txt', 'faq-page.html', 'faq-page.txt', 'google-business-profile.txt', 'schema-localbusiness.html', 'llms.txt']) assert.ok(text.includes(f), f);
    assert.ok(!text.includes('robots.txt\u0000') && !/PK[^]{26}robots\.txt/.test(text), 'no robots.txt: the site already lets AI in');
    assert.match(text, /We focus on B2B software companies\./);
    assert.match(text, /"telephone": "\(212\) 555-0100"/);
  });
});

test('router: a report with no phone still builds and downloads; the phone is left out, not invented', async () => {
  await withWorker(async (call) => {
    const { details } = await (await call(`/api/fix-kit/${TOKEN}`)).json();
    assert.equal(details.phone, '');
    const ok = await call(`/api/fix-kit/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, details }) });
    assert.equal(ok.status, 200);
    const zip = await call(`/api/fix-kit/${TOKEN}.zip`);
    assert.equal(zip.status, 200);
    const text = new TextDecoder().decode(new Uint8Array(await zip.arrayBuffer()));
    assert.doesNotMatch(text, /"telephone"/);
    assert.match(text, /Missing: Phone number\./);
  });
});
