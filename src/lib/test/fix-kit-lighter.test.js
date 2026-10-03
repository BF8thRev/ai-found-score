// The lighter Fix Kit page (Oct 2 2026 buyer feedback: "quick and easy and short, then click for more").
// public/fix-kit.html + public/js/fix-kit.js: each block shows a heading, one line and its action; the
// how/why, the long list of blanks, the AI drafts' sources and the file contents sit behind <details>.
// Served through the real Worker (the page and the sample kit's API), then the page and script are read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const PUBLIC = new URL('../../../public/', import.meta.url);
const read = (p) => readFileSync(new URL(p, PUBLIC), 'utf8');
const HTML = read('fix-kit.html');
const JS = read('js/fix-kit.js');

async function withWorker(fn) {
  globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
  const { default: worker } = await import('../../worker.js');
  const served = [];
  const env = {
    SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service',
    // The real files: /fix-kit -> public/fix-kit.html.
    ASSETS: { fetch: async (req) => {
      const p = new URL(req.url).pathname;
      served.push(p);
      const file = p === '/fix-kit' ? 'fix-kit.html' : p.slice(1);
      return new Response(read(file), { headers: { 'Content-Type': 'text/html' } });
    } },
  };
  const call = (path, init) => worker.fetch(new Request(`https://aifoundscore.com${path}`, init), env, { waitUntil() {} });
  await fn({ call, served });
}

// The kit's visible part: from the h1 to the end of the kit state.
const kitHtml = (html) => html.slice(html.indexOf('data-state="kit"'), html.indexOf('</main>'));
// Text outside any <details> (what shows before a click).
const visible = (html) => html.replace(/<details[\s\S]*?<\/details>/g, '');

test('router: /fix-kit/sample-001 serves the lighter page: short lede, 3 steps, caveat still on screen', async () => {
  await withWorker(async ({ call, served }) => {
    const res = await call('/fix-kit/sample-001');
    assert.equal(res.status, 200);
    assert.deepEqual(served, ['/fix-kit']);
    const kit = kitHtml(await res.text());
    // The lede is one short paragraph; the how-to is three numbered steps.
    const lede = kit.match(/<p class="lede-page">([\s\S]*?)<\/p>/)[1];
    assert.ok(lede.replace(/<[^>]+>/g, '').length <= 140, `lede is ${lede.length} chars`);
    assert.match(lede, /correct facts/);
    assert.match(lede, /from your website and your report/);
    const steps = kit.match(/<ol class="fk-steps">([\s\S]*?)<\/ol>/)[1];
    assert.deepEqual([...steps.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]), ['Check the details', 'Tick the box and download', 'Hand the folder to whoever runs your website']);
    // The honesty line stays next to the claim, not behind a click.
    assert.match(visible(kit), /We can&rsquo;t promise any assistant will name you; the last item in your kit says what to expect and how to tell\./);
    // The help box's promises stay on screen too.
    assert.match(visible(kit), /Asking is free, you don&rsquo;t owe anything unless you say yes in writing, it&rsquo;s one reply and not a mailing list, and we never ask for a password here\./);
    // Nothing starts open.
    assert.doesNotMatch(kit, /<details[^>]*\sopen/);
    // Cache-buster on the changed script.
    assert.match(await (await call('/fix-kit/sample-001')).text(), /<script src="\/js\/fix-kit\.js\?v=\d+"><\/script>/);
  });
});

test('router: the sample kit has more than 3 blanks and every job has a "where it goes", so both clicks have content', async () => {
  await withWorker(async ({ call }) => {
    const res = await call('/api/fix-kit/sample-001');
    assert.equal(res.status, 200);
    const { kit } = await res.json();
    assert.ok(kit.faq.items.filter((i) => i.slot).length > 3, 'sample shows "Show all N"');
    for (const j of kit.jobs) assert.ok(j.where, j.id);
  });
});

