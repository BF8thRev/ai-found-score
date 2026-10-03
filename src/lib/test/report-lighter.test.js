// The report, short first (Oct 2 2026 buyer feedback, relayed by the owner: "The report felt like too much
// information to start. He wants quick and easy and short, and then if he needs more info on how or where
// to go he will click."). Through the real route (GET /api/report/<id>) and the page that renders it
// (public/js/report.js in a vm): each section is a heading, one line and a few items, the rest one click
// away in <details>; nothing is dropped, and print opens everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

async function api(path) {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  const res = await worker.fetch(new Request(`https://aifoundscore.com${path}`), { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } }, { waitUntil() {} });
  assert.equal(res.status, 200, path);
  return res.json();
}

function render(report) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: (t) => ['xray', 'competitor_breakdown'].includes(t), scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(src, ctx);
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  ctx.renderV2(root, report);
  return root.innerHTML;
}
const section = (html, id) => {
  const i = html.indexOf(`id="${id}"`);
  assert.ok(i >= 0, `has #${id}`);
  return html.slice(i, html.indexOf('</section>', i));
};
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the top: score, result line and "3 things to do this week", then a "Jump to" row of section links', async () => {
  const body = await api('/api/report/sample-001');
  const html = render(body);
  const verdict = html.indexOf('class="r2-verdict');
  const jump = html.indexOf('class="r2-jump"');
  assert.ok(html.indexOf('class="r2-score') < verdict && verdict < jump && jump < html.indexOf('id="action-plan"'));
  assert.match(html, /3 things to do this week/);
  const row = html.slice(jump, html.indexOf('</nav>', jump));
  // Each link goes to a section that is on the page.
  const ids = [...row.matchAll(/href="#([a-z-]+)" data-jump="\1"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['action-plan', 'why-picked', 'gap-sheet', 'breakdown', 'site', 'listings', 'facts', 'proof']);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), id);
});

