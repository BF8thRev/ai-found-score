// The EXP-002 follow-up runner (src/lib/followups.js): the timing rules, suppression (replied, bought,
// unsubscribed: fail closed), the max-2 cap (in the runner and in the database claim), token linkage
// from each follow-up back to the prospect, and the Gmail sender's guards. Google, Gmail and Supabase
// are fakes (fake-followups.js on top of fake-gmail.js): nothing real is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextFollowup, sendWindowOpen, runFollowups, followupsEnabled, MAX_FOLLOWUPS } from '../followups.js';
import { clearTokenCache } from '../gmail-sender.js';
import { validToken } from '../email-tracking.js';
import { GMAIL_ENV } from './fake-gmail.js';
import { fakeFollowups, prospect, ROOT, REPORT, DAY, NOW, iso } from './fake-followups.js';

const REPORT_JSON = JSON.parse(readFileSync(new URL('../../../outreach/test/fixtures/fictional-laundromat.json', import.meta.url), 'utf8'));
const ENV = { ...GMAIL_ENV, GMAIL_OUTREACH: 'on', GMAIL_FOLLOWUPS: 'on' };
const run = (f, { env = ENV, now = NOW, ...rest } = {}) => runFollowups(env, { fetchImpl: f.impl, now, sleep: async (ms) => { f.sleeps = [...(f.sleeps || []), ms]; f.g.tick(ms); }, ...rest });
const clicked = (daysAgo, over = {}) => prospect({ opened_at: iso(NOW - (daysAgo + 0.1) * DAY), clicked_at: iso(NOW - daysAgo * DAY), ...over });
const fixture = (prospects, opts = {}) => fakeFollowups({ prospects, reports: { [REPORT]: REPORT_JSON }, ...opts });

test.beforeEach(() => clearTokenCache());

// ---- the rules (pure) ------------------------------------------------------------------------

test('rules: clicked → Follow-up 1 at 3 days, Follow-up 2 at 7 days (3+ days after Follow-up 1)', () => {
  assert.deepEqual(nextFollowup({ ...clicked(2.9), followups: [] }, NOW).wait, 'followup1');
  assert.deepEqual(nextFollowup({ ...clicked(3), followups: [] }, NOW), { due: 'followup1' });
  const fu1 = (daysAgo) => [{ stage: 'followup1', sent_at: iso(NOW - daysAgo * DAY) }];
  assert.equal(nextFollowup({ ...clicked(6.9), followups: fu1(3.9) }, NOW).wait, 'followup2');
  assert.deepEqual(nextFollowup({ ...clicked(7), followups: fu1(4) }, NOW), { due: 'followup2' });
  // Follow-up 1 went out late (day 6): Follow-up 2 waits 3 days after it, not just until day 7.
  const late = nextFollowup({ ...clicked(7), followups: fu1(1) }, NOW);
  assert.equal(late.wait, 'followup2');
  assert.equal(late.at, NOW - DAY + 3 * DAY);
});

test('rules: no open and no click → one bump at 5 days; an open without a click gets nothing', () => {
  assert.equal(nextFollowup({ ...prospect({ sent_at: iso(NOW - 4.9 * DAY) }), followups: [] }, NOW).wait, 'bump');
  assert.deepEqual(nextFollowup({ ...prospect({ sent_at: iso(NOW - 5 * DAY) }), followups: [] }, NOW), { due: 'bump' });
  assert.deepEqual(nextFollowup({ ...prospect({ opened_at: iso(NOW - 4 * DAY) }), followups: [] }, NOW), { skip: 'opened, no click' });
  const bumped = [{ stage: 'bump', sent_at: iso(NOW - 3 * DAY) }];
  assert.deepEqual(nextFollowup({ ...prospect(), followups: bumped }, NOW), { skip: 'bump sent' }, 'one bump only');
  // Clicked after the bump: Follow-up 1 is the second and last one.
  assert.deepEqual(nextFollowup({ ...clicked(3), followups: bumped }, NOW), { due: 'followup1' });
});

