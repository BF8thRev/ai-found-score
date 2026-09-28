// The report page's "Who got the call instead", "Websites AI trusted" (Why they got named instead),
// "Can AI read your website?" meter and the phone bottom bar (public/js/report.js), rendered from a
// locked report exactly as GET /api/report sends it, and nothing withheld shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { reportBody } from '../lock.js';
import { register } from 'node:module';

// src/worker.js imports 'cloudflare:workers' (Workflows), which Node doesn't have: give it an empty class.
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

function load({ tier = true } = {}) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => tier, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' },
    URLSearchParams,
    console,
  });
  vm.runInContext(src, ctx);
  return ctx;
}
const locked = () => reportBody(MOCK_REPORTS['sample-001'], false);
const render = (ctx, report) => {
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  ctx.renderV2(root, report);
  return root.innerHTML;
};

test('who got the call instead: renamed, owner row present, one-off businesses counted not charted', () => {
  const r = load();
  const html = render(r, locked());
  assert.match(html, /<h2>Who got the call instead<\/h2>/);
  assert.doesNotMatch(html, /Who AI names for/);
  assert.match(html, /r2-row you/);
});

test('who got the call instead: owner named 0 times gets the empty hatched row', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) { a.namedYou = false; a.namedYouFirst = false; a.businessesNamed = (a.businessesNamed || []).filter((n) => !n.entityId || n.entityId !== 'you'); }
  for (const e of rep.entities) if (e.isYou) { e.named = 0; e.first = 0; }
  const html = render(r, rep);
  assert.match(html, /r2-row you none/);
});

test('one-off businesses are summed as "+ N other businesses named once each"', () => {
  const r = load();
  const rep = locked();
  const html = r.whoAiNamesV2({ report: rep, b: rep.business, t: r.computeTotalsV2(rep.answers), N: rep.answers.length, cw: r.countWords(rep), proven: r.provenEntities(rep).slice(0, 1) });
  const others = rep.entities.filter((e) => !e.isYou).length - 1;
  assert.ok(others > 0);
  assert.ok(html.includes(`+ ${others} other ${others === 1 ? 'business' : 'businesses'} named once each`), html);
});

test('websites AI trusted: locked report lists the cited domains it has, never the withheld source list', () => {
  const r = load();
  const rep = locked();
  const html = render(r, rep);
  const domains = rep.answers.flatMap((a) => (a.citations || []).map((c) => c.domain));
  assert.ok(domains.length, 'fixture has a cited domain');
  assert.match(html, /class="r2-cited"/);
  for (const d of domains.slice(0, 4)) assert.ok(html.includes(d), d);
  assert.ok(!rep.sources || rep.sources.length === 0, 'lock.js empties sources');
  assert.match(html, /🔒 In the full report/);
});

test('can AI read your website: locked shows a pass/fail meter and the count, never which checks', () => {
  const r = load();
  const rep = locked();
  const sc = rep.siteCheck;
  assert.equal(sc.locked, true);
  const html = r.siteV2(rep);
  const failed = sc.checks - sc.passed;
  assert.equal((html.match(/<i>/g) || []).length, sc.passed);
  assert.equal((html.match(/<i class="f">/g) || []).length, failed);
  assert.match(html, new RegExp(`${failed} of ${sc.checks} checks failed`));
  assert.match(html, /is in the audit/);
  assert.doesNotMatch(html, /robots|schema|sitemap|llms/i);
});

test('bottom bar: rendered with the offer band, hidden until shown, not without the offer', () => {
  const on = render(load({ tier: true }), locked());
  assert.match(on, /<div class="r2-sticky" data-sticky-cta hidden>/);
  assert.match(on, /data-scroll-offer>Show me the fixes — \$49</);
  const off = render(load({ tier: false }), locked());
  assert.doesNotMatch(off, /data-sticky-cta/);
});

test('bottom bar shows past the first screen and hides while the offer band is on screen', () => {
  const r = load();
  const bar = { hidden: true };
  const band = {};
  let cb;
  const classes = [];
  r.document.body = { classList: { toggle: (c, on) => classes.push([c, on]) } };
  r.IntersectionObserver = class { constructor(f) { cb = f; } observe() {} };
  let scroll;
  r.window.addEventListener = (ev, f) => { if (ev === 'scroll') scroll = f; };
  const root = { querySelector: (q) => (q === '[data-sticky-cta]' ? bar : q === '[data-offer-band]' ? band : null) };
  r.wireStickyCta(root);
  assert.equal(bar.hidden, true, 'top of page: hidden');
  r.window.scrollY = 900; scroll();
  assert.equal(bar.hidden, false, 'past the first screen: shown');
  cb([{ isIntersecting: true }]);
  assert.equal(bar.hidden, true, 'offer band on screen: hidden');
  cb([{ isIntersecting: false }]);
  assert.equal(bar.hidden, false, 'band scrolled away: shown again');
});

