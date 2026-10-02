// The "PR 73" paid report through the real routes (src/worker.js): /api/report/<token> and the page that
// renders it (public/js/report.js), and /api/fix-kit/<token>. Two stored reports:
//   - a new scan (scanner/test/fixtures/pr73.js, built offline by the scanner): each list AI cited says
//     "You’re not on it" (with the directory's add link), "You’re listed — check the details" (with the
//     profile) or "Pending check" (with why);
//   - a report stored before Oct 2 2026 (no list checks, no siteCheck.brand): nothing is fetched at serve
//     time; only the spelling is read off the stored homepage title and description.
// The name: the website writes "PR73", the request said "PR 73". One spelling everywhere, and a plain ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { buildPr73Report, fakeListingSearch } from '../../../scanner/test/fixtures/pr73.js';
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
    assert.match(siteRow(plan, 'clutch.co'), /Pending check<\/span>.*\(the site blocks automated checks\)/s);
    assert.match(siteRow(plan, 'designrush.com'), /Pending check<\/span>.*\(the site asks crawlers not to read this page\)/s);
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

test('GET /api/report/<token>, a report stored before: the spelling is fixed from its stored title; lists stay "Pending check"', async () => {
  await withWorker(storedBeforeOct2(), async (call, seen) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const lists = body.xray.actionPlan.items.find((i) => i.id === 'lists');
    for (const s of lists.sites) assert.equal(s.status, 'check', 'never read: never "not on it"');
    assert.ok(lists.sites.every((s) => !s.reason), 'no reason we don’t have');
    const plan = planOf(render(body));
    assert.match(plan, /<span class="badge low">Pending check<\/span>/);
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

// ---------------------------------------------------------------------------
// The paid audit's small-firm questions (scanner/questions.js smallFirmQuestions), built by the real
// scanner (buildReport), served by the Worker and rendered by public/js/report.js.
// ---------------------------------------------------------------------------
import { SCAN, PROPOSALS, BUSINESS, HOME, fakeWeb } from '../../../scanner/test/fixtures/pr73.js';
import { paidQuestions } from '../../../scanner/questions.js';
import { metaCheck } from '../../../scanner/owner-checks.js';
import { buildReport } from '../../../scanner/extract/build.js';
import { buildFaq } from '../../../shared/faq.js';
import { computeVisibilityScore, lostIntents } from '../../../shared/report-v2.js';

const GIANTS = '**Edelman** and **Weber Shandwick** are the largest PR firms in New York.';
const BOUTIQUE = '**Juniper & Vale PR** is a boutique agency that takes small clients. **Kestrel PR** also works with startups. **Clutch** lists more.';
const NICHE = '**PR73** focuses on integrated communications. **Juniper & Vale PR** does too.';

/** A 7-question PR 73 audit (2 engines → 14 answers): the giants on the 5, boutique firms on q6, PR73 on q7. */
async function buildSevenQuestionReport() {
  const questions = paidQuestions(BUSINESS, { siteCheck: { meta: metaCheck(HOME, BUSINESS) } }).map(({ id, intent, text }) => ({ id, intent, text }));
  const textFor = (qid) => (qid === 'q6' ? BOUTIQUE : qid === 'q7' ? NICHE : GIANTS);
  const calls = [];
  const proposals = {};
  for (const q of questions) {
    for (const engine of SCAN.engines) {
      const text = textFor(q.id);
      calls.push({ engine, questionId: q.id, run: 1, ok: true, text, askedAt: '2026-10-02T15:00:00Z', model: `${engine}-x`, citations: [] });
      const names = [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => ({ name: m[1], pos: m.index + 2 }));
      proposals[`${engine}:${q.id}:1`] = { businesses: names, ownerFacts: [] };
    }
  }
  const { report, validation } = await buildReport({ scan: { ...SCAN, questions, calls }, business: BUSINESS, proposalsByAnswer: proposals, env: { GOOGLE_PLACES_API_KEY: 'test-key' }, fetchImpl: fakeWeb(), id: 'pr73-seven' });
  return { report, validation, questions };
}

test('paid PR 73 audit with the small-firm questions: "Firms your size" leads "Why AI picked them" with who AI named there', async () => {
  const { report, validation, questions } = await buildSevenQuestionReport();
  assert.deepEqual(validation.errors, []);
  assert.equal(questions.length, 7);
  assert.equal(report.questions.length, 7);
  assert.equal(report.totals.answers, 14);
  await withWorker(report, async (call) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const html = render(body);
    // Counts: every answer, all 7 questions.
    assert.match(html, /We asked AI 14 times\./);
    const i = html.indexOf('id="your-size"');
    assert.ok(i >= 0, 'the small-firm block renders');
    const sec = html.slice(i, html.indexOf('class="r2-why-you"', i));
    assert.match(sec, /<h3>Firms your size<\/h3>/);
    assert.match(sec, /What&#39;s a good boutique PR agency in New York City, NY for a small company\?/);
    assert.match(sec, /Which PR agency in New York City, NY specializes in integrated communications\?/);
    // Boutique question: the firms AI named there, the directory left out, the owner not named.
    const [q6, q7] = sec.split('class="r2-small-q"').slice(1);
    assert.match(q6, /Juniper &amp; Vale PR<\/span> <span class="c">2 of 2 answers/);
    assert.match(q6, /Kestrel PR/);
    assert.doesNotMatch(q6, /Clutch/, 'a directory is never a competitor');
    assert.doesNotMatch(q6, /Edelman|Weber Shandwick/, 'only the names from these answers');
    assert.match(q6, /AI didn’t name you in any of the 2 answers\./);
    // Specialty question: PR73 named by both engines (and never listed as its own rival).
    assert.match(q7, /ChatGPT and Gemini named you \(2 of 2 answers\)\./);
    assert.doesNotMatch(q7, /<span class="nm">PR73<\/span>/);
    // The first block of "Why AI picked them" (no separate section, no "Who AI recommended instead").
    const why = html.indexOf('id="why-picked"');
    assert.ok(why >= 0 && why < i && i < html.indexOf('class="r2-why-card"', why), 'first block of Why AI picked them');
    assert.doesNotMatch(html, /id="who"|When customers ask for a firm your size/);
    // Juniper & Vale PR was named only on the boutique question and is kept with the bigger names.
    const card = html.slice(html.indexOf('<h3>Juniper &amp; Vale PR'), html.indexOf('</article>', html.indexOf('<h3>Juniper &amp; Vale PR')));
    assert.match(card, /<span class="ap-whotag">Named for a firm your size<\/span>/);
    assert.match(card, /“Juniper &amp; Vale PR is a boutique agency that takes small clients\.”/);
    // Our copy has no banned words.
    assert.deepEqual(lintText(sec.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')).map((h) => h.word), []);
    // The score, the lost-question logic and the FAQ take all 7.
    const score = computeVisibilityScore(body);
    assert.equal(score.parts.find((p) => p.key === 'named').detail, '2 of 14 answers');
    assert.deepEqual(lostIntents(body), ['best', 'urgent', 'job', 'trust', 'price', 'small']);
    const faq = buildFaq(body, { name: 'PR73', trade: 'PR agency', town: 'New York City', state: 'NY' });
    assert.ok(faq.items.some((x) => x.intent === 'small' && /boutique PR agency/.test(x.question)));
    assert.ok(faq.items.some((x) => x.intent === 'niche' && /integrated communications/.test(x.question)));
    // The action plan's FAQ step counts the 6 questions AI didn't name them for (q7 named them).
    const step = body.xray.actionPlan.items.find((x) => x.id === 'faq');
    assert.match(step.title, /^Answer the 6 questions AI didn’t name you for/);
    assert.match(step.why, /boutique PR agency/);
    assert.doesNotMatch(step.why, /specializes in integrated communications/);
  });
});

test('a report without the small-firm questions (free, or an audit from before) has no such section', async () => {
  const { report } = await buildPr73Report();
  await withWorker(report, async (call) => {
    const html = render(await (await call(`/api/report/${TOKEN}`)).json());
    assert.doesNotMatch(html, /id="your-size"|firm your size/);
  });
});

// The paid-style sample (preview builds can only load samples): 7 questions on the 5 engines it shows,
// served by the Worker, rendered by report.js with the small-firm section and the 7-question copy.
test('GET /api/report/sample-001: 7 questions, the "business your size" section, before/after on sample-recheck', async () => {
  await withWorker(null, async (call) => {
    const res = await call('/api/report/sample-001');
    assert.equal(res.status, 200, 'passes the serve-time guardrails');
    const body = await res.json();
    assert.equal(body.questions.length, 7);
    assert.deepEqual(body.questions.slice(5).map((q) => `${q.id}:${q.intent}`), ['q6:small', 'q7:niche']);
    const engines = new Set(body.answers.map((a) => a.engine)).size;
    assert.equal(body.answers.length, 7 * engines);
    const html = render(body);
    assert.match(html, new RegExp(`We asked AI ${7 * engines} times\.`));
    const i = html.indexOf('id="your-size"');
    assert.ok(i >= 0, 'the small-firm block renders');
    const sec = html.slice(i, html.indexOf('class="r2-why-you"', i));
    assert.match(sec, /<h3>Businesses your size<\/h3>/);
    assert.match(sec, /Can you recommend a local, family-owned plumber in Massapequa, NY\?/);
    assert.match(sec, /Who does boiler repair in Massapequa NY\?/);
    assert.match(sec, /named you \(\d of \d answers\)/);
    assert.deepEqual(lintText(sec.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')).map((h) => h.word), []);
    // The re-check sample compares the same 7 searches.
    const re = await (await call('/api/report/sample-recheck')).json();
    assert.equal(re.questions.length, 7);
    assert.equal(re.baseline.totals.answers, body.answers.length);
    assert.match(render(re), /Before and after/);
  });
});

test('GET /api/report/sample-001?preview=locked: no small-firm section (a locked page has no names to list)', async () => {
  await withWorker(null, async (call) => {
    const body = await (await call('/api/report/sample-001?preview=locked')).json();
    assert.equal(body.locked, true);
    assert.doesNotMatch(render(body), /id="your-size"/);
  });
});

// ---- Listed or not through Google, and free to join (Oct 2 2026) ----
const rowText = (row) => row.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('GET /api/report/<token>, a paid scan with the Google lookup: listed via search, no profile found, join terms and sign-up links', async () => {
  const { report, validation } = await buildPr73Report({ listingSearch: fakeListingSearch() });
  assert.deepEqual(validation.errors, []);
  await withWorker(report, async (call, seen) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const lists = body.xray.actionPlan.items.find((i) => i.id === 'lists');
    const by = (d) => lists.sites.find((s) => s.domain === d);
    assert.deepEqual(['clutch.co', 'themanifest.com', 'designrush.com'].map((d) => by(d).status), ['listed', 'not_found', 'not_found']);
    const plan = planOf(render(body));
    // Clutch: Google showed the profile; the domain links to it.
    const clutch = siteRow(plan, 'clutch.co');
    assert.match(clutch, /<span class="badge match">You’re listed — check the details<\/span>/);
    assert.match(clutch, /href="https:\/\/clutch\.co\/profile\/pr73"/);
    assert.match(rowText(clutch), /found through Google/);
    // The Manifest: searched, nothing found. Said as a search result, never "you're not on it".
    const tm = siteRow(plan, 'themanifest.com');
    assert.match(tm, /<span class="badge low">No profile found<\/span>/);
    assert.match(rowText(tm), /we searched Google for you on themanifest\.com and found no profile/);
    assert.match(tm, /<span class="ap-join">Free to join<\/span>/);
    assert.match(tm, /<a class="ap-add" href="https:\/\/clutch\.co\/get-listed"[^>]*>Add your company<\/a>/);
    assert.doesNotMatch(tm, /You’re not on it/);
    // DesignRush: the model's made-up URL was not accepted.
    const dr = siteRow(plan, 'designrush.com');
    assert.match(dr, /No profile found/);
    assert.match(dr, /Free basic profile<\/span>/);
    assert.match(dr, /href="https:\/\/www\.designrush\.com\/submit\/agency"/);
    // CommunicationsMatch (read, listed) and GoodFirms (read, not on it) keep their own reads.
    assert.match(siteRow(plan, 'goodfirms.co'), /You’re not on it<\/span>.*Free basic profile/s);
    // The how: only the sub-steps that apply; nothing waits for a next scan.
    assert.match(plan, /Sites marked “No profile found”: the site turns automated reads away, so we searched Google for “PR73” or “PR 73” on each one and found no profile\./);
    assert.doesNotMatch(plan, /next scan|Couldn’t check|Pending check/);
    assert.deepEqual(lintText(plan.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')).map((h) => h.word), []);
    assert.ok(seen.every((u) => u.startsWith('https://sb.example/')), 'serving never searches');
  });
});

test('GET /api/report/<token>, the live PR 73 report as stored: join terms and sign-up links now, the search on the next scan', async () => {
  await withWorker(storedBeforeOct2(), async (call, seen) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const plan = planOf(render(body));
    const clutch = siteRow(plan, 'clutch.co');
    assert.match(clutch, /<span class="badge low">Pending check<\/span>/);
    assert.match(clutch, /<span class="ap-join">Free basic profile<\/span>/);
    assert.match(clutch, /<a class="ap-add" href="https:\/\/vendor\.clutch\.co\/profile\/create\/basic"[^>]*>Add your company<\/a>/);
    assert.match(siteRow(plan, 'themanifest.com'), /Free to join<\/span>.*href="https:\/\/clutch\.co\/get-listed"/s);
    assert.match(siteRow(plan, 'communicationsmatch.com'), /Paid listing<\/span>.*href="https:\/\/www\.communicationsmatch\.com\/account\/registration"/s);
    // The industry list: an entry fee, and the list's own entry page.
    const od = siteRow(plan, 'odwyerpr.com');
    assert.match(od, /<span class="ap-join">Entry fee<\/span>/);
    assert.match(od, /<a class="ap-add" href="https:\/\/www\.odwyerpr\.com\/pr_firm_[a-z]+\/Rank-Your-Firm-With-ODwyers-2026\.pdf"[^>]*>How to enter<\/a>/);
    // The how adapts: the next scan does the search; costs only as known.
    assert.match(plan, /Sites marked “Pending check”: we haven’t checked them for your name yet\. Your next scan searches Google for your profile there for you/);
    assert.match(plan, /clutch\.co and themanifest\.com have a free basic profile; you don’t need the paid upgrades\. communicationsmatch\.com charges to be listed at all/);
    assert.match(plan, /Use the “How to enter” link next to it/);
    assert.doesNotMatch(plan, /Not checked yet|No profile found|A basic profile costs nothing/);
    // The badge is short; the step says once what it means (it read 4 times: buyer review, Oct 2).
    assert.equal((plan.match(/next scan/g) || []).length, 1, 'one "next scan" line, not one per site');
    assert.deepEqual(lintText(plan.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ')).map((h) => h.word), []);
    assert.ok(seen.every((u) => u.startsWith('https://sb.example/')), 'a pure lookup: nothing fetched at serve time');
  });
});

test('buyer review 3 (Oct 2): an answer that named no business is an "open spot", not a plain ✕; the score is unchanged', async () => {
  const { report } = await buildPr73Report();
  const before = await (async () => { let b; await withWorker(report, async (call) => { b = await (await call(`/api/report/${TOKEN}`)).json(); }); return b; })();
  // Two answers where AI named nobody.
  const open = structuredClone(report);
  open.answers[0].businessesNamed = [];
  open.answers[1].businessesNamed = [];
  // Keep the stored report valid: the rivals' counts and the headline follow the answers.
  for (const e of open.entities) {
    e.answerIds = e.answerIds.filter((id) => !['a1', 'a2'].includes(id));
    e.named = e.answerIds.length;
    e.first = Math.min(e.first, e.named);
  }
  open.headline.answerId = 'a3';
  await withWorker(open, async (call) => {
    const res = await call(`/api/report/${TOKEN}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof before.score.score, 'number');
    assert.equal(body.score.score, before.score.score, 'not named is still not named: same score');
    const html = render(body);
    assert.equal((html.match(/<i class="open" title="AI named no business: an open spot">○<\/i>/g) || []).length, 2);
    assert.match(html, /<b class="o">○ named no one<\/b>/);
    assert.match(html, /In 2 answers AI named no business at all\. Nobody holds those spots yet, so they are the easiest to win\./);
    assert.equal((html.match(/<span class="open">Open spot: AI named no one<\/span>/g) || []).length, 2);
  });
  // None open: no extra key, no line.
  const html = render(before);
  assert.doesNotMatch(html, /class="open"|named no one|r2-verdict-open/);
});
