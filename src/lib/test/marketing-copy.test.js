// Marketing and legal pages describe the assistants generically: no assistant names (except the
// Full Audit's assistant list on the homepage, site copy v2), no fixed search count (each report
// lists exactly which assistants were asked and when), only the plans on the ladder, and none of
// the banned words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ENGINE_NAMES } from '../../../scanner/config.js';
import { INTENTS, FREE_QUESTION_COUNT } from '../../../scanner/questions.js';
import { lintText } from '../../../shared/report-v2.js';

const PUBLIC = new URL('../../../public/', import.meta.url);
const PAGES = ['index.html', 'checkout.html', 'about.html', 'terms.html', 'refunds.html', 'privacy.html', 'contact.html', 'llms.txt'];
const read = (f) => readFileSync(new URL(f, PUBLIC), 'utf8');

// index.html quotes third-party usage figures (a cited stats band); that band is not our claim.
// The hero's sample card is a labelled verbatim quote from the sample report. The Full Audit
// tier names the assistants it asks (owner decision, site copy v2): that one list item may.
const withoutStats = (html) => html
  .replace(/<section class="stats-band"[\s\S]*?<\/section>/, '')
  .replace(/<div class="real-answer" data-(?:real|sample)-quote>[\s\S]*?<\/figure>[\s\S]*?<\/p>\s*<\/div>/, '')
  .replace(/<li data-assistant-list>[\s\S]*?<\/li>/g, '');
const visible = (html) => html
  .replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ');

test('no assistant names or fixed search counts on marketing/legal pages', () => {
  for (const f of PAGES) {
    const text = withoutStats(read(f));
    for (const name of Object.values(ENGINE_NAMES)) {
      assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${f} names ${name}`);
    }
    assert.ok(!/\b\d+\s+(searches|times in all)\b/i.test(text), `${f} states a search count`);
    assert.ok(!/data-ai-(list|count|names)|data-search-count|data-question-count|data-copy=|\{\{[A-Z_]+\}\}/.test(text), `${f} still has a copy slot`);
  }
});

test('"three questions" in the free-report copy matches the scanner', () => {
  assert.equal(INTENTS.length, 5);
  assert.equal(FREE_QUESTION_COUNT, 3);
  const index = read('index.html');
  assert.match(index, /gets these three questions/);
  assert.ok(!/\bfive (plain )?questions\b/i.test(index), 'index.html still says five questions');
});

test('only the plans on the ladder are offered', () => {
  for (const f of PAGES) {
    const text = read(f);
    assert.ok(!/Full Year|\$69\b|\$199\b|full listing build/i.test(text), `${f} mentions a plan that is off sale`);
  }
  const index = read('index.html');
  // Two offers on the homepage: the free snapshot starts the free report; the audit has its own
  // checkout page (public/checkout.html), where the $25 Competitor Breakdown is offered.
  assert.match(index, /data-offer="free_snapshot" href="#request"/);
  assert.match(index, /data-offer="full_audit" href="\/checkout"/);
  assert.ok(!/Be the Answer|\$499|data-offer="be_the_answer"/.test(index), 'Be the Answer is off the homepage');
  assert.ok(!/data-tier=/.test(index), 'homepage buttons should not start a checkout');
  for (const f of PAGES) {
    const text = read(f);
    assert.ok(!/\$29|\$59|Monthly monitoring|Accuracy Guarantee/i.test(text), `${f} mentions a retired plan or promise`);
  }
  assert.ok(!/AI Defense|ladder-note/.test(index), 'after-delivery offers on the homepage');
  assert.ok(!/pricing-trust/.test(index), 'the secure-checkout badges live on the checkout page');
  const checkout = read('checkout.html');
  assert.match(checkout, /Competitor Breakdown <em>\+\$25<\/em>/);
  assert.match(checkout, /Secure payment by Stripe/);
  // The Fix Kit is part of the $49 audit, never a separate price.
  assert.ok(!/\$149\b/.test(index), 'the Fix Kit is included in the audit, not sold at $149');
  assert.ok(!/0[–-]100/.test(index), 'the offer no longer promises a score');
});

test('no banned words in page copy', () => {
  for (const f of PAGES) {
    const hits = lintText(visible(read(f)));
    assert.deepEqual(hits.map((h) => h.match), [], `${f}: ${hits.map((h) => h.match).join(', ')}`);
  }
});

test('hero shows who got the call and who did not; nav and card link the real reports', () => {
  const index = read('index.html');
  assert.match(index, /class="sc-names"><li>Mega Wash &amp; Dry<\/li><li>One Hour Laundry<\/li><\/ul>/);
  assert.match(index, /class="sc-lost"><b>Every other laundromat in North Babylon<\/b>/);
  assert.match(index, /class="sc-link">See real reports: <a href="\/report\/mega-wash-and-dry">Mega Wash &amp; Dry<\/a> &middot; <a href="\/report\/vbeonkpiYROpBEiAi74kVQ">Glenn Wayne Bakery<\/a>/);
  assert.match(index, /href="\/report\/mega-wash-and-dry">Sample report</);
  assert.ok(!/lost-band|stopped Googling/.test(index), 'the made-up lost-call strip and the "stopped Googling" claim are gone');
});