test('trade names read as businesses: plumbing → plumbers', () => {
  const r = load();
  assert.equal(r.tradePlural('plumbing'), 'plumbers');
  assert.equal(r.tradePlural('bakery'), 'bakeries');
});

test('report page ships the new script and styles under fresh cache keys', () => {
  const html = readFileSync(new URL('../../../public/report.html', import.meta.url), 'utf8');
  assert.ok(Number(html.match(/report\.js\?v=(\d+)/)[1]) >= 24);
  assert.ok(Number(html.match(/report-extra\.css\?v=(\d+)/)[1]) >= 13);
});

// ---- the top of the page: result, the search card, the short version ----
const totals = (r, rep) => ({ t: r.computeTotalsV2(rep.answers), cw: r.countWords(rep), proven: r.provenEntities(rep) });

test('result panel: one box per answer, plain sentence, red when nobody named the owner', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) { a.namedYou = false; a.namedYouFirst = false; }
  const { t, cw, proven } = totals(r, rep);
  const html = r.verdictV2(rep, { t, N: t.answers, cw, proven, zero: true, allNamed: false, b: rep.business, engineList: 'ChatGPT, Gemini and Perplexity' });
  assert.match(html, /class="r2-verdict zero"/);
  assert.equal((html.match(/<i class="no"/g) || []).length, rep.answers.length);
  assert.equal((html.match(/<i class="yes"/g) || []).length, 0);
  assert.match(html, /It never mentioned you\./);
  assert.match(html, /We asked ChatGPT, Gemini and Perplexity for /);
  assert.match(html, /✓ it mentioned you/);
  assert.doesNotMatch(html.slice(0, html.indexOf('r2-score')), /searches|named/i);
});

test('result panel: mixed results get a ✓ box per answer that named the owner', () => {
  const r = load();
  const rep = locked();
  rep.answers.forEach((a, i) => { a.namedYou = i < 2; });
  const { t, cw, proven } = totals(r, rep);
  const html = r.verdictV2(rep, { t, N: t.answers, cw, proven, zero: false, allNamed: false, b: rep.business, engineList: 'Gemini' });
  assert.match(html, /class="r2-verdict some"/);
  assert.equal((html.match(/<i class="yes"/g) || []).length, 2);
});

test('search card: names in the order AI gave them, owner row last as Not mentioned', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = false;
  h.businessesNamed = [{ pos: 300, name: 'Third Co', entityId: 'e3' }, { pos: 10, name: 'First Co', entityId: 'e1' }, { pos: 100, name: 'Second Co', entityId: 'e2' }];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: true, b: rep.business });
  assert.ok(html.indexOf('First Co') < html.indexOf('Second Co') && html.indexOf('Second Co') < html.indexOf('Third Co'), 'ordered by position');
  assert.match(html, /class="not"[^>]*>.*Not mentioned/s);
  assert.match(html, /told a customer who asked/);
});

test('search card: when the owner was named it shows them highlighted and no Not mentioned row', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = true; h.namedYouFirst = false;
  h.businessesNamed = [{ pos: 10, name: 'First Co', entityId: 'e1' }, { pos: 20, name: rep.business.name, entityId: 'you', isYou: true }];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: false, b: rep.business });
  assert.match(html, /class="me"/);
  assert.doesNotMatch(html, /Not mentioned/);
});

