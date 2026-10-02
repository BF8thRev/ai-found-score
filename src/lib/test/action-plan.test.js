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
import { buildGapSheet, lintText } from '../../../shared/report-v2.js';
import { tradeWords, metaCheck } from '../../../scanner/owner-checks.js';
import { reportBody, lockReport } from '../lock.js';
import { recheckDueAt } from '../auto-scan.js';
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
  // Every stored kind lands in some step, or in the Fix Kit (llms.txt is a kit file, not a step).
  const covered = new Set([...plan.items.flatMap((i) => i.from), ...(plan.kitOnly || [])]);
  for (const i of rep.issues) assert.ok(covered.has(i.kind), `${i.kind} is in the plan`);
  assert.deepEqual(plan.kitOnly, ['site_no_llms_txt']);
  assert.ok(!plan.items.some((i) => i.from.includes('site_no_llms_txt') || /llms\.txt/i.test(i.title)), 'no llms.txt step');
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
  const plan = buildActionPlan(officeReport());
  const lists = byId(plan, 'lists');
  const domains = lists.sites.map((s) => s.domain);
  assert.deepEqual(domains.sort(), ['clutch.co', 'communicationsmatch.com', 'themanifest.com']);
  // Rankings are their own, later step.
  assert.deepEqual(byId(plan, 'awards').sites.map((s) => s.domain), ['odwyerpr.com']);
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
  // An office says where it's based, not "where you work".
  assert.equal(home.title, 'Make your homepage say that you’re in New York City');
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
  assert.ok(at((i) => i.id === 'google') < code, 'Google above schema code');
  assert.ok(reviews < code, 'reviews above schema code');
  assert.equal(at((i) => i.from.includes('site_no_llms_txt')), -1, 'llms.txt is in the Fix Kit, not a step');
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
  const plan = buildActionPlan(rep);
  const lists = byId(plan, 'lists');
  const awards = byId(plan, 'awards');
  assert.ok(![...lists.sites, ...awards.sites].some((s) => s.domain === 'aaaa.org'));
  assert.equal(awards.sites.find((s) => s.domain === 'odwyerpr.com').type, 'award');
  assert.equal(lists.sites.find((s) => s.domain === 'clutch.co').type, 'directory');
  assert.match(awards.steps.join(' '), /deadline in your calendar/);
  assert.doesNotMatch(lists.steps.join(' '), /take entries|deadline/);
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
// `tiers`: the tiers on sale (public/js/config.js OFFERED_TIERS); every tier unless given.
function loadPage(stored = {}, { tiers = null } = {}) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: (t) => !tiers || tiers.includes(t), scrollY: 0, addEventListener() {} },
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
  assert.ok(plan < at(html, 'Who AI recommended instead'), 'before who AI recommended');
  const n = buildActionPlan(officeReport()).items.length;
  assert.ok(at(html, 'Hand the website work to your web person') > at(html, `id="step-${n}"`), 'Fix Kit card after the last step');
  assert.ok(at(html, 'Every question, every answer') < at(html, 'Want us to keep watching?'), 'Be the Answer after the evidence');
  assert.ok(at(html, 'Want us to keep watching?') < at(html, 'Get my Competitor Breakdown'), '$25 offer last of all');
  // The plan replaces the old fix list, the checklist and the Fix Kit band.
  assert.doesNotMatch(html, /What to fix, in order|Your fix checklist|Your Fix Kit is included\.|Get my Fix Kit/);
  // No gap sheet made of "found nothing" cards.
  assert.doesNotMatch(html, /Competitor gap sheet|We found no sites AI cited that list them/);
  // Sites we couldn't read are folded, not a wall of "Not checked".
  assert.match(html, /<details class="r2-fold"><summary>\d+ (more )?sites? AI read for these answers<\/summary>/);
  // Clutch is a directory, never in "Who AI recommended".
  const who = html.slice(at(html, 'Who AI recommended instead'), at(html, 'Who AI recommended instead') + 3000);
  assert.doesNotMatch(who, />Clutch</);
  // One tick per step, the first step's "How to do it" open, why + who on every step.
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
  assert.equal(siteType('guides.example.com', 'https://guides.example.com/the-plumber-guide-2026', { trade: 'plumber' }), 'article');
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