test('rules: max 2 follow-ups ever, whatever the stages', () => {
  const two = [{ stage: 'bump', sent_at: iso(NOW - 9 * DAY) }, { stage: 'followup1', sent_at: iso(NOW - 5 * DAY) }];
  assert.deepEqual(nextFollowup({ ...clicked(8), followups: two }, NOW), { skip: 'max' });
  const both = [{ stage: 'followup1', sent_at: iso(NOW - 9 * DAY) }, { stage: 'followup2', sent_at: iso(NOW - 5 * DAY) }];
  assert.deepEqual(nextFollowup({ ...clicked(20), followups: both }, NOW), { skip: 'max' });
  assert.equal(MAX_FOLLOWUPS, 2);
});

test('rules: replied, bought (or unknown), unsubscribed, no email, no report → never', () => {
  const due = { ...clicked(3), followups: [] };
  assert.deepEqual(nextFollowup(due, NOW), { due: 'followup1' }, 'control');
  assert.deepEqual(nextFollowup({ ...due, replied_at: iso(NOW - DAY) }, NOW), { skip: 'replied' });
  for (const purchased of [true, null, undefined, 'false', 0]) {
    assert.deepEqual(nextFollowup({ ...due, purchased }, NOW), { skip: 'purchased' }, `purchased=${JSON.stringify(purchased)} fails closed`);
  }
  assert.deepEqual(nextFollowup({ ...due, unsubscribed_at: iso(NOW - DAY) }, NOW), { skip: 'unsubscribed' });
  assert.deepEqual(nextFollowup({ ...due, email: null }, NOW), { skip: 'no email' });
  assert.deepEqual(nextFollowup({ ...due, report_token: null }, NOW), { skip: 'no report' });
  assert.deepEqual(nextFollowup({ ...due, followups: null }, NOW), { skip: 'bad row' });
});

test('send window: weekdays 9am-5pm New York (DST-aware)', () => {
  assert.equal(sendWindowOpen(new Date('2026-09-30T13:00:00Z')), true, 'Wed 9:00 EDT');
  assert.equal(sendWindowOpen(new Date('2026-09-30T12:59:00Z')), false, 'Wed 8:59 EDT');
  assert.equal(sendWindowOpen(new Date('2026-09-30T20:59:00Z')), true, 'Wed 4:59 pm EDT');
  assert.equal(sendWindowOpen(new Date('2026-09-30T21:00:00Z')), false, 'Wed 5:00 pm EDT');
  assert.equal(sendWindowOpen(new Date('2026-10-03T15:00:00Z')), false, 'Saturday');
  assert.equal(sendWindowOpen(new Date('2026-12-02T14:00:00Z')), true, 'Wed 9:00 EST');
  assert.equal(sendWindowOpen(new Date('2026-12-02T13:30:00Z')), false, 'Wed 8:30 EST');
  assert.equal(followupsEnabled({}), false);
  assert.equal(followupsEnabled({ GMAIL_FOLLOWUPS: ' On ' }), true);
});

// ---- a send, and the token linkage ------------------------------------------------------------

