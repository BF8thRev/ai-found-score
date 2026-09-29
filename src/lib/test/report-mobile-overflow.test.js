// The unlocked report must not scroll sideways on a phone: long URLs in fix steps/descriptions and
// wide code blocks stay inside their own box (public/css/report-extra.css).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../../public/css/report-extra.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Declarations applied to a selector (any rule whose comma-separated selector list includes it).
function decls(selector) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) out.push(m[2]);
  }
  return out.join(';');
}
const has = (selector, re) => assert.match(decls(selector), re, `${selector} needs ${re}`);

test('fix step and description text breaks long URLs instead of widening the page', () => {
  has('.r2 .r2-steps li', /overflow-wrap:\s*anywhere/);
  has('.r2 .issue-card p', /overflow-wrap:\s*anywhere/);
});

test('copy blocks and code stay inside their box and scroll on their own', () => {
  has('.r2-copy', /min-width:\s*0/);
  has('.r2-code', /max-width:\s*100%/);
  has('.r2-code', /overflow-x:\s*auto/);
  has('.r2-copytext', /overflow-wrap:\s*anywhere/);
  has('.r2 code', /overflow-wrap:\s*anywhere/);
});
