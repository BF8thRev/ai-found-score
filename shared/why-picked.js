// "Why AI picked them": for the paid report, the firms AI named instead of the owner, what AI said about
// each one (quoted word for word from the answer text) and the pages AI read in the answers that named
// them. Built at serve time from the report's own data (src/lib/lock.js reportBody), never fetched or
// guessed: every quote is a line or sentence of an answer, around a name the scan found at a stored
// position, with only markdown marks taken out.
//
// Oct 2 2026 owner review of the PR 73 report: "Who AI recommended instead" and "Why they got named
// instead" didn't say HOW or WHY those firms got named, or WHERE. This replaces both on paid reports.

import { isDirectoryName, sentenceBounds, RISKY_RE } from './report-v2.js';
import { ATTRIBUTES } from './faq.js';
import { directoryFor } from './directories.js';
import { siteType, isCompetitorSite } from './action-plan.js';

/** Most firms in the section. */
export const WHY_MAX_RIVALS = 5;
/** Most quotes per firm (from different assistants). */
export const WHY_MAX_QUOTES = 2;
/** Most pages listed per firm. */
export const WHY_MAX_PAGES = 6;
const QUOTE_MAX_CHARS = 280;
const SMALL_INTENTS = new Set(['small', 'niche']);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
function domainOf(c) {
  if (c && c.domain) return normDomain(c.domain);
  try { return normDomain(new URL(String(c && c.url)).hostname); } catch { return ''; }
}
function ownDomainOf(report) {
  const w = String((report && report.business && report.business.website) || '').trim();
  if (!w) return '';
  try { return normDomain(new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`).hostname); } catch { return ''; }
}

/**
 * plainLine(markdown) → the same words without markdown marks: links keep their text, bold/italic/code
 * marks and citation markers ([1], 【…】) go, a leading heading/bullet/number/quote mark goes.
 */
export function plainLine(s) {
  return String(s || '')
    .replace(/!?\[([^\]\n]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/g, '$1')
    .replace(/【[^】\n]*】/g, '')
    .replace(/\[\^?\d+\]/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/`+/g, '')
    .replace(/^\s*(?:#{1,6}\s+)?(?:>\s*)?(?:(?:\d+[.)]|[-*•+])\s+)*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capText(t) {
  if (t.length <= QUOTE_MAX_CHARS) return t;
  const cut = t.slice(0, QUOTE_MAX_CHARS - 10);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).replace(/[\s,;:–—-]+$/, '')}…`;
}

const words = (s) => String(s || '').split(/\s+/).filter(Boolean).length;
const idOf = (b) => String((b && (b.entityId || b.name)) || '');

/**
 * quoteFor(text, mention, mentions) → { text, others } | null: what an answer said about one business, word
 * for word. Its bullet or line when that line is short (a list item: "1. **Rubenstein** – The definitive…");
 * the sentence holding the name inside a long paragraph; a heading that is only the name takes the lines
 * under it (up to the next heading, blank gap or other business). `others`: other businesses in the quote.
 */
export function quoteFor(text, b, list = []) {
  const t = String(text || '');
  const name = String((b && b.name) || '');
  if (!t || !name || typeof b.pos !== 'number' || t.slice(b.pos, b.pos + name.length) !== name) return null;
  const ls = t.lastIndexOf('\n', b.pos - 1) + 1;
  let le = t.indexOf('\n', b.pos);
  if (le < 0) le = t.length;
  const others = (s, e) => new Set(list.filter((x) => x && typeof x.pos === 'number' && x.pos >= s && x.pos < e && idOf(x) !== idOf(b)).map(idOf)).size;
  const line = plainLine(t.slice(ls, le));
  const rest = line.split(name).join(' ').replace(/[\s:–—\-.,|()]+/g, ' ').trim();
  if (words(rest) < 3) {
    // A heading (or bold line) that is only the name: the lines under it.
    const parts = [];
    let pos = le + 1;
    for (let n = 0; n < 6 && pos < t.length && parts.length < 2; n++) {
      let e2 = t.indexOf('\n', pos);
      if (e2 < 0) e2 = t.length;
      const l = t.slice(pos, e2);
      if (!l.trim()) { if (parts.length) break; pos = e2 + 1; continue; }
      if (/^\s*(?:#{1,6}\s|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(l)) break;
      if (others(pos, e2)) break;
      const p = plainLine(l);
      if (p) parts.push(p);
      pos = e2 + 1;
    }
    if (!parts.length) return null;
    const head = line.replace(/[\s:–—-]+$/, '');
    const out = `${head}: ${parts.join(' · ')}`;
    return words(out) >= 5 ? { text: capText(out), others: 0 } : null;
  }
  // A list item is about its own business: the whole line. A paragraph: the whole line only when it is
  // short and names no one else; else the sentence holding the name.
  const item = /^\s*(?:#{1,6}\s|(?:\d+[.)]|[-*•+])\s)/.test(t.slice(ls, le));
  if (line.length <= QUOTE_MAX_CHARS && (item || !others(ls, le))) return words(line) >= 5 ? { text: line, others: others(ls, le) } : null;
  const sb = sentenceBounds(t, b.pos, name.length);
  const s = Math.max(sb.start, ls);
  const e = Math.min(sb.end, le);
  const out = plainLine(t.slice(s, e));
  return words(out) >= 5 ? { text: capText(out), others: others(s, e) } : null;
}

/**
 * buildWhyPicked(report, plan?) → null | {
 *   answers,                      how many answers in the scan
 *   rivals: [{ id, name, named, first, small, questions: [{ id, intent, text }], answerIds,
 *              quotes: [{ text, engine, answerId }],
 *              pages: [{ domain, url, name, answers, list, theirs, type, status, step }], morePages }],
 *   takeaway: { of, reasons: [{ type, label, count }], sources: [{ domain, name, count }] },
 *   you: { named, first, answers, missing: [{ domain, name, status, step }], listed: [...] },
 * }
 * Rivals: named in 2+ answers (directories never), most named first; up to 2 named on the small-firm
 * questions are kept in even when bigger names fill the list. `plan` (shared/action-plan.js) gives each
 * list page its status ("not on it", "listed") and the step that covers it.
 */
export function buildWhyPicked(report, plan = null) {
  const r = report || {};
  const answers = (r.answers || []).filter((a) => a && a.id);
  if (!answers.length) return null;
  const aById = new Map(answers.map((a) => [a.id, a]));
  const questions = (r.questions || []).filter((q) => q && q.id);
  const qById = new Map(questions.map((q) => [q.id, q]));
  const intentOf = (a) => a.intent || (qById.get(a.questionId) || {}).intent || null;
  const own = ownDomainOf(r);
  const trade = (r.business && r.business.trade) || '';
  const entities = (r.entities || []).filter((e) => e && e.id && !e.isYou);

  // Each list page's status and step, from the plan.
  const planSite = new Map();
  for (const it of (plan && plan.items) || []) {
    if (!it || !['lists', 'awards'].includes(it.id)) continue;
    for (const s of it.sites || []) if (s && s.domain && !planSite.has(normDomain(s.domain))) planSite.set(normDomain(s.domain), { status: s.status, step: it.id, type: s.type });
  }
  const srcByDomain = new Map();
  for (const s of r.sources || []) if (s && s.domain && !srcByDomain.has(normDomain(s.domain))) srcByDomain.set(normDomain(s.domain), s);

  const proven = entities
    .filter((e) => num(e.named) >= 2 && (e.answerIds || []).filter((id) => aById.has(id)).length >= 2 && !isDirectoryName(e.name))
    .sort((x, y) => num(y.named) - num(x.named) || num(y.first) - num(x.first) || String(x.name).localeCompare(String(y.name)));
  const isSmall = (e) => (e.answerIds || []).some((id) => aById.has(id) && SMALL_INTENTS.has(intentOf(aById.get(id))));
  let picked = proven.slice(0, WHY_MAX_RIVALS);
  const smallOut = proven.filter((e) => isSmall(e) && !picked.includes(e));
  const smallIn = picked.filter(isSmall).length;
  for (const e of smallOut.slice(0, Math.max(0, 2 - smallIn))) {
    // Swap out the least-named firm that isn't a small-firm winner.
    const k = [...picked].reverse().findIndex((x) => !isSmall(x));
    if (k < 0) break;
    picked.splice(picked.length - 1 - k, 1);
    picked.push(e);
  }
  picked = picked.sort((x, y) => num(y.named) - num(x.named) || num(y.first) - num(x.first));

  const rivals = picked.map((e) => {
    const ids = (e.answerIds || []).filter((id) => aById.has(id));
    // Quotes: one per mention, fewest other businesses first, never a complaint when there's another.
    const cands = [];
    for (const id of ids) {
      const a = aById.get(id);
      const list = (a.businessesNamed || []).filter((b) => b && typeof b.pos === 'number').sort((x, y) => x.pos - y.pos);
      for (const b of list) {
        if (b.entityId !== e.id && b.name !== e.name) continue;
        const q = quoteFor(a.text, b, list);
        if (q && !cands.some((c) => c.text === q.text && c.engine === a.engine)) cands.push({ ...q, engine: a.engine || null, answerId: a.id, risky: RISKY_RE.test(q.text) });
      }
    }
    cands.sort((x, y) => Number(x.risky) - Number(y.risky) || x.others - y.others || Math.min(y.text.length, 200) - Math.min(x.text.length, 200));
    const quotes = [];
    for (const c of cands) {
      if (quotes.length >= WHY_MAX_QUOTES) break;
      if (quotes.some((q) => q.engine === c.engine || q.text === c.text)) continue;
      quotes.push({ text: c.text, engine: c.engine, answerId: c.answerId });
    }
    // Pages: every citation of the answers that named them.
    const pages = new Map();
    for (const id of ids) {
      const a = aById.get(id);
      const seen = new Set();
      for (const c of a.citations || []) {
        const d = domainOf(c);
        if (!d || d === own || seen.has(d)) continue;
        seen.add(d);
        const p = pages.get(d) || { domain: d, url: typeof c.url === 'string' && /^https?:\/\//i.test(c.url) ? c.url : `https://${d}/`, answers: 0 };
        p.answers += 1;
        pages.set(d, p);
      }
    }
    const pageList = [...pages.values()].map((p) => {
      const dir = directoryFor(p.domain);
      const theirs = !dir && isCompetitorSite(p.domain, [e]);
      const ps = planSite.get(p.domain);
      const type = ps ? ps.type : siteType(p.domain, p.url, { trade });
      const src = srcByDomain.get(p.domain);
      const status = ps ? ps.status : src && src.youListed === true ? 'listed' : src && src.youListed === false ? 'missing' : null;
      const list = !theirs && (!!ps || !!dir || type === 'directory' || type === 'award');
      return { domain: p.domain, url: p.url, name: dir ? dir.name : null, answers: p.answers, list, theirs, type, status, step: ps ? ps.step : null };
    }).sort((x, y) => Number(y.list) - Number(x.list) || Number(x.theirs) - Number(y.theirs) || y.answers - x.answers || x.domain.localeCompare(y.domain));
    const qs = [];
    for (const q of questions) if (ids.some((id) => aById.get(id).questionId === q.id)) qs.push({ id: q.id, intent: q.intent || null, text: q.text || '' });
    return {
      id: e.id, name: e.name, named: num(e.named), first: num(e.first), small: isSmall(e), questions: qs, answerIds: ids,
      quotes, pages: pageList.slice(0, WHY_MAX_PAGES), morePages: Math.max(0, pageList.length - WHY_MAX_PAGES),
      _texts: cands.map((c) => c.text), _all: pageList,
    };
  });

  // The takeaway: the reasons AI gave (attribute types in what it wrote about them) and the lists it read,
  // shared by at least 2 of the firms (or the one firm, when there's one).
  const need = rivals.length > 1 ? 2 : 1;
  const reasons = ATTRIBUTES.map((t, n) => ({ type: t.type, label: t.label, n, count: rivals.filter((x) => x._texts.some((s) => t.re.test(s))).length }))
    .filter((x) => x.count >= need).sort((x, y) => y.count - x.count || x.n - y.n).slice(0, 3).map(({ n, ...rest }) => rest);
  const srcCount = new Map();
  for (const x of rivals) for (const p of x._all) if (p.list) {
    const s = srcCount.get(p.domain) || { domain: p.domain, name: p.name, count: 0, answers: 0 };
    s.count += 1;
    s.answers += p.answers;
    srcCount.set(p.domain, s);
  }
  const sources = [...srcCount.values()].filter((s) => s.count >= need)
    .sort((x, y) => y.count - x.count || y.answers - x.answers || x.domain.localeCompare(y.domain)).slice(0, 3)
    .map(({ domain, name, count }) => ({ domain, name, count }));

  // The owner: how often named, and the list pages AI read for these firms that they're not on (or listed on).
  const youMissing = new Map();
  const youListed = new Map();
  for (const x of rivals) for (const p of x._all) {
    if (!p.list) continue;
    const row = { domain: p.domain, name: p.name, status: p.status, step: p.step };
    if (p.status === 'missing' || p.status === 'not_found') youMissing.set(p.domain, row);
    if (p.status === 'listed') youListed.set(p.domain, row);
  }
  for (const x of rivals) { delete x._texts; delete x._all; }
  const counted = answers.filter((a) => a.ownerMatch !== 'unsure' || a.namedYou);
  return {
    answers: answers.length,
    rivals,
    takeaway: { of: rivals.length, reasons, sources },
    you: {
      named: counted.filter((a) => a.namedYou === true).length,
      first: counted.filter((a) => a.namedYouFirst === true).length,
      answers: answers.length,
      missing: [...youMissing.values()],
      listed: [...youListed.values()],
    },
  };
}
