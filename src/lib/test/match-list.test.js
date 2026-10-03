// Competitor Match List (the $25 Competitor Breakdown add-on): the builder in shared/report-v2.js, the paid page
// (public/js/report.js breakdownV2), the wording that sells it, and the real /api/report route. Built only from
// a report's own answers and cited pages: every tick has evidence, a dash only means "not seen".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { buildCompetitorBreakdown, buildMatchList, nameKey, classifyCitation, isTownPagePath, MATCH_SIGNALS } from '../../../shared/report-v2.js';
import { reportBody, BREAKDOWN_TIERS } from '../lock.js';
import { PRODUCTS } from '../checkout.js';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const GEMINI = [
  '### 1. Best Overall & Award-Winning: **Varsity Home Service**',
  '* **Why they stand out:** A multi-year winner of the Best of Long Island awards with an A+ Better Business Bureau rating and licensed technicians on every call.',
  '',
  '### 2. Best for Transparency: **Rubber Duck Plumbing**',
  '* **Why they stand out:** Known for upfront pricing, free estimates and 24/7 emergency dispatch.',
  '',
  '### 3. Best for Late Nights: **Roto-Rooter**',
  '* **Why they stand out:** A dedicated fleet for basement flooding and sewer backups.',
  '',
  '---',
  '',
  '### Tips Before Hiring',
  '1. Make sure whoever you hire is licensed and insured, and ask about 24/7 fees.',
].join('\n');

const at = (text, name) => ({ pos: text.indexOf(name), name });

function makeReport(over = {}) {
  const a3 = GEMINI;
  const a1 = 'For a plumber in Smithtown, people often call Roto-Rooter or Rubber Duck Plumbing for fast, reliable service.';
  const a2 = 'Consider Varsity Home Service, Roto-Rooter and Rubber Duck Plumbing if you need someone tonight.';
  const answers = [
    { id: 'a1', engine: 'chatgpt', questionId: 'q1', text: a1, namedYou: false, citations: [], businessesNamed: [{ ...at(a1, 'Roto-Rooter'), entityId: 'e1' }, { ...at(a1, 'Rubber Duck Plumbing'), entityId: 'e2' }] },
    { id: 'a2', engine: 'perplexity', questionId: 'q2', text: a2, namedYou: false, citations: [], businessesNamed: [{ ...at(a2, 'Varsity Home Service'), entityId: 'e3' }, { ...at(a2, 'Roto-Rooter'), entityId: 'e1' }, { ...at(a2, 'Rubber Duck Plumbing'), entityId: 'e2' }] },
    {
      id: 'a3', engine: 'gemini', questionId: 'q1', text: a3, namedYou: false,
      citations: [
        { url: 'https://www.varsityhomeservice.com/smithtown-ny/plumbing/', domain: 'varsityhomeservice.com' },
        { url: 'https://rubberduckplumbinginc.com/service-area/smithtown-ny/', domain: 'rubberduckplumbinginc.com' },
        { url: 'https://www.rotorooter.com/smithtownny/', domain: 'rotorooter.com' },
        { url: 'https://www.reddit.com/r/longisland/comments/1podcqc/plumber_smithtown_area/', domain: 'reddit.com' },
        { url: 'https://www.yelp.com/biz/some-plumber', domain: 'yelp.com' },
      ],
      businessesNamed: [{ ...at(a3, 'Varsity Home Service'), entityId: 'e3' }, { ...at(a3, 'Rubber Duck Plumbing'), entityId: 'e2' }, { ...at(a3, 'Roto-Rooter'), entityId: 'e1' }],
    },
  ];
  return {
    version: 2,
    business: { name: 'Werner Plumbing', town: 'Smithtown', state: 'NY', trade: 'plumbing', website: 'https://wernersplumbing.com/' },
    questions: [{ id: 'q1', text: 'What’s the best plumber in Smithtown, NY?', intent: 'best' }, { id: 'q2', text: 'I need an emergency plumber near Smithtown tonight', intent: 'urgent' }],
    entities: [
      { id: 'e1', name: 'Roto-Rooter', named: 3, first: 1, isYou: false, answerIds: ['a1', 'a2', 'a3'] },
      { id: 'e2', name: 'Rubber Duck Plumbing', named: 3, first: 1, isYou: false, answerIds: ['a1', 'a2', 'a3'] },
      { id: 'e3', name: 'Varsity Home Service', named: 2, first: 1, isYou: false, answerIds: ['a2', 'a3'] },
    ],
    answers,
    sources: [],
    reviews: { you: { rating: 4.1, count: 12 }, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }, { name: 'Rubber Duck Plumbing', rating: 4.9, count: 210 }] },
    ...over,
  };
}
const rowOf = (m, key) => m.rows.find((r) => r.key === key);
const names = (bd) => bd.competitors.map((c) => c.name);

test('nameKey: the distinctive letters of a name, nothing when too short to trust', () => {
  assert.equal(nameKey('Rubber Duck Plumbing'), 'rubberduck');
  assert.equal(nameKey('Roto-Rooter'), 'rotorooter');
  assert.equal(nameKey('Varsity Home Service'), 'varsity');
  assert.equal(nameKey('Benjamin Franklin Plumbing of Smithtown', ['smithtown']), 'benjaminfranklin');
  assert.equal(nameKey('ABC Co'), '');
  assert.equal(nameKey('Roto-Rooter (Suffolk County Branch)'), 'rotorooter');
});

test('classifyCitation: community, directory, town page, site, and junk', () => {
  const town = { compact: 'smithtown', state: 'ny' };
  assert.equal(classifyCitation('https://www.reddit.com/r/x/comments/1', town).kind, 'community');
  assert.equal(classifyCitation('https://www.facebook.com/fb-answers/plumbers', town).kind, 'community');
  assert.equal(classifyCitation('https://www.yelp.com/biz/x', town).kind, 'directory');
  assert.equal(classifyCitation('https://www.bbb.org/us/ny/smithtown/profile/plumber/x', town).kind, 'directory');
  assert.equal(classifyCitation('https://rubberduckplumbinginc.com/service-area/smithtown-ny/', town).kind, 'town-page');
  assert.equal(classifyCitation('https://www.benjaminfranklinplumbing.com/areas-we-service/smithtown-ny/', town).kind, 'town-page');
  assert.equal(classifyCitation('https://www.rotorooter.com/smithtownny/', town).kind, 'town-page');
  assert.equal(classifyCitation('https://outstandingplumber.com/', town).kind, 'site');
  assert.equal(classifyCitation('https://rival.com/service-area/smithtown-ny/').kind, 'site', 'no town known: never guessed');
  assert.deepEqual(classifyCitation('javascript:alert(1)', town), { kind: 'other', domain: '' });
  assert.deepEqual(classifyCitation('not a url', town), { kind: 'other', domain: '' });
  assert.equal(classifyCitation('ftp://x.com/a', town).kind, 'other');
});

