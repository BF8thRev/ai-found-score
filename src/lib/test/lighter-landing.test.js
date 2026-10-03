// Lighter landing pages (Oct 2026). Buyer feedback: "quick and easy and short, then click for more";
// owner: "add more space, it feels heavier text a tiny bit"; review of 8cbe63a: no folds over short
// fragments, promises and caveats stay on screen, one disclosure marker (details.disc).
// What must stay on screen sits outside any <details>; the few folds left start closed and say what's
// inside; nothing was dropped; print opens everything and closes it again; the new CSS is one block
// that can't reach the report or Fix Kit pages, which share styles.css.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../../../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');
const section = (html, id) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)[0];
const block = () => { const css = read('css/styles.css'); return css.slice(css.indexOf('/* ---------- Lighter landing pages')); };

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
const noOpen = (b) => assert.ok(!/<details[^>]*\sopen[\s>]/.test(b), 'the click-for-more starts closed');

test('homepage FAQ: four questions on screen, the other eight behind "More questions (8)", none dropped', () => {
  const index = read('index.html');
  const faq = section(index, 'faq');
  const ld = JSON.parse(/<script type="application\/ld\+json">(\{"@context": "https:\/\/schema\.org", "@type": "FAQPage"[\s\S]*?)<\/script>/.exec(index)[1]);
  assert.match(faq, /<details class="faq-more disc">\s*<summary>More questions \(8\)<\/summary>/);
  const questions = [...faq.matchAll(/<summary>([^<]*)<\/summary>/g)].map((m) => m[1]).filter((s) => !/^More questions/.test(s));
  assert.equal(questions.length, 12);
  assert.deepEqual([...questions].sort(), ld.mainEntity.map((q) => q.name).sort(), 'every FAQ question is still on the page');
  for (const q of ld.mainEntity) assert.ok(faq.includes(q.acceptedAnswer.text), `answer kept word for word: ${q.name}`);
  for (const q of ['What is AI Found Score?', 'Is it really free?', 'What do I get for $49?', 'Can you guarantee AI will recommend my business?']) {
    assert.equal(depth(faq, faq.indexOf(`<summary>${q}</summary>`)), 1, `${q} is a top-level question`);
  }
  assert.equal(depth(faq, faq.indexOf('<summary>Who is behind AI Found Score?</summary>')), 2, 'later questions sit inside "More questions"');
  noOpen(faq);
});

test('FAQ "More questions": the FAQ\'s own +/– never shows on it, open or closed (specificity)', () => {
  const css = block();
  // .faq details[open] summary::after (2 classes) would put a stray "–" over "(8)"; this rule has 3.
  assert.match(css, /\.faq details\.faq-more > summary::after, \.faq details\.faq-more\[open\] > summary::after \{ content: none; \}/);
  assert.match(css, /\.faq \.faq-more details:not\(\[open\]\) > summary::after \{ content: "\+"; \}/);
});

test('homepage cards and steps: every line is on screen again (no "More" folds), word for word as before', () => {
  const index = read('index.html');
  assert.ok(!/more-line|<summary>More<\/summary>/.test(index), 'no bare "More" folds');
  for (const id of ['what', 'how', 'trust', 'pricing']) assert.ok(!/<details/.test(section(index, id)), `${id}: nothing hidden`);
  for (const line of [
    'The exact questions, the exact answers. Type them in yourself and check.',
    'Your hours, prices, and phone number as the AI states them, so you can catch what it gets wrong.',
    'Your business name and website. No email, no card. We find your town from your website.',
    'Live, with web search on, the way a customer would. We also check your website and Google listing.',
    'Your private report opens right away and fills in as the answers come back: whether AI names you, who it names instead, word for word, and what to fix first.',
    'Every answer is quoted exactly, with the question and the date. Type it in yourself.',
    'Every number comes from your scan. Nothing guessed, nothing &ldquo;typical.&rdquo;',
    'If AI names you and your listings agree, the report says so. No scare tactics.',
    'We only read public information. You stay in control of every listing.',
  ]) assert.ok(index.includes(`<p>${line}</p>`), line);
});

test('homepage pricing: prices, what you get, the promise and both buttons stay on screen; the refund reads as one bold conditional', () => {
  const pricing = section(read('index.html'), 'pricing');
  assert.match(pricing, /<div class="price">Free<\/div>/);
  assert.match(pricing, /<div class="price">\$49 <small>one-time<\/small><\/div>/);
  assert.equal((pricing.match(/<li[ >]/g) || []).length, 12, 'all 5 + 7 "what you get" lines');
  assert.match(pricing, /<li>A free re-check in 30 days to see what your fixes changed<\/li>/);
  assert.match(pricing, /<p class="tier-promise"><b>Fewer than 3 problems specific to your business\? Your \$49 back\.<\/b><\/p>/);
  assert.match(pricing, /<p class="tier-promise"><b>No card\.<\/b> No email needed\.<\/p>/);
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
  assert.match(index, /If it isn&rsquo;t you, <b>the call never rings<\/b> and you never find out\./);
  assert.match(index, /<p class="stats-after">Your next customer isn't searching\. <b>They're asking\.<\/b> And you can't see/);
});

test('checkout: price, every line of what you get (7, with the free re-check), the add-on, promise, no-subscription and pay button on screen', () => {
  const co = read('checkout.html');
  assert.ok(!/<details/.test(co), 'nothing on the checkout page is folded');
  for (const [needle, why] of [
    ['<span>$49</span>', 'the price'], ['Competitor Breakdown <em>+$25</em>', 'the add-on box'], ['id="co-pay"', 'the pay button'],
    ['No subscription, no auto-renew.', 'no subscription'], ['reply to your receipt and we refund your $49.', 'the refund promise'],
    ['Money-back promise', 'the refund badge'], ['Secure payment by Stripe.', 'secure payment'],
  ]) visible(co, needle, why);
  const sum = /<aside class="co-card co-summary"[\s\S]*?<\/aside>/.exec(co)[0];
  const list = /<ul class="tier-list co-incl">([\s\S]*?)<\/ul>/.exec(sum)[1];
  assert.deepEqual([...list.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1]), [
    'All 7 customer questions on every AI assistant we check, including 2 for businesses your size',
    'Every answer word for word, and every website AI cited',
    'What&rsquo;s wrong on your website and Google listing',
    'Every fix, step by step, with the exact text to paste',
    'Your Fix Kit: ready-to-install files for your website',
    'You vs. the businesses AI picked, and your fix checklist',
    '<strong class="co-incl-tag">Included</strong> A free re-check in 30 days to see what your fixes changed',
  ]);
  visible(co, 'id="list-breakdown"', 'the add-on detail, shown when ticked');
});

test('about page: every "How we\'re different" point shows its line (promises and caveats on screen); only the long note and the agent detail fold', () => {
  const about = read('about.html');
  const diff = /<ul class="diff-list">([\s\S]*?)<\/ul>/.exec(about)[1];
  const items = [...diff.matchAll(/<li><strong>([^<]+)<\/strong> ([\s\S]*?)<\/li>/g)];
  assert.deepEqual(items.map((m) => m[1]), [
    'We show you the real answer.', 'We name who got the call.', 'You get the fix, not just the problem.',
    'No logins, ever.', 'Free to look, no strings.', 'Plain English.', 'Honest about the limits.',
  ]);
  visible(about, 'The first check needs no email and no card. No contract, no retainer, nothing to cancel.', 'no-subscription line');
  visible(about, 'No one can promise what an AI will say.', 'honesty caveat');
  visible(about, 'My dad ran a small service business.', 'the note opens on screen');
  visible(about, 'I believe every business, big or small, should have the tools to be found', 'the note closes on screen');
  visible(about, '<strong>Bryan Fields</strong><br>Founder, AI Found Score', 'the signature');
  visible(about, 'AI Found Score is run largely by an AI agent', 'the AI-run line');
  oneClick(about, 'My mom has spent her life helping people.');
  oneClick(about, 'go looking for local businesses that AI isn&rsquo;t naming');
  const folds = [...about.matchAll(/<details class="([^"]*)">\s*<summary>([^<]+)<\/summary>/g)];
  assert.deepEqual(folds.map((m) => [m[1], m[2]]), [['disc', 'Read the whole note'], ['disc', 'How the agent finds businesses']]);
  noOpen(about);
  visible(about, 'Each report lists exactly which assistants we asked and when.', 'where the data comes from');
});

test('every fold left on the landing pages uses the shared marker and says what is inside', () => {
  for (const f of ['index.html', 'about.html', 'checkout.html', 'contact.html', 'success.html']) {
    const html = read(f);
    for (const m of html.matchAll(/<summary>([^<]*)<\/summary>/g)) assert.notEqual(m[1].trim(), 'More', `${f}: a bare "More"`);
  }
  assert.equal((read('index.html').match(/<details class="[^"]*\bdisc\b/g) || []).length, 1);
  const css = block();
  assert.match(css, /details\.disc > summary \{ list-style: none; cursor: pointer; font-weight: 600; color: var\(--blue\); min-height: 44px; display: flex; align-items: center; gap: 10px; \}/);
  assert.match(css, /details\.disc > summary::before \{ content: "\+"; flex: none; display: inline-grid; place-content: center; width: 22px; height: 22px; border-radius: 50%; border: 2px solid currentColor; font-size: 15px; line-height: 1; \}/);
  assert.match(css, /details\.disc\[open\] > summary::before \{ content: "\\2212"; \}/);
  // The same marker as the Fix Kit's.
  assert.match(read('fix-kit.html'), /\.fk details > summary::before \{ content: "\+"; flex: none; display: inline-grid; place-content: center; width: 22px; height: 22px; border-radius: 50%; border: 2px solid currentColor; font-size: 15px; line-height: 1; \}/);
});

