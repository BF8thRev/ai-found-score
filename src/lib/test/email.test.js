// Email through Resend: nothing without a key, unsubscribes respected (receipts excepted), idempotent,
// and who gets which email when a scan finishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendEmail, RESEND_URL, reportReadyEmail, receiptEmail, recheckEmail, leadEmail, fullAuditEmail, POSTAL,
} from '../email.js';
import { notifyScanDone, notifyPayment } from '../notify.js';
import { lintText } from '../../../shared/report-v2.js';

const ENV = { RESEND_API_KEY: 're_test', SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc' };

// Fake Supabase + Resend. `tables` maps table → rows; unsubscribes suppress by email.
function fake(tables = {}) {
  const sent = [];
  const f = async (input, init = {}) => {
    const u = new URL(String(input));
    if (String(input) === RESEND_URL) {
      sent.push({ body: JSON.parse(init.body), headers: init.headers });
      return Response.json({ id: `em_${sent.length}` });
    }
    const table = u.pathname.split('/').pop();
    let rows = tables[table] || [];
    for (const [k, v] of u.searchParams) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k] ?? '').toLowerCase() === decodeURIComponent(v.slice(3)).toLowerCase());
      if (v === 'not.is.null') rows = rows.filter((r) => r[k] != null);
      if (v.startsWith('in.')) { const set = v.slice(4, -1).split(','); rows = rows.filter((r) => set.includes(String(r[k]))); }
    }
    return Response.json(rows);
  };
  return { sent, fetch: f };
}

test('sendEmail: no key, nothing sent; a key sends with idempotency and one-click unsubscribe', async () => {
  const x = fake();
  assert.equal((await sendEmail({}, { to: 'a@b.co', subject: 's', text: 't', html: 'h' }, { fetchImpl: x.fetch })).reason, 'not configured');
  const r = await sendEmail(ENV, { to: 'Owner@Shop.com', subject: 's', text: 't', html: 'h', idempotencyKey: 'k1', token: 'tok' }, { fetchImpl: x.fetch });
  assert.equal(r.ok, true);
  assert.deepEqual(x.sent[0].body.to, ['owner@shop.com']);
  assert.equal(x.sent[0].headers['Idempotency-Key'], 'k1');
  assert.match(x.sent[0].body.headers['List-Unsubscribe'], /unsubscribe\?t=tok/);
  assert.equal((await sendEmail(ENV, { to: 'not-an-email', subject: 's', text: 't', html: 'h' }, { fetchImpl: x.fetch })).reason, 'bad address');
});

test('sendEmail: unsubscribed addresses get updates never, receipts always', async () => {
  const x = fake({ unsubscribes: [{ email: 'gone@shop.com' }] });
  assert.equal((await sendEmail(ENV, { to: 'gone@shop.com', subject: 's', text: 't', html: 'h' }, { fetchImpl: x.fetch })).reason, 'suppressed');
  assert.equal((await sendEmail(ENV, { to: 'gone@shop.com', subject: 's', text: 't', html: 'h', transactional: true }, { fetchImpl: x.fetch })).ok, true);
  // A failed unsubscribe check means don't send.
  const broken = async (u) => (String(u) === RESEND_URL ? Response.json({ id: 'x' }) : new Response('down', { status: 500 }));
  assert.equal((await sendEmail(ENV, { to: 'a@shop.com', subject: 's', text: 't', html: 'h' }, { fetchImpl: broken })).reason, 'suppressed');
});

test('templates: one link, the postal address, no banned words, numbers when known', () => {
  const env = { SITE_URL: 'https://aifoundscore.com' };
  const mails = [
    reportReadyEmail(env, { token: 'tok', name: 'Otter Plumbing', totals: { namedYou: 2, answers: 9 } }),
    leadEmail(env, { token: 'tok', name: 'Otter Plumbing' }),
    receiptEmail(env, { token: 'tok', name: 'Otter Plumbing', tier: 'xray' }),
    receiptEmail(env, { token: 'tok', name: 'Otter Plumbing', tier: 'fix_kit' }),
    fullAuditEmail(env, { token: 'tok', name: 'Otter Plumbing', totals: { namedYou: 4, answers: 15 } }),
    recheckEmail(env, { token: 'tok', name: 'Otter Plumbing', totals: { namedYou: 7, answers: 15 }, before: { namedYou: 4, answers: 15 } }),
  ];
  for (const m of mails) {
    assert.ok(m.subject && m.text && m.html);
    assert.ok(m.text.includes(POSTAL));
    assert.match(m.text, /https:\/\/aifoundscore\.com\/(report|fix-kit)\/tok/);
    assert.deepEqual(lintText(m.text).map((h) => h.match), [], m.subject);
  }
  assert.match(mails[0].text, /2 of 9/);
  assert.match(mails[3].text, /fix-kit\/tok/);
  assert.match(mails[5].text, /4 of 15.*7 of 15.*progress/s);
  assert.match(recheckEmail(env, { token: 't', totals: { namedYou: 2, answers: 15 }, before: { namedYou: 4, answers: 15 } }).text, /slipped/);
  // Names are escaped in HTML.
  assert.ok(!reportReadyEmail(env, { token: 't', name: '<b>x</b>' }).html.includes('<b>x</b>'));
});

test('notifyScanDone: free report → the request\'s address; paid and re-check → the buyer', async () => {
  const x = fake({
    scan_results: [{ report_token: 'tok', version: 2, name: 'Otter Plumbing', totals: { namedYou: 2, answers: 9 }, before: null }],
    report_requests: [{ report_token: 'tok', email: 'owner@otter.com' }, { report_token: 'tok', email: null }],
    payments: [{ report_token: 'tok', customer_email: 'buyer@otter.com' }],
  });
  assert.deepEqual(await notifyScanDone(ENV, { trigger: 'request', token: 'tok', scanId: 's1' }, { fetchImpl: x.fetch }), { sent: 1 });
  assert.deepEqual(x.sent[0].body.to, ['owner@otter.com']);
  assert.match(x.sent[0].body.subject, /is ready/);
  await notifyScanDone(ENV, { trigger: 'recheck', token: 'tok', scanId: 's2' }, { fetchImpl: x.fetch });
  assert.deepEqual(x.sent[1].body.to, ['buyer@otter.com']);
  assert.match(x.sent[1].body.subject, /30 days later/);
  assert.equal((await notifyScanDone(ENV, { trigger: 'admin', token: 'tok' }, { fetchImpl: x.fetch })).skipped, 'trigger');
  assert.equal((await notifyScanDone({}, { trigger: 'request', token: 'tok' }, { fetchImpl: x.fetch })).skipped, 'not configured');
});

test('notifyPayment: a receipt keyed by the checkout session', async () => {
  const x = fake({ scan_results: [{ report_token: 'tok', version: 2, name: 'Otter Plumbing' }] });
  assert.deepEqual(await notifyPayment(ENV, { token: 'tok', email: 'buyer@otter.com', tier: 'xray', sessionId: 'cs_1' }, { fetchImpl: x.fetch }), { sent: 1 });
  assert.equal(x.sent[0].headers['Idempotency-Key'], 'receipt:cs_1');
  assert.equal((await notifyPayment(ENV, { token: 'tok', email: null, tier: 'xray' }, { fetchImpl: x.fetch })).skipped, 'not configured');
});