// ---- Oct 2 2026 buyer review of the paid PR agency page ----
// The tiers on sale today (public/js/config.js OFFERED_TIERS): Be the Answer is not.
const LIVE_TIERS = ['xray', 'competitor_breakdown'];
const paidOffice = (tiers = LIVE_TIERS) => render(loadPage({}, { tiers }), reportBody(officeReport(), true));
const planOf = (html) => html.slice(at(html, 'id="action-plan"'), html.indexOf('</section>', at(html, 'id="action-plan"')));

test('Fix Kit: no box above step 1; "Done for you" on the steps it covers; one hand-off card after the last step', () => {
  const html = paidOffice();
  const plan = planOf(html);
  assert.doesNotMatch(plan, /class="ap-kit"|Your Fix Kit is ready, and it’s included/);
  assert.ok(plan.indexOf('Open my Fix Kit') > plan.indexOf('id="step-1"'), 'no Fix Kit link above step 1');
  assert.doesNotMatch(plan, /not both/);
  const items = reportBody(officeReport(), true).xray.actionPlan.items;
  for (const id of ['faq', 'contact', 'google']) {
    const n = items.findIndex((i) => i.id === id) + 1;
    const step = plan.slice(plan.indexOf(`id="step-${n}"`), plan.indexOf('</li>', plan.indexOf('class="ap-kitnote"', plan.indexOf(`id="step-${n}"`))));
    assert.match(step, /<p class="ap-kitnote">Done for you: [^<]*Fix Kit[^<]* <a href="\/fix-kit\/office-test-token">Open my Fix Kit<\/a><\/p>/, id);
  }
  // The card, after the last step.
  const card = plan.slice(at(plan, 'class="ap-kitcard"'));
  assert.ok(plan.indexOf('class="ap-kitcard"') > plan.indexOf(`id="step-${items.length}"`));
  assert.match(card, /<h3>Hand the website work to your web person<\/h3>/);
  assert.match(card, /<a class="btn" href="\/fix-kit\/office-test-token">Open my Fix Kit<\/a>/);
  assert.match(card, /llms\.txt/, 'llms.txt is named in the kit card');
  assert.doesNotMatch(card.match(/<h3>[^<]*<\/h3>/)[0], /JSON|llms|schema/i);
  // "Email it to my web person": the owner's own mail app, the kit link inside, no address of theirs.
  const href = card.match(/<a class="btn-secondary" href="([^"]+)">Email it to my web person<\/a>/)[1].replace(/&amp;/g, '&');
  assert.match(href, /^mailto:\?subject=/);
  const body = decodeURIComponent(href.split('&body=')[1]);
  assert.match(body, /https:\/\/aifoundscore\.com\/fix-kit\/office-test-token/);
  assert.doesNotMatch(href, /@|%40/);
  // A sample has no kit to open.
  const sample = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.doesNotMatch(sample, /ap-kitcard|Email it to my web person/);
});

test('Do these 3 this week: above the full plan, each with who, time and cost; the plan shows them too', () => {
  const rep = reportBody(officeReport(), true);
  for (const i of rep.xray.actionPlan.items) assert.ok(i.time && i.cost, `${i.id} has time and cost`);
  const html = render(loadPage(), rep);
  const plan = planOf(html);
  const week = plan.slice(at(plan, 'class="ap-week"'), plan.indexOf('</div>', at(plan, 'class="ap-week"')));
  assert.ok(plan.indexOf('class="ap-week"') < plan.indexOf('class="ap-list"'), 'above the full plan');
  assert.match(week, /<h3>Do these 3 this week<\/h3>/);
  const links = [...week.matchAll(/<a href="#step-(\d+)">([^<]+)<\/a><span>([^<]+)<\/span>/g)];
  assert.equal(links.length, 3);
  for (const [, , , meta] of links) assert.match(meta, /(You can do this|For whoever runs your website|You, with your web person) · (About|Under) .+ · .+/);
  assert.match(week, /Get on the 3 lists AI read/);
  assert.doesNotMatch(week, /industry list|entry dates/i, 'industry lists and awards are not a this-week job');
  // Our own copy: no banned words (shared/report-v2.js BANNED_WORDS, e.g. "minutes", "rank").
  const words = plan.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ');
  assert.deepEqual(lintText(words).map((h) => h.word), []);
  // Each step's time and cost in the plan itself.
  assert.equal((plan.match(/class="ap-effort"/g) || []).length, rep.xray.actionPlan.items.length);
  // A step already ticked makes room for the next one.
  const first = rep.xray.actionPlan.items[0].id;
  const ticked = render(loadPage({ ['afs_plan_' + rep.id]: JSON.stringify({ [first]: true }) }), rep);
  assert.doesNotMatch(planOf(ticked).slice(0, planOf(ticked).indexOf('class="ap-list"')), /href="#step-1"/);
});

