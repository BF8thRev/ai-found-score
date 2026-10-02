// The paid report's action plan (shared/action-plan.js): every fix merged into one ordered checklist,
// biggest impact first, fit to the kind of business; served only on paid reports (src/lib/lock.js),
// and shown first on the paid page (public/js/report.js actionPlanV2).
// Oct 2 2026 review of a paid PR agency report: 12 "fixes" were 6, four said "add an FAQ", the first was
// "get on Google Maps", the steps said storefront photos and opening hours, and the plan sat 9 screens down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { buildActionPlan, homepageSaysTrade, fixCase, siteType } from '../../../shared/action-plan.js';
import { buildGapSheet } from '../../../shared/report-v2.js';
import { tradeWords, metaCheck } from '../../../scanner/owner-checks.js';
import { reportBody } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { officeReport } from './fixtures/office-report.js';

const allText = (plan) => JSON.stringify(plan.items);
const byId = (plan, id) => plan.items.find((i) => i.id === id);

test('office business: one step per job, every stored fix accounted for', () => {
  const rep = officeReport();
  const plan = buildActionPlan(rep);
  assert.equal(plan.kind, 'professional');
  const ids = plan.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique (they key the saved ticks)');
  // 12 stored fixes become 6 steps.
  assert.equal(rep.issues.length, 12);
  assert.ok(plan.items.length <= 7, `${plan.items.length} steps`);
  assert.deepEqual(byId(plan, 'faq').from.sort(), ['baseline_faq', 'lost_question', 'site_no_faq_schema']);
  assert.deepEqual(byId(plan, 'google').from.sort(), ['baseline_gbp', 'google_missing']);
  assert.deepEqual(byId(plan, 'contact').from.sort(), ['baseline_schema', 'site_missing_nap']);
  // Exactly one FAQ step, not one per question.
  assert.equal(plan.items.filter((i) => /question/i.test(i.title)).length, 1);
  // Every stored kind lands in some step.
  const covered = new Set(plan.items.flatMap((i) => i.from));
  for (const i of rep.issues) assert.ok(covered.has(i.kind), `${i.kind} is in the plan`);
});

test('office business: no storefront, walk-in or "open now" advice', () => {
  const plan = buildActionPlan(officeReport());
  const t = allText(plan);
  assert.doesNotMatch(t, /storefront/i);
  assert.doesNotMatch(t, /open now/i);
  assert.doesNotMatch(t, /opening hours|Add your hours|hours match/i);
  assert.match(byId(plan, 'google').steps.join(' '), /hide your address/);
  assert.match(byId(plan, 'google').steps.join(' '), /photos of your team/);
  assert.equal(byId(plan, 'google').title, 'Create your Google Business Profile');
});

test('office business: biggest impact first, and the lists AI read come first', () => {
  const plan = buildActionPlan(officeReport());
  const rank = { high: 0, medium: 1, low: 2 };
  plan.items.forEach((it, n) => { if (n) assert.ok(rank[plan.items[n - 1].impact] <= rank[it.impact], 'ordered by impact'); });
  assert.equal(plan.items[0].id, 'lists');
  assert.equal(plan.items[0].impact, 'high');
  assert.notEqual(byId(plan, 'google').impact, 'high', 'Google Maps is not the first job for an office');
});

test('lists step: the directories and rankings AI cited, never rivals’ own sites, job boards or wires', () => {
  const lists = byId(buildActionPlan(officeReport()), 'lists');
  const domains = lists.sites.map((s) => s.domain);
  assert.deepEqual(domains.sort(), ['clutch.co', 'communicationsmatch.com', 'odwyerpr.com', 'themanifest.com']);
  // A rival's own profile page on a directory links to the directory, not to the rival.
  assert.equal(lists.sites.find((s) => s.domain === 'communicationsmatch.com').url, 'https://communicationsmatch.com/');
  assert.equal(lists.sites.find((s) => s.domain === 'clutch.co').url, 'https://clutch.co/pr-firms/new-york');
  for (const s of lists.sites) assert.equal(s.status, 'check', 'not read: the owner checks');
  assert.match(lists.why, /Brightline Communications/);
  assert.doesNotMatch(lists.why, /Clutch/, 'a directory is never named as a rival');
});

