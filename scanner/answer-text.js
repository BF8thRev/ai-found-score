// scanner/answer-text.js — an AI answer as a reader sees it, and the short excerpt the homepage shows.
//
// Engines return markdown with citation links: "… top option. ([site.com](https://site.com/?utm_source=x))".
// displayText() removes only the markup (links, bold markers, heading hashes) and keeps every word in
// its original order, so the result is still the answer word for word. excerptAnswer() then cuts a
// prefix of it at a sentence end for the homepage card (scanner/showcase.js, src/lib/showcase.js).
// Pure, runtime-agnostic.

import { findPhones, findStreets } from './extract/normalize.js';

/** Markdown answer → plain text, same words in the same order. */
export function displayText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // Citation groups: " ([label](url))" and " [label](url)" right after text that already names the source.
    .replace(/\s*\(\s*\[[^\]\n]*\]\([^)\s]*\)(?:\s*,?\s*\[[^\]\n]*\]\([^)\s]*\))*\s*\)/g, '')
    // Any other markdown link keeps its label.
    .replace(/\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    // Bare URLs.
    .replace(/\s*\(?https?:\/\/[^\s)]+\)?/g, '')
    // Bold / italic markers and heading hashes.
    .replace(/\*\*|__/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const words = (s) => (String(s).match(/\S+/g) || []).length;

/**
 * Sentence-ish units covering `text` from the start: each line, split again after . ! ? when the
 * next sentence starts with a capital, digit or quote. → [{ start, end }] (end exclusive).
 */
export function units(text) {
  const out = [];
  const re = /[^\n]+/g;
  for (const m of text.matchAll(re)) {
    const line = m[0];
    let from = 0;
    for (const b of line.matchAll(/[.!?](?=\s+["“(]?[A-Z0-9])/g)) {
      const end = b.index + 1;
      out.push({ start: m.index + from, end: m.index + end });
      from = end + (line.slice(end).match(/^\s+/) || [''])[0].length;
    }
    if (from < line.length) out.push({ start: m.index + from, end: m.index + line.length });
  }
  return out;
}

/** Every literal occurrence of each name in `text`. → sorted, non-overlapping [[start, end], ...]. */
export function nameSpans(text, names) {
  const spans = [];
  for (const n of names || []) {
    const name = String(n || '');
    if (name.length < 2) continue;
    let at = text.indexOf(name);
    while (at !== -1) {
      spans.push([at, at + name.length]);
      at = text.indexOf(name, at + name.length);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const s of spans) if (!out.length || s[0] >= out[out.length - 1][1]) out.push(s);
  return out;
}

export const EXCERPT_WORDS = 60;
const FIRST_UNIT_MAX_WORDS = 90;

/**
 * The homepage excerpt: a prefix of `text` that ends at a sentence end, is at most ~60 words,
 * names at least one business, and stops before the first phone number or street address.
 * `names` are business names verified as literal substrings of `text`.
 * → { text, spans, truncated } or null when no such prefix exists (the answer is then not shown).
 */
export function excerptAnswer(text, names, { maxWords = EXCERPT_WORDS } = {}) {
  const t = String(text || '');
  if (!t || !names?.length) return null;
  let end = 0;          // end of the last unit that names a business
  let count = 0;
  for (const [i, u] of units(t).entries()) {
    const piece = t.slice(u.start, u.end);
    if (findPhones(piece).length || findStreets(piece).length) break;
    const w = words(piece);
    if (count + w > (i === 0 ? Math.max(maxWords, FIRST_UNIT_MAX_WORDS) : maxWords)) break;
    count += w;
    if (nameSpans(piece, names).length) end = u.end;
  }
  if (!end) return null;
  const out = t.slice(0, end).trim();
  return { text: out, spans: nameSpans(out, names), truncated: out.length < t.length };
}