test('lists split: directories this week; rankings and awards a later "put the dates in your calendar" step', () => {
  const plan = buildActionPlan(officeReport());
  const lists = byId(plan, 'lists');
  const awards = byId(plan, 'awards');
  assert.equal(lists.impact, 'high');
  assert.equal(lists.who, 'you');
  assert.equal(lists.week, true);
  assert.match(lists.time, /half an hour per site/);
  assert.equal(awards.week, false);
  assert.notEqual(awards.impact, 'high');
  assert.match(awards.title, /in your calendar/);
  assert.match(awards.cost, /charge to enter/);
  assert.ok(plan.items.indexOf(lists) < plan.items.indexOf(awards));
  const html = paidOffice();
  assert.match(html, /<span class="badge low">Not checked yet<\/span>/);
  assert.doesNotMatch(html, /<span class="badge low">Check<\/span>|marked “Check”/);
});

test('score at zero says so plainly, with what "good" looks like', () => {
  const html = paidOffice();
  assert.match(html, /<p class="r2-sc-verdict">AI didn’t recommend you in any of the 6 answers\.<\/p>/);
  assert.doesNotMatch(html, /almost never recommends you/);
  assert.match(html, /<p class="r2-sc-target">Fair starts at 40\. Strong is 70 and up\.<\/p>/);
  // Named sometimes: the old wording, still with the target.
  const some = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.doesNotMatch(some, /didn’t recommend you in any/);
});

test('acronyms stay upper case: "PR agencies near New York City"', () => {
  const html = paidOffice();
  assert.match(html, /for PR agencies near New York City\./);
  assert.doesNotMatch(html, /pr agencies/);
});

test('the website checklist and the plan agree: "PR & Media Relations" says what a PR agency does', () => {
  const body = reportBody(officeReport(), true);
  assert.equal(body.siteCheck.meta.mentionsTrade, true);
  const html = render(loadPage(), body);
  assert.match(html, /Your title and main heading say what you do\./);
  assert.doesNotMatch(html, /don’t say what you do/);
  // The free tally counts it as passed too.
  assert.equal(reportBody(officeReport(), false).siteCheck.passed, lockReport(officeReport()).siteCheck.passed + 1);
});

test('office report: no van or storefront wording, and a missing Google profile isn’t "listings disagree"', () => {
  const html = paidOffice();
  assert.doesNotMatch(html, /towns you serve|got the call|licenses|say where you work|Google Maps listing/i);
  assert.match(html, /<h2>Who AI recommended instead<\/h2>/);
  const listings = html.slice(at(html, '<h2>Your listings</h2>'), html.indexOf('</section>', at(html, '<h2>Your listings</h2>')));
  assert.match(listings, /We couldn’t find a Google Business Profile for Harbor Lane PR\./);
  assert.match(listings, /✗ Not found/);
  assert.doesNotMatch(listings, /disagree|1 of 1/);
  // A plumber keeps their own words.
  const trade = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.match(trade, /Who got the call instead/);
});

test('paid report with a plan: the website checklist is a closed box for the web person, with one line on top', () => {
  const html = paidOffice();
  const site = html.slice(at(html, '<h2>Can AI read your website?</h2>'), html.indexOf('</section>', at(html, '<h2>Can AI read your website?</h2>')));
  assert.match(site, /<b>\d+ of \d+ checks passed\.<\/b>/);
  assert.match(site, /<details class="r2-site-more">\s*<summary>Technical details for your web person<\/summary>/);
  assert.doesNotMatch(site, /<details class="r2-site-more" open/);
  assert.doesNotMatch(site, /Page title:|A sitemap helps|has a meta description/, 'passes that say nothing are left out');
  // Failed checks come first inside the box.
  const list = site.slice(site.indexOf('<ul class="r2-site-list">'));
  assert.ok(list.indexOf('class="bad"') < list.indexOf('class="ok"'));
  // The free page is unchanged: no box.
  assert.doesNotMatch(render(loadPage(), reportBody(officeReport(), false)), /r2-site-more/);
});

test('sites we couldn’t read: a calm line, pointed at the plan', () => {
  const html = paidOffice();
  assert.match(html, /<summary>8 sites AI read for these answers<\/summary><p class="r2-muted r2-fold-note">We haven’t checked these pages for your name yet\. Nothing here needs doing now/);
  assert.doesNotMatch(html, /couldn’t read for listings/);
});

