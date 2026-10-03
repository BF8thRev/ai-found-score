// Lighter landing pages (Oct 2026, buyer feedback: "quick and easy and short, then click for more").
// What must stay on screen stays outside any <details>; the longer text is one click away, inside a
// closed <details>; nothing was dropped; print opens everything; the new CSS can't touch the report
// or Fix Kit pages, which share styles.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../../../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');

// How many <details> are open around position i (0 = on screen without a click).
function depth(html, i) {
  const before = html.slice(0, i);
  return (before.match(/<details[\s>]/g) || []).length - (before.match(/<\/details>/g) || []).length;
}
function at(html, needle) {
  const i = html.indexOf(needle);
  assert.ok(i >= 0, `missing: ${needle}`);
  return depth(html, i);
}
const visible = (html, needle, why) => assert.equal(at(html, needle), 0, `${needle} should be on screen (${why})`);
const oneClick = (html, needle) => assert.ok(at(html, needle) >= 1, `${needle} should be behind a click`);
const noOpen = (block) => assert.ok(!/<details[^>]*\sopen[\s>]/.test(block), 'the click-for-more starts closed');

test('homepage FAQ: four questions on screen, the other eight one click away, none dropped', () => {
  const index = read('index.html');
  const faq = /<section class="section" id="faq">[\s\S]*?<\/section>/.exec(index)[0];
  const ld = JSON.parse(/<script type="application\/ld\+json">(\{"@context": "https:\/\/schema\.org", "@type": "FAQPage"[\s\S]*?)<\/script>/.exec(index)[1]);
  const summaries = [...faq.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1]);
  assert.equal(summaries[0 + 4], 'More questions (8)');
  const questions = summaries.filter((s) => !/^More questions/.test(s));
  assert.equal(questions.length, 12);
  assert.deepEqual([...questions].sort(), ld.mainEntity.map((q) => q.name).sort(), 'every FAQ question is still on the page');
  for (const q of ld.mainEntity) assert.ok(faq.includes(q.acceptedAnswer.text), `answer kept word for word: ${q.name}`);
  for (const q of ['What is AI Found Score?', 'Is it really free?', 'What do I get for $49?', 'Can you guarantee AI will recommend my business?']) {
    assert.equal(depth(faq, faq.indexOf(`<summary>${q}</summary>`)), 1, `${q} is a top-level question`);
  }
  assert.equal(depth(faq, faq.indexOf('<summary>Who is behind AI Found Score?</summary>')), 2, 'later questions sit inside "More questions"');
  noOpen(faq);
});

test('homepage pricing: prices, what you get, the promise and both buttons stay on screen', () => {
  const index = read('index.html');
  const pricing = /<section class="section center" id="pricing">[\s\S]*?<\/section>/.exec(index)[0];
  assert.ok(!/<details/.test(pricing), 'nothing in the pricing cards is hidden');
  assert.match(pricing, /<div class="price">Free<\/div>/);
  assert.match(pricing, /<div class="price">\$49 <small>one-time<\/small><\/div>/);
  assert.equal((pricing.match(/<li[ >]/g) || []).length, 12, 'all 5 + 7 "what you get" lines');
  assert.match(pricing, /Fewer than 3 problems specific to your business\? <b>Your \$49 back\.<\/b>/);
  assert.match(pricing, /\*Being added now\. Your report lists exactly which assistants we asked\./);
  assert.match(pricing, /data-offer="free_snapshot" href="#request">Get my free snapshot</);
  assert.match(pricing, /data-offer="full_audit" href="\/checkout">Get my audit</);
});

test('homepage: the hero and the free-report form are untouched by the tidy-up', () => {
  const index = read('index.html');
  const hero = /<section class="hero">[\s\S]*?<\/section>/.exec(index)[0];
  assert.ok(!/<details/.test(hero));
  assert.match(hero, /<h1>Your customers are asking AI now\. <span class="h1-accent">Is it sending your calls to someone else\?<\/span><\/h1>/);
  assert.match(index, /<div class="cards what-points">/);
  assert.match(index, /<div class="cards four trust-points">/);
});