test('the blanks: why we ask is inside a closed <details>; the first 3 show and the rest sit behind "Show all N"', () => {
  const needs = HTML.slice(HTML.indexOf('id="fk-needs"'), HTML.indexOf('data-sec="you"'));
  const why = needs.match(/<details class="fk-why"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(why, 'a "Why we ask" click');
  assert.match(why[1], /<summary>Why we ask<\/summary>/);
  assert.match(why[1], /AI picked other businesses for things only you can tell it, like <span data-needs-why>/);
  assert.doesNotMatch(visible(needs), /AI picked other businesses/, 'the why is not on screen before the click');
  assert.match(visible(needs), /Write one true sentence for each and we put it into the answer\. Any you leave blank stay out of the code until you fill them in\./);
  assert.match(JS, /var SHOW_SLOTS = 3;/);
  assert.match(JS, /more\.appendChild\(el\('summary', null, 'Show all ' \+ items\.length\)\);/);
  assert.match(JS, /\(more && n >= SHOW_SLOTS \? more : wrap\)\.appendChild\(row\);/);
  // "Add to my answers" still reads every blank, the hidden ones too.
  assert.match(JS, /document\.querySelectorAll\('\[data-slot\]'\)\.forEach\(function \(input\) \{ d\.faqFacts/);
  // A note on a field behind a click opens it, so the owner sees what to fix.
  assert.match(JS, /for \(var d = f\.closest\('details'\); d; d = d\.parentElement && d\.parentElement\.closest\('details'\)\) d\.open = true;/);
});

test('each job: title, one line, who/time and its caveat on screen; where it goes and the steps behind "How to do it"', () => {
  const draw = JS.slice(JS.indexOf('function drawJobs'), JS.indexOf('if (kit.readme)'));
  const at = (s) => { const i = draw.indexOf(s); assert.ok(i >= 0, s); return i; };
  // Visible first: the one line, the who/time line, the note (a caveat like "your site already has code").
  assert.ok(at("li.appendChild(el('p', null, j.what));") < at("var how = el('details', 'fk-how');"));
  assert.ok(at("li.appendChild(el('p', 'who'") < at("var how = el('details', 'fk-how');"));
  assert.ok(at("if (j.note) li.appendChild(el('p', 'fk-note sample', j.note));") < at("var how = el('details', 'fk-how');"));
  assert.match(draw, /how\.appendChild\(el\('summary', null, 'How to do it'\)\);/);
  // Inside the click: where it goes, the site builder's steps, and why the FAQ covers what it covers.
  assert.match(draw, /how\.appendChild\(where\);/);
  assert.match(draw, /how\.appendChild\(box\);/);
  assert.match(draw, /how\.appendChild\(el\('p', null, 'When AI picked other businesses, it mentioned '/);
  assert.doesNotMatch(draw, /li\.appendChild\(where\)|li\.appendChild\(box\)/);
  // The full Q&A and every file stay one click away, as before.
  assert.match(draw, /'Read all ' \+ plural\(/);
  assert.match(JS, /el\('summary', null, 'See the file: ' \+ f\.path\)/);
});

test('download box: one fixed line, and what is still open goes on its own line under it', () => {
  assert.match(HTML, /<p class="fk-take" data-dl-note>Every file below, plus a one-page guide for whoever runs your website\. Nothing changes on your website until someone puts the files in place\.<\/p>/);
  assert.match(HTML, /<p class="fk-dl-needs" data-dl-needs hidden><\/p>/);
  assert.doesNotMatch(JS, /\$\('\[data-dl-note\]'\)/, 'the script no longer rewrites the note');
  assert.match(JS, /var note = \$\('\[data-dl-needs\]'\);/);
  assert.match(JS, /'You can download now; '/);
  assert.match(JS, /el\('a', null, 'Fill them in below'\)/);
});

test('AI drafts: the sentence and "Use this" on screen; the words from their website behind "Where this came from"', () => {
  const box = JS.slice(JS.indexOf("var box = suggestBox('Drafted by AI from your website. Check that it is true"), JS.indexOf('row.appendChild(box);'));
  assert.ok(box.indexOf("el('button', 'btn-secondary', 'Use this')") < box.indexOf("var src = el('details', 'fk-src');"));
  assert.match(box, /src\.appendChild\(el\('summary', null, 'Where this came from'\)\);\s*src\.appendChild\(el\('p', 'fk-suggest-q', 'From your website: “' \+ s\.quote \+ '”'\)\);/);
});

test('print opens every click-for-more, and the page has room: wide gaps, roomy cards, 44px tap targets', () => {
  assert.match(JS, /window\.addEventListener\('beforeprint', function \(\) \{\s*openedForPrint = \[\]\.slice\.call\(document\.querySelectorAll\('\.fk details:not\(\[open\]\)'\)\);/);
  assert.match(JS, /window\.addEventListener\('afterprint'/);
  // The last section-heading rule wins. Owner's second pass ("add more space"): at least 80px on
  // desktop, 52-64px on a phone.
  const desk = [...HTML.matchAll(/\.fk h2\.fk-section \{ margin: (\d+)px/g)].map((m) => Number(m[1])).pop();
  assert.ok(desk >= 80 && desk <= 96, `desktop section gap ${desk}px`);
  const phone = [...HTML.matchAll(/\.fk h2\.fk-section \{ margin-top: (\d+)px/g)].map((m) => Number(m[1])).pop();
  assert.ok(phone >= 52 && phone <= 64, `phone section gap ${phone}px`);
  assert.match(HTML, /\.fk-box \{ padding: 40px 44px; margin: 0 0 72px; \}/);
  assert.match(HTML, /\.fk-job \{ padding: 32px 36px; \}/);
  assert.match(HTML, /\.fk details > summary \{[^}]*min-height: 44px/);
});

test('second pass: line-height 1.65, a softer body colour that still passes AA, no bold sentences, sizes kept', () => {
  const rule = HTML.match(/\.fk \{ --ink: (#[0-9A-F]{6}); color: var\(--ink\); padding: 56px 0 112px; line-height: 1\.65; \}/i);
  assert.ok(rule, 'the page body rule');
  // WCAG contrast of the body colour against every background on the page: at least 4.5:1.
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const bg of ['#FFFFFF', '#F4F7FB', '#FFFAF0', '#F1FAF5', '#F5F9FF', '#EEF4FE']) assert.ok(ratio(rule[1], bg) >= 4.5, `${rule[1]} on ${bg}`);
  assert.notEqual(rule[1].toUpperCase(), '#14213A', 'softer than the site ink');
  // Sentences are not bold: the ownership tick, status lines, the "Start here" line, the AI-draft
  // warning and the step pills. Labels stay a step bolder than body text.
  assert.match(HTML, /\.fk \.fk-confirm \{ font-weight: 500;/, 'outranks .fk-field label');
  assert.match(HTML, /\.fk-status, \.fk-most, \.fk-suggest \.fk-suggest-h \{ font-weight: 500; \}/);
  assert.match(HTML, /\.fk-steps li \{[^}]*font-weight: 500;/);
  assert.match(HTML, /\.fk-facts \.k, \.fk-field label \{ font-weight: 600; \}/);
  // Font sizes not shrunk.
  assert.match(HTML, /\.fk \.lede-page \{ font-size: 19px;/);
  assert.match(HTML, /\.fk-steps li \{[^}]*font-size: 15px;/);
  assert.match(HTML, /\.fk-job h3 \{ font-size: 20px; \}/);
});