test('homepage step: "PR & Media Relations" says what a PR agency does; only the town is missing', () => {
  const rep = officeReport();
  assert.equal(homepageSaysTrade(rep.siteCheck.meta, 'pr agency'), true);
  const home = byId(buildActionPlan(rep), 'homepage');
  assert.equal(home.title, 'Make your homepage say where you work');
  assert.doesNotMatch(home.why, /what you do/);
  // The scanner itself now gets this right too.
  assert.ok(tradeWords('pr agency').includes('pr') && tradeWords('pr agency').includes('public relations'));
  assert.equal(metaCheck('<title>Integrated Communications, PR & Media Relations | X</title>', { trade: 'pr agency' }).mentionsTrade, true);
  assert.equal(metaCheck('<title>Fresh bread daily</title>', { trade: 'pr agency' }).mentionsTrade, false);
  assert.ok(!tradeWords('plumbing').includes('pr'));
});

test('FAQ drafts: their own homepage words, "a PR agency", and [brackets] for what only they know', () => {
  const faq = byId(buildActionPlan(officeReport()), 'faq');
  const qa = faq.copyText[0].text;
  assert.match(qa, /^What's the best PR agency in New York City, NY\?\nHarbor Lane PR is a PR agency in New York City, NY\. Harbor Lane's integrated communications team/);
  assert.match(qa, /\[[^\]]+\]/);
  assert.doesNotMatch(qa, /\ban PR\b|\bpr agency\b/);
  assert.equal(qa.split('\n\n').length, 2, 'the "open now" question is left out for an office');
  assert.match(faq.copyText[1].text, /"@type": "FAQPage"/);
  assert.doesNotMatch(faq.copyText[1].text, /\[[A-Z]/, 'no [bracket] placeholder can go live in the FAQ code');
  // The homepage words appear once, not in every answer.
  assert.equal(qa.split("Harbor Lane's integrated communications team").length - 1, 1);
  // Names, not an inflated count; never a directory.
  assert.match(faq.why, /named Brightline Communications, Kestrel PR and Monarch Media Group, not you/);
  assert.doesNotMatch(faq.why, /\d+ other businesses|Clutch/);
  assert.equal(fixCase('Pr agency open now'), 'PR agency open now');
});

test('trade business (a plumber): service-area Google advice, hours kept, no storefront; Google and reviews above code', () => {
  const plan = buildActionPlan(MOCK_REPORTS['sample-001']);
  assert.equal(plan.kind, 'trade');
  const g = byId(plan, 'google');
  const gs = g.steps.join(' ');
  assert.match(gs, /hide your address and set the towns you serve, starting with Massapequa/);
  assert.match(gs, /hours/i);
  assert.match(gs, /photos of your jobs/);
  assert.doesNotMatch(JSON.stringify(plan.items), /storefront/);
  assert.equal(g.impact, 'medium', 'never a "quick extra" for a local business');
  const at = (pred) => plan.items.findIndex(pred);
  const reviews = at((i) => i.from.includes('few_reviews'));
  const code = at((i) => i.id === 'contact');
  const llms = at((i) => i.from.includes('site_no_llms_txt'));
  assert.ok(at((i) => i.id === 'google') < code && at((i) => i.id === 'google') < llms, 'Google above schema code and llms.txt');
  assert.ok(reviews < llms, 'reviews above llms.txt');
  // Wrong facts and listing mismatches stay first.
  assert.ok(/^fact-/.test(plan.items[0].id), plan.items[0].id);
});

test('a shop people walk into keeps storefront photos and opening hours', () => {
  const rep = officeReport();
  rep.business = { ...rep.business, name: 'Corner Bakery', trade: 'bakery' };
  const g = byId(buildActionPlan(rep), 'google');
  assert.match(g.steps.join(' '), /storefront/);
  assert.match(g.steps.join(' '), /opening hours/);
  assert.equal(g.impact, 'high', 'not on Maps is the first job for a shop');
});

