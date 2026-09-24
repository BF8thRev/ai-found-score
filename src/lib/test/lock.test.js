// Server-side lock: unpaid reports never carry fix descriptions, steps or copy-paste text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockReport, reportBody, LOCKED_ISSUE_FIELDS } from '../lock.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { validateReport, snapshotOffered } from '../../../shared/report-v2.js';

const v2 = MOCK_REPORTS['sample-001'];

test('v2: descriptions, steps and copyText are stripped; titles, kinds and severities stay', () => {
  assert.ok(v2.issues.some((i) => i.steps?.length && i.copyText?.length), 'sample has paid content to strip');
  const locked = lockReport(v2);
  assert.equal(locked.locked, true);
  assert.equal(locked.issues.length, v2.issues.length, 'every fix is still counted');
  locked.issues.forEach((i, n) => {
    assert.deepEqual(Object.keys(i).sort(), [...LOCKED_ISSUE_FIELDS, 'locked'].filter((k) => k === 'locked' || v2.issues[n][k] != null).sort());
    assert.equal(i.title, v2.issues[n].title);
    assert.equal(i.description, undefined);
    assert.equal(i.steps, undefined);
    assert.equal(i.copyText, undefined);
  });
  // Nothing paid survives anywhere in the serialized body.
  const body = JSON.stringify(locked);
  for (const i of v2.issues) {
    for (const s of i.steps || []) assert.ok(!body.includes(JSON.stringify(s)), `step leaked: ${s}`);
    // (A one-value block like the phone number is also in the free business details.)
    for (const c of i.copyText || []) {
      if (c.text.length > 40) assert.ok(!body.includes(JSON.stringify(c.text)), `copy text leaked: ${c.label}`);
    }
  }
  // Mismatched listings keep only platform + status.
  for (const l of locked.listings) if (l.status !== 'match') assert.deepEqual(Object.keys(l).sort(), ['locked', 'platform', 'status']);
  // The free parts stay: descriptors, facts, answers; and the locked report still validates.
  assert.deepEqual(locked.ownerDescriptors, v2.ownerDescriptors);
  assert.equal(validateReport(locked).ok, true);
  // The offer rule still works on a locked report (it counts titles).
  assert.equal(snapshotOffered(locked), snapshotOffered(v2));
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
