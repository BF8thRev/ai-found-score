// Lighter landing pages, pass 2 (owner, Oct 2026: "add more space, it feels heavier text a tiny bit",
// and fewer words on screen below the hero). Each card or step shows a heading and one short line; the
// second sentence is behind a small closed "More", word for word. Type is lighter (one bold phrase per
// block), body text a touch softer but still WCAG AA, and the sections have more room.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../../../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');
const plain = (h) => h.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '"').replace(/\s+/g, ' ').trim();
const sentenceCount = (t) => (t.match(/[.!?]+"?(\s|$)/g) || []).length;
const section = (html, id) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)[0];
const pass2 = () => { const css = read('css/styles.css'); return css.slice(css.indexOf('Lighter landing pages, pass 2')); };

test('homepage cards and steps: a heading and one short line on screen, the rest behind a closed "More"', () => {
  const index = read('index.html');
  for (const [id, split, n] of [['what', '<div class="card">', 4], ['how', '<li class="how-step">', 3], ['trust', '<div class="card">', 4]]) {
    const sec = section(index, id);
    const blocks = sec.split(split).slice(1);
    assert.equal(blocks.length, n, id);
    for (const b of blocks) {
      assert.match(b, /<h3>/, `${id}: a heading`);
      const onScreen = b.replace(/<details class="more-line">[\s\S]*?<\/details>/g, '').replace(/<(div|a) class="how-pic[\s\S]*$/, '');
      const lines = [...onScreen.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plain(m[1]));
      assert.equal(lines.length, 1, `${id}: one line on screen`);
      assert.equal(sentenceCount(lines[0]), 1, `${id}: one sentence on screen: ${lines[0]}`);
      assert.ok(lines[0].split(' ').length <= 14, `${id}: a short line: ${lines[0]}`);
    }
    assert.ok(!/<details class="more-line"[^>]*\sopen/.test(sec), `${id}: "More" starts closed`);
  }
});

test('homepage: the words behind "More" are the same words that used to be on screen', () => {
  const index = read('index.html');
  const more = [...index.matchAll(/<details class="more-line"><summary>More<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => m[1]);
  assert.deepEqual(more, [
    'Type them in yourself and check.',
    'So you can catch what it gets wrong.',
    'No email, no card. We find your town from your website.',
    'We also check your website and Google listing.',
    'Whether AI names you, who it names instead, word for word, and what to fix first.',
    'Type it in yourself.',
    'Nothing guessed, nothing &ldquo;typical.&rdquo;',
    'No scare tactics.',
    'You stay in control of every listing.',
  ]);
  // And what stays on screen is the first part of each old line.
  for (const line of [
    '<p>The exact questions, the exact answers.</p>',
    '<p>Your hours, prices, and phone number as the AI states them.</p>',
    '<p>Your business name and website.</p>',
    '<p>Live, with web search on, the way a customer would.</p>',
    '<p>Your private report opens right away and fills in as the answers come back.</p>',
    '<p>Every answer is quoted exactly, with the question and the date.</p>',
    '<p>Every number comes from your scan.</p>',
    '<p>If AI names you and your listings agree, the report says so.</p>',
    '<p>We only read public information.</p>',
  ]) assert.ok(index.includes(line), line);
});

test('lighter type: one bold phrase per block, not whole bold sentences', () => {
  const index = read('index.html');
  assert.match(index, /If it isn&rsquo;t you, <b>the call never rings<\/b> and you never find out\./);
  assert.match(index, /<p class="stats-after">Your next customer isn't searching\. <b>They're asking\.<\/b> And you can't see/);
  assert.match(index, /<p class="tier-promise"><b>No card\.<\/b> No email needed\.<\/p>/);
  assert.match(index, /<p class="tier-promise">Fewer than 3 problems specific to your business\? <b>Your \$49 back\.<\/b><\/p>/);
  const css = pass2();
  for (const sel of ['.lp .lost-note', '.lp .stats-after', '.lp .tiers.ladder .tier-promise', '.lp .tiers.ladder .tier-when']) {
    assert.ok(css.includes(`${sel} { font-weight: 400;`), `${sel} is regular weight, its key phrase bold`);
  }
});

test('softer body text still passes WCAG AA 4.5:1 on every landing background', () => {
  const ink = /--ink-soft: (#[0-9A-Fa-f]{6})/.exec(pass2())[1];
  const lum = (h) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const bg of ['#FFFFFF', '#F4F7FB', '#F6F9FE']) assert.ok(ratio(ink, bg) >= 4.5, `${ink} on ${bg}: ${ratio(ink, bg).toFixed(2)}`);
  assert.ok(ratio(ink, '#FFFFFF') < ratio('#14213A', '#FFFFFF'), 'softer than the old body ink');
});

test('more space: 88px between sections on desktop, 56px on phone, line-height 1.65, no smaller type', () => {
  const css = pass2();
  assert.match(css, /\.lp \.section, \.lp \.stats-band \{ padding: 88px 0; \}/);
  assert.match(css, /@media \(max-width: 560px\) \{\s*\.lp \.section, \.lp \.stats-band \{ padding: 56px 0; \}/);
  assert.match(css, /\.lp \.section, \.lp \.stats-band \{ line-height: 1\.65; \}/);
  assert.ok(!/font-size/.test(css.replace(/\.more-line > summary \{[^}]*\}/, '')), 'pass 2 changes no font sizes (the new "More" label aside)');
});

test('pricing: the one shortened list line keeps its meaning; prices, list, promise and buttons as before', () => {
  const pricing = section(read('index.html'), 'pricing');
  assert.match(pricing, /<li>A free re-check in 30 days to see what your fixes changed<\/li>/);
  assert.ok(!/<details/.test(pricing));
  assert.equal((pricing.match(/<li[ >]/g) || []).length, 12);
});