test('edge cases: no town, no questions, duplicate titles, positional facts', () => {
  // No town: the suggested title has no dangling "in" or "| |".
  const noTown = officeReport();
  noTown.business = { ...noTown.business, town: '', state: '' };
  noTown.siteCheck.meta = { ...noTown.siteCheck.meta, title: 'Short', description: 'Fresh bread daily.', h1: 'Hi' };
  const t = byId(buildActionPlan(noTown), 'homepage').copyText[0].text;
  assert.equal(t, 'PR agency | Harbor Lane PR');
  // No questions stored: lost questions fall back to stored fixes, and an office still never sees "open now".
  const noQ = officeReport();
  noQ.questions = [];
  const plan = buildActionPlan(noQ);
  assert.doesNotMatch(JSON.stringify(plan.items.map((i) => i.title)), /open now/i);
  // Two stored fixes whose titles share a long start still get different ids (they key the ticks).
  const dup = officeReport();
  dup.questions = [];
  dup.issues.push({ kind: 'few_reviews', severity: 'medium', title: 'Not named when asked "What is the best agency"', steps: [] });
  dup.issues.push({ kind: 'few_reviews', severity: 'medium', title: 'Not named when asked "What is the best agency"', steps: [] });
  const ids = buildActionPlan(dup).items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  // A fact step's id comes from its text, so a tick stays on it when other facts come and go.
  const f = officeReport();
  f.issues.unshift({ kind: 'fact_differs', severity: 'high', title: 'AI states your phone differently', steps: [] });
  const id1 = buildActionPlan(f).items.find((i) => i.title === 'AI states your phone differently').id;
  f.issues.unshift({ kind: 'fact_differs', severity: 'high', title: 'AI states your hours differently', steps: [] });
  assert.equal(buildActionPlan(f).items.find((i) => i.title === 'AI states your phone differently').id, id1);
});

test('contact step: says where the phone goes in the code; office title doesn’t promise an address', () => {
  const c = byId(buildActionPlan(officeReport()), 'contact');
  assert.equal(c.title, 'Put your phone number and business code on your website');
  assert.match(c.copyText[0].text, /"telephone": "\[your phone number\]"/);
  assert.match(c.steps.join(' '), /replacing each part in \[brackets\]/);
});

test('lists step: a paid membership association is not a list to "get on"; awards get an entry step', () => {
  const rep = officeReport();
  rep.sources.push({ url: 'https://www.aaaa.org/agency-profile/x/brightline-new-york', domain: 'aaaa.org', citedIn: ['a2'], topListed: null, youListed: null });
  const lists = byId(buildActionPlan(rep), 'lists');
  assert.ok(!lists.sites.some((s) => s.domain === 'aaaa.org'));
  assert.equal(lists.sites.find((s) => s.domain === 'odwyerpr.com').type, 'award');
  assert.equal(lists.sites.find((s) => s.domain === 'clutch.co').type, 'directory');
  assert.match(lists.steps.join(' '), /Industry lists and awards: these take entries/);
  assert.doesNotMatch(lists.why, /most direct way/);
});

test('a directory AI listed as a business is never a competitor', () => {
  const gap = buildGapSheet(officeReport());
  assert.ok(!gap.competitors.some((c) => c.name === 'Clutch'));
  assert.ok(gap.competitors.some((c) => c.name === 'Brightline Communications'));
});

test('served only when paid: unlocked carries the plan, locked never does', () => {
  const open = reportBody(officeReport(), true);
  assert.ok(open.xray.actionPlan.items.length >= 5);
  const locked = reportBody(officeReport(), false);
  assert.ok(!JSON.stringify(locked).includes('actionPlan'));
});

// ---- the real router ----
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));
async function api(path) {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  return worker.fetch(new Request(`https://aifoundscore.com${path}`), { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } }, { waitUntil() {} });
}

test('GET /api/report/sample-001 (the real route) carries the action plan; ?preview=locked never does', async () => {
  const res = await api('/api/report/sample-001');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.xray.actionPlan.items.length >= 3);
  for (const i of body.xray.actionPlan.items) assert.ok(i.id && i.title && i.impact && i.who);
  const locked = await (await api('/api/report/sample-001?preview=locked')).json();
  assert.ok(!JSON.stringify(locked).includes('actionPlan'));
});