test('print and Save as PDF open everything behind a click, and close it again afterwards', () => {
  for (const f of ['index.html', 'about.html', 'checkout.html']) {
    const html = read(f);
    assert.match(html, /addEventListener\('beforeprint', function \(\) \{ opened = \[\]; document\.querySelectorAll\('details:not\(\[open\]\)'\)\.forEach\(function \(d\) \{ d\.open = true; opened\.push\(d\); \}\); \}\)/, f);
    assert.match(html, /addEventListener\('afterprint', function \(\) \{ opened\.forEach\(function \(d\) \{ d\.open = false; \}\); opened = \[\]; \}\)/, f);
  }
});

test('lighter type and more space: soft body ink #2B3A52 passes WCAG AA; 88px / 56px sections; line-height 1.65', () => {
  const css = block();
  const inks = [...css.matchAll(/--ink-soft: (#[0-9A-Fa-f]{6})/g)].map((m) => m[1].toUpperCase());
  assert.deepEqual([...new Set(inks)], ['#2B3A52'], 'one soft ink, the site-wide one');
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const bg of ['#FFFFFF', '#F4F7FB', '#F6F9FE']) assert.ok(ratio('#2B3A52', bg) >= 4.5, `on ${bg}`);
  assert.match(css, /\.lp \.section, \.lp \.stats-band \{ padding: 88px 0; line-height: 1\.65; \}/);
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.lp \.section, \.lp \.stats-band \{ padding: 56px 0; \}/);
  for (const sel of ['.lp .lost-note', '.lp .stats-after', '.lp .tiers.ladder .tier-promise', '.lp .tiers.ladder .tier-when']) {
    assert.match(css, new RegExp(sel.replace(/\./g, '\\.') + ' \\{[^}]*font-weight: 400;'), `${sel}: regular weight, the key phrase bold`);
  }
});

test('contact keeps its spacing: no landing rule changes the lede margin', () => {
  assert.ok(!/\.lede-page \{[^}]*margin/.test(block()), 'the lede margin is the base one on every page');
});

test('one CSS block, no rule repeated with the same property, scoped away from the report and Fix Kit', () => {
  const css = read('css/styles.css');
  assert.equal((css.match(/Lighter landing pages/g) || []).length, 1, 'one landing-page block');
  const b = block();
  // Outside @media, a selector + property pair appears once (no self-overrides).
  const flat = b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{([^{}]*\{[^{}]*\}\s*)*\}/g, '');
  const seen = new Map();
  for (const m of flat.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    for (const sel of m[1].split(',').map((x) => x.trim())) {
      for (const prop of m[2].split(';').map((d) => d.split(':')[0].trim()).filter(Boolean)) {
        const k = `${sel} | ${prop}`;
        assert.ok(!seen.has(k), `set twice: ${k}`);
        seen.set(k, 1);
      }
    }
  }
  const own = /^(\.lp\b|\.co-page\b|\.what-points\b|\.trust-points\b|\.faq (details)?\.faq-more\b|\.diff-list\b|details\.disc\b)/;
  const selectors = b.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '').match(/[^{}]+(?=\{)/g).map((s) => s.trim()).filter(Boolean);
  for (const group of selectors) for (const sel of group.split(',')) assert.match(sel.trim(), own, `unscoped rule: ${sel.trim()}`);
  const shared = ['report.html', 'fix-kit.html', 'js/report.js', 'js/fix-kit.js'].map(read).join('\n');
  for (const cls of ['lp', 'what-points', 'trust-points', 'faq-more', 'diff-list']) {
    assert.ok(!new RegExp(`class="[^"]*\\b${cls}\\b|'${cls}'|\\.${cls}\\b`).test(shared), `${cls} is used by the report or Fix Kit`);
  }
  // Leftovers from earlier passes are gone.
  assert.ok(!/more-line|co-more|details\.more\b/.test(b));
});

test('one stylesheet version everywhere (20)', () => {
  const versions = new Set();
  for (const f of ['index.html', 'about.html', 'checkout.html', 'success.html', 'contact.html', 'report.html', 'fix-kit.html', 'plan.html', 'privacy.html', 'terms.html', 'refunds.html', 'unsubscribe.html']) {
    versions.add(/\/css\/styles\.css\?v=(\d+)"/.exec(read(f))[1]);
  }
  assert.deepEqual([...versions], ['20']);
  for (const f of ['index.html', 'about.html', 'success.html', 'contact.html']) assert.match(read(f), /<body class="lp">/, f);
});
