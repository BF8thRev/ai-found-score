// Follow-up copy (outreach/followup-templates.js): no surveillance phrasing anywhere we ship, gap claims
// only from the scan, the generic fallback, and the copy checks /admin saving relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_TEMPLATES, FOLLOWUP_STAGES, VARIANTS, SURVEILLANCE_PHRASES, GAP_SLOTS,
  surveillanceHits, validateTemplate, verifiedGap, renderFollowup, mergeTemplates,
} from '../followup-templates.js';
import { lintText, validateReport, computeTotals, pickHeadline } from '../../shared/report-v2.js';

const load = () => JSON.parse(readFileSync(new URL('./fixtures/fictional-laundromat.json', import.meta.url), 'utf8'));
const LINK = 'https://aifoundscore.com/e/click?token=Fu_token_abcdefghijk&to=https%3A%2F%2Faifoundscore.com%2Freport%2Frep1';
// After editing answers: entity counts, totals and headline recomputed, so the report is still valid
// (a report that fails validation gets no gap for that reason alone, which would hide what's tested).
function consistent(r) {
  for (const e of r.entities) {
    const ids = r.answers.filter((a) => a.businessesNamed.some((b) => b.entityId === e.id)).map((a) => a.id);
    e.named = ids.length;
    e.answerIds = ids;
    e.first = r.answers.filter((a) => [...a.businessesNamed].filter((b) => b.ownerMatch !== 'unsure').sort((x, y) => x.pos - y.pos)[0]?.entityId === e.id).length;
  }
  for (const a of r.answers) {
    const first = [...a.businessesNamed].filter((b) => b.ownerMatch !== 'unsure').sort((x, y) => x.pos - y.pos)[0];
    a.namedYouFirst = !!(a.namedYou && first?.isYou);
  }
  r.totals = computeTotals(r);
  r.headline = pickHeadline(r);
  const v = validateReport(r);
  assert.ok(v.ok, v.errors.join('; '));
  return r;
}
/** The owner added to every answer that left them out, except `keep`. */
function ownerAddedExcept(keep) {
  const r = load();
  for (const a of r.answers) {
    if (a.namedYou || keep.includes(a.id)) continue;
    a.businessesNamed.push({ name: 'Bluebird Wash & Fold', pos: a.text.length + 1, entityId: 'e1', isYou: true });
    a.text += ' Bluebird Wash & Fold is also nearby.';
    a.namedYou = true;
  }
  return consistent(r);
}

// The spec's banned phrasing, grepped for literally (not through surveillanceHits, so a bug in the
// matcher can't hide a hit).
const SPEC_BANNED = /saw you|noticed you|checked out/i;

// ---- no surveillance phrasing in anything we ship --------------------------------------------

test('shipped templates: none says "saw you", "noticed you" or "checked out" (literal grep of every string)', () => {
  let n = 0;
  for (const stage of FOLLOWUP_STAGES) {
    for (const variant of VARIANTS) {
      const t = DEFAULT_TEMPLATES[stage][variant];
      for (const s of [t.subject, t.body]) {
        n += 1;
        assert.doesNotMatch(s, SPEC_BANNED, `${stage}.${variant}: ${s}`);
        assert.deepEqual(surveillanceHits(s), [], `${stage}.${variant}: ${s}`);
      }
    }
  }
  assert.equal(n, FOLLOWUP_STAGES.length * VARIANTS.length * 2, 'every stage and variant checked');
});

test('shipped templates: the source file has no banned phrasing outside the ban list itself', () => {
  const src = readFileSync(new URL('../followup-templates.js', import.meta.url), 'utf8');
  // Drop the SURVEILLANCE_PHRASES array (it has to name them) and the comments that quote them.
  const start = src.indexOf('export const SURVEILLANCE_PHRASES');
  const code = (src.slice(0, start) + src.slice(src.indexOf('];', start) + 2))
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.doesNotMatch(code, SPEC_BANNED);
  for (const p of ['you clicked', 'you opened', 'you visited', 'just bumping', 'circling back']) assert.ok(!code.toLowerCase().includes(p), p);
});