test('send: Follow-up 1 goes out with its own token, linked to the prospect, with the verified gap', async () => {
  const f = fixture([clicked(3)]);
  const r = await run(f);
  assert.equal(r.sent, 1);
  assert.equal(f.g.gmail.length, 1);
  // The claim links the new token to the prospect's first email.
  assert.equal(f.claims.length, 1);
  const { p_parent: parent, p_stage: stage, p_token: fu } = f.claims[0];
  assert.equal(parent, ROOT);
  assert.equal(stage, 'followup1');
  assert.ok(validToken(fu) && fu !== ROOT, 'a fresh token of its own');
  assert.deepEqual(f.rows.map((x) => [x.token, x.parent_token, x.stage]), [[fu, ROOT, 'followup1']]);
  // The Gmail sender logged it under the follow-up token and the campaign.
  assert.deepEqual([f.g.sends[0].kind, f.g.sends[0].token, f.g.sends[0].campaign, f.g.sends[0].to_email, f.g.sends[0].status],
    ['outreach', fu, 'exp002', 'owner@bluebird.example', 'sent']);
  // Every tracked thing in the email carries the follow-up token (never the prospect's).
  const m = f.g.gmail[0].decoded;
  assert.ok(m.text.includes(`https://aifoundscore.com/e/click?token=${fu}&to=${encodeURIComponent(`https://aifoundscore.com/report/${REPORT}`)}`), 'tracked report link');
  assert.ok(m.text.includes(`https://aifoundscore.com/stop?ref=${fu}`), 'unsubscribe link');
  assert.ok(m.html.includes(`https://aifoundscore.com/e/open?token=${fu}`), 'open pixel');
  assert.match(m.head, new RegExp(`List-Unsubscribe: <https://aifoundscore.com/stop\\?ref=${fu}>`));
  assert.match(m.head, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.ok(!m.mime.includes(ROOT), 'the prospect token is not in the email');
  // The verified gap, and the footer.
  assert.match(m.head, /Subject: Harbor Lane Laundromat and Seaford laundromats/);
  assert.match(m.text, /12 didn't name Bluebird Wash & Fold\. Harbor Lane Laundromat was named in 7 of those 12\./);
  assert.match(m.text, /120 Terminal Drive, Plainview, NY 11803/);
  assert.doesNotMatch(m.text, /saw you|noticed you|checked out|clicked/i);
  assert.deepEqual(r.results.map((x) => [x.stage, x.ok, x.variant]), [['followup1', true, 'gap']]);
});

test('send: a bump uses the generic copy when the scan has no clean gap', async () => {
  const f = fakeFollowups({ prospects: [prospect({ sent_at: iso(NOW - 6 * DAY) })], reports: { [REPORT]: { ...REPORT_JSON, answers: [] } } });
  const r = await run(f);
  assert.equal(r.sent, 1);
  assert.equal(f.claims[0].p_stage, 'bump');
  assert.equal(r.results[0].variant, 'generic');
  assert.doesNotMatch(f.g.gmail[0].decoded.text.replace(/https?:\/\/\S+/g, ''), /Harbor Lane|\d+ of/);
});

test('send: no saved report → no follow-up (the copy points to "your free report")', async () => {
  const f = fakeFollowups({ prospects: [clicked(3)], reports: {} });
  const r = await run(f);
  assert.equal(r.sent, 0);
  assert.equal(r.results[0].reason, 'no report');
  assert.equal(f.claims.length + f.g.gmail.length, 0);
});

// ---- suppression: fail closed ---------------------------------------------------------------

test('suppression: replied, bought or unsubscribed prospects are never followed up', async () => {
  for (const over of [{ replied_at: iso(NOW - DAY) }, { purchased: true }, { purchased: null }, { unsubscribed_at: iso(NOW - DAY) }]) {
    const f = fixture([clicked(3, over), prospect({ token: 'Other_prospect_12345', sent_at: iso(NOW - 6 * DAY), email: 'b@b.example' })]);
    const r = await run(f);
    assert.equal(f.g.gmail.length, 1, JSON.stringify(over));
    assert.equal(f.claims.every((c) => c.p_parent !== ROOT), true, `${JSON.stringify(over)}: never even claimed`);
    assert.equal(r.sent, 1, 'the other prospect still gets its bump');
  }
});

test('suppression: an address or report on the unsubscribe list → nothing claimed, nothing sent', async () => {
  for (const unsubscribed of [['owner@bluebird.example'], [REPORT]]) {
    const f = fixture([clicked(3)], { unsubscribed });
    const r = await run(f);
    assert.equal(r.results[0].reason, 'suppressed');
    assert.equal(f.claims.length + f.g.gmail.length, 0);
  }
});

test('suppression fails closed: the unsubscribe lookup, the candidates read or the copy read failing sends nothing', async () => {
  for (const table of ['unsubscribes', 'report_links']) {
    const f = fixture([clicked(3)], { fail: [table] });
    const r = await run(f);
    assert.equal(r.results[0]?.reason, 'suppressed', table);
    assert.equal(f.claims.length + f.g.gmail.length, 0, table);
  }
  for (const table of ['v_followup_candidates', 'outreach_templates']) {
    const f = fixture([clicked(3)], { fail: [table] });
    const r = await run(f);
    assert.equal(r.ok, false, table);
    assert.match(r.error, /HTTP 500/);
    assert.equal(f.claims.length + f.g.gmail.length, 0, table);
  }
  // The report read failing: no copy to send.
  const f = fixture([clicked(3)], { fail: ['scan_results'] });
  assert.equal((await run(f)).results[0].reason, 'report read failed');
  assert.equal(f.claims.length + f.g.gmail.length, 0);
});

test('suppression: the database claim refuses a prospect who replied or bought since the list was read', async () => {
  for (const over of [{ replied_at: iso(NOW) }, { purchased: true }]) {
    const f = fixture([clicked(3)]);
    const orig = f.impl;
    // The view read says "not replied / not bought"; by the time of the claim the database knows better.
    f.impl = async (input, init) => {
      const res = await orig(input, init);
      if (String(input).includes('v_followup_candidates')) Object.assign(f.prospects[0], over);
      return res;
    };
    const r = await run(f);
    assert.equal(f.claims.length, 1);
    assert.equal(r.results[0].reason, Object.keys(over)[0] === 'replied_at' ? 'replied' : 'purchased');
    assert.equal(f.g.gmail.length, 0);
    assert.equal(f.rows.length, 0);
  }
});

// ---- the max-2 cap ------------------------------------------------------------------------------

test('cap: a prospect with 2 follow-ups is never claimed again', async () => {
  const rows = [
    { token: 'Fu_bump_abcdefghijkl', parent_token: ROOT, stage: 'bump', sent_at: iso(NOW - 9 * DAY) },
    { token: 'Fu_one_abcdefghijklm', parent_token: ROOT, stage: 'followup1', sent_at: iso(NOW - 5 * DAY) },
  ];
  const f = fixture([clicked(9)], { rows });
  const r = await run(f);
  assert.equal(r.due, 0);
  assert.equal(f.claims.length + f.g.gmail.length, 0);
});

test('cap: the database refuses a third follow-up even when the runner read a stale list', async () => {
  // Two follow-ups already claimed (e.g. by a run in parallel) but not in the list this run read.
  const rows = [
    { token: 'Fu_bump_abcdefghijkl', parent_token: ROOT, stage: 'bump', sent_at: iso(NOW - 9 * DAY), hidden: true },
    { token: 'Fu_two_abcdefghijklm', parent_token: ROOT, stage: 'followup2', sent_at: iso(NOW - DAY), hidden: true },
  ];
  const f = fixture([clicked(3)], { rows });
  const r = await run(f);
  assert.equal(f.claims.length, 1, 'the runner thought one was due');
  assert.equal(r.results[0].reason, 'max');
  assert.equal(f.g.gmail.length, 0);
});

test('cap: a prospect\'s whole life, run every day for 3 weeks → exactly 2 follow-ups (bump, then Follow-up 1)', async () => {
  const start = NOW - 20 * DAY;
  const f = fixture([prospect({ sent_at: iso(start) })]);
  for (let day = 0; day <= 20; day++) {
    const now = start + day * DAY;
    if (!sendWindowOpen(new Date(now))) continue;
    // Day 8: they click the bump.
    if (day === 8) { f.prospects[0].clicked_at = iso(now - 3600e3); }
    f.g.tick(24 * 3600e3);
    const before = f.rows.length;
    await run(f, { now });
    for (const r of f.rows.slice(before)) r.sent_at = iso(now); // stamped by the simulated day, not the fake's clock
  }
  assert.deepEqual(f.rows.map((r) => r.stage), ['bump', 'followup1']);
  assert.equal(f.g.gmail.length, 2);
  assert.ok(f.rows.every((r) => r.parent_token === ROOT));
});

// ---- the sender's guards and failures ------------------------------------------------------

test('guards: follow-ups off, outreach off, missing secrets or outside hours → nothing read, nothing sent', async () => {
  const cases = [
    [{ ...ENV, GMAIL_FOLLOWUPS: 'off' }, NOW, 'followups off'],
    [{ ...ENV, GMAIL_OUTREACH: 'off' }, NOW, 'outreach off'],
    [{ ...ENV, GMAIL_REFRESH_TOKEN: '' }, NOW, 'not configured'],
    [ENV, Date.parse('2026-10-03T15:00:00Z'), 'outside hours'],
    [ENV, Date.parse('2026-09-30T23:00:00Z'), 'outside hours'],
  ];
  for (const [env, now, why] of cases) {
    const f = fixture([clicked(3)]);
    const r = await run(f, { env, now });
    assert.equal(r.skipped, why);
    assert.equal(f.reads.length + f.claims.length + f.g.gmail.length, 0, why);
  }
});

test('guards: Pause → the claimed follow-up is taken back and the run stops; after Resume it goes out', async () => {
  const f = fixture([clicked(3), clicked(4, { token: 'Second_prospect_1234', email: 'two@b.example' })], { paused: true });
  const r = await run(f);
  assert.equal(r.stopped, 'paused');
  assert.equal(f.claims.length, 1, 'stopped after the first refusal');
  assert.deepEqual(f.releases, [f.claims[0].p_token]);
  assert.equal(f.rows.length, 0, 'nothing counts toward the cap');
  f.g.state.paused = false;
  const again = await run(f);
  assert.equal(again.sent, 2);
  assert.equal(f.g.gmail.length, 2);
});

test('guards: the daily cap is shared with the first emails: at the cap, nothing goes out and nothing is burned', async () => {
  const f = fixture([clicked(3)], { cap: 0 });
  const r = await run(f);
  assert.equal(r.stopped, 'cap');
  assert.equal(f.g.gmail.length, 0);
  assert.equal(f.rows.length, 0);
});

test('guards: 5 seconds between sends (waits and retries), and at most maxSends per run', async () => {
  const ps = ['A', 'B', 'C'].map((x, i) => clicked(3 + i, { token: `Prospect_${x}_abcdefghij`, email: `${x.toLowerCase()}@b.example` }));
  const f = fixture(ps);
  const r = await run(f, { maxSends: 2 });
  assert.equal(r.due, 3);
  assert.equal(r.sent, 2);
  assert.equal(f.g.gmail.length, 2);
  assert.deepEqual(f.sleeps, [5000], 'waited out the gap once');
  assert.ok(f.g.sends[1].at - f.g.sends[0].at >= 5000);
});

test('guards: an unclear Gmail failure keeps the claim (marked not sent) so it is never sent twice', async () => {
  const f = fixture([clicked(3)], { sendStatus: 500 });
  const r = await run(f);
  assert.equal(r.sent, 0);
  assert.equal(f.releases.length, 0);
  assert.equal(f.rows.length, 1);
  assert.match(f.rows[0].detail, /^not sent: Gmail 500/);
  // The next run doesn't try Follow-up 1 again.
  f.g.sendStatus = 200;
  const again = await run(f, { now: NOW + DAY });
  assert.equal(again.due, 0);
  assert.equal(f.g.gmail.length, 1, 'only the failed attempt ever reached Gmail');
});

test('copy: saved copy with surveillance phrasing is refused at send time: nothing claimed or sent', async () => {
  const f = fixture([clicked(3)], { templates: [{ key: 'followup1.gap', subject: 'Hi', body: 'Noticed you checked out your report: {link}' }] });
  const r = await run(f);
  assert.equal(r.results[0].reason, 'copy');
  assert.equal(f.claims.length + f.g.gmail.length, 0);
});

test('copy: saved copy replaces the placeholder with no code change', async () => {
  const f = fixture([clicked(3)], { templates: [{ key: 'followup1.gap', subject: '{competitor} in {town}', body: 'Real copy for {business}: {link}' }] });
  await run(f);
  assert.match(f.g.gmail[0].decoded.head, /Subject: Harbor Lane Laundromat in Seaford/);
  assert.match(f.g.gmail[0].decoded.text, /^Real copy for Bluebird Wash & Fold: https:\/\/aifoundscore\.com\/e\/click/);
});

test('claim: the database being down stops the run with nothing sent', async () => {
  const f = fixture([clicked(3)], { claimDown: true });
  const r = await run(f);
  assert.equal(r.stopped, 'claim failed');
  assert.equal(f.g.gmail.length, 0);
});
