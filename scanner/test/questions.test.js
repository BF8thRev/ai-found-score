import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions, normalizeTrade, TRADES, INTENTS } from '../questions.js';

const laundromat = { name: 'Fictional Wash', trade: 'laundromat', town: 'North Babylon', nearbyTown: 'Deer Park', state: 'NY', zip: '11703' };

test('laundromat questions reproduce the plan examples exactly', () => {
  assert.deepEqual(buildQuestions(laundromat), [
    { id: 'q1', intent: 'best', text: "What's the best laundromat in North Babylon, NY?" },
    { id: 'q2', intent: 'urgent', text: '24 hour laundromat near Deer Park NY' },
    { id: 'q3', intent: 'job', text: 'Who does laundry pickup and delivery in North Babylon NY?' },
    { id: 'q4', intent: 'trust', text: 'Laundromat with big washers for comforters near Deer Park, NY' },
    { id: 'q5', intent: 'price', text: 'Cheapest wash and fold near North Babylon NY' },
  ]);
});

test('plumber questions reproduce the plan examples exactly', () => {
  const q = buildQuestions({ trade: 'plumbing', town: 'Massapequa', state: 'NY', zip: '11758' }).map((x) => x.text);
  assert.deepEqual(q, [
    "What's the best plumber in Massapequa, NY?",
    'I need an emergency plumber near Massapequa tonight',
    'Who can replace a water heater in Massapequa NY?',
    'Plumber with good reviews near Massapequa, NY',
    'Affordable plumber near 11758',
  ]);
});

test('without nearbyTown every question uses the business town', () => {
  const q = buildQuestions({ trade: 'laundromat', town: 'North Babylon', state: 'NY' });
  assert.equal(q[1].text, '24 hour laundromat near North Babylon NY');
  assert.equal(q[3].text, 'Laundromat with big washers for comforters near North Babylon, NY');
});

test('state defaults to NY and accepts full names', () => {
  assert.equal(buildQuestions({ trade: 'roofing', town: 'Plainview' })[0].text, "What's the best roofer in Plainview, NY?");
  assert.equal(buildQuestions({ trade: 'roofing', town: 'Hoboken', state: 'New Jersey' })[0].text, "What's the best roofer in Hoboken, NJ?");
});

test('ZIP-only template falls back to town + state when ZIP is missing', () => {
  assert.equal(buildQuestions({ trade: 'plumbing', town: 'Massapequa', state: 'NY' })[4].text, 'Affordable plumber near Massapequa NY');
});

test('all 8 trades give 5 filled questions with town, no leftover slots', () => {
  const trades = ['plumbing', 'hvac', 'electrical', 'roofing', 'landscaping', 'cleaning', 'auto_repair', 'laundromat'];
  assert.deepEqual(Object.keys(TRADES).sort(), [...trades].sort());
  for (const trade of trades) {
    const qs = buildQuestions({ trade, town: 'Levittown', state: 'NY', zip: '11756' });
    assert.equal(qs.length, 5);
    assert.deepEqual(qs.map((q) => q.intent), INTENTS);
    assert.deepEqual(qs.map((q) => q.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
    for (const q of qs) {
      assert.doesNotMatch(q.text, /[{}]/, `${trade} ${q.id} has an unfilled slot`);
      assert.match(q.text, /Levittown|11756/, `${trade} ${q.id} lacks the location`);
      assert.doesNotMatch(q.text, /\s{2}|\s[,?]/, `${trade} ${q.id} has spacing issues`);
    }
  }
});

test('trade aliases normalise', () => {
  assert.equal(normalizeTrade('Plumber'), 'plumbing');
  assert.equal(normalizeTrade('HVAC'), 'hvac');
  assert.equal(normalizeTrade('auto repair'), 'auto_repair');
  assert.equal(normalizeTrade('Laundry'), 'laundromat');
  assert.equal(normalizeTrade('pest control'), null);
});

test('unknown trade still yields 5 plain questions', () => {
  const qs = buildQuestions({ trade: 'Pest Control', town: 'Bethpage', state: 'NY' });
  assert.equal(qs[0].text, "What's the best pest control in Bethpage, NY?");
  assert.equal(qs.length, 5);
});

test('town is required', () => {
  assert.throws(() => buildQuestions({ trade: 'plumbing' }), /town/);
});