test('shipped templates: rendered emails (gap and generic, every stage) have no banned phrasing or banned words', () => {
  const r = load();
  const bare = { ...load(), answers: [] }; // fails validation → generic
  for (const stage of FOLLOWUP_STAGES) {
    for (const report of [r, bare]) {
      const e = renderFollowup({ stage, report, link: LINK });
      for (const s of [e.subject, e.text, e.html]) {
        assert.doesNotMatch(s, SPEC_BANNED, `${stage}.${e.variant}`);
        assert.deepEqual(surveillanceHits(s), [], `${stage}.${e.variant}`);
      }
      assert.deepEqual(lintText(e.text), []);
    }
  }
});

test('surveillanceHits: the spec phrases and the obvious cousins, any case or spacing; not inside other words', () => {
  for (const s of ['I saw you checked out the site', 'Noticed  you were looking', 'you CLICKED the link', 'Just bumping this', 'circling back on this']) {
    assert.ok(surveillanceHits(s).length, s);
  }
  assert.deepEqual(surveillanceHits('Harbor Lane was named in 7 of 12 answers.'), []);
  assert.deepEqual(surveillanceHits('a sawyouth checkedoutside'), [], 'whole words only');
  assert.deepEqual(surveillanceHits(`link: ${LINK}`), [], 'URLs are skipped');
  for (const p of ['saw you', 'noticed you', 'checked out']) assert.ok(SURVEILLANCE_PHRASES.includes(p), p);
});

// ---- verified gap: every number comes from the answers --------------------------------------

test('verifiedGap: the competitor named most in the answers that left the owner out, counted from the answers', () => {
  const r = load();
  const g = verifiedGap(r);
  assert.deepEqual(g, { competitor: 'Harbor Lane Laundromat', competitor_named: 7, left_out: 12, competitor_total: 11, searches: 20, named_you: 8 });
  // Recount by hand from the fixture, independent of the implementation.
  const left = r.answers.filter((a) => !a.namedYou);
  assert.equal(left.length, g.left_out);
  assert.equal(left.filter((a) => a.businessesNamed.some((b) => b.name === g.competitor)).length, g.competitor_named);
  assert.equal(r.answers.filter((a) => a.businessesNamed.some((b) => b.name === g.competitor)).length, g.competitor_total);
  assert.equal(r.answers.filter((a) => a.namedYou).length, g.named_you);
});

test('verifiedGap: null when there is no clean gap (→ generic copy), on reports that are still valid', () => {
  assert.equal(verifiedGap(null), null);
  assert.equal(verifiedGap({ ...load(), answers: [] }), null, 'fails validation');
  // The owner is named in more answers (17) than the top competitor (11): nobody is "ahead" of them.
  const ahead = ownerAddedExcept(['a1', 'a4', 'a5']);
  assert.equal(ahead.totals.namedYou, 17);
  assert.equal(verifiedGap(ahead), null);
  // Only one answer left them out: the competitor isn't named in 2+ of those.
  assert.equal(verifiedGap(ownerAddedExcept(['a16'])), null);
  // Unsure owner matches are left out of every count: with them all unsure there is nothing to say.
  const unsure = load();
  for (const a of unsure.answers) if (!a.namedYou) a.ownerMatch = 'unsure';
  consistent(unsure);
  assert.equal(verifiedGap(unsure), null);
  // Control: the untouched fixture, run through the same helper, still has its gap.
  assert.equal(verifiedGap(consistent(load()))?.competitor, 'Harbor Lane Laundromat');
});

// ---- rendering --------------------------------------------------------------------------------

