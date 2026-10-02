// The Fix Kit (src/lib/fix-kit.js, src/lib/fix-kit-route.js, src/lib/vendor/qrcode.js): prefill,
// validation, every generated file, the ZIP writer, the QR encoder and the /api/fix-kit routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  prefillDetails, validateDetails, buildFixKitFiles, buildKit, zipFiles, crc32, parseOpeningHours, faqItems,
  gbpDescriptionText, localBusinessSchema, splitList, tradeKey, zipName, FIX_KIT_TIERS,
} from '../fix-kit.js';
import { officeReport } from './fixtures/office-report.js';
import { handleFixKit } from '../fix-kit-route.js';
import { qrMatrix, qrSvg } from '../vendor/qrcode.js';
import { TIER_BY_CENTS } from '../stripe.js';
import { AI_BOTS } from '../../../scanner/owner-checks.js';
import { TRADES } from '../../../scanner/questions.js';
import { MOCK_REPORTS } from '../../mock/sample-reports.js';
import { lintText } from '../../../shared/report-v2.js';

const SAMPLE = MOCK_REPORTS['sample-001'];
const DATE = new Date(2026, 8, 26, 14, 30, 10);

const confirmed = (over = {}) => {
  const v = validateDetails({ ...prefillDetails(SAMPLE), ...over });
  assert.deepEqual(v.errors, []);
  return v.details;
};
const fileMap = (details, report = SAMPLE) =>
  Object.fromEntries(buildFixKitFiles(details, report, { token: 'tok_1', date: DATE }).map((f) => [f.path, f.content]));
const ldBlocks = (html) => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));

// ---------------------------------------------------------------------------
// prefill
// ---------------------------------------------------------------------------
test('prefillDetails: owner details, website facts, then defaults', () => {
  const p = prefillDetails(SAMPLE);
  assert.equal(p.name, 'Harborview Plumbing & Heating');
  assert.equal(p.trade, 'plumber');
  assert.equal(p.phone, '(516) 555-0148');
  assert.equal(p.street, '4820 Merrick Road');
  assert.deepEqual([p.town, p.state, p.zip], ['Massapequa', 'NY', '11758']);
  assert.equal(p.website, 'harborviewplumbing.example.com');
  assert.match(p.hours, /^Mon–Fri 8am–6pm/);
  assert.deepEqual(p.services, ['Plumbing repair', '24/7 emergency service', 'Tank and tankless water heater installation', 'Boiler and heating service']);
  assert.deepEqual(p.serviceTowns, ['Massapequa']);
  assert.equal(p.description, 'Harborview Plumbing & Heating is a plumber in Massapequa, NY.');
  assert.equal(p.googleReviewUrl, '');
});

test('prefillDetails: website and Google listing fill what the scan was not given', () => {
  const report = {
    business: { name: 'Acme Electric', trade: 'electrical', town: 'Hicksville', state: 'NY' },
    siteCheck: { onSite: { phone: '(516) 555-0100', address: '' } },
    listings: [{ platform: 'Google', status: 'match', url: 'https://maps.google.com/?cid=1', fields: { name: 'Acme Electric', phone: '(516) 555-0199', address: '12 Main St, Hicksville, NY 11801, USA' } }],
  };
  const p = prefillDetails(report);
  assert.equal(p.phone, '(516) 555-0100', 'the website wins over Google');
  assert.equal(p.street, '12 Main St');
  assert.equal(p.zip, '11801');
  assert.equal(p.googleMapsUrl, 'https://maps.google.com/?cid=1');
  assert.deepEqual(p.services, ['Electrical repair'], 'trade default when the site listed none');
  assert.deepEqual(prefillDetails(null).services, []);
  assert.equal(prefillDetails({ business: { name: 'x', city: 'Islip' } }).town, 'Islip', 'v1 reports use city');
});

