// The report page's "Who got the call instead", "Websites AI trusted" (Why they got named instead),
// "Can AI read your website?" meter and the phone bottom bar (public/js/report.js), rendered from a
// locked report exactly as GET /api/report sends it, and nothing withheld shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { reportBody } from '../lock.js';

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
  assert.match(html, /report\.js\?v=18/);
  assert.match(html, /report-extra\.css\?v=5/);
});
