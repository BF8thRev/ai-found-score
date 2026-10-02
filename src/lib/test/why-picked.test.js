// The paid report after the Oct 2 2026 owner review of the PR 73 page, through the real routes
// (src/worker.js /api/report/<token>) and the page that renders them (public/js/report.js in a vm):
//   - the FAQ step points to the Fix Kit (the page is written there) instead of pasting the Q&A and its code;
//   - "Why AI picked them": for each firm AI named instead, what AI said (quoted from the answer) and the
//     pages it read, in place of the search card, "Who AI recommended instead" and "Why they got named
//     instead" (a locked free report keeps those);
//   - "The proof": every answer as clean, safe HTML (no literal ###, ** or ---; a <script> or a javascript:
//     link in an answer stays inert text), with a one-line summary above each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { buildPr73Report } from '../../../scanner/test/fixtures/pr73.js';
import { lintText, pickHeadline } from '../../../shared/report-v2.js';
import { quoteFor, plainLine } from '../../../shared/why-picked.js';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const TOKEN = 'pR73tokenAbCdEfGhIjKl1';
const reply = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

/** The real Worker over a fake Supabase holding `stored`; paid (an xray payment) unless `paid: false`. */
async function withWorker(stored, fn, { paid = true } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === '/rest/v1/rpc/report_unlocked') return reply(paid);
    if (u.pathname === '/rest/v1/scan_results') return reply(stored ? [{ version: 2, report: stored, scanned_at: '2026-10-01T17:51:00Z' }] : []);
    if (u.pathname === '/rest/v1/payments') return reply(paid ? [{ tier: 'xray', amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' }] : []);
    return reply([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = { SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service', ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
    const call = (path) => worker.fetch(new Request(`https://aifoundscore.com${path}`), env, { waitUntil() {} });
    await fn(call);
  } finally {
    globalThis.fetch = real;
  }
}

function render(report) {
  const src = readFileSync(new URL('../../../public/js/report.js', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    document: { addEventListener() {}, querySelector: () => null, getElementById: () => null, body: { classList: { toggle() {} } } },
    window: { location: { search: '', hash: '' }, tierOffered: () => true, scrollY: 0, addEventListener() {} },
    location: { search: '', hash: '' }, URLSearchParams, console,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0,
  });
  vm.runInContext(src, ctx);
  const root = { innerHTML: '', addEventListener() {}, querySelector: () => null };
  ctx.renderV2(root, report);
  return root.innerHTML;
}
const section = (html, id) => { const i = html.indexOf(`id="${id}"`); assert.ok(i >= 0, `has #${id}`); return html.slice(i, html.indexOf('</section>', i)); };
const stepHtml = (html, body, id) => {
  const n = body.xray.actionPlan.items.findIndex((i) => i.id === id) + 1;
  assert.ok(n > 0, `plan has a ${id} step`);
  const i = html.indexOf(`id="step-${n}"`);
  return html.slice(i, html.indexOf('</li>\n', i));
};
const words = (html) => html.replace(/href="[^"]*"/g, '').replace(/<[^>]+>/g, ' ');

test('FAQ step on the paid PR 73 page: points to the Fix Kit, with how many answers need a detail; no Q&A or code pasted', async () => {
  const { report } = await buildPr73Report();
  await withWorker(report, async (call) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const html = render(body);
    const faq = stepHtml(html, body, 'faq');
    const k = body.xray.actionPlan.items.find((i) => i.id === 'faq').kit;
    assert.ok(k.questions >= 2 && k.needs >= 1, JSON.stringify(k));
    assert.match(faq, /<p class="ap-why"><b>Why it matters:<\/b> AI was asked/, 'the why stays');
    assert.match(faq, new RegExp(`<b>Drafted for you\\.</b> Your Questions page is in your Fix Kit: ${k.questions} questions and answers, starting with the ${k.fromScan} questions AI was asked in this scan`));
    assert.match(faq, new RegExp(`${k.needs} answers? needs? one detail only you know`));
    assert.match(faq, new RegExp(`<a class="btn-secondary" href="/fix-kit/${encodeURIComponent(body.id)}">Open my Fix Kit</a>`));
    // Nothing of the page itself: no copy box, no FAQ code, no answers.
    assert.doesNotMatch(faq, /class="r2-copy"|FAQPage|application\/ld\+json|Questions and answers for your website/);
    assert.doesNotMatch(html, /FAQ code: the finished answers only/);
    // The business code is the kit's too.
    const contact = body.xray.actionPlan.items.find((i) => i.id === 'contact');
    if (contact) assert.doesNotMatch(stepHtml(html, body, 'contact'), /application\/ld\+json|Business code for your web person/);
  });
});

test('"Why AI picked them" on the paid PR 73 page: a quoted reason and the pages AI read for each firm; the old sections are gone', async () => {
  const { report } = await buildPr73Report();
  await withWorker(report, async (call) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    const html = render(body);
    const why = section(html, 'why-picked');
    assert.match(why, /<h2>Why AI picked them<\/h2>/);
    // In place of the search card, "Who AI recommended instead" and "Why they got named instead".
    assert.doesNotMatch(html, /class="r2-hero"|told a customer who asked|id="who"|Who AI recommended instead|Why they got named instead/);
    // The verdict box stays first, as it was.
    assert.ok(html.indexOf('class="r2-verdict') < html.indexOf('id="action-plan"') && html.indexOf('id="action-plan"') < html.indexOf('id="why-picked"'));
    const lists = body.xray.actionPlan.items.findIndex((i) => i.id === 'lists') + 1;
    for (const [name, quotes] of [
      ['Brightline Communications', ['Brightline Communications and Kestrel PR are well known New York PR agencies.', 'Many people pick Brightline Communications; Kestrel PR is also well reviewed.']],
      ['Kestrel PR', ['Brightline Communications and Kestrel PR are well known New York PR agencies.', 'Many people pick Brightline Communications; Kestrel PR is also well reviewed.']],
    ]) {
      const i = why.indexOf(`<h3>${name}`);
      assert.ok(i >= 0, name);
      const card = why.slice(i, why.indexOf('</article>', i));
      assert.match(card, /Named in 4 of 4 answers/);
      assert.match(card, /Asked for: best, a specific job/);
      // WHY: quoted word for word from two assistants.
      for (const q of quotes) assert.ok(card.includes(`“${q}”`), `${name}: ${q}`);
      assert.match(card, /As ChatGPT wrote it/);
      assert.match(card, /As Gemini wrote it/);
      // WHERE: the pages AI read in the answers that named them, the owner's status on each list, and the step.
      for (const d of ['clutch.co', 'goodfirms.co', 'themanifest.com', 'communicationsmatch.com']) assert.match(card, new RegExp(d.replace(/\./g, '\\.')), `${name} read ${d}`);
      assert.match(card, /<a href="https:\/\/www\.goodfirms\.co\/directory\/city\/public-relations\/new-york"[^>]*>GoodFirms<\/a> <span class="r2-muted">goodfirms\.co<\/span> <span class="ap-type">List<\/span> <span class="badge mismatch">You’re not on it<\/span>/);
      assert.match(card, /CommunicationsMatch<\/a>[^<]*<span class="r2-muted">communicationsmatch\.com<\/span> <span class="ap-type">List<\/span> <span class="badge match">You’re listed<\/span>/);
      assert.match(card, new RegExp(`AI read Clutch, CommunicationsMatch, DesignRush and 3 more when it named them; you can get on 5 of them \\(<a href="#step-${lists}" data-step="${lists}">step ${lists}</a>\\)\\.`));
    }
    // The takeaway generalizes only what the answers show, with the counts.
    assert.match(why, /<b>In short:<\/b> AI most often described these firms by reviews and reputation, and read Clutch, CommunicationsMatch and DesignRush when it named them\./);
    assert.match(why, /Counted over the 2 firms below: reviews and reputation: 2 of 2\./);
    // The owner's row: named 0 of 4, and where they're missing.
    assert.match(why, new RegExp(`<h3>PR 73 <span class="r2-muted">\\(you\\)</span></h3>\\s*<p>Named in 0 of 4 answers\\. Of the lists AI read for these firms, you’re not on GoodFirms and Public Relations Database \\(<a href="#step-${lists}" data-step="${lists}">step ${lists}</a>\\)\\. You’re already on CommunicationsMatch: check the details match\\.</p>`));
    // Our copy has no banned words.
    assert.deepEqual(lintText(words(why)).map((h) => h.word), []);
  });
});

test('a locked free report keeps its sales layout: the search card and who got named', async () => {
  const { report } = await buildPr73Report();
  await withWorker(report, async (call) => {
    const body = await (await call(`/api/report/${TOKEN}`)).json();
    assert.equal(body.locked, true);
    assert.equal(body.xray.whyPicked, undefined, 'never sent unpaid');
    const html = render(body);
    assert.doesNotMatch(html, /id="why-picked"|Why AI picked them/);
    assert.match(html, /class="r2-hero"/);
    assert.match(html, /told a customer who asked/);
    assert.match(html, /<section class="report-section" id="who">\s*<h2>Who got the call instead<\/h2>/);
    // (A free page with the offer has no sources list of its own; the offer band carries the count.)
    assert.match(html, /<h2>What to fix<\/h2>/);
    assert.match(html, /<h2>The proof: what AI answered<\/h2>/);
  }, { paid: false });
});

// An answer the way assistants write them: markdown, a link, a table, and things that must never run.
const MD = [
  '### Top picks',
  '',
  '1. **Brightline Communications** – The definitive *New York* institution, known for [media relations](https://brightline.example.com/about).',
  '   - Clients include national consumer brands.',
  '2. **Kestrel PR**: a boutique agency that works with startups.',
  '',
  '---',
  '',
  '| Firm | Focus |',
  '|---|---|',
  '| Kestrel PR | Startups |',
  '',
  'Also worth a look: **PR73**.',
  '<script>alert(1)</script> and [click me](javascript:alert(2)) and <img src=x onerror=alert(3)> and [x](https://e.example/"onmouseover="alert(4))',
].join('\n');

async function markdownReport() {
  const { report } = await buildPr73Report();
  const a = report.answers.find((x) => x.id === 'a1');
  a.text = MD;
  a.businessesNamed = [
    { name: 'Brightline Communications', pos: MD.indexOf('Brightline Communications'), entityId: 'e1' },
    { name: 'Kestrel PR', pos: MD.indexOf('Kestrel PR'), entityId: 'e2' },
    { name: 'PR73', pos: MD.indexOf('PR73'), entityId: null, isYou: true },
  ];
  a.namedYou = true;
  a.namedYouFirst = false;
  a.ownerMatch = 'exact';
  report.totals = { ...report.totals, namedYou: report.totals.namedYou + 1 };
  report.headline = pickHeadline(report);
  return report;
}

test('the proof: answers render as clean HTML (no ###, ** or ---), names bolded, the owner highlighted, a summary line above', async () => {
  const report = await markdownReport();
  await withWorker(report, async (call) => {
    const res = await call(`/api/report/${TOKEN}`);
    assert.equal(res.status, 200, 'passes the serve-time guardrails');
    const body = await res.json();
    const html = render(body);
    assert.match(html, /<h2>The proof: every answer, word for word<\/h2>/);
    assert.doesNotMatch(html, /Every question, every answer/);
    const i = html.indexOf('id="ans-a1"');
    const ans = html.slice(i, html.indexOf('</details>', i));
    assert.doesNotMatch(ans, /###|\*\*|---|<blockquote>/);
    assert.match(ans, /<div class="r2-md"><h4 class="md-h">Top picks<\/h4><ol><li><strong><b>Brightline Communications<\/b><\/strong> – The definitive <em>New York<\/em> institution, known for <a href="https:\/\/brightline\.example\.com\/about" rel="nofollow noopener" target="_blank">media relations<\/a>\.<ul><li>Clients include national consumer brands\.<\/li><\/ul><\/li><li><strong><b>Kestrel PR<\/b><\/strong>: a boutique agency that works with startups\.<\/li><\/ol>/);
    assert.match(ans, /<table class="md-table"><thead><tr><th>Firm<\/th><th>Focus<\/th><\/tr><\/thead><tbody><tr><td><b>Kestrel PR<\/b><\/td><td>Startups<\/td><\/tr><\/tbody><\/table>/);
    assert.match(ans, /Also worth a look: <strong><mark>PR73<\/mark><\/strong>\./, 'the owner highlighted');
    // The one-line summary: who it named, what it read, whether it named the owner.
    assert.match(ans, /<p class="r2-ans-sum"><span><b>Named:<\/b> Brightline Communications, Kestrel PR<\/span><span><b>Read:<\/b> clutch\.co, communicationsmatch\.com \+ 1 more<\/span><span class="yes">Named you<\/span><\/p>/);
    // The quote in "Why AI picked them" is the same words without the markdown.
    assert.match(section(html, 'why-picked'), /“Brightline Communications – The definitive New York institution, known for media relations\.”/);
  });
});

test('the proof is XSS-safe: a <script>, an <img onerror> and javascript: links in an answer stay inert text', async () => {
  const report = await markdownReport();
  await withWorker(report, async (call) => {
    const html = render(await (await call(`/api/report/${TOKEN}`)).json());
    const i = html.indexOf('id="ans-a1"');
    const ans = html.slice(i, html.indexOf('</details>', i));
    // No real tag or attribute from the answer: only escaped text.
    assert.doesNotMatch(html, /<script|<img src=x|<[^>]*\sonerror=|<[^>]*\sonmouseover=|href="javascript:/i);
    assert.match(ans, /&lt;script&gt;alert\(1\)&lt;\/script&gt; and click me and &lt;img src=x onerror=alert\(3\)&gt;/);
    // A link whose address tries to break out of the attribute stays inside it, escaped.
    assert.match(ans, /<a href="https:\/\/e\.example\/&quot;onmouseover=&quot;alert\(4\)" rel="nofollow noopener" target="_blank">x<\/a>/);
  });
});

test('markdown helpers: escape first, whitelist after; quotes take the line or the sentence around the name', () => {
  assert.equal(plainLine('1. **Rubenstein** – The definitive *New York* institution [1]'), 'Rubenstein – The definitive New York institution');
  const t = '### Rubenstein\n- Legendary for representing iconic NYC institutions.\n- Big team.\n\n### DKC\n- Something else.';
  const list = [{ name: 'Rubenstein', pos: t.indexOf('Rubenstein'), entityId: 'r' }, { name: 'DKC', pos: t.indexOf('DKC'), entityId: 'd' }];
  assert.equal(quoteFor(t, list[0], list).text, 'Rubenstein: Legendary for representing iconic NYC institutions. · Big team.');
  const p = `${'Lots of firms work in the city and many of them are large. '.repeat(6)}Rubenstein is known for crisis work. Other firms exist.`;
  const b = { name: 'Rubenstein', pos: p.indexOf('Rubenstein'), entityId: 'r' };
  assert.equal(quoteFor(p, b, [b]).text, 'Rubenstein is known for crisis work.');
});

test('GET /api/report/sample-001: the sample renders the new evidence, the size block and clean answers', async () => {
  await withWorker(null, async (call) => {
    const res = await call('/api/report/sample-001');
    assert.equal(res.status, 200);
    const body = await res.json();
    const html = render(body);
    const why = section(html, 'why-picked');
    assert.match(why, /<h3>Businesses your size<\/h3>/);
    assert.match(why, /<h3>Kessler Bros\. Plumbing <span class="ap-whotag">Named for a business your size<\/span><\/h3>/);
    assert.match(why, /“Kessler Bros\. Plumbing – Family-owned, known for clear pricing\.”/);
    assert.match(why, /<h3>Harborview Plumbing &amp; Heating <span class="r2-muted">\(you\)<\/span><\/h3>/);
    assert.doesNotMatch(html, /told a customer who asked|Who got the call instead|Why they got named instead/);
    assert.match(html, /<div class="r2-md">/);
    assert.match(html, /<h2>The proof: every answer, word for word<\/h2>/);
    // The sample's kit steps link to the sample kit only.
    assert.match(html, /<a class="btn-secondary" href="\/fix-kit\/sample-001">See the sample Fix Kit<\/a>/);
    assert.deepEqual(lintText(words(why)).map((h) => h.word), []);
  });
});
