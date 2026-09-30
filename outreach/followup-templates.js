// Follow-up copy for the EXP-002 funnel (src/lib/followups.js decides who gets which one, and when).
//
// Runtime-agnostic ES module (no Node built-ins). Pure functions.
//
// Three stages, each with two variants:
//   followup1  clicked, nothing bought after 3 days: value-add, a verified gap from their scan
//   followup2  clicked, nothing bought after 7 days: last touch
//   bump       no open, no click after 5 days: short, a new angle
//   gap        used when their report has a clean gap (verifiedGap below): a competitor named in more
//              answers than them, counted from the answers themselves
//   generic    everything else (a report that fails validation, only unsure owner matches, no
//              competitor ahead of them). Names no numbers or competitors: nothing to verify.
// A prospect with no saved report gets no follow-up at all (every template points to "your free report").
//
// Hard rules, enforced here and not only by review:
//   - Never surveillance framing. The system may know they clicked; the copy never says so. Every
//     template (shipped or saved from /admin) and every rendered email is checked against
//     SURVEILLANCE_PHRASES; a hit is refused.
//   - Every claim about their business comes from their scan. The gap slots are only filled from
//     verifiedGap(); the generic variant may not use them (validateTemplate refuses it).
//
// DEFAULT_TEMPLATES is placeholder copy until the EXP-001 read (Oct 5). The real copy is saved on /admin
// (outreach_templates, supabase/v14_followups.sql) and overrides these without a code change.

import { lintText, validateReport } from '../shared/report-v2.js';
import { tradePlural } from './templates.js';

export const FOLLOWUP_STAGES = ['followup1', 'followup2', 'bump'];
export const VARIANTS = ['gap', 'generic'];
export const STAGE_LABELS = {
  followup1: 'Follow-up 1 (clicked, 3 days)',
  followup2: 'Follow-up 2 (clicked, 7 days, last touch)',
  bump: 'Bump (no open or click, 5 days)',
};

