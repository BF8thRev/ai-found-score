import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuestions, normalizeTrade, tradeOrKind, TRADES, INTENTS } from '../questions.js';

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
  const bakery = buildQuestions({ trade: 'bakery', town: 'Bohemia', state: 'NY' }).map((q) => q.text);
  assert.deepEqual(bakery.slice(0, 3), ["What's the best bakery in Bohemia, NY?", 'Bakery open now near Bohemia NY', 'Can you recommend a bakery in Bohemia NY?']);
  assert.equal(buildQuestions({ trade: 'insurance agency', town: 'Islip' })[2].text, 'Can you recommend an insurance agency in Islip NY?');
});

test('tradeOrKind: known trades, else the plain words the owner typed, never junk', () => {
  assert.equal(tradeOrKind('Plumber'), 'plumbing');
  assert.equal(tradeOrKind('  Bakery '), 'bakery');
  assert.equal(tradeOrKind('Nail salon'), 'nail salon');
  assert.equal(tradeOrKind('Arts & crafts'), 'arts & crafts');
  assert.equal(tradeOrKind(''), null);
  assert.equal(tradeOrKind('<script>'), null);
  assert.equal(tradeOrKind('x'.repeat(41)), null);
});

test('town is required', () => {
  assert.throws(() => buildQuestions({ trade: 'plumbing' }), /town/);
});

// ---- kinds we have no tuned questions for: offices get no "open now" question; acronyms read right ----
import { kindClass, caseKind, PROFESSIONAL_RE, freeQuestions } from '../questions.js';

test('kindClass: home-service trades, offices (professional), everything else a storefront', () => {
  assert.equal(kindClass('plumbing'), 'trade');
  assert.equal(kindClass('plumber'), 'trade');
  assert.equal(kindClass('PR agency'), 'professional');
  assert.equal(kindClass('law firm'), 'professional');
  assert.equal(kindClass('marketing agency'), 'professional');
  assert.equal(kindClass('IT company'), 'professional');
  assert.equal(kindClass('accountant'), 'professional');
  assert.equal(kindClass('bakery'), 'storefront');
  assert.equal(kindClass('painter'), 'storefront');
  assert.equal(kindClass(''), 'storefront');
  for (const walkIn of ['nail salon', 'yoga studio', 'dance studio', 'massage therapist', 'photographer', 'print shop', 'web cafe', 'coffee shop']) {
    assert.equal(kindClass(walkIn), 'storefront', `${walkIn} keeps its "open now" question`);
  }
  assert.ok(!PROFESSIONAL_RE.test('nail salon'));
});

test('a professional kind gets "Top rated …" instead of "open now near …"; storefronts keep it', () => {
  const pr = freeQuestions({ trade: 'pr agency', town: 'New York City', state: 'NY', zip: '10001' }).map((q) => q.text);
  assert.deepEqual(pr, [
    "What's the best PR agency in New York City, NY?",
    'Top rated PR agency in New York City, NY',
    'Can you recommend a PR agency in New York City NY?',
  ]);
  assert.ok(!pr.some((t) => /open now/.test(t)), 'no "open now" for an office');
  const bakery = freeQuestions({ trade: 'bakery', town: 'Bohemia', state: 'NY' }).map((q) => q.text);
  assert.equal(bakery[1], 'Bakery open now near Bohemia NY');
  assert.equal(freeQuestions({ trade: 'it company', town: 'Islip', state: 'NY' })[2].text, 'Can you recommend an IT company in Islip NY?');
});

test('caseKind / tradeOrKind: acronyms upper-cased, whole words only, the rest unchanged', () => {
  assert.equal(caseKind('pr agency'), 'PR agency');
  assert.equal(caseKind('hvac contractor'), 'HVAC contractor');
  assert.equal(caseKind('print shop'), 'print shop', '"print" is not "pr"');
  assert.equal(caseKind('sprinkler repair'), 'sprinkler repair');
  assert.equal(tradeOrKind('pr agency'), 'PR agency');
  assert.equal(tradeOrKind('PR Agency'), 'PR agency');
  assert.equal(tradeOrKind('cpa firm'), 'CPA firm');
  assert.equal(tradeOrKind('3d printing'), '3D printing', 'a kind may start with a digit');
  assert.equal(tradeOrKind('73'), null, 'but not be only digits');
  assert.equal(tradeOrKind('hvac'), 'hvac', 'a known trade stays its key');
});
