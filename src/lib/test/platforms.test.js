// Builder-specific steps (shared/platforms.js): the playbook data itself, the paid report's action plan
// and page for a Wix and a Squarespace site, the Fix Kit's jobs and README, and the real router
// building the kit for an old report whose builder is looked up on the spot (src/lib/site-platform.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { PLAYBOOKS, CHECKED, JOB_LABELS, platformFor } from '../../../shared/platforms.js';
import { PLATFORM_NAMES, detectPlatform } from '../../../shared/platform-detect.js';
import { buildActionPlan } from '../../../shared/action-plan.js';
import { lintText } from '../../../shared/report-v2.js';
import { reportBody } from '../lock.js';
import { buildKit, prefillDetails, validateDetails } from '../fix-kit.js';
import { officeReport } from './fixtures/office-report.js';
import { HTML } from './fixtures/builder-pages.js';

const WIX = { id: 'wix', name: 'Wix', confidence: 'high', evidence: ['generator: Wix.com'] };
const SQ = { id: 'squarespace', name: 'Squarespace', confidence: 'high', evidence: ['server: Squarespace'] };
const on = (platform, over = {}) => { const r = officeReport(); return { ...r, ...over, siteCheck: { ...r.siteCheck, platform } }; };
const byId = (plan, id) => plan.items.find((i) => i.id === id);
const OFFICIAL = /^https:\/\/(support\.wix\.com|support\.squarespace\.com|wordpress\.com\/support|wordpress\.org\/documentation|yoast\.com\/help|yoast\.com\/features|help\.shopify\.com|www\.godaddy\.com\/help|help\.webflow\.com|squareup\.com\/help|www\.weebly\.com\/app\/help|support\.duda\.co|knowledge\.hubspot\.com|www\.framer\.com\/help|support\.google\.com\/sites)\//;

