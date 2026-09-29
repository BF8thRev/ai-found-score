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
const locked = () => structuredClone(reportBody(MOCK_REPORTS['sample-001'], false));
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

test('early offer strip: right after Who got the call, before the search card; real promise; scrolls to the offer band', () => {
  const html = render(load(), locked());
  const strip = html.indexOf('class="r2-strip"');
  assert.ok(strip > html.indexOf('id="who"'), 'after Who got the call instead');
  assert.ok(strip < html.indexOf('class="r2-hero"'), 'before the search card');
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
  assert.doesNotMatch(band.slice(0, band.indexOf('ob-buy')), /named you|searches/);
});

test('how we searched: collapsed behind one line, all the text still there', () => {
  const html = render(load(), locked());
  assert.match(html, /<details class="r2-method"><summary>How we searched<\/summary><p>/);
  assert.match(html, /AI answers change; this is a snapshot\./);
});

test('print: the strip and sample link are hidden', () => {
  const css = readFileSync(new URL('../../../public/css/report-print.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-strip, \.ob-sample, \.r2-bridge \{ display: none !important; \}/);
  assert.match(css, /\.r2-hero-read a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)"/);
  assert.match(css, /\.r2-hero \{ background: none !important; color: #000 !important;/);
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
  assert.match(html, /report\.js\?v=(34|[3-9]\d)/);
});

test('result sentence: the top competitor gets its own amber highlight, escaped', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) a.namedYou = false;
  const t = r.computeTotalsV2(rep.answers);
  const proven = r.provenEntities(rep);
  assert.ok(proven[0], 'fixture has a competitor');
  proven[0].name = 'A & B <b>Co</b>';
  const html = r.verdictV2(rep, { t, N: t.answers, cw: r.countWords(rep), proven, zero: true, allNamed: false, b: rep.business, engineList: 'Gemini' });
  assert.match(html, /<span class="r2-rival">A &amp; B &lt;b&gt;Co&lt;\/b&gt;<\/span> came up /);
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-rival \{ background: #FFC857; color: #14213A;/);
});

test('result sentence: no highlight when everyone mentioned the owner (no rival sentence)', () => {
  const r = load();
  const rep = locked();
  for (const a of rep.answers) a.namedYou = true;
  const t = r.computeTotalsV2(rep.answers);
  const html = r.verdictV2(rep, { t, N: t.answers, cw: r.countWords(rep), proven: r.provenEntities(rep), zero: false, allNamed: true, b: rep.business, engineList: 'Gemini' });
  assert.doesNotMatch(html, /r2-rival/);
});

// ---- the page order and the merged "Every question, every answer" section ----
const at = (html, s) => { const i = html.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i; };

test('order (free report with the offer): result, who got the call, offer strip, search card ... offer band, then the reference sections', () => {
  const html = render(load(), locked());
  const order = ['class="r2-verdict', 'id="who"', 'class="r2-strip"', 'class="r2-hero"', '<h2>What to fix</h2>', 'class="r2-fixwhere"', 'id="offer"', '<h2>Every question, every answer</h2>', 'class="r2-method"'].map((s) => at(html, s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('the grid and the standalone short version are gone; their content lives in Every question, every answer', () => {
  const r = load();
  const rep = locked();
  const html = render(r, rep);
  assert.doesNotMatch(html, /<h2>Every search, every assistant<\/h2>|<h2>The short version<\/h2>|r2-grid|r2-qlist/);
  const intents = r.intentResultsV2(rep).filter((x) => x.answers > 0);
  const lost = intents.filter((x) => x.lost).length;
  assert.equal((html.match(/class="r2-qv lost"/g) || []).length, lost);
  assert.equal((html.match(/class="r2-qv won"/g) || []).length, intents.length - lost);
  for (const q of rep.questions) assert.ok(html.includes(q.text.replace(/'/g, '&#39;')) || html.includes(q.text), q.text);
  assert.ok(html.indexOf('r2-qv') > html.indexOf('id="offer"'), 'reference section sits after the offer');
});

test('every answer is still reachable from the search card link after the grid was removed', () => {
  const html = render(load(), locked());
  const m = html.match(/data-open="([^"]+)"/);
  assert.ok(m, 'search card has a read link');
  assert.ok(html.includes(`id="ans-${m[1]}"`), `answer ${m[1]} exists in the merged section`);
});

test('order without the offer (tier off): findings first, then who got the call; still no grid or short version', () => {
  const html = render(load({ tier: false }), locked());
  assert.doesNotMatch(html, /r2-strip|r2-grid|<h2>The short version<\/h2>/);
  assert.ok(at(html, 'class="r2-hero"') < at(html, 'id="who"'));
  assert.ok(at(html, '<h2>Every question, every answer</h2>') > at(html, '<h2>What to fix</h2>'));
});

test('score card: number, pill, three-zone meter with the marker at the score, at 0 / 55 / 92', () => {
  const r = load();
  for (const [score, cls, word] of [[0, 'weak', 'Low'], [55, 'mixed', 'Fair'], [92, 'strong', 'Strong']]) {
    const rep = locked();
    rep.score = { ...rep.score, score };
    const html = r.scoreV2(rep);
    assert.match(html, new RegExp(`class="r2-score ${cls}" role="group" aria-label="AI Found Score ${score} out of 100, ${word}"`));
    assert.ok(html.includes(`<b>${score}</b><span>/100</span>`));
    assert.ok(html.includes(`class="r2-sc-meter" style="--n:${score}"`));
    assert.equal((html.match(/<i><\/i>/g) || []).length, 3);
    assert.match(html, /How we score/);
  }
});

test('search card shows three names, then the owner row', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  h.namedYou = false;
  h.businessesNamed = Array.from({ length: 7 }, (_, i) => ({ pos: i + 1, name: `Rival ${i + 1}`, entityId: `e${i + 1}` }));
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const t = r.computeTotalsV2(rep.answers);
  const html = r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw: r.countWords(rep), engineList: 'Gemini', proven: [], provenIds: new Set(), zero: true, b: rep.business });
  assert.equal((html.match(/<li><span class="pos">\d<\/span>/g) || []).length, 3);
  assert.match(html, /and 4 more/);
  assert.match(html, /class="not"/);
});

test('what to fix shows two locked rows and counts the rest', () => {
  const rep = locked();
  const html = render(load(), rep);
  assert.equal((html.match(/<li><span class="badge (high|medium|low)">/g) || []).length, 2);
  assert.ok(html.includes(`and ${rep.issues.length - 2} more.`));
});

test('offer band: one sentence and one card; no list of everything in the audit; contact and sample link stay one line of small print', () => {
  const html = render(load(), { ...locked(), sample: false });
  const band = html.slice(html.indexOf('id="offer"'), html.indexOf('class="ob-next"'));
  assert.match(band, /<p class="ob-one"><b>\$49, one time\.<\/b> Every problem we found, with the exact steps to fix each one, plus the finished pieces to paste into your website\. We re-check you free in 30 days\.<\/p>/);
  assert.doesNotMatch(band, /ob-stack|ob-grid|ob-lede|ob-found|ob-anchor|ob-keep|Everything in the audit|Fix Kit|competitor gap/i);
  assert.match(band, /Questions first\? <a href="mailto:hello@aifoundscore\.com">hello@aifoundscore\.com<\/a> · <a class="ob-sample" href="\/report\/sample-001">See a sample report first<\/a>/);
  assert.equal((band.match(/data-tier="xray"/g) || []).length, 1, 'one buy button');
  assert.match(band, /<b>The 3-problem promise\.<\/b> Fewer than 3 problems specific to .+\? Email us within 30 days and get your \$49 back\./);
  assert.ok(band.length < 3800, `the offer band markup stays small (${band.length})`);
});

test('plainer words: no "AI crawler"; the website lines are in plain terms', () => {
  const html = render(load(), locked());
  assert.doesNotMatch(html, /AI crawler/);
  // the older findings-first order (no offer) keeps its own labels
  assert.match(render(load({ tier: false }), locked()), /Websites [A-Za-z]+ used in the answer above/);
});

test('long unbroken names wrap: CSS for the lines that overflowed, blue on light grey, tap targets', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.report-section \.sub, \.r2-ans p, \.r2-ans, \.r2-line \{ overflow-wrap: anywhere; min-width: 0; \}/);
  assert.match(css, /\.report-page \.site-footer a \{ color: #1A5FD0; \}/);
  assert.match(css, /\.report-page summary \{ min-height: 44px;/);
  assert.match(css, /\.ob-small a \{ padding: 11px 0; \}/);
  assert.match(css, /\.ob-compact \.ob-sample \{ padding: 12px 0; \}/);
});

// ---- "Email me this report": a second way into the funnel, near the top ----
test('email capture: ONE box, in the offer strip near the top; none repeated at the bottom of the offer', () => {
  const html = render(load(), { ...locked(), sample: false, hasEmail: false });
  const strip = html.slice(html.indexOf('class="r2-strip"'), html.indexOf('</aside>'));
  assert.match(strip, /<form class="lead-form" data-where="strip"/);
  assert.match(strip, /Not ready\? We’ll email you this report so you can come back to it\./);
  assert.match(strip, /type="email"/);
  assert.match(strip, /Email me this report<\/button>/);
  assert.equal((html.match(/<form class="lead-form"/g) || []).length, 1);
  assert.doesNotMatch(html, /ob-keep|id="keep"|data-where="bottom"/);
  assert.ok(html.indexOf('data-where="strip"') < html.indexOf('id="offer"'), 'above the offer band');
});

test('email capture: not shown on a sample, or when an email is already on file', () => {
  const r = load();
  assert.doesNotMatch(render(r, { ...locked(), sample: true }), /data-where="strip"|ob-keep/);
  const has = render(r, { ...locked(), sample: false, hasEmail: true });
  assert.doesNotMatch(has, /data-where="strip"|ob-keep/);
  assert.match(has, /class="r2-strip"/, 'the strip itself stays');
});

test('email capture: the ready page wires every lead form to the same handler, and no cross-hiding is left behind', () => {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  assert.match(src, /root\.querySelectorAll\('form\.lead-form'\)\.forEach\(\(f\) => f\.addEventListener\('submit', \(e\) => submitLead\(e, report\.id\)\)\)/);
  assert.doesNotMatch(src, /ob-keep/);
});

test('email capture posts the token and email to /api/lead, then thanks them and collapses the row', async () => {
  const r = load();
  const calls = [];
  const status = { textContent: '', className: '' };
  const row = { hidden: false };
  const form = {
    dataset: { where: 'strip' }, email: { value: 'owner@werner.example' }, company_url: { value: '' },
    querySelector: (q) => (q === '.lead-status' ? status : q === 'button' ? { disabled: false } : q === '.lead-row' ? row : null),
  };
  r.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  const ok = await r.submitLead({ preventDefault() {}, currentTarget: form }, 'r9aew8ndec');
  assert.equal(ok, true);
  assert.deepEqual(calls, [{ url: '/api/lead', body: { token: 'r9aew8ndec', email: 'owner@werner.example', company_url: '' } }]);
  assert.equal(row.hidden, true);
  assert.match(status.textContent, /We’ll send the link to owner@werner\.example/);
  const bad = { ...form, email: { value: 'nope' } };
  assert.equal(await r.submitLead({ preventDefault() {}, currentTarget: bad }, 'r9aew8ndec'), false);
  assert.equal(calls.length, 1, 'an invalid email posts nothing');
});


test('listing line: none when no listing mismatches, escaped platform name', () => {
  const r = load();
  assert.equal(r.listingLineV2([]), '');
  assert.equal(r.listingLineV2([{ platform: 'Google', status: 'match' }]), '');
  assert.match(r.listingLineV2([{ platform: '<b>G</b>', status: 'mismatch' }]), /Your &lt;b&gt;G&lt;\/b&gt; listing doesn’t match your website, or we couldn’t find it/);
  assert.match(r.listingLineV2([{ platform: 'Google', status: 'mismatch' }, { platform: 'Yelp', status: 'mismatch' }]), /Your Google and Yelp listings don’t match your website, or we couldn’t find them/);
});

test('after the bottom email box is used the strip leaves no empty divider; the hidden wrapper stays hidden', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-strip-lead\[hidden\] \{ display: none; \}/);
});

test('long unbroken questions wrap in the search card and the answer headings', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.r2-hero \.q, h3\.r2-q \{ overflow-wrap: anywhere; \}/);
});

test('plainer words on the bars and the website check', () => {
  const html = render(load(), locked());
  assert.doesNotMatch(html, /\d+ named( · \d+ first)?<\/span>/, 'bar counts say mentions, not named');
  assert.match(html, /\d+ mentions?( · \d+ first)?<\/span>/);
  assert.doesNotMatch(html, /llms\.txt/, 'no llms.txt in the offer stack');
});

test('dead helpers are gone', () => {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /function nearMiss|function shortVersionV2|function gridV2/);
});

// ---- "Why AI skips you" and the offer trim ----




test('what to fix: no second button stacked on the offer; a short bridge line instead', () => {
  const html = render(load(), locked());
  const fix = html.slice(html.indexOf('<h2>What to fix</h2>'), html.indexOf('id="offer"'));
  assert.doesNotMatch(fix, /unlock-panel|data-scroll-offer|class="btn"/);
  assert.match(fix, /Every one is fixed step by step in the audit below\./);
  // the other entry points are still there: strip, offer band, phone bar
  assert.equal((html.match(/data-scroll-offer/g) || []).length, 2, 'strip button + phone bar');
  assert.match(html, /data-offer-band/);
});


// ---- accuracy fixes from the fact-check, and the last review round ----



test('listing line covers "no listing found" as well as a mismatch', () => {
  const r = load();
  const html = r.listingLineV2([{ platform: 'Google', status: 'mismatch' }]);
  assert.match(html, /doesn’t match your website, or we couldn’t find it/);
  assert.doesNotMatch(html, /shows details/);
});


test('every question, every answer: the Won/Lost line stays visible, the answers open on tap', () => {
  const r = load();
  const rep = locked();
  const html = render(r, rep);
  const sec = html.slice(html.indexOf('<h2>Every question, every answer</h2>'));
  const qs = rep.questions.filter((q) => rep.answers.some((a) => a.questionId === q.id));
  assert.equal((sec.match(/<details class="r2-qans">/g) || []).length, qs.length);
  assert.doesNotMatch(sec, /<details class="r2-qans" open/);
  for (const m of sec.matchAll(/<h3 class="r2-q">[^]*?<\/h3>\s*(<p class="r2-qv|<details class="r2-qans">)/g)) assert.match(m[1], /r2-qv/, 'the verdict line comes before the closed answers');
  assert.match(sec, /<summary>Read the \d+ answers?<\/summary>/);
});

test('links to an answer open the group around it (Read the whole answer, #ans- links)', () => {
  const r = load();
  const outer = { tagName: 'DETAILS', open: false, parentElement: { tagName: 'SECTION', open: false, parentElement: null } };
  const inner = { tagName: 'DETAILS', open: false, parentElement: outer };
  r.openAnswer(inner);
  assert.equal(inner.open, true);
  assert.equal(outer.open, true);
  assert.equal(outer.parentElement.open, false, 'only details elements are opened');
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  assert.match(src, /openAnswer\(d\);\r?\n\s+d\.scrollIntoView\(\{ behavior: 'smooth'/);
  assert.match(src, /if \(d\) \{ openAnswer\(d\); d\.scrollIntoView\(\{ block: 'start' \}\); \}/);
});

test('dead CSS for the removed bridge line is gone', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.ob-bridge/);
  assert.match(css, /\.r2-why-eg a, \.ob-small a \{ display: inline-block; padding: 10px 0; \}/);
});

// ---- Where the problems are (inside What to fix) and the example site (inside the Gemini card) ----
test('no "Why AI skips you" section anywhere; the older sections stay only on the findings-first order', () => {
  const html = render(load(), locked());
  assert.doesNotMatch(html, /Why AI skips you|r2-why|<h2>Why they got named instead<\/h2>|<h2>Can AI read your website\?<\/h2>|<h2>Your listings<\/h2>/);
  const plain = render(load({ tier: false }), locked());
  assert.match(plain, /<h2>Why they got named instead<\/h2>/);
  assert.match(plain, /<h2>Can AI read your website\?<\/h2>/);
  assert.doesNotMatch(plain, /r2-fixwhere/);
});

test('what to fix: up to three lines say where the problems are, from the report’s own numbers', () => {
  const r = load();
  const rep = locked();
  const html = render(r, rep);
  const fix = html.slice(html.indexOf('<h2>What to fix</h2>'), html.indexOf('id="offer"'));
  const rows = fix.match(/<ul class="r2-fixwhere">([^]*?)<\/ul>/)[1];
  assert.ok((rows.match(/<li>/g) || []).length <= 3);
  const failed = rep.siteCheck.checks - rep.siteCheck.passed;
  if (failed) assert.ok(rows.includes(`<b>Your website:</b> ${failed} of ${rep.siteCheck.checks} checks failed, so it’s harder for AI to read.`));
  if (rep.sourcesSummary.missingYou) assert.ok(rows.includes(`${rep.sourcesSummary.missingYou} of the ${rep.sourcesSummary.cited} we checked ${rep.sourcesSummary.missingYou === 1 ? 'lists' : 'list'} other`));
  if ((rep.listings || []).some((l) => l.status === 'mismatch')) assert.match(rows, /<b>Your .+ listings?:<\/b> (doesn’t|don’t) match your website, or we couldn’t find (it|them)\./);
  assert.doesNotMatch(rows, /robots|schema|sitemap|llms/i, 'never which checks failed');
  assert.ok(fix.indexOf('r2-fixtiles') < fix.indexOf('r2-fixwhere') && fix.indexOf('r2-fixwhere') < fix.indexOf('r2-locked-list'), 'tiles, then where, then the locked rows');
});

test('where the problems are: unreachable site, clean site, singular grammar, no data, escaping', () => {
  const r = load();
  const base = (o) => ({ business: { name: 'X', trade: 'plumbing' }, listings: [], ...o });
  const b = { trade: 'plumbing' };
  assert.match(r.fixWhereV2({ report: base({ siteCheck: { url: 'https://x.com', locked: true, reachable: false, checks: 13, passed: 0 } }), b }), /we couldn’t load it, and AI can’t read a site that doesn’t load/);
  assert.equal(r.fixWhereV2({ report: base({ siteCheck: { url: 'https://x.com', locked: true, reachable: true, checks: 13, passed: 13 } }), b }), '', 'a clean site adds no line');
  assert.equal(r.fixWhereV2({ report: base({}), b }), '');
  assert.match(r.fixWhereV2({ report: base({ sourcesSummary: { cited: 5, missingYou: 1 } }), b }), /1 of the 5 we checked lists other plumbers and not you\./);
  assert.match(r.fixWhereV2({ report: base({ sourcesSummary: { cited: 22, missingYou: 2 } }), b }), /2 of the 22 we checked list other plumbers and not you\./);
  assert.doesNotMatch(r.fixWhereV2({ report: base({ sourcesSummary: { cited: 22, missingYou: 0 } }), b }), /pages AI reads/);
  const one = r.fixWhereV2({ report: base({ listings: [{ platform: '<b>G</b>', status: 'mismatch' }] }), b });
  assert.match(one, /Your &lt;b&gt;G&lt;\/b&gt; listing:<\/b> doesn’t match your website, or we couldn’t find it\./);
  assert.match(r.fixWhereV2({ report: base({ listings: [{ platform: 'Google', status: 'mismatch' }, { platform: 'Yelp', status: 'mismatch' }] }), b }), /Your Google and Yelp listings:<\/b> don’t match your website, or we couldn’t find them\./);
});

test('example site in the Gemini card: the headline answer’s own citation, domain shown, full page linked, never the owner’s site, http(s) only', () => {
  const r = load();
  const rep = locked();
  const h = rep.answers.find((a) => a.id === rep.headline.answerId) || rep.answers[0];
  const aById = Object.fromEntries(rep.answers.map((a) => [a.id, a]));
  const qById = Object.fromEntries(rep.questions.map((q) => [q.id, q]));
  const t = r.computeTotalsV2(rep.answers);
  const call = (own) => r.heroV2(rep, { answers: rep.answers, aById, qById, t, cw: r.countWords(rep), engineList: 'Gemini', proven: [], provenIds: new Set(), zero: true, b: rep.business, ownDomain: own });
  h.citations = [{ domain: 'www.mine.com', url: 'https://www.mine.com/a' }, { domain: 'bad.com', url: 'javascript:alert(1)' }, { domain: 'www.varsity.com', url: 'https://www.varsity.com/smithtown-ny/plumbing/?a=1&b="2"' }];
  const html = call('mine.com');
  assert.match(html, /Check it yourself: [A-Za-z]+ used <a href="https:\/\/www\.varsity\.com\/smithtown-ny\/plumbing\/\?a=1&amp;b=(&quot;|%22)2(&quot;|%22)" rel="nofollow noopener" target="_blank">varsity\.com<\/a>/);
  assert.doesNotMatch(html, /mine\.com\/a|javascript:/);
  h.citations = [];
  assert.doesNotMatch(call('mine.com'), /Check it yourself/);
  h.citations = [{ domain: 'mine.com', url: 'https://mine.com/' }];
  assert.doesNotMatch(call('mine.com'), /Check it yourself/);
});

test('example site: on the real Werner-shaped report it is one page the report really cited', () => {
  const r = load();
  const rep = locked();
  const html = render(r, rep);
  const hero = html.slice(html.indexOf('class="r2-hero"'), html.indexOf('</ol>', html.indexOf('class="r2-hero"')));
  const after = html.slice(html.indexOf('class="r2-hero-read"'), html.indexOf('</p>', html.indexOf('class="r2-hero-read"')));
  const cited = rep.answers.flatMap((a) => (a.citations || []).map((c) => c.url));
  const m = after.match(/Check it yourself: [A-Za-z]+ used <a href="([^"]+)"/);
  if (m) assert.ok(cited.includes(m[1].replace(/&amp;/g, '&')));
  assert.ok(hero.length > 0);
});

// ---- final review round ----
test('every button that means "see the fixes" says the same thing (header, strip, offer, phone bar); a strong score says "See what to improve"', () => {
  const r = load();
  const low = { ...locked(), sample: false, score: { ...locked().score, score: 10 } };
  const html = render(r, low);
  assert.match(html, /data-scroll-offer>Show me the fixes — \$49</g);
  const strip = html.slice(html.indexOf('class="r2-strip"'), html.indexOf('</aside>'));
  assert.match(strip, />Show me the fixes — \$49</);
  assert.match(html.slice(html.indexOf('id="offer"')), /data-tier="xray" href="#" data-base-price="49">Show me the fixes — \$<span data-total>49<\/span><\/a>/);
  assert.doesNotMatch(html, /Show me every fix/);
  const high = render(r, { ...locked(), sample: false, score: { ...locked().score, score: 92 } });
  assert.match(high.slice(high.indexOf('id="offer"')), /data-base-price="49">See what to improve — \$<span data-total>49/);
  assert.equal(r.ctaLabel(low), 'Show me the fixes — $49');
  assert.equal(r.ctaWord(high.length ? { score: { score: 92 } } : {}), 'See what to improve');
});

test('every question, every answer: one line until opened; opening a link to an answer opens it', () => {
  const html = render(load(), locked());
  assert.match(html, /<details class="report-section r2-allans">\s*<summary><h2>Every question, every answer<\/h2><span class="r2-allans-n">\d+ answers?<\/span><\/summary>/);
  assert.doesNotMatch(html, /<details class="report-section r2-allans" open/);
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /details\.r2-allans > summary \{ cursor: pointer; display: flex;/);
});

test('example site: a subdomain of the owner’s site is the owner’s site', () => {
  const r = load();
  assert.equal(r.citedExampleV2([{ engine: 'gemini', citations: [{ domain: 'blog.mine.com', url: 'https://blog.mine.com/a' }] }], 'mine.com'), null);
  assert.equal(r.citedExampleV2([{ engine: 'gemini', citations: [{ domain: 'notmine.com', url: 'https://notmine.com/a' }] }], 'mine.com').domain, 'notmine.com');
});

test('where the problems are: a sources line needs both numbers (never "of the 0")', () => {
  const r = load();
  const base = { business: { name: 'X', trade: 'plumbing' }, listings: [] };
  assert.equal(r.fixWhereV2({ report: { ...base, sourcesSummary: { missingYou: 2 } }, b: { trade: 'plumbing' } }), '');
});

test('email box: after a successful send the label goes too, and hidden labels really hide', () => {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  assert.match(src, /f\.querySelector\('label'\)\?\.setAttribute\('hidden', ''\);/);
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.match(css, /\.lead-form label\[hidden\] \{ display: none; \}/);
});

test('dead offer CSS is gone (the old list, grid, kicker and lede)', () => {
  const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.ob-(stack|keep|lede|found|anchor|tag|head|kicker|grid|gets|price|price-note|secure)(?![\w-])/);
});
