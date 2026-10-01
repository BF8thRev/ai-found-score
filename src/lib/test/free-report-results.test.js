// The free-report results area on the homepage (#results: the live answer, the "Open my free
// report" button, the questions, the optional email box). It is filled in by the page script after
// the hero form is submitted, so nothing else on the page can be allowed to hide it.
//
// Sep 28 - Oct 1 2026: the form moved into the hero and the results block became the only child
// of `.request.done`; a leftover rule `.request.done > div:first-child { display: none }` (written
// for the old two-column layout) then hid the whole block. Visitors saw an empty box at the
// bottom of the page and never got their report link or the email box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PUBLIC = new URL('../../../public/', import.meta.url);
const html = readFileSync(new URL('index.html', PUBLIC), 'utf8');
const css = readFileSync(new URL('css/styles.css', PUBLIC), 'utf8');

/** Every rule in the stylesheet as { selector, body } (one entry per comma-separated selector). */
function rules(text) {
  const out = [];
  const flat = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/@media[^{]*\{([\s\S]*?\}\s*)\}/g, '$1');
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = m[2].replace(/\s+/g, ' ').trim();
    for (const sel of m[1].split(',')) out.push({ selector: sel.replace(/\s+/g, ' ').trim(), body });
  }
  return out;
}

test('the results block is the first (and only) content of .request.done', () => {
  const section = /<section class="section" id="results" hidden>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(section, 'index.html has <section id="results">');
  const box = /<div class="request done">\s*(<[^>]+>)/.exec(section[1]);
  assert.ok(box, 'the section has a .request.done box');
  assert.match(box[1], /^<div class="request-next" id="request-next" hidden>$/, 'its first child is #request-next');
});

test('no stylesheet rule hides the results block once the page script shows it', () => {
  // The script clears `hidden` on #results and #request-next; from then on only [hidden] rules may
  // hide them. A structural selector (first-child, nth-child, a class the markup no longer has)
  // that resolves to display:none on either element is the bug this test exists for.
  const hiders = rules(css).filter((r) => /display\s*:\s*none/.test(r.body) && !/\[hidden\]/.test(r.selector));
  // The last compound of the selector is what the rule hides: the block itself, or something the
  // markup no longer has (.request-col). A rule on a child (.request-next > .status:empty) is fine.
  const last = (sel) => sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';
  const bad = hiders.filter((r) => /^(div(:first-child|:nth-child\(1\)))$|^\.request-next$|^#request-next$|^#results$|\.request-col\b/.test(last(r.selector))
    || /\.request\.done\s*>\s*div/.test(r.selector));
  assert.deepEqual(bad.map((r) => r.selector), [], 'rules that hide the free-report results');
});

test('the results come right after the hero, where "See it below" points', () => {
  const hero = html.indexOf('<section class="hero">');
  const results = html.indexOf('<section class="section" id="results"');
  const stats = html.indexOf('<section class="stats-band"');
  assert.ok(hero >= 0 && results >= 0 && stats >= 0);
  assert.ok(results > hero, '#results is after the hero');
  assert.ok(results < stats, '#results is before the stats band (not at the bottom of the page)');
  assert.match(html, /id="hero-done" hidden>[^<]*<a href="#results">/, 'the hero links to #results after submit');
});