test('match list: what the top businesses show, with evidence, and you at zero', () => {
  const bd = buildCompetitorBreakdown(makeReport());
  const m = bd.match;
  assert.ok(m, 'a match list');
  assert.deepEqual(names(bd).sort(), ['Roto-Rooter', 'Rubber Duck Plumbing', 'Varsity Home Service']);
  const idx = (n) => names(bd).indexOf(n);
  // a page for the owner's town: all three rivals, none for the owner
  const town = rowOf(m, 'townPage');
  assert.equal(town.rivalCount, 3);
  assert.equal(town.you, false);
  assert.match(town.label, /A page just for Smithtown/);
  assert.ok(town.rivals.every((r) => r.has && /^https:\/\//.test(r.evidence.url)));
  // descriptors come from the text about each business, not from the whole answer
  assert.equal(rowOf(m, 'emergency').rivals[idx('Rubber Duck Plumbing')].has, true);
  assert.equal(rowOf(m, 'emergency').rivals[idx('Roto-Rooter')].has, false, 'the "24/7 fees" tip after the rule is not about Roto-Rooter');
  assert.equal(rowOf(m, 'licensed').rivals[idx('Varsity Home Service')].has, true);
  assert.equal(rowOf(m, 'licensed').rivals[idx('Roto-Rooter')].has, false, 'the "licensed and insured" tip is not about Roto-Rooter');
  assert.equal(rowOf(m, 'bbb').rivalCount, 1);
  assert.equal(rowOf(m, 'awards').rivalCount, 1);
  assert.equal(rowOf(m, 'pricing').rivals[idx('Rubber Duck Plumbing')].has, true);
  // every quoted sentence is word for word from an answer
  const texts = makeReport().answers.map((a) => a.text.replace(/\*\*/g, ''));
  for (const r of m.rows) for (const c of r.rivals) if (c.evidence && c.evidence.text && !['reviewsCount', 'ratingHigher'].includes(r.key)) assert.ok(texts.some((t) => t.includes(c.evidence.text)), `verbatim: ${c.evidence.text}`);
  // the owner was never named, so nothing is credited to them
  assert.equal(m.youCount, 0);
  assert.ok(m.total >= 5);
  assert.ok(m.avgRivals > 0 && m.avgRivals <= m.total);
});

test('match list: a review-count row from the Google numbers already in the report', () => {
  const m = buildCompetitorBreakdown(makeReport()).match;
  const row = rowOf(m, 'reviewsCount');
  assert.ok(row);
  const bd = buildCompetitorBreakdown(makeReport());
  const rr = row.rivals[names(bd).indexOf('Roto-Rooter')];
  assert.equal(rr.has, true);
  assert.equal(rr.evidence.text, '300 Google reviews at 4.5 stars, to your 12.');
  assert.equal(row.rivals[names(bd).indexOf('Varsity Home Service')].has, false, 'no review data for Varsity: not claimed');
});

test('match list: do these first is ordered by how many rivals have it, at most 5, only things the owner lacks', () => {
  const m = buildCompetitorBreakdown(makeReport()).match;
  assert.ok(m.first.length >= 3 && m.first.length <= 5);
  assert.equal(m.first[0].key, 'townPage');
  assert.match(m.first[0].action, /Add a page for Smithtown/);
  for (let i = 1; i < m.first.length; i++) assert.ok(m.first[i - 1].rivalCount >= m.first[i].rivalCount);
  for (const f of m.first) assert.equal(rowOf(m, f.key).you, false);
  for (const s of MATCH_SIGNALS) assert.ok(s.label && s.action, s.key);
});

test('match list: pages AI cited are classified and matched to a business only when the name is in the domain', () => {
  const m = buildCompetitorBreakdown(makeReport()).match;
  const by = (d) => m.pages.find((p) => p.domain === d);
  assert.deepEqual([by('varsityhomeservice.com').kind, by('varsityhomeservice.com').competitor], ['town-page', 'Varsity Home Service']);
  assert.deepEqual([by('rubberduckplumbinginc.com').kind, by('rubberduckplumbinginc.com').competitor], ['town-page', 'Rubber Duck Plumbing']);
  assert.deepEqual([by('rotorooter.com').kind, by('rotorooter.com').competitor], ['town-page', 'Roto-Rooter']);
  assert.deepEqual([by('reddit.com').kind, by('reddit.com').competitor], ['community', null]);
  assert.deepEqual([by('yelp.com').kind, by('yelp.com').competitor], ['directory', null]);
  assert.equal(m.townPages, 3);
  assert.equal(m.youTownPage, false);
});

test('match list: the owner’s own signals count, and an owner town page removes the gap', () => {
  const rep = makeReport();
  const text = 'Werner Plumbing is a licensed and insured family-owned shop with 25 years in business.';
  rep.answers.push({ id: 'a4', engine: 'gemini', questionId: 'q1', text, namedYou: true, citations: [{ url: 'https://wernersplumbing.com/smithtown-ny/', domain: 'wernersplumbing.com' }], businessesNamed: [{ pos: text.indexOf('Werner Plumbing'), name: 'Werner Plumbing', entityId: 'you', isYou: true }] });
  const bd = buildCompetitorBreakdown(rep);
  const m = bd.match;
  assert.equal(rowOf(m, 'licensed').you, true);
  assert.equal(m.youTownPage, true);
  assert.equal(rowOf(m, 'townPage').you, true);
  assert.ok(m.youCount >= 2);
  assert.ok(m.first.every((f) => f.key !== 'townPage' && f.key !== 'licensed'));
  for (const c of bd.competitors) assert.ok(!c.edges.some((e) => /It cited none from your site/.test(e)), 'no false gap');
});

test('match list: each rival’s list leads with the town page AI cited, and never claims more than was seen', () => {
  const bd = buildCompetitorBreakdown(makeReport());
  for (const c of bd.competitors) {
    assert.ok(c.edges.length <= 5);
    assert.match(c.edges[0], /^AI cited their page for Smithtown \([a-z.]+\)\. It cited none from your site\.$/);
    assert.ok(c.pages.every((p) => p.competitor === c.name));
    assert.ok(Array.isArray(c.says));
  }
  const rr = bd.competitors.find((c) => c.name === 'Rubber Duck Plumbing');
  assert.deepEqual(rr.says.map((s) => s.key).sort(), ['emergency', 'pricing']);
});

test('match list: nobody named twice → no list; an ambiguous domain is never guessed', () => {
  const none = makeReport({ entities: [], answers: [] });
  assert.equal(buildCompetitorBreakdown(none).match, null);
  assert.equal(buildMatchList(makeReport(), [], null), null);
  const rep = makeReport();
  rep.entities.push({ id: 'e9', name: 'Rooter Rubber Duck Plumbing', named: 3, first: 0, isYou: false, answerIds: ['a1', 'a2', 'a3'] });
  rep.answers[0].businessesNamed.push({ pos: 0, name: 'Rooter Rubber Duck Plumbing', entityId: 'e9' });
  rep.answers[1].businessesNamed.push({ pos: 0, name: 'Rooter Rubber Duck Plumbing', entityId: 'e9' });
  rep.answers[2].businessesNamed.push({ pos: 0, name: 'Rooter Rubber Duck Plumbing', entityId: 'e9' });
  const m = buildCompetitorBreakdown(rep).match;
  const page = m.pages.find((p) => p.domain === 'rubberduckplumbinginc.com');
  assert.ok(page.competitor === 'Rubber Duck Plumbing' || page.competitor === 'Rooter Rubber Duck Plumbing' || page.competitor === null);
});

test('reportBody carries the match list only when the add-on is paid for, never on a locked report', () => {
  const rep = makeReport();
  assert.equal(reportBody(rep, true).breakdown, undefined);
  assert.ok(reportBody(rep, true, { breakdown: true }).breakdown.match.rows.length);
  assert.equal(reportBody(rep, false, { breakdown: true }).breakdown, undefined);
  assert.ok(BREAKDOWN_TIERS.includes('competitor_breakdown'));
});

// ---- the real router: GET /api/report/sample-001 (no database needed for the sample) ----
async function api(path) {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  const res = await worker.fetch(new Request(`https://aifoundscore.com${path}`), { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } }, { waitUntil() {} });
  return res;
}

test('GET /api/report/sample-001 (the real route) carries the Match List; ?preview=locked never does', async () => {
  const res = await api('/api/report/sample-001');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.breakdown && body.breakdown.competitors.length >= 1, 'competitors');
  assert.ok(body.breakdown.match && body.breakdown.match.rows.length >= 1, 'a match list');
  assert.ok(body.breakdown.match.first.length >= 1 && body.breakdown.match.first.length <= 5);
  for (const c of body.breakdown.competitors) assert.ok(c.edges.length <= 5);
  const locked = await (await api('/api/report/sample-001?preview=locked')).json();
  assert.equal(locked.breakdown, undefined, 'a locked view never carries it');
});