// ---- the page ----
function loadPage(stored = {}) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
    localStorage: { getItem: (k) => stored[k] ?? null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const render = (ctx, report) => {
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  ctx.renderV2(root, report);
  return root.innerHTML;
};
const at = (html, s) => { const i = html.indexOf(s); assert.ok(i >= 0, `page has ${s}`); return i; };

test('paid page: the action plan comes first, with the Fix Kit; evidence after; anything for sale last', () => {
  const html = render(loadPage(), reportBody(officeReport(), true));
  const plan = at(html, '<h2>Your action plan</h2>');
  assert.ok(plan < at(html, 'told a customer who asked'), 'before the AI quote');
  assert.ok(plan < at(html, 'Who got the call instead'), 'before who got the call');
  assert.ok(at(html, 'Open my Fix Kit') < at(html, 'Step 1'), 'Fix Kit link at the top of the plan');
  assert.ok(at(html, 'Every question, every answer') < at(html, 'Get my Competitor Breakdown'), '$25 offer after the evidence');
  assert.ok(at(html, 'Every question, every answer') < at(html, 'Want us to keep watching?'), 'Be the Answer after the evidence');
  // The plan replaces the old fix list, the checklist and the Fix Kit band.
  assert.doesNotMatch(html, /What to fix, in order|Your fix checklist|Your Fix Kit is included\.|Get my Fix Kit/);
  // No gap sheet made of "found nothing" cards.
  assert.doesNotMatch(html, /Competitor gap sheet|We found no sites AI cited that list them/);
  // Sites we couldn't read are folded, not a wall of "Not checked".
  assert.match(html, /<details class="r2-fold"><summary>\d+ sites? AI cited that we couldn’t read for listings<\/summary>/);
  // Clutch is a directory, never in "Who got the call".
  const who = html.slice(at(html, 'Who got the call instead'), at(html, 'Who got the call instead') + 3000);
  assert.doesNotMatch(who, />Clutch</);
  // One tick per step, the first step's "How to do it" open, why + who on every step.
  const n = buildActionPlan(officeReport()).items.length;
  assert.equal((html.match(/data-ap="/g) || []).length, n);
  assert.equal((html.match(/<details class="ap-row" open>/g) || []).length, 1);
  assert.equal((html.match(/class="ap-why"/g) || []).length, n);
  assert.match(html, /<b data-ap-count>0<\/b> of \d+ done/);
});

test('paid page: saved ticks come back (done steps struck, the first undone step open)', () => {
  const rep = reportBody(officeReport(), true);
  const first = rep.xray.actionPlan.items[0].id;
  const html = render(loadPage({ ['afs_plan_' + rep.id]: JSON.stringify({ [first]: true }) }), rep);
  assert.match(html, /<b data-ap-count>1<\/b>/);
  assert.match(html, /<li class="ap-item done" id="step-1">/);
  assert.match(html, /id="step-2">[\s\S]*?<details class="ap-row" open>/);
});

test('sample report shows the plan as a buyer would see it, with nothing to buy and no Fix Kit link', () => {
  const html = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.match(html, /<h2>Your action plan<\/h2>/);
  assert.ok(html.indexOf('<h2>Your action plan</h2>') < html.indexOf('Who got the call instead'));
  assert.doesNotMatch(html, /Open my Fix Kit|Get my Competitor Breakdown|Want us to keep watching\?|Your fix checklist|What to fix, in order/);
  // The sample's gap sheet found gaps, so it stays, without its own checklist.
  assert.match(html, /<h2>Competitor gap sheet<\/h2>/);
});

test('paid page never says "free" in the plan', () => {
  const html = render(loadPage(), reportBody(officeReport(), true));
  const plan = html.slice(html.indexOf('id="action-plan"'), html.indexOf('</section>', html.indexOf('id="action-plan"')));
  assert.doesNotMatch(plan, /\bfree\b/i);
});

test('Be the Answer report: plan panel and action plan together; Fix Kit link uses the plan token; no $499 pitch', () => {
  const rep = reportBody(officeReport(), true);
  rep.plan = { token: 'plan-tok', town: '' };
  const html = render(loadPage(), rep);
  assert.ok(html.indexOf('Open my plan') > -1 && html.indexOf('Open my plan') < html.indexOf('<h2>Your action plan</h2>'));
  assert.match(html, /href="\/fix-kit\/plan-tok"/);
  assert.doesNotMatch(html, /Want us to keep watching\?|Get my Competitor Breakdown/);
});

test('free (locked) page is unchanged: no action plan', () => {
  const html = render(loadPage(), reportBody(officeReport(), false));
  assert.doesNotMatch(html, /Your action plan/);
});

test('site types: directories are claimed, industry lists are entered, articles are pitched', () => {
  assert.equal(siteType('yelp.com', 'https://www.yelp.com/search?find_desc=best-plumbers'), 'directory');
  assert.equal(siteType('clutch.co', 'https://clutch.co/pr-firms/new-york'), 'directory');
  assert.equal(siteType('odwyerpr.com', 'https://www.odwyerpr.com/pr_firm_rankings/newyork.htm'), 'award');
  assert.equal(siteType('example.org', 'https://example.org/awards/2026'), 'award');
  assert.equal(siteType('franklinpatch.com', 'https://franklinpatch.com/best-plumbers-in-franklin'), 'article');
  // A town directory on a domain we don't know is still a directory.
  assert.equal(siteType('localpages.example.com', 'https://localpages.example.com/massapequa-ny/plumbers', { trade: 'plumber' }), 'directory');
  assert.equal(siteType('chamber.example.org', 'https://chamber.example.org/directory/'), 'directory');
  assert.equal(siteType('news.example.com', 'https://news.example.com/2026/05/new-shop-opens'), 'article');
  assert.equal(siteType('example.com', 'https://example.com/about'), 'unsure');
  const rep = officeReport();
  rep.sources.push({ url: 'https://citymag.example.com/best-pr-agencies-nyc', domain: 'citymag.example.com', citedIn: ['a1'], youListed: null });
  const lists = byId(buildActionPlan(rep), 'lists');
  assert.match(lists.steps.join(' '), /Articles and “best of” posts: find the writer/);
});

test('contact code uses the real phone and street when known; placeholders only when missing', () => {
  const rep = officeReport();
  rep.business = { ...rep.business, phone: '(212) 555-0100' };
  const c = byId(buildActionPlan(rep), 'contact');
  assert.match(c.copyText[0].text, /"telephone": "\(212\) 555-0100"/);
  assert.doesNotMatch(c.copyText[0].text, /\[your/);
  assert.doesNotMatch(c.steps.join(' '), /brackets/);
});

test('FAQ code is added only once the answers are final, and matches the page', () => {
  const faq = byId(buildActionPlan(officeReport()), 'faq');
  assert.match(faq.copyText[1].label, /once your answers are final/);
  assert.match(faq.steps.join(' '), /The code must say exactly what the page says/);
  // Every question on the page is in the code.
  const questions = faq.copyText[0].text.split(/\n\n/).map((b) => b.split(/\n/)[0]);
  assert.equal(questions.length, 2);
  for (const q of questions) assert.ok(faq.copyText[1].text.includes(JSON.stringify(q)), q);
});

test('Fix Kit notes show on a paid report and never on a sample', () => {
  const paid = render(loadPage(), reportBody(officeReport(), true));
  assert.match(paid, /class="ap-kitnote"/);
  const sample = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.doesNotMatch(sample, /ap-kitnote|Fix Kit/);
});

test('the plumber sample: its town directory is a directory, and the row shows who does the step', () => {
  const plan = buildActionPlan(MOCK_REPORTS['sample-001']);
  const lists = byId(plan, 'lists');
  assert.ok(lists.sites.some((x) => x.domain === 'localpages.example.com' && x.type === 'directory'));
  assert.match(lists.title, /lists AI read/);
  const html = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.match(html, /<span class="ap-whotag">Web person<\/span>/);
});
