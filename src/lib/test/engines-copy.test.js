// Unit tests for src/lib/engines-copy.js, plus a drift check: the static text in public/ (what a
// page shows if the Worker's fill-in never ran) must already match ACTIVE_ENGINES.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  numberWord, capitalize, listPhrase, engineCopy, copyTokens, fillTokens, copyFor,
} from '../engines-copy.js';
import { ACTIVE_ENGINES, ENGINE_IDS, ENGINE_NAMES } from '../../../scanner/config.js';

const PUBLIC = new URL('../../../public/', import.meta.url);

test('numberWord / capitalize', () => {
  assert.equal(numberWord(3), 'three');
  assert.equal(numberWord(0), 'zero');
  assert.equal(numberWord(15), 'fifteen');
  assert.equal(numberWord(25), '25');
  assert.equal(capitalize('three'), 'Three');
});

test('listPhrase: "A", "A and B", "A, B and C"', () => {
  assert.equal(listPhrase([]), '');
  assert.equal(listPhrase(['A']), 'A');
  assert.equal(listPhrase(['A', 'B']), 'A and B');
  assert.equal(listPhrase(['A', 'B', 'C']), 'A, B and C');
  assert.equal(listPhrase(['A', 'B', 'C', 'D'], 'or'), 'A, B, C or D');
});

test('engineCopy: three engines → 15 searches', () => {
  const c = engineCopy(['chatgpt', 'claude', 'gemini']);
  assert.equal(c.aiList, 'ChatGPT, Claude and Gemini');
  assert.equal(c.aiListOr, 'ChatGPT, Claude or Gemini');
  assert.equal(c.aiCount, 3);
  assert.equal(c.aiCountWord, 'three');
  assert.equal(c.questionCount, 5);
  assert.equal(c.searchCount, 15);
});

test('engineCopy: adding an engine changes every value', () => {
  const c = engineCopy(['chatgpt', 'claude', 'gemini', 'perplexity']);
  assert.equal(c.aiList, 'ChatGPT, Claude, Gemini and Perplexity');
  assert.equal(c.aiCountWord, 'four');
  assert.equal(c.searchCount, 20);
  assert.equal(engineCopy(ENGINE_IDS).searchCount, 25);
  assert.equal(engineCopy(['chatgpt'], { questions: 2, runs: 2 }).searchCount, 4);
});

test('fillTokens / copyTokens', () => {
  const t = copyTokens(engineCopy(['chatgpt', 'claude', 'gemini']));
  assert.equal(
    fillTokens('We ask {{AI_LIST}} ({{AI_COUNT_WORD}}, {{AI_COUNT}}), {{SEARCH_COUNT}} searches, {{QUESTION_COUNT_WORD}} questions. {{AI_COUNT_WORD_CAP}}.', t),
    'We ask ChatGPT, Claude and Gemini (three, 3), 15 searches, five questions. Three.',
  );
  assert.equal(fillTokens('{{NOPE}} stays', t), '{{NOPE}} stays');
});

test('copyFor: attribute forms', () => {
  const c = engineCopy(['chatgpt', 'claude', 'gemini']);
  assert.equal(copyFor('list', '', c), 'ChatGPT, Claude and Gemini');
  assert.equal(copyFor('list', 'or', c), 'ChatGPT, Claude or Gemini');
  assert.equal(copyFor('ai', '', c), '3');
  assert.equal(copyFor('ai', 'digit', c), '3');
  assert.equal(copyFor('ai', 'word', c), 'three');
  assert.equal(copyFor('ai', 'Word', c), 'Three');
  assert.equal(copyFor('search', '', c), '15');
  assert.equal(copyFor('question', 'word', c), 'five');
  assert.equal(copyFor('bogus', '', c), null);
});

// ---- the static pages already read correctly for ACTIVE_ENGINES ----------------------------

const pages = readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
const c = engineCopy();
const tokens = copyTokens(c);
const INACTIVE_NAMES = ENGINE_IDS.filter((e) => !ACTIVE_ENGINES.includes(e)).map((e) => ENGINE_NAMES[e]);

test('static fallback: every marked element and meta template matches ACTIVE_ENGINES', () => {
  let marked = 0;
  for (const f of pages) {
    const html = readFileSync(new URL(f, PUBLIC), 'utf8');
    for (const [kind, attr] of [['list', 'data-ai-list'], ['ai', 'data-ai-count'], ['search', 'data-search-count'], ['question', 'data-question-count']]) {
      const re = new RegExp(`<(\\w+)[^>]*\\s${attr}(?:="([^"]*)")?[^>]*>([^<]*)</\\1>`, 'g');
      for (const m of html.matchAll(re)) {
        marked++;
        assert.equal(m[3], copyFor(kind, m[2] || '', c), `${f}: ${m[0]}`);
      }
    }
    for (const m of html.matchAll(/<meta[^>]*content="([^"]*)"[^>]*data-copy="([^"]*)"/g)) {
      marked++;
      assert.equal(m[1], fillTokens(m[2], tokens), `${f}: meta ${m[2]}`);
    }
    for (const m of html.matchAll(/data-ai-names="([^"]*)"/g)) assert.equal(m[1], c.names.join('|'), f);
  }
  assert.ok(marked >= 20, `only ${marked} marked spots found`);
});

test('pages and llms.txt: tokens are known; no engine outside ACTIVE_ENGINES is named', () => {
  for (const f of [...pages, 'llms.txt']) {
    const text = readFileSync(new URL(f, PUBLIC), 'utf8');
    for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(Object.hasOwn(tokens, m[1]), `${f}: unknown token ${m[0]}`);
    // Engine names belong in data-driven spots only (report.html/js render names from report data).
    for (const name of INACTIVE_NAMES) assert.ok(!text.includes(name), `${f} names ${name}`);
    assert.ok(!/\b(25|20) searches\b/.test(text), `${f} hardcodes a search count`);
  }
});