test('tradeKey: trade keys, aliases and the scanner nouns', () => {
  assert.equal(tradeKey('plumber'), 'plumbing');
  assert.equal(tradeKey('heating and air conditioning company'), 'hvac');
  assert.equal(tradeKey('house cleaning service'), 'cleaning');
  assert.equal(tradeKey('bakery'), null);
  assert.deepEqual(splitList('a, b; c\n- a\n'), ['A', 'B', 'C']);
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------
test('validateDetails: required fields, formats and limits', () => {
  const bad = validateDetails({ name: ' ', phone: '555', town: '', state: 'New York', zip: '123', website: 'not a site', googleReviewUrl: 'http://g.page/x', services: Array.from({ length: 16 }, (_, i) => `S${i}`) });
  assert.equal(bad.ok, false);
  const fields = bad.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['googleReviewUrl', 'name', 'phone', 'services', 'state', 'town', 'website', 'zip']);
  assert.equal(bad.details.services.length, 15, 'lists are capped');

  const ok = validateDetails({
    name: '  Joe’s   Plumbing ', phone: '516.555.0148', town: 'Massapequa', state: 'ny', website: 'www.joes.example.com/',
    googleReviewUrl: 'https://g.page/r/abc/review', services: 'Drains\nDrains\n  water heaters ', serviceTowns: [], description: '',
    trade: 'plumber', hours: 'x'.repeat(400),
  });
  assert.deepEqual(ok.errors.map((e) => e.field), ['hours']);
  const d = ok.details;
  assert.equal(d.name, 'Joe’s Plumbing');
  assert.equal(d.phone, '(516) 555-0148');
  assert.equal(d.state, 'NY');
  assert.equal(d.website, 'https://www.joes.example.com');
  assert.deepEqual(d.services, ['Drains', 'Water heaters']);
  assert.deepEqual(d.serviceTowns, ['Massapequa'], 'defaults to the home town');
  assert.equal(d.description, 'Joe’s Plumbing is a plumber in Massapequa, NY.');
  assert.equal(d.hours.length, 300);
  assert.equal(validateDetails({ name: 'a', phone: '5165550148', town: 't', state: 'NY', website: 'javascript:alert(1)' }).errors[0].field, 'website');
  assert.equal(validateDetails(null).ok, false);
});

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------
// The plumber sample's website check: AI allowed, business code already there (Plumber), no llms.txt.
const withSite = (over) => ({ ...SAMPLE, siteCheck: { ...SAMPLE.siteCheck, ...over } });
const BLOCKED = withSite({ robots: { found: true, blocked: [{ agent: 'GPTBot', who: 'ChatGPT (training)' }, { agent: 'ClaudeBot', who: 'Claude' }] } });

test('buildFixKitFiles: only the files that help this business; the QR code only with a review link', () => {
  // The plumber sample's AI answers mention reviews, so the kit carries the review messages even without a link.
  assert.deepEqual(Object.keys(fileMap(confirmed())), ['README.txt', 'faq-page.html', 'faq-page.txt', 'google-business-profile.txt', 'ask-for-reviews.txt', 'schema-localbusiness.html', 'llms.txt', 'check-it-worked.txt']);
  const withQr = fileMap(confirmed({ googleReviewUrl: 'https://g.page/r/abc/review' }));
  assert.ok(withQr['review-qr.svg'].startsWith('<svg'));
  assert.match(withQr['README.txt'], /review-qr\.svg/);
  // The site already has an llms.txt: none in the kit, and the README says so.
  const hasLlms = fileMap(confirmed(), withSite({ llmsTxt: true }));
  assert.equal(hasLlms['llms.txt'], undefined);
  assert.match(hasLlms['README.txt'], /You already have an llms\.txt file\. Nothing to do\./);
});

test('buildKit: the jobs left, in order; what the site already has is done or optional', () => {
  const k = buildKit(confirmed(), SAMPLE, { token: 'tok_1', date: DATE });
  assert.deepEqual(k.jobs.map((j) => [j.id, j.optional]), [['faq', false], ['google', false], ['qr', false], ['schema', true], ['llms', true]]);
  assert.match(k.jobs.find((j) => j.id === 'schema').note, /already has business code \(Plumber\)/);
  assert.deepEqual(k.done.map((x) => x.id), ['robots']);
  // Plain words first; the technical name is the small print.
  assert.equal(k.jobs[0].title, 'A Questions page AI can quote');
  assert.equal(k.jobs.find((j) => j.id === 'schema').title, 'Your business details in the format Google and AI read');
  for (const j of k.jobs) assert.doesNotMatch(j.title, /JSON-LD|schema|llms\.txt|robots/i, j.title);
  // Blocked crawlers: letting AI back in is the first job. No website check at all: robots.txt in case.
  const blocked = buildKit(confirmed(), BLOCKED, { date: DATE });
  assert.equal(blocked.jobs[0].id, 'robots');
  assert.match(blocked.jobs[0].what, /ChatGPT \(training\) and Claude/);
  const unchecked = buildKit(confirmed(), { ...SAMPLE, siteCheck: null }, { date: DATE });
  assert.ok(unchecked.jobs.some((j) => j.id === 'robots'));
  assert.deepEqual(unchecked.done, []);
  assert.equal(unchecked.jobs.find((j) => j.id === 'schema').optional, false, 'unknown: not marked optional');
});

test('robots.txt: only when AI is blocked (or we could not check); allows every AI crawler, notes merging', () => {
  assert.equal(fileMap(confirmed())['robots.txt'], undefined, 'the sample site already lets AI in');
  assert.match(fileMap(confirmed())['README.txt'], /Your robots\.txt already lets AI read your site\. Nothing to do\./);
  const office = buildKit(validateDetails(prefillDetails(officeReport())).details, officeReport(), { date: DATE });
  assert.match(office.done[0].note, /Nothing on your website blocks AI from reading it/, 'no robots.txt at all is not a block');
  const t = fileMap(confirmed(), BLOCKED)['robots.txt'];
  for (const b of AI_BOTS) assert.match(t, new RegExp(`User-agent: ${b.agent}\\nAllow: /\\n`));
  assert.match(t, /^# Your robots\.txt blocks ChatGPT \(training\) and Claude today\./m);
  assert.match(t, /^# Already have a robots\.txt\? Do not replace it\. Add the lines below to it/m);
  assert.match(t, /Sitemap: https:\/\/harborviewplumbing\.example\.com\/sitemap\.xml/);
  assert.ok(!/Disallow/.test(t.replace(/^#.*$/gm, '')), 'never blocks anything');
  assert.ok(!/Sitemap:/.test(fileMap(confirmed({ website: '' }), BLOCKED)['robots.txt']));
});

test('llms.txt: H1, summary, services, service area, contact', () => {
  const t = fileMap(confirmed({ serviceTowns: ['Massapequa', 'Seaford'], googleReviewUrl: 'https://g.page/r/abc/review' }))['llms.txt'];
  assert.match(t, /^# Harborview Plumbing & Heating\n\n> Harborview Plumbing & Heating is a plumber in Massapequa, NY\.\n/);
  assert.match(t, /## Services\n\n- Plumbing repair\n/);
  assert.match(t, /## Service area\n\n- Massapequa, NY\n- Seaford, NY\n/);
  assert.match(t, /## Contact\n\n- \[Phone: \(516\) 555-0148\]\(tel:\+15165550148\)\n- Address: 4820 Merrick Road, Massapequa, NY 11758\n/);
  assert.match(t, /- \[Google reviews\]\(https:\/\/g\.page\/r\/abc\/review\)/);
});

test('schema: valid JSON-LD with the trade type, address, area served; hours only when readable', () => {
  const html = fileMap(confirmed({ serviceTowns: ['Massapequa', 'Seaford'], googleMapsUrl: 'https://maps.google.com/?cid=9' }))['schema-localbusiness.html'];
  const [o] = ldBlocks(html);
  assert.equal(o['@type'], 'Plumber');
  assert.equal(o.telephone, '(516) 555-0148');
  assert.deepEqual(o.address, { '@type': 'PostalAddress', streetAddress: '4820 Merrick Road', addressLocality: 'Massapequa', addressRegion: 'NY', postalCode: '11758', addressCountry: 'US' });
  assert.equal(o.url, 'https://harborviewplumbing.example.com');
  assert.deepEqual(o.areaServed.map((a) => a.name), ['Massapequa, NY', 'Seaford, NY']);
  assert.deepEqual(o.sameAs, ['https://maps.google.com/?cid=9']);
  assert.equal(o.openingHours, undefined, '"24/7 emergency line" is not an opening time we can convert');
  const open = localBusinessSchema(confirmed({ hours: 'Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed' }));
  assert.deepEqual(open.openingHours, ['Mo-Fr 08:00-18:00', 'Sa 09:00-14:00']);
  // Types per trade; a name with </script> can't break out of the tag.
  assert.equal(localBusinessSchema(confirmed({ trade: 'hvac' }))['@type'], 'HVACBusiness');
  assert.equal(localBusinessSchema(confirmed({ trade: 'roofer' }))['@type'], 'RoofingContractor');
  assert.equal(localBusinessSchema(confirmed({ trade: 'electrician' }))['@type'], 'Electrician');
  assert.equal(localBusinessSchema(confirmed({ trade: 'landscaper' }))['@type'], 'HomeAndConstructionBusiness');
  assert.equal(localBusinessSchema(confirmed({ trade: 'bakery' }))['@type'], 'LocalBusiness');
  for (const key of Object.keys(TRADES)) assert.notEqual(localBusinessSchema(confirmed({ trade: key }))['@type'], 'LocalBusiness', key);
  const evil = fileMap(confirmed({ name: 'Bad </script><script>alert(1)</script> Co' }))['schema-localbusiness.html'];
  assert.equal(ldBlocks(evil)[0].name, 'Bad </script><script>alert(1)</script> Co');
  assert.equal((evil.match(/<\/script>/g) || []).length, 1);
});

test('parseOpeningHours: only what reads without guessing', () => {
  assert.deepEqual(parseOpeningHours('Mon–Fri 8am–6pm; Sat 9:30 am - 2 pm'), ['Mo-Fr 08:00-18:00', 'Sa 09:30-14:00']);
  assert.deepEqual(parseOpeningHours('Open 24 hours'), ['Mo-Su 00:00-23:59']);
  assert.deepEqual(parseOpeningHours('Monday to Saturday 07:00 - 19:00'), ['Mo-Sa 07:00-19:00']);
  assert.deepEqual(parseOpeningHours('Fri 6pm-12am'), ['Fr 18:00-23:59']);
  for (const h of ['8-6', 'Mon-Fri 9-5pm', 'Weekdays 8am-6pm', 'Mon–Fri 8am–6pm; 24/7 emergency line', 'Sat 10pm-2am', '']) {
    assert.equal(parseOpeningHours(h), null, h);
  }
});

test('faq-page.html: semantic Q&A section; the FAQ code holds exactly the finished answers', () => {
  const d = confirmed({ serviceTowns: ['Massapequa', 'Seaford'] });
  const html = fileMap(d)['faq-page.html'];
  const items = faqItems(d, SAMPLE);
  const [ld] = ldBlocks(html);
  assert.equal(ld['@type'], 'FAQPage');
  // The visible page: an h2, then every question (h3) and answer (p), escaped.
  assert.match(html, /<section class="faq" id="faq">\n {2}<h2>Frequently asked questions<\/h2>/);
  for (const it of items) {
    assert.ok(html.includes(`<h3>${it.question.replace(/'/g, '&#39;').replace(/&(?!#39;)/g, '&amp;')}</h3>`), it.question);
  }
  // The code: only finished answers, word for word; never a [bracket].
  const done = items.filter((i) => i.complete);
  assert.deepEqual(ld.mainEntity.map((m) => [m.name, m.acceptedAnswer.text]), done.map((i) => [i.question, i.answer]));
  for (const m of ld.mainEntity) assert.doesNotMatch(m.acceptedAnswer.text, /[[\]]/, m.name);
  assert.ok(items.some((i) => !i.complete), 'the sample has answers waiting for a detail');
  assert.match(html, /answers still have a part in \[brackets\]/);
  // Filled in on the kit page: the sentence goes in and the answer joins the code.
  const filled = confirmed({ faqFacts: { specialty: 'Most of our work is boiler repair [and more]' } });
  const f = faqItems(filled, SAMPLE).find((i) => i.slot && i.slot.type === 'specialty');
  assert.ok(f.complete);
  assert.match(f.answer, /Most of our work is boiler repair and more\./, 'their words, brackets stripped');
  assert.ok(ldBlocks(fileMap(filled)['faq-page.html'])[0].mainEntity.some((m) => m.name === f.question));
  // A report without questions (an old one): the scanner's questions for the trade and town.
  assert.ok(faqItems(d, {}).length >= 5);
});

test('faq-page.txt: the same questions and answers as plain text for a site builder', () => {
  const d = confirmed();
  const t = fileMap(d)['faq-page.txt'];
  assert.match(t, /^QUESTIONS AND ANSWERS: Harborview Plumbing & Heating\n/);
  assert.match(t, /Wix, Squarespace, WordPress/);
  for (const it of faqItems(d, SAMPLE)) assert.ok(t.includes(`${it.question}\n${it.answer}`), it.question);
});

test('a missing phone is flagged and left out of every file, never invented', () => {
  const v = validateDetails({ ...prefillDetails(SAMPLE), phone: '' });
  assert.deepEqual(v.errors, [], 'a phone is not required');
  const k = buildKit(v.details, SAMPLE, { date: DATE });
  assert.deepEqual(k.missing.map((m) => m.field), ['phone']);
  const files = Object.fromEntries(k.files.map((f) => [f.path, f.content]));
  assert.equal(ldBlocks(files['schema-localbusiness.html'])[0].telephone, undefined);
  assert.match(files['schema-localbusiness.html'], /Your phone number is not in it yet/);
  assert.doesNotMatch(files['llms.txt'], /Phone/);
  assert.match(files['google-business-profile.txt'], /PHONE\n\[Missing: add your phone number/);
  assert.match(files['README.txt'], /Missing: Phone number\./);
  for (const it of k.faq.items) assert.doesNotMatch(it.answer, /Call |\(\d{3}\)/, it.question);
  assert.match(k.faq.items[0].answer, /Visit harborviewplumbing\.example\.com\./);
});

test('google-business-profile.txt: description ≤ 750, categories, services, areas', () => {
  const d = confirmed({ serviceTowns: ['Massapequa', 'Seaford'] });
  const t = fileMap(d)['google-business-profile.txt'];
  assert.match(t, /PRIMARY CATEGORY \(our suggestion\)\nPlumber\n/);
  assert.match(t, /DESCRIPTION \(\d+ of 750 characters\)\nHarborview Plumbing & Heating is a plumber in Massapequa, NY\. Services: /);
  assert.match(t, /SERVICE AREAS\n- Massapequa, NY\n- Seaford, NY\n/);
  assert.match(t, /SERVICES\n- Plumbing repair\n/);
  const long = confirmed({ description: 'Family owned. '.repeat(50).trim(), services: Array.from({ length: 15 }, (_, i) => `Service number ${i} with a long name`) });
  const desc = gbpDescriptionText(long);
  assert.ok(desc.length <= 750);
  assert.ok(!desc.includes('Service number'), 'a sentence that does not fit is left out whole');
  assert.match(fileMap(confirmed({ trade: 'hvac' }))['google-business-profile.txt'], /OTHER CATEGORIES TO CONSIDER.*\n- Air conditioning contractor\n- Heating contractor/);
});

test('README.txt: plain words first, only the jobs left (in order), what is done, the details and the link back', () => {
  const t = fileMap(confirmed())['README.txt'];
  const at = (s) => { const i = t.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('1. A Questions page AI can quote') < at('2. Your Google Business Profile text'));
  assert.ok(at('2. Your Google Business Profile text') < at('3. Ask happy customers for a Google review'));
  assert.ok(at('3. Ask happy customers for a Google review') < at('4. Your business details in the format Google and AI read (optional)'));
  assert.ok(at('5. A short summary for AI tools (optional)') < at('ALREADY DONE ON YOUR WEBSITE'));
  assert.doesNotMatch(t, /^\d\. .*(JSON-LD|schema|llms\.txt|robots\.txt)/m, 'no job leads with jargon');
  assert.doesNotMatch(t, /File: robots\.txt/, 'no robots.txt to install');
  assert.match(t, /answers in your Questions page need one detail from you/);
  assert.match(t, /Phone: \(516\) 555-0148/);
  assert.match(t, /https:\/\/aifoundscore\.com\/fix-kit\/tok_1/);
  assert.ok(!/review-qr/.test(t), 'no link, no QR code');
  assert.match(t, /Time: About an hour for you, then about half an hour for your web person. No cost from us./);
  assert.match(t, /We can’t promise any assistant will name you: check-it-worked.txt says what to expect/);
});

test('copy: no banned words, no "unlock", "seamless" or "leverage"', () => {
  const office = validateDetails(prefillDetails(officeReport())).details;
  const files = {
    ...fileMap(confirmed({ googleReviewUrl: 'https://g.page/r/abc/review' }), BLOCKED),
    ...Object.fromEntries(buildFixKitFiles(office, officeReport(), { date: DATE }).map((f) => [`office/${f.path}`, f.content])),
  };
  const page = readFileSync(new URL('../../../public/fix-kit.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../../../public/js/fix-kit.js', import.meta.url), 'utf8');
  for (const [name, text] of [...Object.entries(files).filter(([p]) => !p.endsWith('.svg')), ['fix-kit.html', page], ['fix-kit.js', script]]) {
    assert.deepEqual(lintText(text).map((h) => h.match), [], name);
    assert.ok(!/\b(unlock\w*|seamless\w*|leverag\w*)\b/i.test(text), name);
  }
  assert.match(page, /Your Fix Kit is ready/);
  assert.match(page, /Check these <span data-fact-count>6<\/span> details/);
  assert.match(page, /Download my Fix Kit/);
  assert.match(page, /I own or manage this business and these details are correct/);
  assert.doesNotMatch(page, /Check every detail\. We only use what you confirm here\./, 'no form-first wall');
});

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
const u32 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b, o) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);

test('crc32: standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zipFiles: local headers, central directory and end record agree; CRCs are right', () => {
  const files = [
    { path: 'a.txt', content: 'hello' },
    { path: 'dir/ü.bin', content: new Uint8Array([0, 1, 2, 255]) },
    { path: 'empty.txt', content: '' },
  ];
  const z = zipFiles(files, { date: DATE });
  assert.deepEqual([...z.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const eocd = z.length - 22;
  assert.equal(u32(z, eocd), 0x06054b50);
  assert.equal(u16(z, eocd + 8), 3);
  assert.equal(u16(z, eocd + 10), 3);
  const cdSize = u32(z, eocd + 12);
  let p = u32(z, eocd + 16);
  assert.equal(p + cdSize, eocd);
  const dec = new TextDecoder();
  for (const f of files) {
    const data = typeof f.content === 'string' ? new TextEncoder().encode(f.content) : f.content;
    assert.equal(u32(z, p), 0x02014b50);
    assert.equal(u16(z, p + 8) & 0x0800, 0x0800, 'UTF-8 names');
    assert.equal(u16(z, p + 10), 0, 'stored');
    assert.equal(u32(z, p + 16), crc32(data));
    assert.equal(u32(z, p + 20), data.length);
    const nameLen = u16(z, p + 28);
    assert.equal(dec.decode(z.slice(p + 46, p + 46 + nameLen)), f.path);
    const lh = u32(z, p + 42);
    assert.equal(u32(z, lh), 0x04034b50);
    assert.equal(u32(z, lh + 14), crc32(data));
    const start = lh + 30 + u16(z, lh + 26);
    assert.deepEqual([...z.slice(start, start + data.length)], [...data]);
    // DOS time: 14:30:10, 2026-09-26
    assert.equal(u16(z, lh + 10), (14 << 11) | (30 << 5) | 5);
    assert.equal(u16(z, lh + 12), ((2026 - 1980) << 9) | (9 << 5) | 26);
    p += 46 + nameLen;
  }
});

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------
// Reference: 'https://g.page/r/CabcDEF123/review', level M, mask 2, from the independent `qrcode` npm
// package (node-qrcode 1.5.4). Our encoder matched it module for module across versions 1-40.
const QR_REF = ['11111110000101110010101111111', '10000010000111111000001000001', '10111010101001010000101011101', '10111010110110110000001011101', '10111010111010011010101011101', '10000010110110000100101000001', '11111110101010101010101111111', '00000000101000101011000000000', '10111110011100000110001111100', '10111100001111110001111110001', '01100110110011111010000110000', '10110100000101001001001011010', '10110010001000111110000001100', '00100100110100001001111110001', '01110011111000011110100011100', '00001001100100111010000010010', '00111110011110010110010101100', '10000101101101101001111110101', '10110010111101111110101000100', '10110101111011010001001100010', '10001111101110100110111110111', '00000000101000001110100011111', '11111110010100010100101011100', '10000010100000101001100010011', '10111010110000011100111110110', '10111010101111101001100001111', '10111010110010111111101011110', '10000010010001011010110101010', '11111110110010010100011110100'];

test('qrMatrix: matches a reference encoder bit for bit', () => {
  const m = qrMatrix('https://g.page/r/CabcDEF123/review', { ecl: 'M', mask: 2 });
  assert.equal(m.version, 3);
  assert.deepEqual(m.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')), QR_REF);
});

test('qrMatrix: versions grow with the text; too long throws', () => {
  assert.equal(qrMatrix('x').version, 1);
  const long = qrMatrix('https://search.google.com/local/writereview?placeid=' + 'A'.repeat(200));
  assert.ok(long.version >= 10 && long.size === long.version * 4 + 17);
  assert.throws(() => qrMatrix('x'.repeat(3000)), /too long/);
});

test('qrSvg: a standalone SVG with a quiet zone', () => {
  const svg = qrSvg('https://g.page/r/abc/review', { title: 'Review <us>' });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.match(svg, /viewBox="0 0 37 37"/); // version 3 (29 modules) + 4 each side
  assert.match(svg, /<title>Review &lt;us&gt;<\/title>/);
  assert.match(svg, /<path d="M4 4h7v1h-7z/, 'finder pattern at the top left, inside the quiet zone');
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------
const ENV = {};
const req = (path, init = {}) => [new Request(`https://aifoundscore.com${path}`, init), new URL(`https://aifoundscore.com${path}`)];
const post = (path, body, headers = { 'Content-Type': 'application/json' }) => req(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

function fakes({ tiers = [], saved = null, report = SAMPLE } = {}) {
  const calls = { saved: [] };
  return {
    calls,
    deps: {
      mockReports: MOCK_REPORTS,
      getReport: async (env, id, mocks) => (id.startsWith('sample-') ? mocks[id] || null : id === 'real_tok' ? report : null),
      getPaidTiers: async () => tiers,
      getFixKitDetails: async () => saved,
      saveFixKitDetails: async (env, token, details) => { calls.saved.push({ token, details }); },
      rateLimit: async () => null,
      now: () => DATE,
    },
  };
}

test('tiers: the $49 audit, $499 and the retired $149 Fix Kit all open the Fix Kit', () => {
  assert.equal(TIER_BY_CENTS[4900], 'xray');
  assert.equal(TIER_BY_CENTS[14900], 'fix_kit');
  assert.equal(TIER_BY_CENTS[49900], 'be_the_answer');
  assert.deepEqual([...FIX_KIT_TIERS], ['xray', 'fix_kit', 'be_the_answer']);
});

test('GET: 404 without a report; unpaid says so; sample is a paid demo with prefilled details', async () => {
  const { deps } = fakes();
  assert.equal((await handleFixKit(...req('/api/fix-kit/nope'), ENV, deps)).status, 404);
  assert.equal((await handleFixKit(...req('/api/fix-kit/bad%20token'), ENV, deps)).status, 404);
  const unpaid = await (await handleFixKit(...req('/api/fix-kit/real_tok'), ENV, fakes({ tiers: ['competitor_breakdown'] }).deps)).json();
  assert.equal(unpaid.paid, false, 'a payment for a plan without the kit does not open it');
  const sample = await handleFixKit(...req('/api/fix-kit/sample-001'), ENV, deps);
  assert.match(sample.headers.get('Cache-Control'), /no-store/);
  const s = await sample.json();
  assert.deepEqual([s.paid, s.confirmed, s.sample], [true, false, true]);
  assert.equal(s.details.name, 'Harborview Plumbing & Heating');
});

test('GET: a paid token shows saved details once confirmed; a failed paid check is "not paid"', async () => {
  const saved = { details: { ...confirmed(), name: 'Saved Name' }, confirmed_at: '2026-09-26T10:00:00Z' };
  const r = await (await handleFixKit(...req('/api/fix-kit/real_tok'), ENV, fakes({ tiers: ['be_the_answer'], saved }).deps)).json();
  assert.deepEqual([r.paid, r.confirmed, r.details.name, r.confirmedAt], [true, true, 'Saved Name', '2026-09-26T10:00:00Z']);
  const { deps } = fakes();
  deps.getPaidTiers = async () => { throw new Error('no key'); };
  assert.equal((await (await handleFixKit(...req('/api/fix-kit/real_tok'), ENV, deps)).json()).paid, false);
});

test('POST: paid only, JSON only, confirm box required, errors per field, then saved', async () => {
  const body = { confirm: true, details: prefillDetails(SAMPLE) };
  assert.equal((await handleFixKit(...post('/api/fix-kit/real_tok', body), ENV, fakes().deps)).status, 402);
  const paid = fakes({ tiers: ['fix_kit'] });
  assert.equal((await handleFixKit(...post('/api/fix-kit/real_tok', body, { 'Content-Type': 'text/plain' }), ENV, paid.deps)).status, 415);
  const noBox = await handleFixKit(...post('/api/fix-kit/real_tok', { ...body, confirm: false }), ENV, paid.deps);
  assert.equal(noBox.status, 422);
  assert.deepEqual((await noBox.json()).errors.map((e) => e.field), ['confirm']);
  const badPhone = await handleFixKit(...post('/api/fix-kit/real_tok', { confirm: true, details: { ...body.details, phone: '12' } }), ENV, paid.deps);
  assert.deepEqual((await badPhone.json()).errors.map((e) => e.field), ['phone']);
  assert.equal(paid.calls.saved.length, 0);
  const ok = await handleFixKit(...post('/api/fix-kit/real_tok', body), ENV, paid.deps);
  assert.equal(ok.status, 200);
  assert.equal(paid.calls.saved.length, 1);
  assert.equal(paid.calls.saved[0].token, 'real_tok');
  assert.equal(paid.calls.saved[0].details.website, 'https://harborviewplumbing.example.com');
  assert.equal((await handleFixKit(...post('/api/fix-kit/real_tok', 'x'.repeat(25000)), ENV, paid.deps)).status, 413);
  // The sample checks but never saves.
  const sample = fakes();
  assert.equal((await (await handleFixKit(...post('/api/fix-kit/sample-001', body), ENV, sample.deps)).json()).sample, true);
  assert.equal(sample.calls.saved.length, 0);
});

test('POST and zip are rate limited', async () => {
  const { deps } = fakes({ tiers: ['fix_kit'] });
  deps.rateLimit = async () => new Response('slow down', { status: 429 });
  assert.equal((await handleFixKit(...post('/api/fix-kit/real_tok', {}), ENV, deps)).status, 429);
  assert.equal((await handleFixKit(...req('/api/fix-kit/real_tok.zip'), ENV, deps)).status, 429);
  assert.equal((await handleFixKit(...req('/api/fix-kit/real_tok'), ENV, deps)).status, 200, 'the form itself is not');
});

test('zip: paid and confirmed only; an attachment named for the business', async () => {
  assert.equal((await handleFixKit(...req('/api/fix-kit/real_tok.zip'), ENV, fakes().deps)).status, 402);
  assert.equal((await handleFixKit(...req('/api/fix-kit/real_tok.zip'), ENV, fakes({ tiers: ['fix_kit'] }).deps)).status, 409);
  assert.equal((await handleFixKit(...post('/api/fix-kit/real_tok.zip', {}), ENV, fakes({ tiers: ['fix_kit'] }).deps)).status, 405);
  const saved = { details: confirmed({ googleReviewUrl: 'https://g.page/r/abc/review' }), confirmed_at: 'x' };
  const res = await handleFixKit(...req('/api/fix-kit/real_tok.zip'), ENV, fakes({ tiers: ['fix_kit'], saved }).deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/zip');
  assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="harborview-plumbing-heating-fix-kit.zip"');
  const z = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...z.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assert.equal(u16(z, z.length - 22 + 10), 9, 'README, the FAQ (page + text), Google text, review messages, business code, llms.txt, the QR code and the check list');
  // The sample zip works with no database.
  const sample = await handleFixKit(...req('/api/fix-kit/sample-001.zip'), ENV, fakes().deps);
  assert.equal(sample.status, 200);
  assert.equal(zipName(prefillDetails(SAMPLE)), 'harborview-plumbing-heating-fix-kit.zip');
});
