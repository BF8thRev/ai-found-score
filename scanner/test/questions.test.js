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

// ---------------------------------------------------------------------------
// Small-firm questions: the paid audit only (q6 'small', q7 'niche').
// ---------------------------------------------------------------------------
import {
  smallFirmQuestions, paidQuestions, readSpecialty, PAID_INTENTS, PAID_QUESTION_COUNT, FREE_QUESTION_COUNT, questionKey,
} from '../questions.js';
import { BUSINESS as PR73, HOME as PR73_HOME } from './fixtures/pr73.js';
import { metaCheck } from '../owner-checks.js';

const pr73Site = { meta: metaCheck(PR73_HOME, PR73) };

test('PR 73 (paid): the 5, then a boutique question and its own specialty from its homepage', () => {
  assert.equal(pr73Site.meta.title, 'Integrated Communications, PR & Media Relations | PR73');
  assert.deepEqual(paidQuestions(PR73, { siteCheck: pr73Site }), [
    { id: 'q1', intent: 'best', text: "What's the best PR agency in New York City, NY?" },
    { id: 'q2', intent: 'urgent', text: 'Top rated PR agency in New York City, NY' },
    { id: 'q3', intent: 'job', text: 'Can you recommend a PR agency in New York City NY?' },
    { id: 'q4', intent: 'trust', text: 'PR agency with good reviews near New York City, NY' },
    { id: 'q5', intent: 'price', text: 'Affordable PR agency near New York City NY' },
    { id: 'q6', intent: 'small', text: "What's a good boutique PR agency in New York City, NY for a small company?" },
    { id: 'q7', intent: 'niche', text: 'Which PR agency in New York City, NY specializes in integrated communications?' },
  ]);
  // An industry on the homepage wins over a kind of work.
  const tech = { meta: { title: 'PR73 | Integrated communications', description: 'PR for tech startups and consumer brands in NYC.', h1: '' } };
  assert.equal(smallFirmQuestions(PR73, { siteCheck: tech })[1].text, 'Which PR agency in New York City, NY specializes in tech startups?');
  // Nothing readable: the budget question, never a guess.
  for (const siteCheck of [null, { meta: null }, { meta: { title: 'Home', description: '', h1: 'Welcome' } }]) {
    assert.equal(smallFirmQuestions(PR73, { siteCheck })[1].text, 'Is there a PR agency in New York City, NY that works with small businesses on a budget?');
  }
});

test('plumber sample (paid): family-owned, and a service from the homepage the job question doesn’t already ask', () => {
  const plumber = { name: 'Harborview Plumbing & Heating', trade: 'plumber', town: 'Massapequa', state: 'NY', zip: '11758' };
  const site = { meta: { title: 'Harborview Plumbing & Heating | Massapequa Plumber & Boiler Repair', description: '', h1: 'Plumbing and heating you can count on' } };
  assert.deepEqual(smallFirmQuestions(plumber, { siteCheck: site }), [
    { id: 'q6', intent: 'small', text: 'Can you recommend a local, family-owned plumber in Massapequa, NY?' },
    { id: 'q7', intent: 'niche', text: 'Who does boiler repair in Massapequa NY?' },
  ]);
  // The water heater is already q3 ("Who can replace a water heater…"): the next service instead.
  assert.equal(readSpecialty(plumber, { meta: { title: 'Tankless water heaters and drain cleaning' } }).phrase, 'drain cleaning');
  assert.equal(smallFirmQuestions(plumber)[1].text, "Who's a reliable plumber in Massapequa NY for a small job?");
});

test('small-firm questions for every kind: filled, located, natural, never the trade itself as a specialty', () => {
  assert.deepEqual(smallFirmQuestions({ trade: 'bakery', town: 'Plainview' }).map((q) => q.text), [
    'Can you recommend a local, family-owned bakery in Plainview, NY?', 'Is there a hidden gem bakery in Plainview, NY?',
  ]);
  // People hire a realtor; companies hire an agency.
  assert.deepEqual(smallFirmQuestions({ trade: 'real estate agent', town: 'Plainview' }, { siteCheck: { meta: { title: 'Real estate in Plainview' } } }).map((q) => q.text), [
    "What's a good independent real estate agent in Plainview, NY?", 'Which real estate agent in Plainview, NY gives clients personal attention?',
  ]);
  assert.equal(smallFirmQuestions({ trade: 'law firm', town: 'Mineola' }, { siteCheck: { meta: { description: 'Personal injury lawyers on Long Island' } } })[1].text, 'Which law firm in Mineola, NY specializes in personal injury?');
  for (const trade of [...Object.keys(TRADES), 'pr agency', 'accountant', 'bakery', 'marketing agency', 'dentist']) {
    const qs = smallFirmQuestions({ trade, town: 'Levittown', state: 'NY', zip: '11756' }, { siteCheck: { meta: { title: 'Boilers, gutters, EV chargers, deep cleaning, transmissions, dry cleaning, healthcare' } } });
    assert.deepEqual(qs.map((q) => `${q.id}:${q.intent}`), ['q6:small', 'q7:niche'], trade);
    for (const q of qs) {
      assert.doesNotMatch(q.text, /[{}]|\s{2}|\s[,?]|undefined|null/, `${trade} ${q.id}: ${q.text}`);
      assert.match(q.text, /Levittown/, `${trade} ${q.id} lacks the town`);
    }
  }
});

test('free questions are unchanged by the paid ones: 3 questions, same text, no small-firm intent', () => {
  for (const b of [PR73, { trade: 'plumbing', town: 'Massapequa', state: 'NY', zip: '11758' }]) {
    const free = freeQuestions(b);
    assert.equal(free.length, FREE_QUESTION_COUNT);
    assert.deepEqual(free, buildQuestions(b).slice(0, 3));
    assert.deepEqual(paidQuestions(b, { siteCheck: pr73Site }).slice(0, 5), buildQuestions(b), 'the paid scan asks the same 5 first');
  }
  assert.equal(buildQuestions(PR73).length, 5);
  assert.deepEqual(INTENTS, ['best', 'urgent', 'job', 'trust', 'price']);
  assert.deepEqual(PAID_INTENTS, [...INTENTS, 'small', 'niche']);
  assert.equal(PAID_QUESTION_COUNT, 7);
  // questionKey: order doesn't matter, wording and ids do.
  const qs = paidQuestions(PR73, { siteCheck: pr73Site });
  assert.equal(questionKey([...qs].reverse()), questionKey(qs));
  assert.notEqual(questionKey(qs.slice(0, 5)), questionKey(qs));
});
