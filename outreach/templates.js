// Outreach copy: postcard and cold email, filled from a report JSON v2.
//
// Runtime-agnostic ES module (no Node built-ins). Pure functions.
// Source of truth: docs/BUILD_PLAN.md "Outreach copy" and the last risk
// ("send only when the headline answer names 2+ others and not the owner").
//
// Every slot comes from the report: the headline answer's engine, question,
// date and businesses named; business name, town, trade; totals. The only
// slots taken from `opts` are delivery details the report can't know:
// short code / link, recipient first name, sender name, report token.
//
// Both builders return null ("send nothing") when there is no honest hook:
//   - the owner is named in every answer
//   - the headline answer names the owner (or is an unsure owner match)
//   - the headline answer names fewer than 2 other businesses
// They throw when the report fails validateReport or the copy trips the
// banned-word lint: those are bugs, not skips.

import { ENGINE_NAMES, lintText, validateReport } from '../shared/report-v2.js';

export const SITE = 'https://aifoundscore.com';
export const ADDRESS_LINE = 'AI Found Score · 120 Terminal Drive, Plainview, NY 11803';

// Fixed plurals for the trades the question sets cover. Anything else gets a
// plain "s" (the plan's own "{trade}s").
const TRADE_PLURALS = {
  plumber: 'plumbers', plumbing: 'plumbers',
  hvac: 'HVAC companies',
  electrician: 'electricians', electrical: 'electricians',
  roofer: 'roofers', roofing: 'roofers',
  landscaper: 'landscapers', landscaping: 'landscapers',
  cleaner: 'cleaners', cleaning: 'cleaning services',
  'auto repair': 'auto repair shops',
  laundromat: 'laundromats',
};

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

export function tradePlural(trade) {
  const t = String(trade || '').trim();
  if (!t) throw new Error('report.business.trade is missing');
  return TRADE_PLURALS[t.toLowerCase()] || `${t}s`;
}

