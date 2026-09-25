// Marketing and legal pages describe the assistants generically: no assistant names, no fixed
// search count (each report lists exactly which assistants were asked and when), only the plans
// on sale, and none of the banned words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE_NAMES } from '../../../scanner/config.js';
import { INTENTS } from '../../../scanner/questions.js';
import { lintText } from '../../../shared/report-v2.js';

const PUBLIC = new URL('../../../public/', import.meta.url);
const PAGES = ['index.html', 'about.html', 'terms.html', 'refunds.html', 'privacy.html', 'contact.html', 'llms.txt'];
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');

// index.html quotes third-party usage figures (a cited stats band); that band is not our claim.
// The hero's "real answer" card is a labelled, dated verbatim quote (published with the owner's
// permission), so it may name the assistant and the real report's search count.
const withoutStats = (html) => html
  .replace(/<section class="stats-band"[\s\S]*?<\/section>/, '')
  .replace(/<div class="real-answer" data-real-quote>[\s\S]*?<\/figure>[\s\S]*?<\/p>\s*<\/div>/, '');
const visible = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');

test('no assistant names or fixed search counts on marketing/legal pages', () => {
  for (const f of PAGES) {
    const text = withoutStats(read(f));
    for (const name of Object.values(ENGINE_NAMES)) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${f} names ${name}`);
    }
    assert.ok(!/\b\d+\s+(searches|times in all)\b/i.test(text), `${f} states a search count`);
    assert.ok(!/data-ai-(list|count|names)|data-search-count|data-question-count|data-copy=|\{\{[A-Z_]+\}\}/.test(text), `${f} still has a copy slot`);
  }
});

test('"five questions" in the copy matches the scanner', () => {
  assert.equal(INTENTS.length, 5);
});

test('only the plans on sale are offered', () => {
  for (const f of PAGES) {
    const text = read(f);
    assert.ok(!/Full Year|\$69\b|\$199\b|full listing build/i.test(text), `${f} mentions a plan that is off sale`);
  }
  const index = read('index.html');
  assert.ok(index.includes('data-tier="xray"'));
  assert.ok(!/data-tier="(snapshot|before_after|full_year|listing_fix)"/.test(index));
  for (const f of PAGES) {
    const text = read(f);
    assert.ok(!/\$29\b|\$59\b|Monthly monitoring|\$99\b/i.test(text), `${f} mentions a retired or unannounced plan`);
  }
});

test('no banned words in page copy', () => {
  for (const f of PAGES) {
    const hits = lintText(visible(read(f)));
    assert.deepEqual(hits.map((h) => h.match), [], `${f}: ${hits.map((h) => h.match).join(', ')}`);
  }
});

test('real report is the primary example; sample stays reachable', () => {
  const index = read('index.html');
  assert.match(index, /href="\/report\/mega-wash-and-dry">See a real report/);
  assert.match(index, /href="\/report\/sample-001">Sample report</);
});