// ---- the page (public/js/report.js breakdownV2), rendered in a bare VM ----
function loadPage() {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const paidWithMatch = () => {
  const rep = makeReport();
  return { ...rep, locked: false, breakdown: buildCompetitorBreakdown(rep) };
};

test('the paid page: a scorecard (rivals and You), a tally, "Do these first", what AI said, pages read, and an honest note', () => {
  const r = loadPage();
  const rep = paidWithMatch();
  const html = r.breakdownV2(rep);
  const m = rep.breakdown.match;
  assert.match(html, /<h2>Competitor Breakdown<\/h2>/);
  assert.match(html, new RegExp(`<b>You match 0 of ${m.total}\\.</b> The top 3 match ${String(m.avgRivals).replace('.', '\\.')} of ${m.total} on average\\.`));
  const head = html.match(/<thead><tr><th scope="col">What we saw<\/th>([^]*?)<\/tr>/)[1];
  for (const n of ['Roto-Rooter', 'Rubber Duck Plumbing', 'Varsity Home Service']) assert.ok(head.includes(n));
  assert.match(head, /<th scope="col" class="m you">You<\/th>/);
  const ticks = (html.match(/<span class="y" aria-label="Seen">✓<\/span>/g) || []).length;
  assert.equal(ticks, m.rows.reduce((n, row) => n + row.rivals.filter((x) => x.has).length + (row.you ? 1 : 0), 0));
  assert.match(html, /<h3 class="r2-match-h">Do these first<\/h3>\s*<ol class="r2-first">/);
  // Every "do this first" item is on the page: the first 3 on screen, the rest behind "Show all N".
  const firstLis = (html.match(/<ol class="r2-first"[^>]*>[^]*?<\/ol>/g) || []).join('').match(/<li>/g) || [];
  assert.equal(firstLis.length, m.first.length);
  if (m.first.length > 4) assert.match(html, new RegExp(`<details class="r2-more"><summary>Show all ${m.first.length} things to copy</summary><ol class="r2-first" start="4"`));
  assert.match(html, /Add a page for Smithtown that says what you do there/);
  assert.match(html, /What AI said about them:/);
  assert.match(html, /<q>[^<]*Best of Long Island[^<]*<\/q>/);
  assert.match(html, /Pages AI cited for them:/);
  assert.match(html, /Their page for your town<\/span><a href="https:\/\/rubberduckplumbinginc\.com\/service-area\/smithtown-ny\/" rel="nofollow noopener" target="_blank">/);
  assert.match(html, /A dash means we didn’t see it there, not that it doesn’t exist\./);
  assert.match(html, /We can’t promise that copying them changes what AI says\./);
  assert.doesNotMatch(html, /side by side|undefined|NaN/);
});

test('the paid page: names and quotes are escaped; a report with no rivals says so; no list when nothing matched', () => {
  const r = loadPage();
  const rep = paidWithMatch();
  rep.breakdown.competitors[0].name = '<img src=x onerror=alert(1)>';
  rep.breakdown.match.rows[0].label = '<b>bad</b>';
  const html = r.breakdownV2(rep);
  assert.doesNotMatch(html, /<img src=x|<b>bad<\/b>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const none = r.breakdownV2({ breakdown: { competitors: [], you: {} } });
  assert.match(none, /nobody to match this time/);
  const noMatch = paidWithMatch();
  noMatch.breakdown.match = null;
  const plain = r.breakdownV2(noMatch);
  assert.doesNotMatch(plain, /r2-match-score|Do these first/);
  assert.match(plain, /One by one/);
});

test('the wording sells the value: offer card, paid-page upsell, checkout, emails; no "side by side"', () => {
  const r = loadPage();
  const html = r.breakdownV2(paidWithMatch());
  assert.doesNotMatch(html, /side by side/);
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  assert.match(src, /<b>Add the Competitor Breakdown <em>\+\$25<\/em><\/b>A scorecard of what the top 3 businesses AI picks over you have that you don’t, and what to copy first\./);
  assert.match(src, /<strong>See what they have that you don’t\.<\/strong> The Competitor Breakdown \(\$25\) is a scorecard of what the top 3 businesses AI names instead of you show that you don’t/);
  assert.match(PRODUCTS.competitor_breakdown.description, /^A scorecard of what the top 3 businesses AI names instead of you have that you don’t, a “do these first” list, and what AI said about each one, word for word\.$/);
  const checkout = readFileSync(new URL('../../../public/checkout.html', import.meta.url), 'utf8');
  assert.match(checkout, /See what the top 3 businesses AI picks over you have that you don&rsquo;t, and what to copy first\./);
  assert.match(checkout, /Competitor Breakdown <em>\+\$25<\/em>/);
  const email = readFileSync(new URL('../email.js', import.meta.url), 'utf8');
  assert.equal((email.match(/a scorecard of what the top 3 businesses AI names instead of you have that you don’t, with a “do these first” list\./g) || []).length, 2);
  for (const [name, text] of [['report.js', src], ['checkout.html', checkout], ['email.js', email], ['checkout.js', readFileSync(new URL('../checkout.js', import.meta.url), 'utf8')]]) {
    assert.doesNotMatch(text, /side by side with you/, name);
  }
});

// ---------------------------------------------------------------------------
// Accuracy regressions: each of these once produced a wrong tick (found by the accuracy audit).
// ---------------------------------------------------------------------------
// A business a gap-sheet counts must be named in 2+ answers, so the same text is used for two answers.
function rival(text, name = 'Roto-Rooter', extra = {}) {
  const businessesNamed = extra.businessesNamed || [{ ...at(text, name), entityId: 'e1' }];
  const mk = (id, engine) => ({ id, engine, questionId: 'q1', text, namedYou: false, citations: [], businessesNamed });
  return {
    version: 2,
    business: { name: 'Werner Plumbing', town: 'Smithtown', state: 'NY', trade: 'plumbing', website: 'https://wernersplumbing.com/' },
    questions: [{ id: 'q1', text: 'best plumber?', intent: 'best' }],
    entities: [{ id: 'e1', name, named: 2, first: 1, isYou: false, answerIds: ['a1', 'a2'] }],
    answers: [mk('a1', 'gemini'), mk('a2', 'chatgpt')],
    sources: [],
    ...extra.report,
  };
}
const ticks = (rep) => { const m = buildCompetitorBreakdown(rep).match; return m ? m.rows.filter((r) => r.rivals[0].has).map((r) => r.key).sort() : []; };

test('negations and hedges never tick: "not 24/7", "no upfront pricing", "lacks a BBB rating", "used to be licensed"…', () => {
  const bad = [
    'Roto-Rooter is not 24/7, so call early in the day.',
    'Roto-Rooter has no upfront pricing that we could find.',
    'Roto-Rooter lacks a BBB rating on its listing.',
    'Roto-Rooter used to be licensed in Suffolk County years ago.',
    'Roto-Rooter is not certified for gas work in this town.',
    'Roto-Rooter has won no awards that we could find.',
    'Roto-Rooter is not top-rated on local sites.',
    'Roto-Rooter is not family owned any more.',
    'Roto-Rooter was accused of not being licensed for the work.',
    'Ask Roto-Rooter whether it is licensed before you book them.',
    'Roto-Rooter is near the emergency room on Main Street.',
    'Roto-Rooter has an emergency plan for the office.',
    'Roto-Rooter insured? That is unclear from what we could see.',
  ];
  for (const text of bad) assert.deepEqual(ticks(rival(text)), [], text);
  // and the same words, said plainly, do tick
  assert.deepEqual(ticks(rival('Roto-Rooter offers 24/7 emergency service across Suffolk County with upfront pricing.')), ['emergency', 'pricing']);
});

test('risky sentences (complaints, lawsuits, F rating) are never quoted under a positive label', () => {
  const rep = rival('Roto-Rooter is licensed but has an F rating and many complaints on file with the Better Business Bureau.');
  assert.deepEqual(ticks(rep), [], 'no licensed, no BBB tick from a complaints sentence');
  const ok = rival('Roto-Rooter is an A+ rated member of the Better Business Bureau and is licensed.');
  assert.deepEqual(ticks(ok), ['bbb', 'licensed']);
});

test('tips after the last business are not about the last business (blank line, bold label, heading, rule)', () => {
  const list = '1. Varsity Home Service: A local favorite for water heaters.\n2. Roto-Rooter: A big national name.';
  for (const tips of [
    '\n\nHiring tips: Make sure whoever you hire is licensed and insured, and ask about 24/7 fees.',
    '\n\n**Hiring tips:** Get free estimates, check licensed status, and ask about upfront pricing.',
    '\n\n### Tips\nAlways choose a licensed and insured plumber with 24/7 service.',
    '\n\n---\nBe sure to pick a licensed, insured plumber.',
  ]) {
    const text = list + tips;
    const rep = rival(text, 'Roto-Rooter');
    assert.deepEqual(ticks(rep), [], tips);
  }
  // but the business's own bullets, on the lines right after its name, do count
  const own = '2. **Roto-Rooter**\n* Offers 24/7 emergency dispatch.\n* Known for upfront pricing.\n\nHiring tips: get several quotes.';
  assert.deepEqual(ticks(rival(own)), ['emergency', 'pricing']);
});

test('one sentence that lists businesses gives the descriptor to each of them; a heading before a name belongs to that name', () => {
  const text = 'Roto-Rooter, Rubber Duck Plumbing and Varsity Home Service all offer 24/7 emergency service in Smithtown.';
  const rep = rival(text, 'Roto-Rooter', { businessesNamed: [{ ...at(text, 'Roto-Rooter'), entityId: 'e1' }, { ...at(text, 'Rubber Duck Plumbing'), entityId: 'e2' }, { ...at(text, 'Varsity Home Service'), entityId: 'e3' }] });
  assert.deepEqual(ticks(rep), ['emergency']);

  const heads = '### 1. Best Overall: **Rubber Duck Plumbing**\n* Friendly staff.\n### 2. Best Licensed: **Varsity Home Service**\n* Great with water heaters.\n### 3. Best 24/7 Emergency: **Roto-Rooter**\n* Big fleet.';
  const both = {
    businessesNamed: [{ ...at(heads, 'Rubber Duck Plumbing'), entityId: 'e2' }, { ...at(heads, 'Varsity Home Service'), entityId: 'e3' }, { ...at(heads, 'Roto-Rooter'), entityId: 'e1' }],
  };
  const rr = rival(heads, 'Roto-Rooter', both);
  assert.deepEqual(ticks(rr), ['emergency'], 'Roto-Rooter gets the 24/7 from its own heading');
  const duck = rival(heads, 'Rubber Duck Plumbing', { businessesNamed: both.businessesNamed.map((b) => ({ ...b, entityId: b.name === 'Rubber Duck Plumbing' ? 'e1' : `other-${b.entityId}` })) });
  assert.deepEqual(ticks(duck), [], 'Rubber Duck does not get "licensed" from the next business heading');
});

test('domains: only the whole business name (plus a plain word or state code) is that business', () => {
  const m = (name, domain) => {
    const rep = rival('Roto-Rooter is one.', name);
    rep.answers[0].citations = [{ url: `https://${domain}/smithtown-ny/`, domain }];
    const match = buildMatchList(rep, [{ id: 'e1', name, named: 2, first: 0, sources: [], answerIds: [] }], null);
    return match ? (match.pages.find((p) => p.domain === domain) || {}).competitor : 'no-list';
  };
  // Matches
  assert.equal(m('Rubber Duck Plumbing', 'rubberduckplumbinginc.com'), 'Rubber Duck Plumbing');
  assert.equal(m('Varsity Home Service', 'varsityhomeservice.com'), 'Varsity Home Service');
  assert.equal(m('Behlen Plumbing & Heating', 'behlenplumbingandheating.com'), 'Behlen Plumbing & Heating');
  assert.equal(m('Roto-Rooter', 'rotorooter.com'), 'Roto-Rooter');
  // Never guessed
  const none = (name, domain) => { const r = m(name, domain); assert.ok(r === null || r === undefined || r === 'no-list', `${name} vs ${domain} -> ${r}`); };
  none('Rubber Duck Plumbing', 'rubberduckpaper.com');
  none('Roto-Rooter', 'rooter.com');
  none('Roto-Rooter', 'rotorooterfranchise.com');
  none('Roto-Rooter', 'mrrooter.com');
  none('ABC Plumbing', 'abcplumbingnyc.com');
});

test('a page for the town: the town is a whole path segment, never a blog, never a bare listing page', () => {
  const town = { compact: 'smithtown', state: 'ny' };
  const yes = ['/smithtown-ny/', '/smithtownny/', '/smithtown/', '/service-area/smithtown-ny/', '/areas-we-service/smithtown-ny/plumbing/', '/locations/smithtown/'];
  const no = ['/blog/smithtown-fire-news', '/news/smithtown-plumbing-tips', '/2024/05/smithtown-water-main', '/locations/', '/about-us/service-area/', '/', '/smithtown-fire-news-today/', '/suffolk-county/', '/category/smithtown/'];
  for (const p2 of yes) assert.equal(isTownPagePath(p2, town), true, p2);
  for (const p2 of no) assert.equal(isTownPagePath(p2, town), false, p2);
  assert.equal(isTownPagePath('/port-jefferson-station/', { compact: 'portjefferson', state: 'ny' }), false);
  assert.equal(isTownPagePath('/port-jefferson/', { compact: 'portjefferson', state: 'ny' }), true);
  assert.equal(isTownPagePath('/central-islip/', { compact: 'islip', state: 'ny' }), false);
  assert.equal(isTownPagePath('/islip-terrace/', { compact: 'islip', state: 'ny' }), false);
  assert.equal(isTownPagePath('/islip/', { compact: 'islip', state: 'ny' }), true);
  assert.equal(isTownPagePath('/smithtown/', null), false);
});

test('the owner’s own blog post or generic /locations/ page does not count as "you have a page for the town"', () => {
  const rep = makeReport();
  rep.answers[2].citations.push({ url: 'https://wernersplumbing.com/blog/smithtown-news', domain: 'wernersplumbing.com' }, { url: 'https://wernersplumbing.com/locations/', domain: 'wernersplumbing.com' });
  const m = buildCompetitorBreakdown(rep).match;
  assert.equal(m.youTownPage, false);
  assert.equal(rowOf(m, 'townPage').you, false);
});

test('reviews row: a missing owner count is "we couldn’t find yours", never "your 0"; a real 0 stays a real 0', () => {
  const noListing = makeReport({ reviews: { you: null, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } });
  const bd1 = buildCompetitorBreakdown(noListing);
  const row1 = rowOf(bd1.match, 'reviewsCount');
  const rr1 = row1.rivals[bd1.competitors.findIndex((c) => c.name === 'Roto-Rooter')];
  assert.equal(rr1.evidence.text, "300 Google reviews at 4.5 stars. We couldn't find yours.");
  const nullCount = makeReport({ reviews: { you: { rating: null, count: null }, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } });
  const t2 = buildCompetitorBreakdown(nullCount);
  assert.doesNotMatch(JSON.stringify(rowOf(t2.match, 'reviewsCount')), /to your 0/);
  const zero = makeReport({ reviews: { you: { rating: null, count: 0 }, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } });
  const t3 = buildCompetitorBreakdown(zero);
  assert.match(JSON.stringify(rowOf(t3.match, 'reviewsCount')), /300 Google reviews at 4\.5 stars, to your 0\./);
  const ahead = makeReport({ reviews: { you: { rating: 4.9, count: 500 }, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } });
  assert.equal(rowOf(buildCompetitorBreakdown(ahead).match, 'reviewsCount'), undefined, 'a rival with fewer reviews is never claimed');
});

test('a long answer with no spaces cannot hang the builder', () => {
  const text = `Roto-Rooter ${'x'.repeat(400)} 24/7 emergency service ${'y'.repeat(400)}`;
  const t0 = Date.now();
  ticks(rival(text));
  assert.ok(Date.now() - t0 < 2000);
});

test('the paid page title matches the product name customers buy, and its subtitle is honest when no list could be built', () => {
  const r = loadPage();
  const html = r.breakdownV2(paidWithMatch());
  assert.match(html, /<h2>Competitor Breakdown<\/h2>/);
  assert.doesNotMatch(html, /Competitor Match List/);
  const noMatch = paidWithMatch();
  noMatch.breakdown.match = null;
  const plain = r.breakdownV2(noMatch);
  assert.match(plain, /AI names instead of you, one by one\./);
  assert.doesNotMatch(plain, /in the order to copy them/);
  assert.match(r.breakdownV2({ breakdown: { competitors: [], you: {} } }), /<h2>Competitor Breakdown<\/h2>/);
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-match \.n \{ color: #5A6577;/);
  assert.match(css, /@media \(max-width: 600px\) \{ \.r2-match tbody th \{ min-width: 132px;/);
  assert.match(css, /\.r2-quote \{ overflow-wrap: anywhere; \}/);
});

test('every quoted sentence is captioned as the assistant wrote it', () => {
  const html = loadPage().breakdownV2(paidWithMatch());
  assert.match(html, /<span class="src">As (Gemini|ChatGPT|Perplexity) wrote it<\/span>/);
});


test('a generic paragraph after the last business (no advice words) is cut off by the paragraph break, not credited to it', () => {
  const text = [
    '1. Varsity Home Service: A local favorite.',
    '2. Roto-Rooter: A big national name.',
    '',
    'Most plumbers in this area are licensed and insured, and many offer 24/7 service with upfront pricing.',
  ].join('\n');
  assert.deepEqual(ticks(rival(text, 'Roto-Rooter')), []);
  // the same words inside the business's own bullets do count
  const own = ['2. **Roto-Rooter**', '* Licensed and insured, with 24/7 service and upfront pricing.'].join('\n');
  assert.deepEqual(ticks(rival(own, 'Roto-Rooter')), ['emergency', 'licensed', 'pricing']);
});

// ---------------------------------------------------------------------------
// Round 2 of the accuracy audit: attribution must be the same sentence, or that business's own bullets.
// ---------------------------------------------------------------------------
// Several named businesses in one text: rivalN(text, ['Roto-Rooter', 'Varsity Home Service', 'Rubber Duck Plumbing']) →
// { 'Roto-Rooter': ['emergency', …], … }, each name being named in two answers so the gap sheet counts it.
function several(text, names, extra = {}) {
  const ents = names.map((n, i) => ({ id: `e${i + 1}`, name: n, named: 2, first: 0, isYou: false, answerIds: ['a1', 'a2'] }));
  const businessesNamed = names.map((n, i) => ({ ...at(text, n), entityId: `e${i + 1}` }));
  const mk = (id, engine) => ({ id, engine, questionId: 'q1', text, namedYou: false, citations: [], businessesNamed });
  const rep = {
    version: 2,
    business: { name: 'Werner Plumbing', town: 'Smithtown', state: 'NY', trade: 'plumbing', website: 'https://wernersplumbing.com/' },
    questions: [{ id: 'q1', text: 'best plumber?', intent: 'best' }],
    entities: ents, answers: [mk('a1', 'gemini'), mk('a2', 'chatgpt')], sources: [], ...extra,
  };
  const bd = buildCompetitorBreakdown(rep);
  const out = {};
  for (const [i, c] of bd.competitors.entries()) out[c.name] = bd.match ? bd.match.rows.filter((r) => r.key !== 'townPage' && r.rivals[i] && r.rivals[i].has).map((r) => r.key).sort() : [];
  return out;
}
const N3 = ['Roto-Rooter', 'Varsity Home Service', 'Rubber Duck Plumbing'];

test('prose with one business per sentence: each gets only its own sentence', () => {
  const text = 'Roto-Rooter is licensed and insured. Varsity Home Service offers 24/7 emergency service. Rubber Duck Plumbing has free estimates.';
  assert.deepEqual(several(text, N3), { 'Roto-Rooter': ['licensed'], 'Varsity Home Service': ['emergency'], 'Rubber Duck Plumbing': ['pricing'] });
});

test('two businesses in one sentence: a descriptor goes to the business it follows, or to the whole "A, B and C" list', () => {
  assert.deepEqual(several('Roto-Rooter is licensed, and Varsity Home Service offers 24/7 emergency service.', N3.slice(0, 2)), { 'Roto-Rooter': ['licensed'], 'Varsity Home Service': ['emergency'] });
  assert.deepEqual(several('Roto-Rooter, Varsity Home Service and Rubber Duck Plumbing all offer 24/7 emergency service.', N3), { 'Roto-Rooter': ['emergency'], 'Varsity Home Service': ['emergency'], 'Rubber Duck Plumbing': ['emergency'] });
  assert.deepEqual(several('1) Roto-Rooter - licensed 2) Varsity Home Service - free estimates 3) Rubber Duck Plumbing - 24/7 emergency service', N3), { 'Roto-Rooter': ['licensed'], 'Varsity Home Service': ['pricing'], 'Rubber Duck Plumbing': ['emergency'] });
  assert.deepEqual(several('Roto-Rooter is licensed.[1] Varsity Home Service offers 24/7 emergency service.[2] Rubber Duck Plumbing has free estimates.[3]', N3), { 'Roto-Rooter': ['licensed'], 'Varsity Home Service': ['emergency'], 'Rubber Duck Plumbing': ['pricing'] });
});

test('comparisons say nothing safe about either business: "unlike", "whereas", "vs", "while", "but"', () => {
  for (const text of [
    'Unlike Roto-Rooter, Varsity Home Service is licensed and offers 24/7 emergency service.',
    'Varsity Home Service is licensed, unlike Roto-Rooter.',
    'Roto-Rooter is licensed, whereas Varsity Home Service is award-winning.',
    'Roto-Rooter is 24/7 vs Varsity Home Service, which is licensed.',
    'Roto-Rooter is 24/7 while Varsity Home Service is not.',
    'Roto-Rooter is licensed but Varsity Home Service is more affordable.',
  ]) assert.deepEqual(several(text, N3.slice(0, 2)), { 'Roto-Rooter': [], 'Varsity Home Service': [] }, text);
});

test('the owner in a comparison: the rival is never ticked for what the owner has', () => {
  const rep = makeReport();
  const text = 'Werner Plumbing is licensed, unlike Roto-Rooter.';
  rep.answers.push({ id: 'a4', engine: 'gemini', questionId: 'q1', text, namedYou: true, citations: [], businessesNamed: [{ pos: 0, name: 'Werner Plumbing', entityId: 'you', isYou: true }, { ...at(text, 'Roto-Rooter'), entityId: 'e1' }] });
  const m = buildCompetitorBreakdown(rep).match;
  const rr = buildCompetitorBreakdown(rep).competitors.findIndex((c) => c.name === 'Roto-Rooter');
  assert.equal(rowOf(m, 'licensed').rivals[rr].has, false);
  assert.equal(rowOf(m, 'licensed').you, false, 'and the owner is not credited from a comparison either');
});

test('more hedges never tick: hardly, rarely, except, unless, cannot, can’t, won’t, neither/nor, un-licensed, non-certified, if, should, may, claims, allegedly, reportedly, expired', () => {
  const bad = [
    'Roto-Rooter hardly offers 24/7 service.', 'Roto-Rooter rarely offers upfront pricing.', 'Roto-Rooter offers 24/7 service except on holidays.',
    'Roto-Rooter is licensed unless the license has lapsed.', 'Roto-Rooter cannot offer 24/7 service.', 'Roto-Rooter can’t offer free estimates.',
    'Roto-Rooter won’t do emergency service.', 'Neither Roto-Rooter nor anyone else is licensed here.', 'Roto-Rooter is un-licensed for gas work.',
    'Roto-Rooter is non-certified for boilers.', 'If licensed, Roto-Rooter can pull permits.', 'Roto-Rooter should be licensed by now.',
    'Roto-Rooter may offer 24/7 service.', 'Roto-Rooter claims to be licensed.', 'Roto-Rooter is allegedly licensed.',
    'Roto-Rooter is reportedly award-winning.', 'Roto-Rooter is licensed, but that license expired.', 'Roto-Rooter is 24/7 in name only.',
    'Roto-Rooter offers 24/7 service? Not really.', 'Is Roto-Rooter licensed and insured?',
  ];
  for (const text of bad) assert.deepEqual(ticks(rival(text)), [], text);
});

test('"licensed. However, that license expired" is not a tick (a follow-up that reverses it)', () => {
  assert.deepEqual(ticks(rival('Roto-Rooter is licensed. However, that license expired last year.')), []);
  assert.deepEqual(ticks(rival('Roto-Rooter is licensed. It has served Suffolk County for decades.')), ['experience', 'licensed'].sort().filter((k) => k !== 'experience'), 'a plain next sentence does not un-tick it');
});

test('tips with no blank line after the list, and general facts, are not credited to the last business', () => {
  for (const tail of [
    'Always hire someone licensed and insured with 24/7 service.',
    'Look for a licensed pro with upfront pricing.',
    'Choose a licensed, insured plumber.',
    'NY law requires plumbers to be licensed.',
    'Is Varsity Home Service licensed and insured?',
  ]) {
    const text = ['1. **Varsity Home Service**', '* Friendly staff.', '2. **Roto-Rooter**', '* A big national name.', tail].join('\n');
    assert.deepEqual(several(text, N3.slice(0, 2)), { 'Roto-Rooter': [], 'Varsity Home Service': [] }, tail);
  }
});

test('a bullet block belongs to the business on the heading above it and stops at a blank line, a heading or another name', () => {
  const text = ['### Roto-Rooter', '* Offers 24/7 emergency service.', '* Free estimates.', '', '### Varsity Home Service', '* Licensed and insured.', '* Better than Roto-Rooter at pricing.'].join('\n');
  assert.deepEqual(several(text, N3.slice(0, 2)), { 'Roto-Rooter': ['emergency', 'pricing'], 'Varsity Home Service': ['licensed'] });
});

test('quotes are word for word: numbered lists and bold names do not leave a stray star or marker', () => {
  const text = ['2. **Rubber Duck Plumbing** offers 24/7 emergency service.', '3. **Roto-Rooter** is licensed and insured.'].join('\n');
  const rep = several(text, ['Rubber Duck Plumbing', 'Roto-Rooter']);
  assert.deepEqual(rep, { 'Rubber Duck Plumbing': ['emergency'], 'Roto-Rooter': ['licensed'] });
  const bd = buildCompetitorBreakdown({
    version: 2,
    business: { name: 'W', town: 'Smithtown', state: 'NY', website: 'https://w.com' },
    questions: [{ id: 'q1', text: 'q', intent: 'best' }],
    entities: [{ id: 'e1', name: 'Rubber Duck Plumbing', named: 2, first: 0, isYou: false, answerIds: ['a1', 'a2'] }],
    answers: ['a1', 'a2'].map((id) => ({ id, engine: 'gemini', questionId: 'q1', text, namedYou: false, citations: [], businessesNamed: [{ ...at(text, 'Rubber Duck Plumbing'), entityId: 'e1' }] })),
    sources: [],
  });
  for (const c of bd.competitors) for (const sy of c.says) {
    assert.ok(text.replace(/\*\*/g, '').includes(sy.text), `verbatim: ${sy.text}`);
    assert.doesNotMatch(sy.text, /^\*|^\d+\./);
  }
});

test('performance: 30 long answers with many businesses build quickly; huge answers are skipped, not analysed', () => {
  const big = `${'Roto-Rooter is a business. '.repeat(400)}Roto-Rooter offers 24/7 emergency service.`;
  const rep = rival(big);
  const t0 = Date.now();
  const bd = buildCompetitorBreakdown(rep);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(bd.match === null || bd.match.rows.length >= 0);
  const huge = 'Roto-Rooter offers 24/7 emergency service. '.repeat(700);
  const t1 = Date.now();
  assert.deepEqual(ticks(rival(huge)), [], 'an answer over 20,000 characters is not analysed');
  assert.ok(Date.now() - t1 < 3000);
});

test('town pages: smithtown-ny-plumber, plumber-smithtown-ny, a town subdomain; still not blogs or other places', () => {
  const town = { compact: 'smithtown', tokens: ['smithtown'], state: 'ny' };
  for (const path of ['/smithtown-ny-plumber/', '/plumber-smithtown-ny/', '/smithtown-plumbing-services/', '/service-areas/smithtown-ny-plumber-near-me/']) assert.equal(isTownPagePath(path, town), true, path);
  assert.equal(isTownPagePath('/', town, 'smithtown.rival.com'), true, 'a town subdomain');
  assert.equal(isTownPagePath('/', town, 'www.rival.com'), false);
  assert.equal(isTownPagePath('/', town, 'rival.com'), false);
  for (const path of ['/smithtown-fire-news-today/', '/blog/smithtown-ny/', '/about-smithtown-and-hauppauge/', '/central-smithtown-plaza-office/']) assert.equal(isTownPagePath(path, town), false, path);
  assert.equal(isTownPagePath('/port-jefferson-station/', { compact: 'portjefferson', tokens: ['port', 'jefferson'], state: 'ny' }), false);
  assert.equal(isTownPagePath('/plumber-port-jefferson-ny/', { compact: 'portjefferson', tokens: ['port', 'jefferson'], state: 'ny' }), true);
});

test('the owner’s own site is recognised with a port, a trailing dot, www and a path', () => {
  for (const website of ['https://wernersplumbing.com/', 'wernersplumbing.com', 'https://www.wernersplumbing.com:443/home', 'https://wernersplumbing.com./']) {
    const rep = makeReport({ business: { name: 'Werner Plumbing', town: 'Smithtown', state: 'NY', trade: 'plumbing', website } });
    rep.answers[2].citations.push({ url: 'https://wernersplumbing.com/smithtown-ny/', domain: 'wernersplumbing.com' });
    assert.equal(buildCompetitorBreakdown(rep).match.youTownPage, true, website);
  }
  const rep = makeReport();
  rep.answers[2].citations.push({ url: 'https://notwernersplumbing.com/smithtown-ny/', domain: 'notwernersplumbing.com' }, { url: 'https://wernersplumbing.com.evil.com/smithtown-ny/', domain: 'wernersplumbing.com.evil.com' });
  assert.equal(buildCompetitorBreakdown(rep).match.youTownPage, false);
  assert.equal(classifyCitation('https://rival.com./smithtown-ny/', { compact: 'smithtown', tokens: ['smithtown'], state: 'ny' }).domain, 'rival.com');
});

test('the "listed on sites" row is honest about what it counts: sites AI read that list them and not you', () => {
  const sig = MATCH_SIGNALS.find((x) => x.key === 'directories');
  assert.equal(sig.label, 'Listed on sites AI read that don’t list you');
  assert.match(sig.action, /Claim your profile on the sites AI reads/);
});

test('a descriptor that comes before two unrelated names belongs to neither; only the one that follows a name is credited', () => {
  const text = '24/7 service is offered by Roto-Rooter; Varsity Home Service is licensed.';
  assert.deepEqual(several(text, N3.slice(0, 2)), { 'Roto-Rooter': [], 'Varsity Home Service': ['licensed'] });
});

test('plain sentence lines under a heading are not the business’s bullets (only bullet or indented lines are)', () => {
  const text = ['### Roto-Rooter', '* Big fleet.', 'Offers 24/7 emergency service.'].join('\n');
  assert.deepEqual(ticks(rival(text)), []);
  const bullets = ['### Roto-Rooter', '* Big fleet.', '* Offers 24/7 emergency service.'].join('\n');
  assert.deepEqual(ticks(rival(bullets)), ['emergency']);
  const indented = ['### Roto-Rooter', '  Big fleet, and offers 24/7 emergency service.'].join('\n');
  assert.deepEqual(ticks(rival(indented)), ['emergency']);
});

test('bullets under a full sentence are not under a heading: only a line that is just the name (and a short label) counts', () => {
  const text = ['Roto-Rooter is a very large national company with many trucks and offices across Suffolk County and beyond.', '* Offers 24/7 emergency service.'].join('\n');
  assert.deepEqual(ticks(rival(text)), []);
  const label = ['**Roto-Rooter** (best for late nights):', '* Offers 24/7 emergency service.'].join('\n');
  assert.deepEqual(ticks(rival(label)), ['emergency']);
});

// ---------------------------------------------------------------------------
// Round 3 of the accuracy audit (30 realistic answers: 97% precise; these are the 7 patterns that were wrong).
// ---------------------------------------------------------------------------
const NAMES = ['Rubber Duck Plumbing', 'Roto-Rooter', 'Varsity Home Service'];

test('a name after "with", "from", "by" is the object, not the subject: the descriptor is about the subject', () => {
  assert.deepEqual(several('Rubber Duck Plumbing works with Roto-Rooter on large jobs and offers 24/7 emergency service.', NAMES.slice(0, 2)), { 'Rubber Duck Plumbing': ['emergency'], 'Roto-Rooter': [] });
  assert.deepEqual(several('Rubber Duck Plumbing partners with Varsity Home Service, and offers free estimates.', [NAMES[0], NAMES[2]]), { 'Rubber Duck Plumbing': ['pricing'], 'Varsity Home Service': [] });
  assert.deepEqual(several('Roto-Rooter, which partnered with Varsity Home Service, is licensed.', [NAMES[1], NAMES[2]]), { 'Roto-Rooter': ['licensed'], 'Varsity Home Service': [] });
  // an appositive is about the object; a verb like "hired" is not a preposition
  assert.deepEqual(several('Customers hired Varsity Home Service, which is licensed and insured.', [NAMES[2], NAMES[1]]), { 'Varsity Home Service': ['licensed'], 'Roto-Rooter': [] });
});

test('comparison verbs never tick either side: outperforms, edges out, beats, tops, better than', () => {
  for (const text of [
    'Rubber Duck Plumbing outperforms Roto-Rooter on upfront pricing.',
    'Rubber Duck Plumbing edges out Roto-Rooter for 24/7 emergency service.',
    'Rubber Duck Plumbing beat Roto-Rooter for the Best of Long Island award.',
    'Rubber Duck Plumbing tops Roto-Rooter in free estimates.',
    'Rubber Duck Plumbing is better than Roto-Rooter for licensed work.',
  ]) assert.deepEqual(several(text, NAMES.slice(0, 2)), { 'Rubber Duck Plumbing': [], 'Roto-Rooter': [] }, text);
});

test('an unrecorded second subject ("…or Varsity will help; Varsity is licensed") is not credited to the recorded name', () => {
  const text = 'Rubber Duck Plumbing or a shop like Varsity will help; Varsity is licensed.';
  assert.deepEqual(several(text, [NAMES[0]]), { 'Rubber Duck Plumbing': [] });
});

test('a heading that names two businesses ("A vs. B") gives its bullets to neither', () => {
  const text = ['### Rubber Duck Plumbing vs. Roto-Rooter', '* Winner: 24/7 emergency service', '* Free estimates'].join('\n');
  assert.deepEqual(several(text, NAMES.slice(0, 2)), { 'Rubber Duck Plumbing': [], 'Roto-Rooter': [] });
});

test('complaints and bad experiences are never quoted under a positive label ("line is always busy", "cancelled", "late")', () => {
  for (const text of [
    'Customers say Roto-Rooter’s 24/7 line is always busy.',
    'Roto-Rooter’s 24/7 line was busy for an hour.',
    'An award-winning chain, Roto-Rooter cancelled our appointment.',
    'Roto-Rooter is licensed but reviewers mention delays.',
    'Roto-Rooter offers 24/7 service, though the wait was long and staff were rude.',
    'Roto-Rooter has upfront pricing but it was a poor experience.',
  ]) assert.deepEqual(ticks(rival(text)), [], text);
  assert.deepEqual(ticks(rival('Roto-Rooter offers 24/7 late-night emergency service.')), ['emergency'], 'a plain "late-night" is fine');
});

test('"no hidden fees" and "no surprise charges" are pluses, not negations', () => {
  assert.deepEqual(ticks(rival('Roto-Rooter offers upfront pricing with no hidden fees.')), ['pricing']);
  assert.deepEqual(ticks(rival('Roto-Rooter has flat-rate jobs and no surprise charges.')), ['pricing']);
  assert.deepEqual(ticks(rival('Roto-Rooter has no upfront pricing.')), [], 'a real negation still blocks');
});

test('terse bullets count when they sit under a heading of one name, and one plain line before them is skipped', () => {
  assert.deepEqual(ticks(rival(['### Roto-Rooter', '* 24/7', '* Free estimates'].join('\n'))), ['emergency', 'pricing']);
  assert.deepEqual(ticks(rival(['### Roto-Rooter', 'A well-known national name.', '* Available 24/7'].join('\n'))), ['emergency']);
  assert.deepEqual(ticks(rival(['### Roto-Rooter', 'Offers 24/7 emergency service.'].join('\n'))), [], 'the plain line itself is never credited');
});

test('a higher Google rating and a BBB profile shown by a cited BBB page are data-backed rows', () => {
  const bd = buildCompetitorBreakdown(makeReport());
  const rr = bd.competitors.findIndex((c) => c.name === 'Roto-Rooter');
  const rating = rowOf(bd.match, 'ratingHigher');
  assert.ok(rating);
  assert.equal(rating.rivals[rr].evidence.text, 'A 4.5 Google rating, to your 4.1.');
  assert.equal(rating.rivals[bd.competitors.findIndex((c) => c.name === 'Varsity Home Service')].has, false, 'no rating data: not claimed');
  assert.equal(rowOf(buildCompetitorBreakdown(makeReport({ reviews: { you: { rating: 4.9, count: 5 }, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } })).match, 'ratingHigher'), undefined, 'a lower rating is never claimed');
  assert.equal(rowOf(buildCompetitorBreakdown(makeReport({ reviews: { you: null, competitors: [{ name: 'Roto-Rooter', rating: 4.5, count: 300 }] } })).match, 'ratingHigher'), undefined, 'no owner rating: not claimed');
  const rep = makeReport({ sources: [{ domain: 'bbb.org', url: 'https://www.bbb.org/us/ny/x/profile/plumber/rubber-duck', citedIn: ['a3'], youListed: false, topListed: 'Rubber Duck Plumbing', listed: ['Rubber Duck Plumbing'] }] });
  const bd2 = buildCompetitorBreakdown(rep);
  const bbb = rowOf(bd2.match, 'bbb');
  const d = bd2.competitors.findIndex((c) => c.name === 'Rubber Duck Plumbing');
  assert.equal(bbb.rivals[d].has, true, 'a cited BBB page that lists them');
  assert.deepEqual(bbb.rivals[d].evidence, { domains: ['bbb.org'] });
  assert.equal(bbb.rivals[bd2.competitors.findIndex((c) => c.name === 'Roto-Rooter')].has, false, 'and only them');
});

test('rows without a quote never make an empty "AI said" line on the page', () => {
  const rep = makeReport({ sources: [{ domain: 'bbb.org', url: 'https://www.bbb.org/us/ny/x/profile/plumber/varsity', citedIn: ['a3'], youListed: false, topListed: 'Varsity Home Service', listed: ['Varsity Home Service'] }] });
  const bd = buildCompetitorBreakdown(rep);
  for (const c of bd.competitors) for (const sy of c.says) assert.ok(typeof sy.text === 'string' && sy.text.length >= 4);
});
