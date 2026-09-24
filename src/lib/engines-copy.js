// src/lib/engines-copy.js — customer-facing wording for "which assistants, how many searches".
//
// One source: ACTIVE_ENGINES in scanner/config.js. The Worker (src/worker.js) fills pages with
// these values, so adding an engine there updates every page. Pure: no I/O, no Worker APIs.

import { ACTIVE_ENGINES, ENGINE_NAMES, DEFAULT_RUNS } from '../../scanner/config.js';
import { INTENTS } from '../../scanner/questions.js';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** 3 → "three" (0..20; larger numbers stay digits). */
export function numberWord(n) {
  const i = Number(n);
  return Number.isInteger(i) && i >= 0 && i < WORDS.length ? WORDS[i] : String(n);
}

export function capitalize(s) {
  const t = String(s);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** ['A'] → "A"; ['A','B'] → "A and B"; ['A','B','C'] → "A, B and C". */
export function listPhrase(items, conj = 'and') {
  const a = (items || []).map(String).filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return `${a.slice(0, -1).join(', ')} ${conj} ${a[a.length - 1]}`;
}

/**
 * Every value the site copy needs, from an engine list (default ACTIVE_ENGINES).
 * → { names, aiList, aiListOr, aiCount, aiCountWord, questionCount, questionCountWord, searchCount, searchCountWord }
 */
export function engineCopy(engines = ACTIVE_ENGINES, { questions = INTENTS.length, runs = DEFAULT_RUNS } = {}) {
  const names = engines.map((e) => ENGINE_NAMES[e] || e);
  const searchCount = questions * names.length * runs;
  return {
    names,
    aiList: listPhrase(names, 'and'),
    aiListOr: listPhrase(names, 'or'),
    aiCount: names.length,
    aiCountWord: numberWord(names.length),
    questionCount: questions,
    questionCountWord: numberWord(questions),
    searchCount,
    searchCountWord: numberWord(searchCount),
  };
}

/** {{TOKEN}} → value, for meta content, JSON-LD and llms.txt. */
export function copyTokens(c = engineCopy()) {
  return {
    AI_LIST: c.aiList,
    AI_LIST_OR: c.aiListOr,
    AI_COUNT: String(c.aiCount),
    AI_COUNT_WORD: c.aiCountWord,
    AI_COUNT_WORD_CAP: capitalize(c.aiCountWord),
    QUESTION_COUNT: String(c.questionCount),
    QUESTION_COUNT_WORD: c.questionCountWord,
    SEARCH_COUNT: String(c.searchCount),
    SEARCH_COUNT_WORD: c.searchCountWord,
  };
}

/** Replace {{TOKEN}}s; unknown tokens are left as they are. */
export function fillTokens(text, tokens = copyTokens()) {
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(tokens, k) ? tokens[k] : m));
}

/**
 * Text for an element marked data-ai-list / data-ai-count / data-search-count / data-question-count.
 * `form` is the attribute's value:
 *   list:  "" | "and" → "A, B and C";  "or" → "A, B or C"
 *   count: "" | "digit" → "3";  "word" → "three";  "Word" → "Three"
 * → string, or null for an unknown kind.
 */
export function copyFor(kind, form = '', c = engineCopy()) {
  const f = String(form || '').trim();
  if (kind === 'list') return f === 'or' ? c.aiListOr : c.aiList;
  const n = { ai: c.aiCount, search: c.searchCount, question: c.questionCount }[kind];
  if (n === undefined) return null;
  if (f === 'word') return numberWord(n);
  if (f === 'Word') return capitalize(numberWord(n));
  return String(n);
}
