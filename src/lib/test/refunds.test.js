import test from 'node:test';
import assert from 'node:assert/strict';
import { refundChange, handleRefundEvent } from '../refunds.js';

const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'svc' };
const charge = (over = {}) => ({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', amount: 4900, amount_refunded: 4900, refunded: true, ...over } } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Fake Supabase: GET payments answers `rows`; every call is recorded. */
function fakeDb(rows, { patchStatus = 204 } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (!init.method) return json(rows);
    return new Response(null, { status: patchStatus });
  };
  fn.calls = calls;
  return fn;
}
const now = () => new Date('2026-10-01T12:00:00Z');

test('refundChange: full refund revokes; partial keeps access; $25 partial drops the add-on', () => {
  assert.deepEqual(refundChange(charge()), { paymentIntent: 'pi_1', refundedCents: 4900, revoke: true, dropBreakdown: false });
  assert.deepEqual(refundChange(charge({ amount: 7400, amount_refunded: 1000, refunded: false })), { paymentIntent: 'pi_1', refundedCents: 1000, revoke: false, dropBreakdown: false });
  assert.deepEqual(refundChange(charge({ amount: 7400, amount_refunded: 2500, refunded: false })), { paymentIntent: 'pi_1', refundedCents: 2500, revoke: false, dropBreakdown: true });
  // Expanded payment_intent object, and amount_refunded reaching the amount without the flag.
  assert.equal(refundChange(charge({ payment_intent: { id: 'pi_2' }, refunded: false })).paymentIntent, 'pi_2');
  assert.equal(refundChange(charge({ refunded: false })).revoke, true);
});

test('refundChange: only a lost dispute counts; other events and missing intents are ignored', () => {
  const dispute = (status) => ({ type: 'charge.dispute.closed', data: { object: { payment_intent: 'pi_1', amount: 49900, status } } });
  assert.deepEqual(refundChange(dispute('lost')), { paymentIntent: 'pi_1', refundedCents: 49900, revoke: true, dropBreakdown: false });
  assert.equal(refundChange(dispute('won')), null);
  assert.equal(refundChange(charge({ payment_intent: null })), null);
  assert.equal(refundChange(charge({ amount_refunded: 0 })), null);
  assert.equal(refundChange({ type: 'checkout.session.completed', data: { object: {} } }), null);
});

test('handleRefundEvent: full refund revokes the payment and closes open refund requests', async () => {
  const f = fakeDb([{ id: 'p1', report_token: 'tok123', amount_cents: 4900, addons: [], revoked_at: null }]);
  const r = await handleRefundEvent(env, charge(), { fetchImpl: f, now });
  assert.deepEqual(r, { ok: true, matched: true, revoked: true, token: 'tok123' });
  assert.match(f.calls[0].url, /payments\?stripe_payment_intent=eq\.pi_1&/);
  assert.equal(f.calls[1].method, 'PATCH');
  assert.match(f.calls[1].url, /payments\?id=eq\.p1$/);
  assert.deepEqual(f.calls[1].body, { refunded_cents: 4900, refunded_at: '2026-10-01T12:00:00.000Z', revoked_at: '2026-10-01T12:00:00.000Z' });
  assert.match(f.calls[2].url, /refund_requests\?report_token=eq\.tok123&status=eq\.open$/);
  assert.deepEqual(f.calls[2].body, { status: 'refunded' });
});

test('handleRefundEvent: a $25 partial refund removes the Competitor Breakdown and keeps the audit', async () => {
  const f = fakeDb([{ id: 'p1', report_token: 'tok123', amount_cents: 7400, addons: ['competitor_breakdown'], revoked_at: null }]);
  const r = await handleRefundEvent(env, charge({ amount: 7400, amount_refunded: 2500, refunded: false }), { fetchImpl: f, now });
  assert.equal(r.revoked, false);
  assert.deepEqual(f.calls[1].body, { refunded_cents: 2500, refunded_at: '2026-10-01T12:00:00.000Z', addons: [] });
  assert.equal(f.calls.length, 2, 'no refund_requests update on a partial refund');
});

test('handleRefundEvent: already revoked keeps its first revoked_at; unknown intent is logged, not an error', async () => {
  const f = fakeDb([{ id: 'p1', report_token: 't', amount_cents: 4900, addons: [], revoked_at: '2026-09-30T00:00:00Z' }]);
  await handleRefundEvent(env, charge(), { fetchImpl: f, now });
  assert.equal(f.calls[1].body.revoked_at, undefined);
  const empty = fakeDb([]);
  assert.deepEqual(await handleRefundEvent(env, charge(), { fetchImpl: empty, now }), { ok: true, matched: false });
  assert.equal(empty.calls.length, 1);
});

test('handleRefundEvent: a failed write throws so the webhook answers 500 and Stripe retries', async () => {
  const f = fakeDb([{ id: 'p1', report_token: 't', amount_cents: 4900, addons: [], revoked_at: null }], { patchStatus: 500 });
  await assert.rejects(handleRefundEvent(env, charge(), { fetchImpl: f, now }), /payments update failed: 500/);
});
