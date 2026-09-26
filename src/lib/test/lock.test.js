// Server-side lock: unpaid reports never carry fix descriptions, steps or copy-paste text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockReport, reportBody, LOCKED_ISSUE_FIELDS } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { validateReport, snapshotOffered } from '../../../shared/report-v2.js';

const v2 = MOCK_REPORTS['sample-001'];

test('v2: fixes keep only their severity; descriptions, steps, copyText and titles are stripped', () => {
  assert.ok(v2.issues.some((i) => i.steps?.length && i.copyText?.length), 'sample has paid content to strip');
  const locked = lockReport(v2);
  assert.equal(locked.locked, true);
  assert.equal(locked.issues.length, v2.issues.length, 'every fix is still counted');
  locked.issues.forEach((i, n) => {
    assert.deepEqual(Object.keys(i).sort(), ['locked', ...(v2.issues[n].severity != null ? ['severity'] : [])].sort());
    assert.equal(i.severity, v2.issues[n].severity);
  });
  // Nothing paid survives anywhere in the serialized body.
  const body = JSON.stringify(locked);
  for (const i of v2.issues) {
    assert.ok(!body.includes(JSON.stringify(i.title)), `title leaked: ${i.title}`);
    for (const s of i.steps || []) assert.ok(!body.includes(JSON.stringify(s)), `step leaked: ${s}`);
    // (A one-value block like the phone number is also in the free business details.)
    for (const c of i.copyText || []) {
      if (c.text.length > 40) assert.ok(!body.includes(JSON.stringify(c.text)), `copy text leaked: ${c.label}`);
    }
  }
  // Mismatched listings keep only platform + status.
  for (const l of locked.listings) if (l.status !== 'match') assert.deepEqual(Object.keys(l).sort(), ['locked', 'platform', 'status']);
  // The free parts stay: descriptors and facts; and the locked report still validates.
  assert.deepEqual(locked.ownerDescriptors, v2.ownerDescriptors);
  assert.deepEqual(locked.aiFacts, v2.aiFacts);
  assert.equal(validateReport(locked).ok, true);
  // The offer rule still works on a locked report (it counts the untitled stand-ins).
  assert.equal(snapshotOffered(locked), snapshotOffered(v2));
});

test('v2: one answer stays word for word (the headline); the rest keep only their verdict', () => {
  const locked = lockReport(v2);
  const hid = v2.headline.answerId;
  assert.equal(locked.answers.length, v2.answers.length);
  for (const [n, a] of locked.answers.entries()) {
    const orig = v2.answers[n];
    if (orig.id === hid) { assert.deepEqual(a, orig); continue; }
    assert.equal(a.locked, true);
    assert.equal(a.text, '');
    assert.equal(a.citations, undefined);
    assert.equal(a.namedYou, orig.namedYou);
    assert.equal(a.engine, orig.engine);
    assert.deepEqual(a.businessesNamed, orig.businessesNamed, 'who AI named stays free');
  }
  const body = JSON.stringify(locked);
  for (const a of v2.answers) if (a.id !== hid && a.text.length > 60) assert.ok(!body.includes(JSON.stringify(a.text)), `answer leaked: ${a.id}`);
});

test('v2: cited sites become a count; website checks become a pass/fail tally', () => {
  const withSite = {
    ...v2,
    siteCheck: { url: 'https://example.com', reachable: true, robots: { blocked: [{ agent: 'GPTBot', who: 'ChatGPT' }] }, schema: { found: false }, onSite: { phone: '(516) 555-0100', address: null }, sitemap: true },
  };
  const locked = lockReport(withSite);
  assert.deepEqual(locked.sources, []);
  assert.ok(locked.sourcesSummary.cited >= locked.sourcesSummary.missingYou);
  assert.ok(locked.sourcesSummary.missingYou > 0, 'the sample has cited sites that miss the owner');
  assert.deepEqual(locked.siteCheck, { url: 'https://example.com', reachable: true, locked: true, checks: 5, passed: 2 });
  assert.ok(!JSON.stringify(locked).includes('GPTBot'));
  assert.deepEqual(lockReport({ ...v2, siteCheck: { url: 'https://x.com', reachable: false } }).siteCheck, { url: 'https://x.com', reachable: false, locked: true, checks: 1, passed: 0 });
});

test('lockReport never mutates its input', () => {
  const before = JSON.stringify(v2);
  lockReport(v2);
  assert.equal(JSON.stringify(v2), before);
});

test('v1: unchanged shape (severity + title only)', () => {
  const v1 = MOCK_REPORTS['sample-v1'];
  const locked = lockReport(v1);
  for (const i of locked.issues) assert.deepEqual(Object.keys(i).sort(), ['locked', 'severity', 'title']);
});

test('reportBody: unlocked v2 says locked:false and keeps everything; locked goes through lockReport', () => {
  const open = reportBody(v2, true);
  assert.equal(open.locked, false);
  assert.deepEqual(open.issues, v2.issues);
  assert.equal(reportBody(v2, false).issues[0].steps, undefined);
});