test('action plan: "Why it matters" sits in a closed box inside each step; the how and the Needs line stay on screen', async () => {
  const body = await api('/api/report/sample-001');
  const html = render(body);
  const plan = section(html, 'action-plan');
  const items = body.xray.actionPlan.items;
  const boxes = plan.match(/<details class="r2-more ap-whybox"><summary>Why it matters<\/summary><p class="ap-why"><b>Why it matters:<\/b> /g) || [];
  assert.equal(boxes.length, items.filter((i) => i.why).length);
  assert.doesNotMatch(plan, /class="r2-more ap-whybox" open/);
  // Every why is still on the page, word for word.
  for (const i of items) if (i.why) assert.ok(text(plan).includes(text(i.why.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'))), i.id);
  // The first step is open with its "How to do it" visible (not inside a closed box).
  const first = plan.slice(plan.indexOf('<details class="ap-row" open>'), plan.indexOf('</li>', plan.indexOf('<details class="ap-row" open>')));
  assert.match(first, /<p class="ap-how-k">How to do it<\/p>/);
  assert.ok(first.indexOf('ap-how-k') > first.indexOf('</details>'), 'the how is outside the why box');
});

test('"Why AI picked them": each business is a closed card showing its name and "Named in N of M"; quotes inside; 3 shown, the rest behind "Show all"', async () => {
  const body = await api('/api/report/sample-001');
  const why = section(render(body), 'why-picked');
  const rivals = body.xray.whyPicked.rivals;
  assert.ok(rivals.length >= 5);
  const cards = why.match(/<article class="r2-why-card"><details class="r2-card-fold">\s*<summary><h3>[^]*?<span class="r2-why-meta">Named in \d+ of \d+ answers[^<]*<\/span><\/summary>/g) || [];
  assert.equal(cards.length, rivals.length, 'every business, each closed');
  assert.doesNotMatch(why, /r2-card-fold" open/);
  // Quotes are inside the card, after its summary.
  const k = why.indexOf('<h3>Kessler Bros. Plumbing');
  const card = why.slice(k, why.indexOf('</article>', k));
  assert.ok(card.indexOf('</summary>') < card.indexOf('“Kessler Bros. Plumbing – Family-owned, known for clear pricing.”'));
  // 3 on screen, the rest one click away.
  const more = why.indexOf(`<details class="r2-more"><summary>Show all ${rivals.length} businesses</summary>`);
  assert.ok(more > 0);
  assert.equal((why.slice(0, more).match(/class="r2-why-card"/g) || []).length, 3);
  // "Businesses your size": closed, heading and one line on top.
  assert.match(why, /<details class="r2-small r2-why-size r2-card-fold" id="your-size">\s*<summary><h3>Businesses your size<\/h3><span class="r2-fold-line">We also asked 2 questions a smaller local business can win\.<\/span><\/summary>/);
});

test('Competitor Breakdown: the scorecard stays on screen; "What AI says about them" and "One by one" are closed; the honest note stays visible', async () => {
  const bd = section(render(await api('/api/report/sample-001')), 'breakdown');
  assert.match(bd, /<b>You match \d+ of \d+\.<\/b>/);
  assert.ok(bd.indexOf('<table class="r2-match">') < bd.indexOf('<details'), 'scorecard before any click');
  assert.match(bd, /<details class="r2-group-fold"><summary><h3 class="r2-match-h">What AI says about them, and the pages it read<\/h3>/);
  assert.match(bd, /<details class="r2-group-fold"><summary><h3 class="r2-match-h">One by one<\/h3>/);
  assert.doesNotMatch(bd, /r2-group-fold" open/);
  const note = bd.indexOf('We can’t promise that copying them changes what AI says.');
  assert.ok(note > bd.lastIndexOf('</details>'), 'the caveat is outside every closed box');
});

test('listings: only the ones that need a fix on screen, the rest behind "Show all 5 listings"; facts: the wrong one on screen', async () => {
  const body = await api('/api/report/sample-001');
  const html = render(body);
  const ls = section(html, 'listings');
  const more = ls.indexOf('<details class="r2-more"><summary>Show all 5 listings</summary>');
  assert.ok(more > 0);
  const shown = ls.slice(0, more);
  assert.equal((shown.match(/class="listing-card"/g) || []).length, body.listings.filter((l) => l.status === 'mismatch').length);
  assert.doesNotMatch(shown, /✓ Correct/);
  assert.equal((ls.match(/class="listing-card"/g) || []).length, body.listings.length, 'every listing is still on the page');
  const facts = section(html, 'facts');
  const fm = facts.indexOf('<details class="r2-more">');
  assert.match(facts.slice(0, fm), /Doesn’t match/);
  assert.doesNotMatch(facts.slice(0, fm), /badge match">Correct/);
  assert.match(facts.slice(fm), /How AI describes you/);
});

test('free (unpaid) view: offer, $49 price, the promise and the buy button stay on screen; no "Jump to" on the sales page', async () => {
  const body = await api('/api/report/sample-001?preview=locked');
  assert.equal(body.locked, true);
  const html = render(body);
  const offer = html.slice(html.indexOf('data-offer-band'), html.indexOf('</section>', html.indexOf('data-offer-band')));
  assert.match(offer, /— \$<span data-total>49<\/span><\/a>/);
  assert.match(offer, /The 3-problem promise:/);
  assert.match(offer, /No subscription\./);
  // Nothing in the offer is inside a closed box.
  assert.doesNotMatch(offer, /<details/);
  assert.doesNotMatch(html, /class="r2-jump"/);
});

test('print: every click-for-more opens for Save as PDF, its "Show all" label is hidden, the bold "Why it matters:" prints', () => {
  const js = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const print = readFileSync(new URL('../../../public/css/report-print.css', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(js, /function openAllForPrint\(\) \{\s*const closed = \[\.\.\.document\.querySelectorAll\('details:not\(\[open\]\)'\)\]/);
  assert.match(print, /details::details-content \{ content-visibility: visible; display: block; \}/);
  assert.match(print, /\.r2-more > summary, \.r2-jump \{ display: none !important; \}/);
  assert.match(print, /\.ap-whybox \.ap-why b \{ display: inline !important; \}/);
  assert.match(css, /@media screen \{ \.ap-whybox \.ap-why b \{ display: none; \} \}/);
  // More room: sections 72px apart on computers, 44px on phones; 44px tap targets on the new clicks.
  assert.match(css, /\.report-page \.r2 > \.report-section \{ margin: 72px 0; \}/);
  assert.match(css, /\.report-page \.r2 > \.report-section \{ margin: 44px 0; \}/);
  assert.match(css, /details\.r2-more > summary \{[^}]*min-height: 44px/);
  assert.match(css, /\.r2-jump a \{[^}]*min-height: 44px/);
  // The cache-busters moved with the files.
  const page = readFileSync(new URL('../../../public/report.html', import.meta.url), 'utf8');
  assert.match(page, /report-extra\.css\?v=44/);
  assert.match(page, /report-print\.css\?v=5/);
  assert.match(page, /js\/report\.js\?v=51/);
});
