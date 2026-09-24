import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postcard, coldEmail, skipReason, otherNamesInOrder, formatDate } from '../templates.js';
import { send } from '../send.js';
import { lintText, pickHeadline, computeTotals } from '../../shared/report-v2.js';

const load = () => JSON.parse(readFileSync(new URL('./fixtures/fictional-laundromat.json', import.meta.url), 'utf8'));

test('fixture headline is the ChatGPT answer that names four others', () => {
  const r = load();
  assert.deepEqual(r.headline, { answerId: 'a1', rule: 'most_others_named_not_you' });
  assert.equal(skipReason(r), null);
});

test('postcard fills every slot from the headline answer, names in order', () => {
  const p = postcard(load(), { code: 'ABC234' });
  assert.equal(p.front,
    'We asked ChatGPT: "What\'s the best laundromat in Seaford, NY?" It named Harbor Lane Laundromat, ' +
    'Maple Street Suds and Corner Spin Laundry. It didn\'t name Bluebird Wash & Fold.');
  assert.equal(p.back,
    'We ran 20 searches like this for Seaford laundromats. You came up in 8. ' +
    'See every answer, free: aifoundscore.com/r/ABC234 No email. No sales call. — AI Found Score, Plainview, NY');
  // the fourth name (Tidewater Wash House) is left out: first three only
  assert.ok(!p.front.includes('Tidewater'));
});

test('cold email matches the plan template', () => {
  const e = coldEmail(load(), { token: 'tok_123', code: 'ABC234', firstName: 'Dana', sender: 'Bryan' });
  assert.equal(e.subject, 'ChatGPT named 4 laundromats in Seaford. Not Bluebird Wash & Fold.');
  const expected = [
    'Hi Dana,',
    'We searched ChatGPT for "What\'s the best laundromat in Seaford, NY?" on September 22, 2026. It named Harbor Lane Laundromat, Maple Street Suds and Corner Spin Laundry. It didn\'t name Bluebird Wash & Fold.',
    'We ran 20 searches like this across four AI assistants. You came up in 8. Every answer is in your free report, word for word: https://aifoundscore.com/r/ABC234',
    'No login, no call. If you\'d rather not hear from us, reply "stop".',
    'Bryan, AI Found Score · 120 Terminal Drive, Plainview, NY 11803',
    'Unsubscribe: https://aifoundscore.com/unsubscribe?t=tok_123',
  ].join('\n\n') + '\n';
  assert.equal(e.text, expected);
  assert.equal(e.headers['List-Unsubscribe'], '<https://aifoundscore.com/unsubscribe?t=tok_123>');
  assert.equal(e.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(e.html, /<a href="https:\/\/aifoundscore\.com\/r\/ABC234">/);
  assert.match(e.html, /Bluebird Wash &amp; Fold/);
  assert.match(e.html, /120 Terminal Drive, Plainview, NY 11803/);
});

test('email defaults: "there", no sender, report link from token', () => {
  const e = coldEmail(load(), { token: 'tok 9' });
  assert.ok(e.text.startsWith('Hi there,\n\n'));
  assert.ok(e.text.includes('\n\nAI Found Score · 120 Terminal Drive, Plainview, NY 11803\n\n'));
  assert.equal(e.link, 'https://aifoundscore.com/report/tok%209');
  assert.equal(e.unsubscribeUrl, 'https://aifoundscore.com/unsubscribe?t=tok%209');
});

test('no banned words in any output', () => {
  const p = postcard(load(), { code: 'ABC234' });
  const e = coldEmail(load(), { token: 't', firstName: 'Dana', sender: 'Bryan' });
  for (const s of [p.front, p.back, e.subject, e.text]) assert.deepEqual(lintText(s), [], s);
});

test('name order follows position in the text, dedupes an entity, skips owner and unsure', () => {
  const a = {
    businessesNamed: [
      { name: 'C Co', pos: 40, entityId: 'e3' },
      { name: 'Owner', pos: 0, entityId: 'e1', isYou: true },
      { name: 'A Co', pos: 10, entityId: 'e2' },
      { name: 'A Company', pos: 60, entityId: 'e2' },
      { name: 'Maybe Owner', pos: 20, ownerMatch: 'unsure' },
      { name: 'B Co', pos: 30, entityId: 'e4' },
    ],
  };
  assert.deepEqual(otherNamesInOrder(a), ['A Co', 'B Co', 'C Co']);
});

// ---- null cases: send nothing ----

function allNamed() {
  const r = load();
  for (const a of r.answers) {
    if (a.namedYou) continue;
    const add = ' Bluebird Wash & Fold is also nearby.';
    a.businessesNamed.push({ name: 'Bluebird Wash & Fold', pos: a.text.length + 1, entityId: 'e1', isYou: true });
    a.text += add;
    a.namedYou = true;
  }
  return r;
}

test('owner named in every answer: null', () => {
  const r = allNamed();
  assert.equal(skipReason(r), 'all_named');
  assert.equal(postcard(r, { code: 'X' }), null);
  assert.equal(coldEmail(r, { token: 't' }), null);
});

test('headline answer names the owner: null', () => {
  const r = load();
  r.headline = { answerId: 'a2', rule: 'most_others_named_not_you' }; // a2 names the owner
  assert.equal(skipReason(r), 'headline_names_you');
  assert.equal(postcard(r, { code: 'X' }), null);
  assert.equal(coldEmail(r, { token: 't' }), null);
});

test('headline answer names fewer than 2 others: null', () => {
  const r = load();
  // Keep only answers that name at most one other business, owner absent in one of them.
  r.answers = r.answers.filter((a) => a.id === 'a20' ? false : true);
  const lone = r.answers.find((a) => a.id === 'a16'); // perplexity q4: one other, not the owner
  assert.equal(lone.namedYou, false);
  r.headline = { answerId: 'a16', rule: 'most_others_named_not_you' };
  assert.equal(skipReason(r), 'fewer_than_2_others');
  assert.equal(postcard(r, { code: 'X' }), null);
  assert.equal(coldEmail(r, { token: 't' }), null);
});

test('headline answer with no names at all: null', () => {
  const r = load();
  r.headline = { answerId: 'a8', rule: 'most_others_named_not_you' }; // general advice, no names
  assert.equal(skipReason(r), 'fewer_than_2_others');
  assert.equal(coldEmail(r, { token: 't' }), null);
});

test('unsure owner match in the headline answer: null', () => {
  const r = load();
  r.answers[0].ownerMatch = 'unsure';
  assert.equal(skipReason(r), 'headline_unsure');
  assert.equal(postcard(r, { code: 'X' }), null);
});

// ---- guards ----

test('tampered totals fail validation (every number traces to data)', () => {
  const r = load();
  r.totals.namedYou = 3;
  assert.throws(() => postcard(r, { code: 'X' }), /fails validation/);
});

test('missing code or token throws rather than printing a broken link', () => {
  assert.throws(() => postcard(load(), {}), /opts\.code/);
  assert.throws(() => coldEmail(load(), {}), /opts\.token/);
});

test('fixture totals and headline agree with the shared rules', () => {
  const r = load();
  assert.deepEqual(r.totals, computeTotals(r));
  assert.deepEqual(r.headline, pickHeadline(r));
});

test('dates are shown in Eastern time', () => {
  assert.equal(formatDate('2026-09-23T02:30:00Z'), 'September 22, 2026');
});

test('send() is a stub that refuses', async () => {
  await assert.rejects(send({}), /sending not enabled/);
});