test('playbooks: every builder we detect has one; every step has an official source and the check date', () => {
  for (const id of Object.keys(PLATFORM_NAMES)) assert.ok(PLAYBOOKS[id], `${id} has a playbook`);
  for (const [id, book] of Object.entries(PLAYBOOKS)) {
    assert.match(book.help, /^https:\/\//, `${id} help`);
    for (const [job, e] of Object.entries(book.jobs)) {
      const where = `${id}.${job}`;
      assert.ok(JOB_LABELS[job], `${where} is a known job`);
      assert.ok(typeof e.steps === 'string' && e.steps.length > 20, `${where} steps`);
      assert.match(e.source, OFFICIAL, `${where} source is the builder’s own help`);
      assert.equal(e.checked, CHECKED);
      assert.deepEqual(lintText([e.steps, e.plan, e.page].filter(Boolean).join(' ')), [], `${where} copy`);
    }
  }
  // Facts that matter most, as the builders' own help states them.
  assert.equal(PLAYBOOKS.squarespace.jobs.robots.can, false, 'Squarespace robots.txt can’t be edited');
  assert.match(PLAYBOOKS.squarespace.jobs.aiCrawlers.steps, /Block known artificial intelligence crawlers/);
  assert.match(PLAYBOOKS.squarespace.jobs.headCode.plan, /Core, Plus and Advanced/);
  assert.equal(PLAYBOOKS.wix.jobs.llms.auto, true, 'Wix makes its own llms.txt');
  assert.equal(PLAYBOOKS.hubspot.jobs.llms.can, false);
  assert.equal(PLAYBOOKS.duda.jobs.faq.schema, true);
  assert.equal(platformFor({ siteCheck: { platform: { id: 'nope', name: 'Nope' } } }), null, 'no playbook, no platform');
});

test('action plan, Wix: the website steps say where to click in Wix, with Wix’s own guides', () => {
  const plan = buildActionPlan(on(WIX));
  assert.deepEqual(plan.platform, { id: 'wix', name: 'Wix' });
  const home = byId(plan, 'homepage');
  assert.ok(home.steps.some((s) => /^In Wix: In the Editor, open Pages & Menu → .*SEO basics → .*“Title tag” and “Meta description”/.test(s)), home.steps.join('\n'));
  assert.ok(!home.steps.some((s) => /In most site builders/.test(s)), 'the generic line is replaced');
  assert.deepEqual(home.platform.guides.map((g) => g.url), ['https://support.wix.com/en/article/adding-seo-title-tags-and-meta-descriptions-to-your-pages']);
  const contact = byId(plan, 'contact');
  assert.ok(contact.steps.some((s) => /^In Wix: In the Editor: Add → Text → .*Move To Footer/.test(s)), 'footer');
  assert.ok(contact.steps.some((s) => /^In Wix: Dashboard → Settings → Custom Code → .*Head .*connected domain/.test(s)), 'code, with the plan note');
  const faq = byId(plan, 'faq');
  assert.ok(faq.steps.some((s) => /^In Wix: In the Editor: Add Apps → search “FAQ”/.test(s)));
  assert.ok(faq.steps.some((s) => /^For the code, in Wix: .*Choose specific pages/.test(s)), 'FAQ code on that page');
  assert.deepEqual(faq.platform.guides.map((g) => g.label), ['Wix’s guide: FAQ section', 'Wix’s guide: adding code']);
});

test('action plan, Squarespace: the AI setting instead of robots.txt, code injection with its plans', () => {
  const blocked = { kind: 'site_blocks_ai', severity: 'high', title: 'Your website blocks ChatGPT', description: 'Your robots.txt tells GPTBot to stay out.', steps: ['Open https://www.harborlanepr.example.com/robots.txt, or ask whoever manages your website to.'], copyText: [] };
  const r = on(SQ);
  const plan = buildActionPlan({ ...r, issues: [blocked, ...r.issues] });
  const unblock = byId(plan, 'unblock');
  assert.match(unblock.steps[0], /^In Squarespace: Settings → Crawlers → make sure “Block known artificial intelligence crawlers” is NOT ticked/);
  assert.match(unblock.steps[1], /^In Squarespace: Squarespace doesn’t let anyone edit robots\.txt/);
  assert.deepEqual(unblock.platform.guides.map((g) => g.url), [
    'https://support.squarespace.com/hc/en-us/articles/360022347072-Request-that-AI-models-exclude-your-site',
    'https://support.squarespace.com/hc/en-us/articles/206543207-Understanding-Google-SEO-emails-and-console-errors',
  ]);
  const contact = byId(plan, 'contact');
  assert.ok(contact.steps.some((s) => /^In Squarespace: Pages panel → the gear icon next to your homepage → Advanced → .*Page Header Code Injection.*Core, Plus and Advanced/.test(s)));
  assert.ok(byId(plan, 'homepage').steps.some((s) => /^In Squarespace: Open the SEO\/AI Visibility panel → SEO Settings/.test(s)));
  for (const it of plan.items) assert.deepEqual(lintText(JSON.stringify(it.steps)), [], it.id);
});

test('action plan, unknown builder: the generic steps, no builder line', () => {
  for (const r of [officeReport(), on(null), on({ id: 'something-else', name: 'X' })]) {
    const plan = buildActionPlan(r);
    assert.equal(plan.platform, undefined);
    assert.ok(byId(plan, 'homepage').steps.some((s) => /In most site builders this is under “SEO title”/.test(s)));
    assert.ok(!plan.items.some((i) => i.platform));
    assert.ok(!JSON.stringify(plan.items).includes('In Wix'));
  }
});

// ---- the paid page ----
function loadPage() {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const render = (report) => { const root = { innerHTML: '', addEventListener() {}, querySelector: () => null }; loadPage().renderV2(root, report); return root.innerHTML; };

test('paid page: “Your site is built on Wix” with Wix’s guide linked; the email to the web person says so', () => {
  const html = render(reportBody(on(WIX), true));
  assert.match(html, /<p class="ap-platform">Your site is built on Wix, so the steps below are for Wix\. <a href="https:\/\/support\.wix\.com\/en\/article\/adding-seo-title-tags-and-meta-descriptions-to-your-pages" rel="noopener" target="_blank">Wix’s guide: page title and description<\/a>/);
  assert.match(html, /In Wix: In the Editor, open Pages &amp; Menu/);
  const mail = decodeURIComponent((/href="mailto:\?subject=[^"&]*&amp;body=([^"]*)"/.exec(html) || [])[1] || '');
  assert.match(mail, /Our site is built on Wix, so the guide says where each one goes in Wix\./);
  const sq = render(reportBody(on(SQ), true));
  assert.match(sq, /Your site is built on Squarespace/);
  assert.match(sq, /support\.squarespace\.com\/hc\/en-us\/articles\/205815908-Using-code-injection/);
  const plain = render(reportBody(officeReport(), true));
  assert.doesNotMatch(plain, /ap-platform|built on/);
});

// ---- the Fix Kit ----
const kitFor = (r) => buildKit(validateDetails(prefillDetails(r)).details, r, { date: new Date(2026, 9, 2), token: 't' });
const readme = (kit) => kit.files.find((f) => f.path === 'README.txt').content;

test('Fix Kit, Wix: each job says where it goes in Wix; llms.txt is optional because Wix makes one', () => {
  const kit = kitFor(on(WIX));
  assert.deepEqual(kit.platform, { id: 'wix', name: 'Wix' });
  const job = (id) => kit.jobs.find((j) => j.id === id);
  assert.match(job('schema').platform.steps[0], /^In Wix: Dashboard → Settings → Custom Code/);
  assert.match(job('faq').platform.steps.join('\n'), /Add Apps → search “FAQ”[\s\S]*For the code from faq-page\.html, in Wix: .*Choose specific pages/);
  assert.equal(job('llms').optional, true);
  assert.match(job('llms').where, /^Wix makes this file for you, so you don’t need ours/);
  const txt = readme(kit);
  assert.match(txt, /Your website is built on Wix\./);
  assert.match(txt, / {3}In Wix: Dashboard → Settings → Custom Code/);
  assert.match(txt, / {3}Wix’s guide: adding code: https:\/\/support\.wix\.com\/en\/article\/embedding-custom-code-on-your-site/);
  assert.doesNotMatch(txt, /The top folder of your website/, 'never told to upload a file Wix makes');
});

test('Fix Kit, Squarespace blocking AI: robots.txt marked optional, the Crawlers setting instead', () => {
  const r = on(SQ);
  const kit = kitFor({ ...r, siteCheck: { ...r.siteCheck, robots: { found: true, blocked: [{ agent: 'GPTBot', who: 'ChatGPT (training)' }] } } });
  const robots = kit.jobs.find((j) => j.id === 'robots');
  assert.equal(robots.optional, true);
  assert.match(robots.where, /^Squarespace doesn’t let you edit robots\.txt, so this file can’t be used there/);
  assert.deepEqual(robots.platform.steps, ['In Squarespace: Settings → Crawlers → make sure “Block known artificial intelligence crawlers” is NOT ticked → Save.']);
  assert.match(kit.jobs.find((j) => j.id === 'llms').platform.steps[0], /^In Squarespace: Open the SEO\/AI Visibility panel → SEO Settings → LLMS\.txt tab/);
});

test('Fix Kit, unknown builder: today’s generic text', () => {
  const kit = kitFor(officeReport());
  assert.equal(kit.platform, undefined);
  assert.ok(kit.jobs.every((j) => !j.platform));
  assert.match(kit.jobs.find((j) => j.id === 'llms').where, /^The top folder of your website/);
  assert.doesNotMatch(readme(kit), /built on/);
});

// ---- the real router: an old paid report (no stored builder) → homepage fetched → Wix kit ----
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));
const TOKEN = 'kZp0wH3vY7aB2cD4eF6gHw';
const reply = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

async function withWorker(homepage, fn) {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    seen.push(u.href);
    if (u.pathname === '/rest/v1/scan_results') return reply([{ version: 2, report: officeReport(), scanned_at: '2026-10-01T17:51:00Z' }]);
    if (u.pathname === '/rest/v1/payments') return reply([{ tier: 'xray', amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' }]);
    if (u.pathname === '/rest/v1/fix_kit_details') return reply([]);
    if (u.host === 'www.harborlanepr.example.com') return homepage(u, init);
    return reply([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service', ASSETS: { fetch: async () => new Response('') } };
    const call = (path, init) => worker.fetch(new Request(`https://aifoundscore.com${path}`, init), env, { waitUntil() {} });
    await fn(call, seen);
  } finally {
    globalThis.fetch = real;
  }
}

test('router: an old paid report’s Fix Kit looks up the builder from the homepage and is built for Wix', async () => {
  let ua = '';
  await withWorker((u, init) => { ua = init.headers['User-Agent']; return new Response(HTML.wix, { headers: { 'Content-Type': 'text/html' } }); }, async (call, seen) => {
    const body = await (await call(`/api/fix-kit/${TOKEN}`)).json();
    assert.equal(body.paid, true);
    assert.ok(seen.includes('https://www.harborlanepr.example.com/'), 'homepage fetched');
    assert.match(ua, /AIFoundScoreBot/);
    assert.deepEqual(body.kit.platform, { id: 'wix', name: 'Wix' });
    const schema = body.kit.jobs.find((j) => j.id === 'schema');
    assert.match(schema.platform.steps[0], /^In Wix: Dashboard → Settings → Custom Code/);
    assert.match(body.kit.readme, /Your website is built on Wix\./);
    assert.equal(body.kit.jobs.find((j) => j.id === 'llms').optional, true);
  });
});

test('router: the homepage failing or unrecognised keeps the generic kit, never an error', async () => {
  for (const homepage of [() => { throw new Error('ECONNRESET'); }, () => new Response('nope', { status: 500 }), () => new Response(HTML.plain)]) {
    await withWorker(homepage, async (call) => {
      const res = await call(`/api/fix-kit/${TOKEN}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.kit.platform, undefined);
      assert.match(body.kit.jobs.find((j) => j.id === 'llms').where, /^The top folder of your website/);
    });
  }
});

test('router: unpaid never fetches the owner’s homepage', async () => {
  await withWorker(() => new Response(HTML.wix), async (call, seen) => {
    // No payment row: the fake answers payments with an empty list only for other paths, so patch it.
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => (new URL(String(input)).pathname === '/rest/v1/payments' ? reply([]) : real(input, init));
    try {
      const body = await (await call(`/api/fix-kit/${TOKEN}`)).json();
      assert.equal(body.paid, false);
      assert.ok(!seen.some((x) => x.startsWith('https://www.harborlanepr.example.com')));
    } finally { globalThis.fetch = real; }
  });
});

test('detectPlatform: Weebly over Square Online when Weebly’s own config is there; Yoast noted on WordPress', () => {
  const weebly = '<html><head><script>_W.configDomain = "www.weebly.com";</script></head><body><img src="https://cdn2.editmysite.com/images/x.png"></body></html>';
  assert.equal(detectPlatform(weebly, {}, '').id, 'weebly');
  assert.equal(detectPlatform(HTML.square, {}, '').id, 'square');
  const yoast = HTML.wordpress.replace('</head>', '<!-- This site is optimized with the Yoast SEO plugin v23.5 - https://yoast.com/wordpress/plugins/seo/ --></head>');
  assert.equal(detectPlatform(yoast, {}, '').seo, 'yoast');
  assert.equal(detectPlatform(HTML.wordpress, {}, '').seo, undefined);
  // WordPress with Yoast gets Yoast's menus; without it, the generic title step.
  const wp = (p) => byId(buildActionPlan(on(p)), 'homepage').steps.join('\n');
  assert.match(wp({ id: 'wordpress', name: 'WordPress', seo: 'yoast' }), /In WordPress: With Yoast SEO: Yoast SEO → Settings → Content types → Homepage/);
  assert.match(wp({ id: 'wordpress', name: 'WordPress' }), /In most site builders/);
});
