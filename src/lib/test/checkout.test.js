// Our checkout: prices per report, the $25 add-on, the Be the Answer credit, and what may be bought when.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceCheckout, sessionForm, handleCheckout, PRICES, MIN_CENTS } from '../checkout.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { xrayOffered } from '../../../shared/report-v2.js';

const real = { ...MOCK_REPORTS['sample-001'], sample: undefined, id: 'real_tok' };
const pay = (tier, cents, extra = {}) => ({ tier, amount_cents: cents, livemode: true, addons: [], ...extra });

test('the sample report qualifies for the audit (3+ specific fixes), so the tests below exercise the real rule', () => {
  assert.equal(xrayOffered(real), true);
});

test('audit: $49, with the $25 add-on as a second line; never twice, never on a sample', () => {
  const a = priceCheckout({ report: real, tier: 'xray' });
  assert.equal(a.total, 4900);
  const b = priceCheckout({ report: real, tier: 'xray', addons: ['competitor_breakdown'] });
  assert.deepEqual(b.items.map((i) => [i.tier, i.cents]), [['xray', 4900], ['competitor_breakdown', 2500]]);
  assert.equal(b.total, 7400);
  assert.equal(priceCheckout({ report: real, tier: 'xray', payments: [pay('xray', 4900)] }).status, 409);
  assert.equal(priceCheckout({ report: MOCK_REPORTS['sample-001'], tier: 'xray' }).status, 400);
  assert.equal(priceCheckout({ report: real, tier: 'xray', addons: ['free_stuff'] }).status, 400);
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer', addons: ['competitor_breakdown'] }).status, 400);
  // Fewer than 3 business-specific fixes: the refund promise means nothing is sold.
  const thin = { ...real, issues: real.issues.filter((i) => /^baseline_/.test(i.kind || '')) };
  assert.equal(priceCheckout({ report: thin, tier: 'xray' }).status, 409);
});

test('Competitor Breakdown on its own: only after the audit, only once', () => {
  assert.equal(priceCheckout({ report: real, tier: 'competitor_breakdown' }).status, 409);
  assert.equal(priceCheckout({ report: real, tier: 'competitor_breakdown', payments: [pay('xray', 4900)] }).total, 2500);
  assert.equal(priceCheckout({ report: real, tier: 'competitor_breakdown', payments: [pay('xray', 7400, { addons: ['competitor_breakdown'] })] }).status, 409);
});

test('Be the Answer: $499 minus what this report already paid (same mode only), never below the floor', () => {
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer' }).total, PRICES.be_the_answer);
  const c = priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('xray', 4900), pay('competitor_breakdown', 2500)] });
  assert.equal(c.credit, 7400);
  assert.equal(c.total, 49900 - 7400);
  // A retired $149 Fix Kit counts too.
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('xray', 4900), pay('fix_kit', 14900)] }).total, 49900 - 19800);
  // Test-mode payments never discount a live checkout.
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('xray', 4900, { livemode: false })] }).total, 49900);
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('x', 60000)] }).total, MIN_CENTS);
  assert.equal(priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('be_the_answer', 49900)] }).status, 409);
});

test('session form: tier and add-ons in metadata, the report token as client_reference_id, prices from us', () => {
  const p = priceCheckout({ report: real, tier: 'xray', addons: ['competitor_breakdown'] });
  const f = sessionForm({ ...p, token: 'real_tok', tier: 'xray', addons: ['competitor_breakdown'], origin: 'https://aifoundscore.com' });
  assert.equal(f.get('client_reference_id'), 'real_tok');
  assert.equal(f.get('metadata[tier]'), 'xray');
  assert.equal(f.get('metadata[addons]'), 'competitor_breakdown');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '4900');
  assert.equal(f.get('line_items[1][price_data][unit_amount]'), '2500');
  assert.equal(f.get('success_url'), 'https://aifoundscore.com/success?tier=xray&session_id={CHECKOUT_SESSION_ID}');
  // Trust on Stripe's own page: the promise under the Pay button, our image on each item.
  assert.match(f.get('custom_text[submit][message]'), /Your \$49 back/);
  assert.ok(f.get('custom_text[submit][message]').length <= 1200);
  assert.equal(f.get('line_items[0][price_data][product_data][images][0]'), 'https://aifoundscore.com/img/og.png');
  const bta = priceCheckout({ report: real, tier: 'be_the_answer', payments: [pay('xray', 4900)] });
  assert.match(sessionForm({ ...bta, token: 't', tier: 'be_the_answer', addons: [], origin: 'https://x' }).get('line_items[0][price_data][product_data][description]'), /\$49\.00 credit/);
});

test('handleCheckout: 503 without a key; creates the session and returns its url', async () => {
  const req = (body) => [new Request('https://x.test/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), new URL('https://x.test/api/checkout')];
  const deps = (sent) => ({
    rateLimit: async () => null,
    getReport: async () => real,
    getPayments: async () => [],
    fetchImpl: async (u, init) => { sent.push({ u, init }); return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }); },
  });
  const sent = [];
  assert.equal((await handleCheckout(...req({ token: 'real_tok', tier: 'xray' }), {}, deps(sent))).status, 503);
  const r = await handleCheckout(...req({ token: 'real_tok', tier: 'xray', addons: ['competitor_breakdown'] }), { STRIPE_SECRET_KEY: 'sk_test_x', SITE_URL: 'https://aifoundscore.com' }, deps(sent));
  const body = await r.json();
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(body.total, 7400);
  assert.equal(sent[0].u, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent[0].init.headers.Authorization, 'Bearer sk_test_x');
  assert.equal((await handleCheckout(...req({ token: 'sample-001', tier: 'xray' }), { STRIPE_SECRET_KEY: 'sk_test_x' }, deps([]))).status, 404);
});