/** "Harbor Lane Laundromat, Maple Street Suds and Corner Spin Laundry" */
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "September 22, 2026" in Eastern time (the business's clock on Long Island). */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`answer askedAt is not a date: ${JSON.stringify(iso)}`);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

/**
 * Distinct other businesses named in one answer, in the order they appear in
 * the text. The owner and unsure owner matches are left out. Name variants of
 * one entity count once, under the first spelling that appears.
 */
export function otherNamesInOrder(answer) {
  const seen = new Set();
  const out = [];
  const named = [...(answer.businessesNamed || [])].sort((a, b) => a.pos - b.pos);
  for (const b of named) {
    if (b.isYou || b.ownerMatch === 'unsure') continue;
    const key = b.entityId || `name:${b.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b.name);
  }
  return out;
}

/**
 * Why this report gets no outreach, or null if it can be sent.
 * Returns one of: 'no_answers', 'no_headline', 'all_named', 'headline_names_you',
 * 'headline_unsure', 'fewer_than_2_others'.
 */
export function skipReason(report) {
  const answers = (report && report.answers) || [];
  if (!answers.length) return 'no_answers';
  if (answers.every((a) => a.namedYou === true)) return 'all_named';
  const a = headlineAnswer(report);
  if (!a) return 'no_headline';
  if (a.namedYou || (a.businessesNamed || []).some((b) => b.isYou)) return 'headline_names_you';
  if (a.ownerMatch === 'unsure' || (a.businessesNamed || []).some((b) => b.ownerMatch === 'unsure')) return 'headline_unsure';
  if (otherNamesInOrder(a).length < 2) return 'fewer_than_2_others';
  return null;
}

function headlineAnswer(report) {
  const id = report && report.headline && report.headline.answerId;
  return id ? (report.answers || []).find((x) => x.id === id) || null : null;
}

/** Every slot the templates use, pulled from the report. Throws on bad data. */
export function slots(report) {
  const v = validateReport(report);
  if (!v.ok) throw new Error(`report ${report && report.id} fails validation: ${v.errors.slice(0, 5).join('; ')}`);
  const a = headlineAnswer(report);
  const q = (report.questions || []).find((x) => x.id === a.questionId);
  if (!q || !q.text) throw new Error(`question ${a.questionId} for headline answer ${a.id} is missing`);
  const engine = ENGINE_NAMES[a.engine];
  if (!engine) throw new Error(`unknown engine "${a.engine}"`);
  const b = report.business || {};
  for (const k of ['name', 'town', 'trade']) if (!b[k]) throw new Error(`report.business.${k} is missing`);
  const others = otherNamesInOrder(a);
  const engineCount = new Set(report.answers.map((x) => x.engine)).size;
  return {
    engine,
    question: q.text,
    date: formatDate(a.askedAt),
    names: others.slice(0, 3),
    othersCount: others.length,
    business: b.name,
    town: b.town,
    trades: tradePlural(b.trade),
    searches: report.totals.answers,
    namedYou: report.totals.namedYou,
    assistants: NUMBER_WORDS[engineCount] || String(engineCount),
  };
}

// Lint our copy. Names found in the answer and the owner's own name are
// verbatim data, not our copy, so they are masked before the lint runs.
function lint(str, s) {
  let masked = str;
  for (const v of [...s.names, s.business]) masked = masked.split(v).join(' ');
  const hits = lintText(masked);
  if (hits.length) throw new Error(`banned word in outreach copy: ${hits.map((h) => JSON.stringify(h.match)).join(', ')}`);
  return str;
}

/**
 * postcard(report, { code }) → { front, back } | null
 * code: the recipient's report_links.short_code (printed as aifoundscore.com/r/{code}).
 */
export function postcard(report, opts = {}) {
  if (skipReason(report)) return null;
  const code = String(opts.code || '').trim();
  if (!code) throw new Error('postcard needs opts.code (report_links.short_code)');
  const s = slots(report);
  const front = `We asked ${s.engine}: "${s.question}" It named ${joinNames(s.names)}. It didn't name ${s.business}.`;
  const back = `We ran ${s.searches} searches like this for ${s.town} ${s.trades}. You came up in ${s.namedYou}. ` +
    `See every answer, free: aifoundscore.com/r/${code} No email. No sales call. — AI Found Score, Plainview, NY`;
  return { front: lint(front, s), back: lint(back, s) };
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * coldEmail(report, { token, code?, firstName?, sender? }) → { subject, text, html, headers, link, unsubscribeUrl } | null
 * token: the recipient's report token (report_links.report_token); drives the
 *   unsubscribe link. code: short code; when given the link is /r/{code},
 *   otherwise /report/{token}.
 */
export function coldEmail(report, opts = {}) {
  if (skipReason(report)) return null;
  const token = String(opts.token || '').trim();
  if (!token) throw new Error('coldEmail needs opts.token (report token for the unsubscribe link)');
  const s = slots(report);
  const code = String(opts.code || '').trim();
  const link = code ? `${SITE}/r/${encodeURIComponent(code)}` : `${SITE}/report/${encodeURIComponent(token)}`;
  const unsubscribeUrl = `${SITE}/unsubscribe?t=${encodeURIComponent(token)}`;
  const firstName = String(opts.firstName || '').trim() || 'there';
  const sender = String(opts.sender || '').trim();
  const signoff = sender ? `${sender}, ${ADDRESS_LINE}` : ADDRESS_LINE;

  const subject = `${s.engine} named ${s.othersCount} ${s.trades} in ${s.town}. Not ${s.business}.`;
  const paras = [
    `Hi ${firstName},`,
    `We searched ${s.engine} for "${s.question}" on ${s.date}. It named ${joinNames(s.names)}. It didn't name ${s.business}.`,
    `We ran ${s.searches} searches like this across ${s.assistants} AI assistants. You came up in ${s.namedYou}. Every answer is in your free report, word for word: ${link}`,
    `No login, no call. If you'd rather not hear from us, reply "stop".`,
    signoff,
  ];
  // Footer unsubscribe link (the Worker's GET /unsubscribe?t=<token> handler). Not in the plan's
  // template text, but the Worker and README expect it in every email footer.
  const footer = `Unsubscribe: ${unsubscribeUrl}`;
  const text = `${paras.join('\n\n')}\n\n${footer}\n`;
  const html = paras
    .map((p) => `<p>${esc(p).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`)}</p>`)
    .join('\n') + `\n<p style="font-size:12px;color:#666"><a href="${esc(unsubscribeUrl)}">Unsubscribe</a></p>\n`;

  lint(subject, s);
  lint(text, s);
  return {
    subject,
    text,
    html,
    link,
    unsubscribeUrl,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