test('renderFollowup: gap copy with the verified numbers, the tracked link, and every slot filled', () => {
  const e = renderFollowup({ stage: 'followup1', report: load(), link: LINK });
  assert.equal(e.variant, 'gap');
  assert.equal(e.subject, 'Harbor Lane Laundromat and Seaford laundromats');
  assert.match(e.text, /Of the 20 AI answers we collected for Seaford laundromats, 12 didn't name Bluebird Wash & Fold\. Harbor Lane Laundromat was named in 7 of those 12\./);
  assert.ok(e.text.includes(LINK));
  assert.ok(e.html.includes(`<a href="${LINK.replace(/&/g, '&amp;')}">`));
  assert.match(e.html, /Bluebird Wash &amp; Fold/);
  for (const s of [e.subject, e.text]) assert.doesNotMatch(s, /[{}]/, 'no slot left unfilled');
});

test('renderFollowup: generic copy names no competitor and no numbers when the scan has no clean gap', () => {
  const r = { ...load(), answers: [] };
  for (const stage of FOLLOWUP_STAGES) {
    const e = renderFollowup({ stage, report: r, link: LINK });
    assert.equal(e.variant, 'generic', stage);
    assert.equal(e.gap, null);
    const copy = e.text.replace(LINK, '');
    assert.doesNotMatch(copy, /\d/, `${stage}: no counts`);
    for (const other of ['Harbor Lane', 'Maple Street', 'Corner Spin', 'Tidewater', 'Clearwater']) assert.ok(!copy.includes(other), `${stage}: ${other}`);
  }
});

test('renderFollowup: no report (or one without name/town/trade) → throws, nothing to send', () => {
  assert.throws(() => renderFollowup({ stage: 'bump', report: null, link: LINK }), /needs a report/);
  assert.throws(() => renderFollowup({ stage: 'bump', report: { business: { name: 'X' } }, link: LINK }), /needs a report/);
  assert.throws(() => renderFollowup({ stage: 'nope', report: load(), link: LINK }), /unknown follow-up stage/);
});

test('renderFollowup: saved copy with surveillance phrasing is refused at send time too', () => {
  const t = mergeTemplates([{ key: 'followup1.gap', subject: 'Hi', body: 'We saw you checked out the report: {link}' }]);
  assert.throws(() => renderFollowup({ stage: 'followup1', templates: t, report: load(), link: LINK }), /not valid/);
});

test('renderFollowup: a business name that happens to contain a banned phrase is data, not copy', () => {
  const r = load();
  r.business.name = 'Checked Out Laundry';
  // The name appears only as data in the generic copy (the fixture's own names still gap-match, so use an empty report).
  const e = renderFollowup({ stage: 'bump', report: { ...r, answers: [] }, link: LINK });
  assert.match(e.text, /Checked Out Laundry/);
});

// ---- validateTemplate (what /admin saving uses) -------------------------------------------

test('validateTemplate: shipped copy is valid; bad copy is refused with a reason', () => {
  for (const stage of FOLLOWUP_STAGES) for (const v of VARIANTS) assert.deepEqual(validateTemplate(DEFAULT_TEMPLATES[stage][v], v), [], `${stage}.${v}`);
  const ok = { subject: 'About {business}', body: 'Your report: {link}' };
  assert.deepEqual(validateTemplate(ok, 'generic'), []);
  const cases = [
    [{ ...ok, body: 'Saw you on the site. {link}' }, 'generic', /“Saw you”/],
    [{ ...ok, subject: 'Noticed you looked' }, 'generic', /“Noticed you”/],
    [{ ...ok, body: 'You checked out {link}' }, 'generic', /“checked out”/],
    [{ ...ok, body: '{competitor} is ahead. {link}' }, 'generic', /only the gap version/],
    [{ ...ok, body: '{first_name}, {link}' }, 'gap', /Unknown slot \{first_name\}/],
    [{ ...ok, body: 'No link here.' }, 'generic', /needs \{link\}/],
    [{ ...ok, body: 'Broken {link' }, 'generic', /without its pair/],
    [{ ...ok, subject: '' }, 'generic', /subject is empty/],
    [{ ...ok, subject: 'a\nb' }, 'generic', /one line/],
    [{ ...ok, body: 'We rank you. {link}' }, 'generic', /Banned word “rank”/],
  ];
  for (const [t, v, re] of cases) assert.match(validateTemplate(t, v).join(' '), re, JSON.stringify(t));
  for (const s of GAP_SLOTS) assert.deepEqual(validateTemplate({ subject: 's', body: `{${s}} {link}` }, 'gap'), [], s);
});

test('mergeTemplates: saved rows override the placeholder; the rest stay placeholder', () => {
  const m = mergeTemplates([{ key: 'bump.generic', subject: 'S', body: 'B {link}', updated_at: '2026-10-05T12:00:00Z' }, { key: 'junk', subject: 'x', body: 'y' }]);
  assert.deepEqual(m.bump.generic, { subject: 'S', body: 'B {link}', saved: true, updatedAt: '2026-10-05T12:00:00Z' });
  assert.equal(m.followup1.gap.saved, false);
  assert.equal(m.followup1.gap.subject, DEFAULT_TEMPLATES.followup1.gap.subject);
});