test('short version: a Lost or Won line per question, in the customer’s own words', () => {
  const r = load();
  const rep = locked();
  const { t, cw, proven } = totals(r, rep);
  const intents = r.intentResultsV2(rep);
  const lostIntents = intents.filter((x) => x.lost);
  const wonIntents = intents.filter((x) => x.answers > 0 && !x.lost);
  const html = r.shortVersionV2({ t, N: t.answers, cw, intents, lostIntents, wonIntents, intentLabel: (x) => x.intent, proven, answers: rep.answers, zero: t.namedYou === 0, allNamed: false, nobodyTwice: proven.length === 0, generalAdvice: 0 });
  assert.match(html, /<ul class="r2-qlist">/);
  for (const x of intents.filter((y) => y.answers > 0)) assert.ok(html.includes(x.q.text.replace(/'/g, '&#39;')) || html.includes(x.q.text), x.q.text);
  assert.equal((html.match(/✕ Lost/g) || []).length, lostIntents.length);
  assert.equal((html.match(/✓ Won/g) || []).length, wonIntents.length);
  assert.doesNotMatch(html, /r2-tile/);
});

test('result panel: every answer unsure never claims "never mentioned you"', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) { a.namedYou = false; a.ownerMatch = 'unsure'; }
  const { t, cw, proven } = totals(r, rep);
  const html = r.verdictV2(rep, { t, N: t.answers, cw, proven, zero: false, allNamed: false, b: rep.business, engineList: 'Gemini' });
  assert.match(html, /couldn’t tell whether it mentioned you/);
  assert.doesNotMatch(html, /never mentioned you/);
  assert.match(html, /\? not sure/);
  const page = render(r, rep);
  assert.doesNotMatch(page, /never mentioned you/);
});

test('result panel: one answer reads "once", not "1 times"', () => {
  const r = load();
  const rep = locked();
  rep.answers = rep.answers.slice(0, 1);
  rep.answers[0].namedYou = false;
  const { t, cw, proven } = totals(r, rep);
  const html = r.verdictV2(rep, { t, N: 1, cw, proven, zero: true, allNamed: false, b: rep.business, engineList: 'Gemini' });
  assert.match(html, /We asked AI once\./);
  assert.match(html, /aria-label="1 time we asked/);
  assert.doesNotMatch(html, /1 times/);
});

test('next-step button only when the "who got the call" section exists; section has its anchor', () => {
  const r = load();
  const rep = locked();
  const { t, cw, proven } = totals(r, rep);
  const args = { t, N: t.answers, cw, proven, zero: true, allNamed: false, b: rep.business, engineList: 'Gemini' };
  assert.match(r.verdictV2(rep, { ...args, hasWho: true }), /href="#who"/);
  assert.doesNotMatch(r.verdictV2(rep, { ...args, hasWho: false }), /href="#who"/);
  assert.match(render(r, locked()), /<section class="report-section" id="who">/);
});

test('top band: business, details and the score together; no score → single column', () => {
  const r = load();
  const rep = locked();
  const withScore = r.headerV2(rep, rep.business, r.scoreV2(rep));
  assert.match(withScore, /class="report-header r2-band"/);
  assert.match(withScore, /<h1>[^<]+<\/h1>/);
  assert.match(withScore, /r2-score-pill (weak|mixed|strong)/);
  assert.doesNotMatch(withScore, /noscore/);
  const bare = r.headerV2(rep, rep.business, '');
  assert.match(bare, /r2-band-grid noscore/);
  assert.doesNotMatch(bare, /r2-score/);
  // whole page: exactly one score card, inside the band, above the result panel
  const html = render(r, rep);
  assert.equal((html.match(/class="r2-score"/g) || []).length, 1);
  assert.ok(html.indexOf('r2-score-ring') < html.indexOf('r2-verdict-line'));
});

test('score pill words are plain', () => {
  const r = load();
  const rep = locked();
  for (const [score, word] of [[0, 'Low'], [55, 'Fair'], [90, 'Strong']]) {
    const x = { ...rep, score: { ...rep.score, score } };
    assert.match(r.scoreV2(x), new RegExp(`r2-score-pill (weak|mixed|strong)">${word}<`));
  }
});

test('search card: owner counted as named but missing from the list is not shown as Not mentioned', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = true; h.businessesNamed = [];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: false, b: rep.business });
  assert.doesNotMatch(html, /Not mentioned|didn’t recommend any business/);
});

test('search card: an unsure headline shows "We couldn’t tell", not "Not mentioned"', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = false; h.ownerMatch = 'unsure';
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: false, b: rep.business });
  assert.match(html, /We couldn’t tell/);
  assert.doesNotMatch(html, /Not mentioned/);
});