test('the free 30-day re-check: right after the plan, with its date; never on a sample, a plan or a re-check', () => {
  const rep = reportBody(officeReport(), true);
  rep.recheckOn = '2099-11-01T18:00:00.000Z';
  const html = render(loadPage(), rep);
  const card = at(html, '<h3>Your free re-check</h3>');
  assert.ok(card > at(html, 'class="ap-kitcard"') && card < at(html, 'told a customer who asked'), 'after the plan, before the evidence');
  assert.match(html, /On Nov 1, 2099, we’ll ask AI the same questions again and email you what changed\./);
  // No date known: says when without one.
  assert.match(render(loadPage(), reportBody(officeReport(), true)), /About 30 days after you bought your audit, we’ll ask AI the same questions again/);
  assert.doesNotMatch(render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true)), /Your free re-check/);
  const onPlan = { ...rep, plan: { token: 'plan-tok', town: '' } };
  assert.doesNotMatch(render(loadPage(), onPlan), /Your free re-check/);
  const recheck = { ...rep, baseline: { generatedAt: '2026-09-01T00:00:00Z', totals: { answers: 6, namedYou: 0, firstYou: 0 } } };
  assert.doesNotMatch(render(loadPage(), recheck), /Your free re-check/);
});

test('recheckDueAt: the first live audit payment + 30 days; test payments and Be the Answer have none', () => {
  assert.equal(recheckDueAt([{ tier: 'xray', livemode: true, paid_at: '2026-10-01T18:00:00Z' }, { tier: 'xray', livemode: true, paid_at: '2026-10-05T18:00:00Z' }]), '2026-10-31T18:00:00.000Z');
  assert.equal(recheckDueAt([{ tier: 'xray', livemode: false, paid_at: '2026-10-01T18:00:00Z' }]), null);
  assert.equal(recheckDueAt([{ tier: 'be_the_answer', livemode: true, paid_at: '2026-10-01T18:00:00Z' }]), null);
  assert.equal(recheckDueAt([{ tier: 'competitor_breakdown', livemode: true, paid_at: '2026-10-01T18:00:00Z' }]), null);
  assert.equal(recheckDueAt([]), null);
});

test('GET /api/report/<token> (the real route) on a paid report carries recheckOn from the payment', async () => {
  const TOKEN = 'zDLK7Xwl4vsA3SaJ-FQr4w';
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const seen = [];
  // The fixture, made to pass the serve gate (validateReport): first-place counts, headline, window.
  const stored = officeReport();
  for (const e of stored.entities) e.first = stored.answers.filter((a) => a.businessesNamed[0] && a.businessesNamed[0].entityId === e.id).length;
  stored.headline = { ...stored.headline, answerId: 'a1' };
  stored.method.window = '5:49 PM to 5:51 PM ET';
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    seen.push(u.pathname + u.search);
    if (u.pathname === '/rest/v1/rpc/report_unlocked') return json(true);
    if (u.pathname === '/rest/v1/scan_results') return json([{ version: 2, report: stored, scanned_at: '2026-10-01T17:51:00Z' }]);
    if (u.pathname === '/rest/v1/payments') return json([{ tier: 'xray', amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' }]);
    return json([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service', ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const res = await worker.fetch(new Request(`https://aifoundscore.com/api/report/${TOKEN}`), env, { waitUntil() {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.locked, false);
    assert.equal(body.recheckOn, '2026-10-31T18:00:00.000Z');
    assert.ok(seen.some((x) => x.includes('/payments?') && x.includes('paid_at')), 'payments read with paid_at');
  } finally {
    globalThis.fetch = real;
  }
});

test('upsells on a paid page: no Be the Answer box when it isn’t on sale; the $25 offer is last, short and optional', () => {
  const html = paidOffice(['xray', 'competitor_breakdown']);
  assert.doesNotMatch(html, /Want us to keep watching\?|Tell me when it opens|Be the Answer/);
  const bd = at(html, 'Get my Competitor Breakdown');
  assert.ok(bd > at(html, 'How we searched'), 'after everything else');
  assert.match(html, /<strong>Optional extra:<\/strong> the Competitor Breakdown \(\$25\)/);
  assert.ok(at(html, 'class="r2-verdict') < at(html, 'id="action-plan"') && at(html, 'id="action-plan"') < bd, 'never right after the verdict');
});
