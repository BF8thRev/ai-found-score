// Paid report page: Share and Save as PDF in the header, by the result and at the bottom; a share box
// (copy link, email a teammate) where there's no phone share sheet; a clean PDF (file name from the
// title, a print header, a footer line on every page); and the result box's line forward to
// "Do these 3 this week". Oct 2 2026 owner request. Renders public/js/report.js in a vm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { reportBody } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { lintText } from '../../../shared/report-v2.js';
import { officeReport } from './fixtures/office-report.js';

const SRC = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../../../public/report.html', import.meta.url), 'utf8');
const PRINT = readFileSync(new URL('../../../public/css/report-print.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const EXTRA = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- a tiny DOM: elements match the selectors listed in `is`, and know their parent ----
function fakeEl({ is = [], dataset = {}, parent = null, rect = { top: 100, bottom: 140, right: 700 } } = {}) {
  const attrs = {};
  const listeners = {};
  const e = {
    is, dataset, parent, style: {}, attrs, listeners, innerHTML: '', textContent: '', hidden: true, offsetHeight: 200,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
    removeEventListener() {},
    closest(sel) {
      const want = sel.split(',').map((s) => s.trim());
      for (let n = e; n; n = n.parent) if (want.some((w) => n.is.includes(w))) return n;
      return null;
    },
    contains(x) { for (let n = x; n; n = n.parent) if (n === e) return true; return false; },
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => rect,
    remove() { e.removed = true; },
    focus() {},
  };
  return e;
}

function loadPage({ stored = {}, share = null } = {}) {
  const docListeners = {};
  const winListeners = {};
  const appended = [];
  const head = [];
  const header = fakeEl({ is: ['.site-header'] });
  const hdrTools = fakeEl({ is: ['[data-hdr-tools]'], parent: header });
  const dataLayer = [];
  const document = {
    title: 'AI Found Score — Harbor Lane PR',
    addEventListener(t, fn) { (docListeners[t] ||= []).push(fn); },
    removeEventListener() {},
    querySelector: (s) => (s === '.site-header [data-hdr-tools]' ? hdrTools : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => fakeEl(),
    documentElement: { clientWidth: 1024 },
    head: { appendChild: (x) => head.push(x) },
    body: { appendChild: (x) => appended.push(x), classList: { toggle() {} } },
  };
  const window = {
    location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, scrollX: 0, innerHeight: 800, innerWidth: 1024,
    addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
    matchMedia: () => ({ matches: !!share }),
    dataLayer,
    printed: 0,
    print() { window.printed++; },
  };
  const ctx = vm.createContext({
    document, window, console, URLSearchParams,
    location: { search: '', hash: '', origin: 'https://aifoundscore.com', pathname: '/report/office-test-token' },
    navigator: share ? { share } : {},
    localStorage: { getItem: (k) => stored[k] ?? null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(SRC, ctx);
  return { ctx, document, window, docListeners, winListeners, appended, head, header, hdrTools, dataLayer };
}
const render = (page, report) => {
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  page.ctx.renderV2(root, report);
  return root.innerHTML;
};
const paid = () => reportBody(officeReport(), true);
const at = (html, s) => { const i = html.indexOf(s); assert.ok(i >= 0, `page has ${s}`); return i; };
const click = async (page, target) => { for (const fn of page.docListeners.click || []) await fn({ target, preventDefault() {} }); };

// ---- 3. the result box points at what to do this week ----

test('result box (named in none): "Here’s how to fix it, starting today" links to Do these 3 this week', () => {
  const html = render(loadPage(), paid());
  assert.match(html, /<p class="r2-verdict-next"><a href="#this-week">Here’s how to fix it, starting today: 3 things to do this week <span aria-hidden="true">↓<\/span><\/a><\/p>/);
  // Inside the result box, and the anchor it points at exists.
  const start = at(html, 'aria-label="Your result"');
  const box = html.slice(start, html.indexOf('</section>', start));
  assert.match(box, /r2-verdict-next/);
  assert.match(html, /<div class="ap-week" id="this-week">/);
  assert.equal(lintText(html.match(/<p class="r2-verdict-next">[\s\S]*?<\/p>/)[0]).length, 0);
});

test('result box: "get mentioned more" when named sometimes, "stay on top" when named every time', () => {
  const some = render(loadPage(), reportBody(MOCK_REPORTS['sample-001'], true));
  assert.match(some, /Here’s how to get mentioned more, starting today: 3 things to do this week/);
  const rep = paid();
  rep.answers = rep.answers.map((a) => ({ ...a, namedYou: true, ownerMatch: 'yes' }));
  assert.match(render(loadPage(), rep), /Here’s how to stay on top: 3 things to do this week/);
});

test('result box: the count follows the saved ticks; with none left this week it points at the plan', () => {
  const rep = paid();
  const weekIds = rep.xray.actionPlan.items.filter((i) => i.week).map((i) => i.id);
  const one = render(loadPage({ stored: { ['afs_plan_' + rep.id]: JSON.stringify({ [weekIds[0]]: true }) } }), rep);
  assert.match(one, /starting today: \d things? to do this week/);
  const all = Object.fromEntries(weekIds.map((id) => [id, true]));
  const none = render(loadPage({ stored: { ['afs_plan_' + rep.id]: JSON.stringify(all) } }), rep);
  assert.match(none, /<a href="#action-plan">Here’s how to fix it, starting today: your action plan, biggest impact first/);
});

test('free locked report: result box unchanged, no top tools, no header tools', () => {
  const page = loadPage();
  const rep = reportBody(officeReport(), false);
  const html = render(page, rep);
  assert.doesNotMatch(html, /r2-verdict-next|r2-tools-top/);
  assert.match(html, /data-tools="bottom"/, 'the bottom tools stay');
  page.ctx.setHeaderForReport({ querySelector: () => null }, rep);
  assert.equal(page.hdrTools.hidden, true);
});

// ---- 1. Share and Save as PDF: header, by the result, bottom ----

test('paid report: Share and Save as PDF right under the result box, and still at the bottom', () => {
  const html = render(loadPage(), paid());
  const top = at(html, 'class="r2-tools r2-tools-top"');
  assert.ok(top > at(html, 'aria-label="Your result"') && top < at(html, '<h2>Your action plan</h2>'));
  const topBlock = html.slice(top, top + 1500);
  assert.match(topBlock, /data-action="share"[\s\S]*Share<span class="wide"> with your team/);
  assert.match(topBlock, /data-action="print"[\s\S]*Save as PDF/);
  assert.ok(at(html, 'data-tools="bottom"') > at(html, 'How we searched'));
});

test('header: Share and Save as PDF buttons in report.html, shown on paid reports and samples', () => {
  assert.match(PAGE, /<div class="hdr-tools" data-hdr-tools [^>]*hidden>[\s\S]*?data-action="share"[\s\S]*?<span>Share<\/span>[\s\S]*?data-action="print"[\s\S]*?<span>Save as PDF<\/span>/);
  for (const rep of [paid(), reportBody(MOCK_REPORTS['sample-001'], true)]) {
    const page = loadPage();
    render(page, rep);
    page.ctx.setHeaderForReport({ querySelector: () => null }, rep);
    assert.equal(page.hdrTools.hidden, false);
  }
  // Phones: icons only (the label is kept for screen readers).
  assert.match(EXTRA, /@media \(max-width: 820px\) \{\s*\.hdr-tool \{[^}]*width: 44px[\s\S]*?\.hdr-tool span \{[^}]*clip: rect\(0 0 0 0\)/);
});

test('share from the header (computer): a share box with the link, copy, email, and a word on who can see it', async () => {
  const page = loadPage();
  const rep = paid();
  page.ctx.wireReportTools({}, rep);
  const btn = fakeEl({ is: ['button[data-action]'], dataset: { action: 'share' }, parent: page.hdrTools });
  await click(page, btn);
  assert.equal(page.appended.length, 1, 'one share box');
  const box = page.appended[0];
  assert.equal(box.style.position, 'fixed', 'stays with the sticky header');
  assert.match(box.innerHTML, /Anyone with this link can see the report/);
  assert.match(box.innerHTML, /value="https:\/\/aifoundscore\.com\/report\/office-test-token"/);
  assert.match(box.innerHTML, /data-share="copy">Copy link</);
  const mail = box.innerHTML.match(/href="(mailto:[^"]+)"[^>]*>Email to a teammate</);
  assert.ok(mail, 'email link');
  const href = mail[1].replace(/&amp;/g, '&');
  assert.equal(decodeURIComponent(href.match(/subject=([^&]+)/)[1]), 'AI Found Score report for Harbor Lane PR');
  const body = decodeURIComponent(href.match(/body=(.+)$/)[1]);
  assert.match(body, /https:\/\/aifoundscore\.com\/report\/office-test-token/);
  assert.match(body, /Anyone with this link can see the report/);
  assert.equal(lintText(box.innerHTML + body).length, 0);
  // Analytics: where and what, never the report token.
  assert.deepEqual(JSON.parse(JSON.stringify(page.dataLayer)), [{ event: 'report_share', method: 'menu', where: 'header', report_kind: 'paid' }]);
  // A second click on the same button closes it.
  await click(page, btn);
  assert.equal(box.removed, true);
});

test('share on a phone: the system share sheet with the report link', async () => {
  const shared = [];
  const page = loadPage({ share: async (d) => { shared.push(d); } });
  page.ctx.wireReportTools({}, paid());
  const group = fakeEl({ is: ['[data-tools]'], dataset: { tools: 'top' } });
  await click(page, fakeEl({ is: ['button[data-action]'], dataset: { action: 'share' }, parent: group }));
  assert.equal(shared.length, 1);
  assert.equal(shared[0].url, 'https://aifoundscore.com/report/office-test-token');
  assert.equal(page.appended.length, 0, 'no share box');
  assert.equal(page.dataLayer[0].where, 'top');
  assert.equal(page.dataLayer[0].method, 'native');
});

// ---- 2. Save as PDF ----

test('Save as PDF: prints, names the PDF after the business and date, restores the title after', async () => {
  const page = loadPage();
  const rep = paid();
  page.ctx.wireReportTools({}, rep);
  await click(page, fakeEl({ is: ['button[data-action]'], dataset: { action: 'print' }, parent: page.hdrTools }));
  assert.equal(page.window.printed, 1);
  assert.equal(page.document.title, 'AI Found Score - Harbor Lane PR - Oct 1 2026');
  assert.deepEqual(JSON.parse(JSON.stringify(page.dataLayer)), [{ event: 'report_print', where: 'header', report_kind: 'paid' }]);
  for (const fn of page.winListeners.afterprint) fn();
  assert.equal(page.document.title, 'AI Found Score — Harbor Lane PR');
  // Ctrl+P works the same way.
  for (const fn of page.winListeners.beforeprint) fn();
  assert.equal(page.document.title, 'AI Found Score - Harbor Lane PR - Oct 1 2026');
  // A footer line on every page, with page numbers.
  assert.equal(page.head.length, 1);
  assert.match(page.head[0].textContent, /@bottom-left \{ content: "aifoundscore\.com · Report for Harbor Lane PR · checked Oct 1, 2026"/);
  assert.match(page.head[0].textContent, /@bottom-right \{ content: "Page " counter\(page\) " of " counter\(pages\)/);
});

test('PDF file name and footer: no characters a file name or CSS string can’t hold', () => {
  const { ctx } = loadPage();
  const rep = { business: { name: 'Mega Wash & Dry: "24/7" <Laundry>\\.' }, generatedAt: '2026-10-01T15:00:00Z' };
  const t = ctx.printTitle(rep);
  assert.equal(t, 'AI Found Score - Mega Wash and Dry 24 7 Laundry - Oct 1 2026');
  assert.doesNotMatch(t, /[\\/:*?"<>|]/);
  const css = ctx.printFooterCss(rep);
  assert.match(css, /Report for Mega Wash & Dry: \\"24\/7\\" <Laundry>\\\\\./);
});

test('print header: logo, business, checked date, score; printed only', () => {
  const html = render(loadPage(), paid());
  const head = html.slice(at(html, 'class="print-only print-head"'), at(html, 'class="report-header r2-band"'));
  assert.match(head, /<img src="\/img\/logo\.svg"/);
  assert.match(head, /AI Found Score report/);
  assert.match(head, /<p class="print-head-name">Harbor Lane PR<\/p>/);
  assert.match(head, /Checked Oct 1, 2026 · New York City, NY/);
  assert.match(head, /<b>0<\/b>\/100 <span>Low<\/span>/);
  assert.match(html, /class="print-only print-end"/);
  assert.match(EXTRA, /\.print-only \{ display: none; \}/);
});

test('print CSS: screen chrome hidden, light header, done steps in words, Fix Kit and site links as addresses', () => {
  const hidden = PRINT.match(/([^{}]+)\{ display: none !important; \}/)[1];
  for (const sel of ['.site-header', '.hdr-tools', '.share-pop', '.r2-tools', '.r2-upsell', '.ap-tick', '.lead-form', '[data-tier]', '.r2-sticky', '.offer-band']) {
    assert.ok(hidden.split(',').map((s) => s.trim()).includes(sel), `${sel} hidden in print`);
  }
  assert.match(PRINT, /\.print-only \{ display: block !important; \}/);
  assert.match(PRINT, /\.report-header\.r2-band \{ display: none !important; \}/);
  assert.match(PRINT, /\.ap-item\.done \.ap-title::before \{ content: "Done \\2713  "/);
  assert.match(PRINT, /\.ap-kitnote a::after, \.ap-kitcard-btns \.btn::after \{ content: ": aifoundscore\.com" attr\(href\)/);
  assert.match(PRINT, /\.ap-sites a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)"/);
  assert.match(PRINT, /\.r2-code code \{ white-space: pre-wrap !important;/);
  assert.match(PRINT, /h1, h2, h3, h4, summary[^{]*\{ break-after: avoid; \}/);
});
