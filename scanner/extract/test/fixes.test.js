// Fix steps ($29 deliverable), "How AI describes you" descriptors, and their guardrails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIssues } from '../issues.js';
import {
  businessDetails, baselineFixes, gbpDescription, faqAnswer, localBusinessJsonLd, napBlock, GBP_DESCRIPTION_MAX, alwaysOpen,
} from '../fixes.js';
import { verifyDescriptors, verifyAnswer } from '../verify.js';
import { buildReport, pickDescriptors, MAX_DESCRIPTORS } from '../build.js';
import { proposeForAnswer, PROPOSAL_SCHEMA } from '../propose.js';
import { validateReport, lintReport, lintText, snapshotOffered, MIN_FIX_ITEMS } from '../../../shared/report-v2.js';
import { parseScanRequest } from '../../../src/admin/scan-core.js';

const dir = new URL('../../test/fixtures/megawash-live/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
const MEGA = parseScanRequest({ business: load('business.json') }).params.business;

const BIZ = {
  name: 'Fictional Pipe Co', trade: 'plumber', address: '12 Main St', town: 'Massapequa', state: 'NY', zip: '11758',
  phone: '(516) 555-0100', website: 'fictionalpipe.example.com',
  facts: { hours: 'Mon–Fri 8am–6pm', price: '$99 service call', services: 'drain cleaning, water heater installation' },
};

const allText = (issues) => issues.flatMap((i) => [i.title, i.description, ...(i.steps || []), ...(i.copyText || []).flatMap((c) => [c.label, c.text])]).join('\n');

/** A tiny report with one differing fact, one missing cited source and one lost question. */
function miniReport() {
  const a1 = 'Try Rival Plumbing on Oak St. Fictional Pipe Co is open 24/7.';
  const a2 = 'Rival Plumbing is listed first on the directory. Also try Rival Plumbing again.';
  return {
    business: BIZ,
    questions: [
      { id: 'q1', intent: 'urgent', text: 'I need an emergency plumber near Massapequa tonight' },
      { id: 'q2', intent: 'price', text: 'Affordable plumber near 11758' },
    ],
    answers: [
      { id: 'a1', questionId: 'q1', engine: 'chatgpt', run: 1, text: a1, namedYou: true, businessesNamed: [] },
      { id: 'a2', questionId: 'q2', engine: 'claude', run: 1, text: a2, namedYou: false, businessesNamed: [{ name: 'Rival Plumbing', pos: 0, entityId: 'e1' }] },
    ],
    entities: [{ id: 'e1', name: 'Rival Plumbing', named: 2, first: 1, answerIds: ['a2'] }],
    aiFacts: [{ answerId: 'a1', field: 'hours', aiSays: 'open 24/7', sourceSays: 'Mon–Fri 8am–6pm', sourceFrom: 'website', status: 'differs' }],
    sources: [{ domain: 'dir.example.com', url: 'https://dir.example.com/plumbers', citedIn: ['a2'], youListed: false, topListed: 'Rival Plumbing' }],
  };
}

test('every issue kind carries steps and copy-paste text built from real details only', () => {
  const issues = buildIssues({ report: miniReport(), business: BIZ });
  const kinds = issues.map((i) => i.kind);
  assert.deepEqual(kinds, ['fact_differs', 'not_listed', 'lost_question', 'baseline_gbp', 'baseline_schema', 'baseline_faq']);
  for (const i of issues) {
    assert.ok(i.steps.length >= 3, `${i.kind} has steps`);
    assert.ok(i.copyText.length >= 1, `${i.kind} has copy text`);
    for (const c of i.copyText) assert.ok(c.label && c.text.trim(), `${i.kind} copy block filled`);
  }
  const fd = issues[0];
  assert.equal(fd.copyText[0].text, 'Mon–Fri 8am–6pm', 'the correct value is the website fact');
  assert.ok(fd.steps.some((s) => s.includes('"open 24/7"')), 'quotes what the AI said');
  const nl = issues[1];
  assert.ok(nl.steps[0].includes('https://dir.example.com/plumbers'));
  assert.ok(nl.steps.some((s) => /Search dir\.example\.com for "Fictional Pipe Co"/.test(s)));
  assert.ok(nl.steps.some((s) => /"claim this business" option \(or similarly named\)/.test(s)), 'generic, not an invented menu path');
  assert.match(nl.copyText[0].text, /Business name: Fictional Pipe Co\nAddress: 12 Main St, Massapequa, NY 11758\nPhone: \(516\) 555-0100/);
  const lq = issues[2];
  assert.match(lq.copyText[0].text, /^Affordable plumber near 11758\nFictional Pipe Co is a plumber at 12 Main St, Massapequa, NY 11758\. Prices: \$99 service call\./);
  // No banned words anywhere in our copy.
  assert.deepEqual(lintText(allText(issues)), []);
});

test('baseline fixes: GBP always; schema + FAQ only with a website; nothing invented', () => {
  const qs = [{ id: 'q1', intent: 'best', text: 'Best plumber?' }];
  const withSite = baselineFixes({ business: BIZ, questions: qs });
  assert.deepEqual(withSite.map((x) => x.kind), ['baseline_gbp', 'baseline_schema', 'baseline_faq']);
  assert.ok(withSite.length >= MIN_FIX_ITEMS, 'a business with a website always gets 3 concrete fixes');
  const noSite = baselineFixes({ business: { ...BIZ, website: null }, questions: qs });
  assert.deepEqual(noSite.map((x) => x.kind), ['baseline_gbp']);
  assert.deepEqual(baselineFixes({ business: { trade: 'plumber' } }), [], 'no name, no fixes');

  // Minimal business: only what is known appears.
  const bare = { name: 'Bare Co', trade: 'roofer', town: 'Islip', website: 'bare.example.com' };
  const d = businessDetails(bare);
  const ld = JSON.parse(localBusinessJsonLd(d).replace(/^<script[^>]*>\n|\n<\/script>$/g, ''));
  assert.deepEqual(ld, { '@context': 'https://schema.org', '@type': 'RoofingContractor', name: 'Bare Co', address: { '@type': 'PostalAddress', addressLocality: 'Islip' }, url: 'https://bare.example.com' });
  assert.equal(napBlock(d), 'Business name: Bare Co\nWebsite: bare.example.com\nCategory: roofer');
  assert.equal(gbpDescription(d), 'Bare Co is a roofer in Islip.');
  const gbp = baselineFixes({ business: bare })[0];
  assert.ok(gbp.steps.some((s) => s === 'Add your opening hours, the same as on your website.'), 'no hours invented');
  const faq = baselineFixes({ business: bare, questions: [{ id: 'q5', intent: 'price', text: 'Affordable roof repair near Islip NY' }] })[2];
  assert.match(faq.steps[1], /add your prices, which your website facts we have don't state/);
  assert.equal(faqAnswer(d, 'price'), 'Bare Co is a roofer in Islip.');
});

test('JSON-LD: 24/7 hours become openingHours; other hour formats are left out, not guessed', () => {
  const mega = JSON.parse(localBusinessJsonLd(businessDetails(MEGA)).replace(/^<script[^>]*>\n|\n<\/script>$/g, ''));
  assert.equal(mega['@type'], 'DryCleaningOrLaundry');
  assert.equal(mega.openingHours, 'Mo-Su 00:00-23:59');
  assert.equal(mega.address.streetAddress, '1502 Deer Park Ave');
  assert.equal(mega.address.postalCode, '11703');
  assert.equal(mega.telephone, '(631) 254-0914');
  const plumber = JSON.parse(localBusinessJsonLd(businessDetails(BIZ)).replace(/^<script[^>]*>\n|\n<\/script>$/g, ''));
  assert.equal(plumber['@type'], 'Plumber');
  assert.equal(plumber.openingHours, undefined);
  // A 24/7 emergency line is not "always open".
  for (const hours of ['Mon–Fri 8am–6pm, Sat 9am–2pm; 24/7 emergency line', '24/7 emergency service', 'Open 24 hours except holidays', '24 hours, closed Sunday']) {
    assert.equal(alwaysOpen(hours), false, hours);
  }
  for (const hours of ['Open 24 Hours Monday - Sunday', 'Open 24/7', 'open 24 hours a day, 365 days a year']) assert.equal(alwaysOpen(hours), true, hours);
});

test('GBP description stays within the 750-character limit and has no phone or link', () => {
  const long = { ...BIZ, facts: { ...BIZ.facts, services: 'x'.repeat(900) } };
  const desc = gbpDescription(businessDetails(long));
  assert.ok(desc.length <= GBP_DESCRIPTION_MAX);
  assert.ok(!desc.includes('555-0100') && !desc.includes('example.com'));
  assert.ok(gbpDescription(businessDetails(BIZ)).length <= GBP_DESCRIPTION_MAX);
});

test('lint: a banned word planted in a step or a copy block blocks the report; owner facts are data', async () => {
  const { report } = await buildReport({
    scan: load('scan.json'), business: MEGA, proposalsByAnswer: load('proposals.json').proposals,
    env: {}, fetchImpl: async () => new Response('', { status: 404 }), id: 'x', maxFetch: 0,
  });
  assert.equal(validateReport(report).ok, true);
  const planted = structuredClone(report);
  planted.issues[0].steps.push('This will rank you higher.');
  assert.ok(validateReport(planted).errors.some((e) => /banned word "rank" in issues\[0\]\.steps/.test(e)));
  const inCopy = structuredClone(report);
  inCopy.issues[1].copyText[0].text += ' Get more customers today.';
  assert.ok(validateReport(inCopy).errors.some((e) => /banned word "more customers" in issues\[1\]\.copyText\[0\]\.text/.test(e)));
  const inLabel = structuredClone(report);
  inLabel.issues[1].copyText[0].label = 'Ready in minutes';
  assert.ok(lintReport(inLabel).some((h) => h.path === 'issues[1].copyText[0].label'));
  // The owner's own website facts are quoted data, not our claim.
  const fact = structuredClone(report);
  fact.business.facts.services = 'Ready in 60 minutes';
  fact.issues[1].copyText[0].text += ' Services: Ready in 60 minutes.';
  assert.deepEqual(lintReport(fact), []);
  // Bad shapes are rejected.
  const bad = structuredClone(report);
  bad.issues[0].copyText = [{ label: 'x' }];
  assert.ok(validateReport(bad).errors.some((e) => /copyText must be an array of \{ label, text \}/.test(e)));
});

test('the $29 tier needs at least 3 fix items', () => {
  assert.equal(MIN_FIX_ITEMS, 3);
  assert.equal(snapshotOffered({ issues: [{ title: 'a' }, { title: 'b' }] }), false);
  assert.equal(snapshotOffered({ issues: [{ title: 'a' }, { title: 'b' }, { title: 'c', locked: true }] }), true);
});

// ---- descriptors --------------------------------------------------------------------------

test('verifyDescriptors: literal substrings only, no competitor names, deduped', () => {
  const text = 'Mega Wash & Dry is praised for fast emergency response. Rival Wash is a cheaper spot. Mega Wash & Dry is a massive, amenity-packed 24/7 alternative.';
  const { kept, rejected } = verifyDescriptors(text, [
    { quote: 'praised for fast emergency response' },
    { quote: 'Praised for fast emergency response' }, // not literal (case)
    { quote: 'praised  for fast emergency response' }, // not literal (spacing)
    { quote: 'a massive, amenity-packed 24/7 alternative' },
    { quote: 'Rival Wash is a cheaper spot' }, // about a competitor
    { quote: 'massive' }, // one word
    { quote: 'praised for fast emergency response' }, // duplicate
  ], ['Rival Wash']);
  assert.deepEqual(kept.map((k) => k.quote), ['praised for fast emergency response', 'a massive, amenity-packed 24/7 alternative']);
  assert.equal(rejected.length, 4);
  assert.ok(rejected.some((r) => /names another business/.test(r.reason)));
});

test('verifyAnswer keeps descriptors only when the answer names the owner', () => {
  const text = 'Rival Wash is praised for fast service.';
  const v = verifyAnswer({ answer: { text, citations: [] }, proposal: { businesses: [{ name: 'Rival Wash', pos: 0 }], ownerDescriptors: [{ quote: 'praised for fast service' }] }, business: MEGA });
  assert.equal(v.namedYou, false);
  assert.deepEqual(v.descriptors, []);
  assert.ok(v.rejected.descriptors[0].reason.includes('does not name the owner'));
});

test('pickDescriptors: dedupes contained phrases, round-robins engines, caps at 6', () => {
  const engineOf = new Map([['a1', 'chatgpt'], ['a2', 'claude']]);
  const raw = [
    ...Array.from({ length: 8 }, (_, i) => ({ answerId: 'a1', quote: `chatgpt phrase number ${i}` })),
    { answerId: 'a2', quote: 'claude says something nice' },
    { answerId: 'a2', quote: 'says something nice' }, // contained in the one above
  ];
  const out = pickDescriptors(raw, engineOf);
  assert.equal(out.length, MAX_DESCRIPTORS);
  assert.equal(out[1].answerId, 'a2', 'second slot goes to the other engine');
  assert.ok(!out.some((d) => d.quote === 'says something nice'));
});

test('extractor schema asks for ownerDescriptors; old recorded proposals without them still work', async () => {
  assert.ok(PROPOSAL_SCHEMA.required.includes('ownerDescriptors'));
  assert.equal(PROPOSAL_SCHEMA.properties.ownerDescriptors.items.required[0], 'quote');
  const p = await proposeForAnswer({ answer: { text: 'x' }, business: MEGA, proposals: { businesses: [], ownerFacts: [] } });
  assert.deepEqual(p.ownerDescriptors, []);
});

test('report: ownerDescriptors come from answers naming the owner, verified, and validateReport checks them', async () => {
  const proposals = structuredClone(load('proposals.json').proposals);
  const scan = load('scan.json');
  // Claude q1 names the owner: propose one real phrase from it and one invented one.
  const claudeQ1 = scan.calls.find((c) => c.engine === 'claude' && c.questionId === 'q1');
  const key = 'claude:q1:1';
  const real = claudeQ1.text.slice(claudeQ1.text.indexOf('Mega Wash & Dry') + 'Mega Wash & Dry'.length).split(/[.!\n]/)[0].trim().split(/\s+/).slice(0, 6).join(' ');
  assert.ok(real.split(' ').length >= 2 && claudeQ1.text.includes(real));
  const rec = proposals[key] || proposals[Object.keys(proposals).find((k) => k.startsWith(key))];
  rec.ownerDescriptors = [{ quote: real }, { quote: 'the best laundromat on Long Island, bar none' }];
  const { report, validation, rejected } = await buildReport({
    scan, business: MEGA, proposalsByAnswer: proposals, env: {}, fetchImpl: async () => new Response('', { status: 404 }), id: 'x', maxFetch: 0,
  });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.deepEqual(report.ownerDescriptors.map((d) => d.quote), [real]);
  assert.ok(rejected.some((r) => r.kind === 'descriptor' && /not a literal substring/.test(r.reason)));
  const bad = structuredClone(report);
  bad.ownerDescriptors.push({ answerId: report.ownerDescriptors[0].answerId, quote: 'invented praise here' });
  assert.ok(validateReport(bad).errors.some((e) => /not a literal quote/.test(e)));
  const notYou = structuredClone(report);
  const miss = report.answers.find((a) => !a.namedYou);
  notYou.ownerDescriptors = [{ answerId: miss.id, quote: miss.text.slice(0, 20) }];
  assert.ok(validateReport(notYou).errors.some((e) => /does not name the owner/.test(e)));
});

test('live Mega Wash & Dry: 1 lost-question fix + 3 baseline fixes, so the $29 tier is offered', async () => {
  const { report, validation } = await buildReport({
    scan: load('scan.json'), business: MEGA, proposalsByAnswer: load('proposals.json').proposals,
    env: {}, fetchImpl: async () => new Response('', { status: 404 }), id: 'mega-wash-and-dry', maxFetch: 0,
  });
  assert.equal(validation.ok, true);
  assert.deepEqual(report.issues.map((i) => i.kind), ['lost_question', 'baseline_gbp', 'baseline_schema', 'baseline_faq']);
  assert.equal(snapshotOffered(report), true);
  assert.deepEqual(report.business.facts, MEGA.facts);
  const lq = report.issues[0];
  assert.match(lq.copyText[0].text, /^Cheapest wash and fold near North Babylon NY\nMega Wash & Dry is a laundromat at 1502 Deer Park Ave, North Babylon, NY 11703\. Prices: \$2\.25\/lb, 20 lb minimum\./);
});