test('checkout: price, the add-on, the promise, no-subscription and the pay button on screen; the full list one click away', () => {
  const co = read('checkout.html');
  visible(co, '<span>$49</span>', 'the price');
  visible(co, 'Competitor Breakdown <em>+$25</em>', 'the add-on box');
  visible(co, 'id="co-pay"', 'the pay button');
  visible(co, 'No subscription, no auto-renew.', 'no subscription');
  visible(co, 'reply to your receipt and we refund your $49.', 'the refund promise');
  visible(co, 'Money-back promise', 'the refund badge');
  visible(co, 'Secure payment by Stripe.', 'secure payment');
  const sum = /<aside class="co-card co-summary"[\s\S]*?<\/aside>/.exec(co)[0];
  const more = /<details class="co-more">\s*<summary>Show all 7 included<\/summary>([\s\S]*?)<\/details>/.exec(sum);
  assert.ok(more, 'a closed "Show all 7 included"');
  noOpen(sum);
  const shown = sum.slice(0, sum.indexOf('<details')).match(/<li>/g) || [];
  const behind = more[1].match(/<li>/g) || [];
  assert.equal(shown.length, 3, 'three lines of what is included on screen');
  assert.equal(shown.length + behind.length, 7, 'all seven lines are still there');
  visible(co, 'All 7 customer questions on every AI assistant we check', 'the headline item');
  oneClick(co, 'A free re-check in 30 days');
  // The add-on detail list is still shown by the script when the box is ticked, not by a click.
  visible(co, 'id="list-breakdown"', 'shown with the add-on');
});

test('about page: the start of each part on screen, the long parts one click away, nothing dropped', () => {
  const about = read('about.html');
  visible(about, 'My dad ran a small service business.', 'the note opens on screen');
  visible(about, 'I believe every business, big or small, should have the tools to be found', 'the note closes on screen');
  visible(about, '<strong>Bryan Fields</strong><br>Founder, AI Found Score', 'the signature');
  oneClick(about, 'My mom has spent her life helping people.');
  oneClick(about, 'Most of the businesses I know are not ready for this');
  visible(about, 'AI Found Score is run largely by an AI agent', 'the AI-run line');
  oneClick(about, 'go looking for local businesses that AI isn&rsquo;t naming');
  const diff = /<div class="diff-list">([\s\S]*?)<\/div>/.exec(about)[1];
  const items = [...diff.matchAll(/<details><summary>([^<]+)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)];
  assert.deepEqual(items.map((m) => m[1]), [
    'We show you the real answer.', 'We name who got the call.', 'You get the fix, not just the problem.',
    'No logins, ever.', 'Free to look, no strings.', 'Plain English.', 'Honest about the limits.',
  ]);
  assert.match(items[6][2], /^No one can promise what an AI will say\./);
  noOpen(about);
  visible(about, 'Each report lists exactly which assistants we asked and when.', 'where the data comes from');
});

test('print and Save as PDF open everything behind a click', () => {
  for (const f of ['index.html', 'about.html', 'checkout.html']) {
    assert.match(read(f), /addEventListener\('beforeprint', function \(\) \{ document\.querySelectorAll\('details'\)\.forEach\(function \(d\) \{ d\.open = true; \}\); \}\)/, f);
  }
});

test('one stylesheet version everywhere, and the new rules cannot reach the report or Fix Kit pages', () => {
  const versions = new Set();
  for (const f of ['index.html', 'about.html', 'checkout.html', 'success.html', 'contact.html', 'report.html', 'fix-kit.html', 'plan.html', 'privacy.html', 'terms.html', 'refunds.html', 'unsubscribe.html']) {
    versions.add(/\/css\/styles\.css\?v=(\d+)"/.exec(read(f))[1]);
  }
  assert.deepEqual([...versions], ['19']);
  for (const f of ['index.html', 'about.html', 'success.html', 'contact.html']) assert.match(read(f), /<body class="lp">/, f);
  const css = read('css/styles.css');
  const block = css.slice(css.indexOf('/* ---------- Lighter landing pages'));
  assert.ok(block.length > 200, 'the landing-page block is in styles.css');
  const own = /^(\.lp\b|\.co-page\b|\.what-points\b|\.trust-points\b|\.faq \.faq-more\b|\.page details\.more\b|\.diff-list\b|\.co-more\b|\.co-incl \+ \.co-more\b|\.more-line\b|\.what-points \.card \.more-line\b|\.how-step \.more-line\b)/;
  const selectors = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter(Boolean);
  for (const group of selectors) for (const sel of group.split(',')) assert.match(sel.trim(), own, `unscoped rule: ${sel.trim()}`);
  // The new classes are only used by the landing pages.
  const shared = ['report.html', 'fix-kit.html', 'js/report.js', 'js/fix-kit.js'].map(read).join('\n');
  for (const cls of ['lp', 'what-points', 'trust-points', 'faq-more', 'diff-list', 'co-more', 'more-line']) {
    assert.ok(!new RegExp(`class="[^"]*\\b${cls}\\b|'${cls}'|\\.${cls}\\b`).test(shared), `${cls} is used by the report or Fix Kit`);
  }
});