// Phrases that tell the prospect we watched them. Case-insensitive, any spacing. Kept broad on
// purpose: better to refuse a harmless sentence than send a creepy one.
export const SURVEILLANCE_PHRASES = [
  'saw you', 'saw that you', 'noticed you', 'noticed that you', 'checked out', 'check out', 'you visited', 'your visit',
  'you clicked', 'clicked', 'you opened', 'opened my', 'opened our', 'opened the', 'you viewed', 'you looked',
  'you read', 'you took a look', 'took a look at', 'looking at our', 'you were looking', 'on our site', 'our website',
  'just bumping', 'bumping this', 'circling back', 'following up on my', 'following up on our', 'in case you missed',
  'tracking', 'tracked',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SURVEILLANCE_RES = SURVEILLANCE_PHRASES.map((p) => ({
  phrase: p,
  re: new RegExp(`(?<![\\p{L}\\p{N}])${p.split(/\s+/).map(escapeRe).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu'),
}));

/** surveillanceHits(str) → [{ phrase, match, index }] (URLs skipped: the tracked link is data, not copy). */
export function surveillanceHits(str) {
  if (typeof str !== 'string' || !str) return [];
  const s = str.replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (u) => ' '.repeat(u.length));
  const hits = [];
  for (const { phrase, re } of SURVEILLANCE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) hits.push({ phrase, match: m[0], index: m.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

// Slots. `link` is the tracked link to their report (or the homepage when they have none).
export const GENERIC_SLOTS = ['business', 'town', 'trades', 'link'];
export const GAP_SLOTS = ['competitor', 'competitor_named', 'left_out', 'competitor_total', 'searches', 'named_you'];
export const SLOT_HELP = {
  business: 'their business name',
  town: 'their town',
  trades: 'their trade, plural ("plumbers")',
  link: 'the tracked link to their free report',
  competitor: 'the business AI named most often in the answers that left them out',
  competitor_named: 'how many of those answers named the competitor',
  left_out: 'how many answers did not name them',
  competitor_total: 'how many answers named the competitor in total',
  searches: 'how many answers their scan collected',
  named_you: 'how many answers named them',
};

// Placeholder copy in the first email's voice: plain, specific, lead with what we found. Blank line =
// new paragraph. No first names (the sent rows don't carry one).
export const DEFAULT_TEMPLATES = {
  followup1: {
    gap: {
      subject: '{competitor} and {town} {trades}',
      body: 'Hi there,\n\n'
        + 'One more thing from your free report. Of the {searches} AI answers we collected for {town} {trades}, {left_out} didn\'t name {business}. '
        + '{competitor} was named in {competitor_named} of those {left_out}.\n\n'
        + 'Every answer is in the report, word for word: {link}\n\n'
        + 'No login, no call.',
    },
    generic: {
      subject: 'Which {town} {trades} AI assistants name',
      body: 'Hi there,\n\n'
        + 'When someone asks an AI assistant for {trades} in {town}, it names a few businesses and leaves the rest out.\n\n'
        + 'Your free report shows which ones it named, and whether {business} was one of them, word for word: {link}\n\n'
        + 'No login, no call.',
    },
  },
  followup2: {
    gap: {
      subject: 'Last note about {business}',
      body: 'Hi there,\n\n'
        + 'This is my last note. In {searches} AI answers for {town} {trades}, {business} was named in {named_you}. {competitor} was named in {competitor_total}.\n\n'
        + 'The full report stays free if it\'s ever useful: {link}\n\n'
        + 'Thanks for reading.',
    },
    generic: {
      subject: 'Last note about {business}',
      body: 'Hi there,\n\n'
        + 'This is my last note. Your free report on what AI assistants say about {town} {trades} stays free if it\'s ever useful: {link}\n\n'
        + 'Thanks for reading.',
    },
  },
  bump: {
    gap: {
      subject: 'Who AI names for {town} {trades}',
      body: 'Hi there,\n\n'
        + 'A different way to look at it: {competitor} was named in {competitor_total} of {searches} AI answers for {town} {trades}. {business} was named in {named_you}.\n\n'
        + 'The counts and every answer are in your free report: {link}\n\n'
        + 'No login, no call.',
    },
    generic: {
      subject: 'What AI says about {town} {trades}',
      body: 'Hi there,\n\n'
        + 'A different way to look at it: when someone asks an AI assistant for {trades} in {town}, it answers with a short list of names.\n\n'
        + 'Your free report shows that list, word for word, and whether {business} is on it: {link}\n\n'
        + 'No login, no call.',
    },
  },
};

export const templateKey = (stage, variant) => `${stage}.${variant}`;

/** Every stage.variant with the saved copy (rows from outreach_templates) over the placeholder copy. */
export function mergeTemplates(rows = []) {
  const saved = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && r.key).map((r) => [r.key, r]));
  const out = {};
  for (const stage of FOLLOWUP_STAGES) {
    out[stage] = {};
    for (const variant of VARIANTS) {
      const row = saved.get(templateKey(stage, variant));
      const def = DEFAULT_TEMPLATES[stage][variant];
      out[stage][variant] = row
        ? { subject: String(row.subject ?? ''), body: String(row.body ?? ''), saved: true, updatedAt: row.updated_at || null }
        : { ...def, saved: false, updatedAt: null };
    }
  }
  return out;
}

const SLOT_RE = /\{([^{}]*)\}/g;

/**
 * validateTemplate({ subject, body }, variant) → [error strings]; [] = fine.
 * Unknown slots, gap slots in a generic template, a missing {link}, stray braces, surveillance
 * phrasing and the report's banned words are all refused.
 */
export function validateTemplate(t, variant) {
  const errors = [];
  const subject = String(t?.subject ?? '');
  const body = String(t?.body ?? '');
  if (!VARIANTS.includes(variant)) errors.push(`unknown variant "${variant}"`);
  if (!subject.trim()) errors.push('The subject is empty.');
  if (/[\r\n]/.test(subject)) errors.push('The subject must be one line.');
  if (subject.length > 150) errors.push('The subject is longer than 150 characters.');
  if (!body.trim()) errors.push('The body is empty.');
  if (body.length > 4000) errors.push('The body is longer than 4000 characters.');
  const allowed = new Set(variant === 'gap' ? [...GENERIC_SLOTS, ...GAP_SLOTS] : GENERIC_SLOTS);
  for (const [where, text] of [['subject', subject], ['body', body]]) {
    for (const [, name] of text.matchAll(SLOT_RE)) {
      if (GAP_SLOTS.includes(name) && variant !== 'gap') errors.push(`{${name}} in the ${where}: only the gap version can use it (the generic one goes to people with no clean gap in their scan).`);
      else if (!allowed.has(name)) errors.push(`Unknown slot {${name}} in the ${where}.`);
    }
    if (/[{}]/.test(text.replace(SLOT_RE, ''))) errors.push(`A { or } without its pair in the ${where}.`);
    for (const h of surveillanceHits(text)) errors.push(`“${h.match}” in the ${where}: follow-ups never say what the prospect did (lead with their gap instead).`);
    for (const h of lintText(text.replace(SLOT_RE, ' '))) errors.push(`Banned word “${h.match}” in the ${where}.`);
  }
  if (!/\{link\}/.test(body)) errors.push('The body needs {link} (the tracked link to their report).');
  return [...new Set(errors)];
}

/**
 * The clean gap in a report, or null. Counted from the answers themselves:
 *   left_out      answers that didn't name the owner (answers with an unsure owner match, or a re-ask
 *                 that flipped, are left out of every count)
 *   competitor    the business named in the most of those (ties: named in more answers overall, then
 *                 the name)
 * Only a gap when the competitor is in 2+ of those answers and in more answers overall than the owner.
 */
export function verifiedGap(report) {
  if (!report || !validateReport(report).ok) return null;
  const answers = (report.answers || []).filter((a) => a && !a.headlineUnstable && a.ownerMatch !== 'unsure'
    && !(a.businessesNamed || []).some((b) => b.ownerMatch === 'unsure'));
  if (!answers.length) return null;
  const namesYou = (a) => a.namedYou === true || (a.businessesNamed || []).some((b) => b.isYou);
  const leftOut = answers.filter((a) => !namesYou(a));
  const namedYou = answers.length - leftOut.length;
  const stats = new Map(); // entity key → { name, inLeftOut, total }
  for (const a of answers) {
    const seen = new Set();
    for (const b of [...(a.businessesNamed || [])].sort((x, y) => x.pos - y.pos)) {
      if (b.isYou || !b.name) continue;
      const key = b.entityId || `name:${b.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = stats.get(key) || { name: b.name, inLeftOut: 0, total: 0 };
      s.total += 1;
      if (!namesYou(a)) s.inLeftOut += 1;
      stats.set(key, s);
    }
  }
  const best = [...stats.values()].sort((x, y) => y.inLeftOut - x.inLeftOut || y.total - x.total || x.name.localeCompare(y.name))[0];
  if (!best || best.inLeftOut < 2 || best.total <= namedYou) return null;
  return {
    competitor: best.name,
    competitor_named: best.inLeftOut,
    left_out: leftOut.length,
    competitor_total: best.total,
    searches: answers.length,
    named_you: namedYou,
  };
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fill(text, values) {
  return text.replace(SLOT_RE, (m, name) => {
    if (!(name in values)) throw new Error(`slot {${name}} has no value`);
    return String(values[name]);
  });
}

// Business names and the competitor's name are data, not our copy: masked before the checks.
function check(str, masks, what) {
  let masked = str;
  for (const v of masks) if (v) masked = masked.split(v).join(' ');
  const s = surveillanceHits(masked);
  if (s.length) throw new Error(`surveillance phrasing in ${what}: ${s.map((h) => JSON.stringify(h.match)).join(', ')}`);
  const b = lintText(masked);
  if (b.length) throw new Error(`banned word in ${what}: ${b.map((h) => JSON.stringify(h.match)).join(', ')}`);
}

/**
 * renderFollowup({ stage, templates, report, link }) → { subject, text, html, variant, gap }
 * `report` is the prospect's own report (the one their first email linked to): every template says
 * "your free report", so there is no follow-up without one. Name, town and trade come from it.
 * The gap variant only when verifiedGap(report) finds one; otherwise generic. Throws when the stage is
 * unknown, the report has no business name / town / trade, the copy fails validateTemplate, a slot is
 * missing, or the finished email trips the surveillance or banned-word check: nothing is sent.
 */
export function renderFollowup({ stage, templates = mergeTemplates(), report, link }) {
  if (!FOLLOWUP_STAGES.includes(stage)) throw new Error(`unknown follow-up stage "${stage}"`);
  if (!link) throw new Error('renderFollowup needs a link');
  const b = report?.business || {};
  const name = String(b.name || '').trim();
  const town = String(b.town || '').trim();
  const trade = String(b.trade || '').trim();
  if (!name || !town || !trade) throw new Error('renderFollowup needs a report with the business name, town and trade');
  const gap = verifiedGap(report);
  const variant = gap ? 'gap' : 'generic';
  const tpl = templates?.[stage]?.[variant];
  const errors = validateTemplate(tpl, variant);
  if (errors.length) throw new Error(`${templateKey(stage, variant)} copy is not valid: ${errors.join(' ')}`);
  const values = { business: name, town, trades: tradePlural(trade), link, ...(gap || {}) };
  const subject = fill(tpl.subject, values).replace(/\s+/g, ' ').trim();
  const paras = fill(tpl.body, values).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const text = `${paras.join('\n\n')}\n`;
  const masks = [name, gap?.competitor];
  check(subject, masks, 'the subject');
  check(text, masks, 'the body');
  const html = paras.map((p) => `<p>${esc(p).split(esc(link)).join(`<a href="${esc(link)}">${esc(link)}</a>`).replace(/\n/g, '<br>')}</p>`).join('\n');
  return { subject, text, html, variant, gap };
}