test('top of page: business names with markup are escaped', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.businessesNamed = [{ pos: 1, name: '<img src=x onerror=alert(1)>', entityId: 'e1' }];
  const html = render(r, rep);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('top band shows the business, the check date and the score: no trade line, address or phone', () => {
  const r = load();
  const rep = locked();
  const band = r.headerV2(rep, rep.business, r.scoreV2(rep));
  assert.ok(band.includes(rep.business.name.replace(/&/g, '&amp;')));
  assert.match(band, /Checked /);
  assert.doesNotMatch(band, /biz-meta/);
  assert.ok(!rep.business.phone || !band.includes(rep.business.phone), 'phone not in the band');
  assert.ok(!band.includes(rep.business.address || ' '), 'address not in the band');
  assert.ok(!band.includes(String(rep.business.trade || ' ') + ' ·'));
});

test('short version: the Lost note shows only when a question was lost', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) a.namedYou = true;
  const { t, cw, proven } = totals(r, rep);
  const intents = r.intentResultsV2(rep);
  const won = r.shortVersionV2({ t, N: t.answers, cw, intents, lostIntents: [], wonIntents: intents, intentLabel: (x) => x.intent, proven, answers: rep.answers, zero: false, allNamed: true, nobodyTwice: false, generalAdvice: 0 });
  assert.doesNotMatch(won, /Lost:/);
  assert.match(won, /✓ Won/);
  for (const a of rep.answers) a.namedYou = false;
  const t2 = r.computeTotalsV2(rep.answers);
  const lostI = r.intentResultsV2(rep);
  const lost = r.shortVersionV2({ t: t2, N: t2.answers, cw, intents: lostI, lostIntents: lostI.filter((x) => x.lost), wonIntents: [], intentLabel: (x) => x.intent, proven, answers: rep.answers, zero: true, allNamed: false, nobodyTwice: false, generalAdvice: 0 });
  assert.match(lost, /Lost: AI mentioned you in half/);
});

test('result panel: some answers unsure and none mentioned says how many we could not tell', () => {
  const r = load();
  const rep = locked();
  rep.answers.forEach((a, i) => { a.namedYou = false; if (i === 0) a.ownerMatch = 'unsure'; });
  const { t, cw, proven } = totals(r, rep);
  const html = r.verdictV2(rep, { t, N: t.answers, cw, proven, zero: true, allNamed: false, b: rep.business, engineList: 'Gemini' });
  assert.ok(html.includes(`didn’t mention you in ${t.answers - 1}, and we couldn’t tell in 1`), html);
  assert.doesNotMatch(html, /never mentioned you/);
});

test('search card: separate read link, no repeated "we asked" line for a single answer', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const many = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'ChatGPT, Gemini and Perplexity', proven, provenIds: new Set(), zero: true, b: rep.business });
  assert.match(many, /class="r2-hero-read"><a href="#ans-/);
  assert.match(many, /This is one of the \d+ times we asked\./);
  assert.doesNotMatch(many, /times we asked ChatGPT/);
  const one = r.heroV2(rep, { answers: [h], aById, qById, t: { ...t, answers: 1 }, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: true, b: rep.business });
  assert.doesNotMatch(one, /This is one of/);
});

test('phone layout: the band grid columns can shrink so long names wrap instead of widening the page', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.r2-band-grid[^{]*\{[^}]*grid-template-columns:\s*1fr\s*[;}]/);
  assert.match(css, /\.r2-band-grid \{ grid-template-columns: minmax\(0, 1fr\); gap: 20px; \}/);
  assert.match(css, /\.r2-verdict-main \{ min-width: 0; overflow-wrap: anywhere; \}/);
});

// ---- the report page's own header, served through the real router ----
async function servedReportPage() {
  // The Worker rewrites HTML with HTMLRewriter (a Workers global); a pass-through stand-in is enough here.
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  const env = {
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        const file = path === '/report' || path === '/report.html' ? 'report.html' : null;
        if (!file) return new Response('nf', { status: 404 });
        const body = readFileSync(new URL(`../../../public/${file}`, import.meta.url), 'utf8');
        return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },
  };
  const res = await worker.fetch(new Request('https://aifoundscore.com/report/r9aew8ndec'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  return res.text();
}

test('GET /report/<token> serves a header with one report button and no links off to the marketing pages', async () => {
  const html = await servedReportPage();
  const head = html.slice(html.indexOf('<header class="site-header">'), html.indexOf('</header>'));
  assert.match(head, /data-hdr-cta/);
  assert.match(head, /data-hdr-ctx/);
  assert.match(head, /href="\/contact">Questions\?/);
  for (const gone of ['/#how', '/#pricing', '/#faq', 'Who&rsquo;s getting my calls', 'Sample report']) assert.ok(!head.includes(gone), gone);
  assert.match(html, /<body class="report-page">/);
  assert.match(html, /report\.js\?v=\d+/);
});

test('header button by state: $49 with the offer, free report on an example, none otherwise', () => {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const mk = () => {
    const cta = { hidden: true, attrs: {}, style: {}, text: '', listeners: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(ev, f) { this.listeners[ev] = f; }, set textContent(v) { this.text = v; }, get textContent() { return this.text; } };
    const ctx = { hidden: true, kids: [], replaceChildren(...k) { this.kids = k; } };
    const doc = {
      addEventListener() {}, querySelector: (q) => (q.includes('data-hdr-cta') ? cta : q.includes('data-hdr-ctx') ? ctx : null),
      createElement: () => ({ className: '', textContent: '' }), body: { classList: { toggle() {} } },
    };
    const w = { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} };
    const c = vm.createContext({ document: doc, window: w, location: w.location, URLSearchParams, console });
    vm.runInContext(src, c);
    return { c, cta, ctx };
  };
  const rootWith = (band) => ({ querySelector: (q) => (q === '[data-offer-band]' ? band : null) });
  const real = { ...locked(), sample: false, id: 'r9aew8ndec' };

  let { c, cta } = mk();
  c.setHeaderForReport(rootWith({ scrollIntoView() {}, querySelector: () => null }), real);
  assert.equal(cta.hidden, false);
  assert.equal(cta.text, 'Show me the fixes — $49');
  assert.equal(cta.attrs.href, '#offer');

  ({ c, cta } = mk());
  c.setHeaderForReport(rootWith(null), real);
  assert.equal(cta.hidden, true, 'no offer on this report: no button');

  ({ c, cta } = mk());
  c.setHeaderForReport(rootWith({}), { ...real, sample: true });
  assert.equal(cta.text, 'Get my free report');
  assert.equal(cta.attrs.href, '/#request');
});

