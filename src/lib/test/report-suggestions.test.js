// Below-the-top suggestions on the report page (public/js/report.js): what-to-fix tiles that explain
// "14 vs 11", an early offer strip, a sample-report link, the method note collapsed, matching wording in
// the offer, and a skeleton while the page loads. Rendered from a locked report as GET /api/report sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { reportBody } from '../lock.js';

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

test('what to fix: big severity tiles that add up to the problem count', () => {
  const rep = locked();
  const html = render(load(), rep);
  const tiles = [...html.matchAll(/<div class="r2-fixtile (high|medium|low)"><div class="n">(\d+)<\/div>/g)];
  assert.ok(tiles.length >= 2, 'tiles shown');
  assert.equal(tiles.reduce((n, m) => n + Number(m[2]), 0), rep.issues.length);
  assert.doesNotMatch(html, /class="r2-sev"/);
});

test('what to fix: says how many are specific to the business and that the rest are general', () => {
  const r = load();
  const rep = locked();
  const specific = rep.issues.filter((i) => !(i.generic === true || /^baseline_/.test(String(i.kind || '')))).length;
  const html = render(r, rep);
  if (specific < rep.issues.length) {
    assert.match(html, new RegExp(`${specific} ${specific === 1 ? 'is' : 'are'} specific to `));
    assert.match(html, /The rest are general tips\./);
  }
  const all = r.issuesV2({ issues: rep.issues, locked: true, xrayOk: false, name: 'X', specificCount: rep.issues.length });
  assert.doesNotMatch(all, /specific to/);
});

test('early offer strip: under the short version, real promise, scrolls to the offer band', () => {
  const html = render(load(), locked());
  const strip = html.indexOf('class="r2-strip"');
  assert.ok(strip > html.indexOf('The short version'), 'after the short version');
  assert.ok(strip < html.indexOf('id="who"'), 'right under the short version, before Who got the call instead');
  assert.ok(strip < html.indexOf('id="offer"'), 'before the offer band');
  const seg = html.slice(strip, html.indexOf('</aside>', strip));
  assert.match(seg, /problems? found/);
  assert.match(seg, /Fewer than 3 problems specific to your business\? Your \$49 back\./);
  assert.match(seg, /href="#offer" data-scroll-offer>Show me the fixes — \$49</);
});

test('early offer strip: not shown when there is no offer band', () => {
  assert.doesNotMatch(render(load({ tier: false }), locked()), /r2-strip/);
});

test('offer: a sample report link next to the buy button, not on the sample itself', () => {
  const r = load();
  assert.match(render(r, { ...locked(), sample: false }), /class="ob-sample" href="\/report\/sample-001">See a sample report first/);
  assert.doesNotMatch(render(r, { ...locked(), sample: true }), /ob-sample/);
});

test('offer wording matches the top of the page: mentioned / answers, not named / searches', () => {
  const html = render(load(), locked());
  const band = html.slice(html.indexOf('id="offer"'));
  assert.doesNotMatch(band.slice(0, band.indexOf('ob-bridge')), /named you|searches/);
});

test('how we searched: collapsed behind one line, all the text still there', () => {
  const html = render(load(), locked());
  assert.match(html, /<details class="r2-method"><summary>How we searched<\/summary><p>/);
  assert.match(html, /AI answers change; this is a snapshot\./);
});

test('print: the strip and sample link are hidden', () => {
  const css = readFileSync(new URL('../../../public/css/report-print.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-strip, \.ob-sample \{ display: none !important; \}/);
});

// ---- served through the real router ----
async function served() {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  const env = {
    ASSETS: {
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path !== '/report' && path !== '/report.html') return new Response('nf', { status: 404 });
        return new Response(readFileSync(new URL('../../../public/report.html', import.meta.url), 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      },
    },
  };
  const res = await worker.fetch(new Request('https://aifoundscore.com/report/r9aew8ndec'), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  return res.text();
}

test('GET /report/<token> serves a skeleton, not a bare "Loading" line, while the report loads', async () => {
  const html = await served();
  const root = html.slice(html.indexOf('<main id="report-root">'), html.indexOf('</main>'));
  assert.match(root, /class="r2-skel" role="status"/);
  assert.match(root, /class="r2-skel-band"/);
  assert.match(root, /Loading your report…/);
  assert.doesNotMatch(root, /padding:60px 0/);
  assert.match(html, /report\.js\?v=(2[5-9]|[3-9]\d)/);
});