test('header shows the business and score chip once scrolled, only when there is a score', () => {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = { hidden: true, kids: [], replaceChildren(...k) { this.kids = k; } };
  let scrollFn;
  const w = { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener: (ev, f) => { if (ev === 'scroll') scrollFn = f; } };
  const c = vm.createContext({ document: { addEventListener() {}, querySelector: (q) => (q.includes('data-hdr-ctx') ? ctx : null), createElement: () => ({ className: '', textContent: '' }), body: { classList: { toggle() {} } } }, window: w, location: w.location, URLSearchParams, console });
  vm.runInContext(src, c);
  const rep = { ...locked(), sample: false };
  c.setHeaderForReport({ querySelector: () => null }, rep);
  assert.equal(ctx.hidden, true, 'hidden at the top');
  assert.equal(ctx.kids[0].textContent, rep.business.name);
  assert.match(ctx.kids[1].textContent, /^\d+ \/ 100$/);
  w.scrollY = 600; scrollFn();
  assert.equal(ctx.hidden, false);
  const noScore = { ...rep }; delete noScore.score;
  ctx.kids = [];
  c.setHeaderForReport({ querySelector: () => null }, noScore);
  assert.equal(ctx.kids.length, 0);
});

test('band has no "Email me this report" link', () => {
  const r = load();
  const rep = locked();
  const band = r.headerV2(rep, rep.business, r.scoreV2(rep));
  assert.doesNotMatch(band, /Email me this report|data-scroll-keep/);
  assert.doesNotMatch(render(r, rep).slice(0, render(r, rep).indexOf('r2-verdict')), /Email me this report/);
});

test('button words follow the score: fixes for a low score, "improve" for a strong one; header and bottom bar agree', () => {
  const r = load();
  const low = { ...locked(), score: { ...locked().score, score: 10 } };
  const high = { ...locked(), score: { ...locked().score, score: 92 } };
  assert.equal(r.ctaLabel(low), 'Show me the fixes — $49');
  assert.equal(r.ctaLabel(high), 'See what to improve — $49');
  assert.ok(r.stickyCtaV2(high).includes('See what to improve — $49'));
  assert.ok(r.stickyCtaV2(low).includes('Show me the fixes — $49'));
});

test('search card: owner counted as named but absent from the list still gets a highlighted row', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = true; h.namedYouFirst = false;
  h.businessesNamed = [{ pos: 1, name: 'Someone Else', entityId: 'e1' }];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const { t, cw, proven } = totals(r, rep);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw, engineList: 'Gemini', proven, provenIds: new Set(), zero: false, b: rep.business });
  assert.match(html, /class="me"><span class="pos">✓<\/span><span class="nm">[^<]+ \(you\)/);
  assert.doesNotMatch(html, /Not mentioned/);
});

test('offer band and the top of the page tolerate long unbroken names in CSS', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.ob-head h2, \.ob-kicker, \.ob-head \{ overflow-wrap: anywhere; min-width: 0; \}/);
  assert.match(css, /\.report-page \.nav a \{[^}]*min-height: 44px/);
});
