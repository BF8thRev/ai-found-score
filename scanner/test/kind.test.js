// What kind of business it is, without asking: the name, then the website.
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessKind, kindFromPage, inferKind, publicSite } from '../kind.js';
import { handleQuestions } from '../../src/lib/questions-route.js';

test('guessKind: the name says it', () => {
  assert.equal(guessKind('Glenn Wayne Bakery'), 'bakery');
  assert.equal(guessKind('Otter Plumbing & Heating'), 'plumbing');
  assert.equal(guessKind('Mega Wash & Dry'), 'laundromat');
  assert.equal(guessKind('Sparkle Car Wash'), 'car wash', 'not auto repair or cleaning');
  assert.equal(guessKind('Main Street Pizza'), 'pizzeria', '"street" is not a tree');
  assert.equal(guessKind('Sunshine Bagels'), 'bakery', '"sunshine" is not cleaning');
  assert.equal(guessKind('Smith Dental Group'), 'dentist');
  assert.equal(guessKind('Glenn Wayne'), null);
  assert.equal(guessKind(''), null);
});

test('kindFromPage: schema.org type first, then title, heading, description', () => {
  assert.equal(kindFromPage('<script type="application/ld+json">{"@context":"https://schema.org","@type":["LocalBusiness","Bakery"]}</script><title>Home</title>'), 'bakery');
  assert.equal(kindFromPage('<script type="application/ld+json">{"@type":"Plumber"}</script>'), 'plumbing');
  assert.equal(kindFromPage('<title>Glenn Wayne | Cakes, Cookies & Pastries in Bohemia</title>'), 'bakery');
  assert.equal(kindFromPage('<title>Welcome</title><h1>Family dentist in Islip</h1>'), 'dentist');
  assert.equal(kindFromPage('<title>Welcome</title><meta name="description" content="Pest control and termite treatment">'), 'pest control');
  assert.equal(kindFromPage('<title>Welcome</title>'), null);
});

test('publicSite: never an IP, localhost or an internal name', () => {
  assert.ok(publicSite('glennwayne.com'));
  assert.equal(publicSite('http://127.0.0.1/'), null);
  assert.equal(publicSite('http://localhost:8787'), null);
  assert.equal(publicSite('http://[::1]/'), null);
  assert.equal(publicSite('http://intranet/'), null);
  assert.equal(publicSite('https://www.facebook.com/glennwayne'), null);
});

test('inferKind: name first, then the website, never throws', async () => {
  let fetched = 0;
  const site = (html, status = 200) => async () => { fetched++; return new Response(html, { status }); };
  assert.deepEqual(await inferKind({ name: 'Glenn Wayne Bakery', website: 'glennwayne.com' }, { fetchImpl: site('') }), { kind: 'bakery', from: 'name' });
  assert.equal(fetched, 0, 'no fetch when the name says it');
  assert.deepEqual(await inferKind({ name: 'Glenn Wayne', website: 'glennwayne.com' }, { fetchImpl: site('<title>Bakery & Cafe</title>') }), { kind: 'bakery', from: 'website' });
  assert.deepEqual(await inferKind({ name: 'Glenn Wayne', website: 'glennwayne.com' }, { fetchImpl: site('nope', 500) }), { kind: null, from: null });
  assert.deepEqual(await inferKind({ name: 'Glenn Wayne', website: 'glennwayne.com' }, { fetchImpl: async () => { throw new Error('down'); } }), { kind: null, from: null });
});

test('GET /api/questions: no "what do you do" needed; asks only when nothing tells us', async () => {
  const q = (params, fetchImpl) => handleQuestions(new URL(`https://x.test/api/questions?${new URLSearchParams({ town: 'Bohemia', zip: '11716', state: 'NY', ...params })}`), { fetchImpl });
  let r = await (await q({ name: 'Glenn Wayne Bakery', website: 'glennwayne.com' })).json();
  assert.equal(r.trade, 'bakery');
  assert.equal(r.from, 'name');
  assert.equal(r.questions[0].text, "What's the best bakery in Bohemia, NY?");
  r = await (await q({ name: 'Glenn Wayne', website: 'glennwayne.com' }, async () => new Response('<script type="application/ld+json">{"@type":"Bakery"}</script>'))).json();
  assert.equal(r.trade, 'bakery');
  assert.equal(r.from, 'website');
  r = await (await q({ name: 'Otter Plumbing', preset: 'laundromat' })).json();
  assert.equal(r.trade, 'plumbing', 'the name beats a link preset');
  r = await (await q({ name: 'Glenn Wayne', preset: 'laundromat' })).json();
  assert.equal(r.trade, 'laundromat');
  r = await (await q({ name: 'Glenn Wayne', trade: 'Cake shop' })).json();
  assert.equal(r.trade, 'cake shop');
  assert.equal(r.from, 'owner');
  const res = await q({ name: 'Glenn Wayne', website: 'glennwayne.com' }, async () => new Response('<title>Welcome</title>'));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).needKind, true);
});

// ---- offices and professionals; the name from the page ----
import { findName, metaContent } from '../kind.js';

test('guessKind: agencies, firms and offices by name', () => {
  assert.equal(guessKind('PR 73'), 'PR agency');
  assert.equal(guessKind('Hudson Public Relations'), 'PR agency');
  assert.equal(guessKind('Bright Marketing Group'), 'marketing agency');
  assert.equal(guessKind('Sterling Law Group'), 'law firm');
  assert.equal(guessKind('Northwell IT Services'), 'IT company');
  assert.equal(guessKind('We make it easy'), null, '"it" the pronoun is not IT');
  assert.equal(guessKind('Island Print Shop'), 'print shop');
  assert.equal(guessKind('Elite Med Spa'), 'med spa');
  assert.equal(guessKind('Quick Towing'), 'towing company');
});

test('kindFromPage: og:description comes after title, h1, description; body text is never read', () => {
  assert.equal(kindFromPage('<title>PR 73</title><meta property="og:description" content="A boutique public relations agency in NYC">'), 'PR agency');
  assert.equal(kindFromPage('<title>Smith Dental</title><p>We are a public relations agency</p>'), 'dentist', 'the title wins');
  assert.equal(kindFromPage('<title>Home | Smith &amp; Sons</title><p>Call today for a free consultation. Follow us on social media.</p>'), null, '"consultation" in prose is not a consulting firm');
  assert.equal(metaContent('<meta name="description" content="A &amp; B">', 'description'), 'A & B');
});

test('findName: schema.org name, else og:site_name, else the short part of the title', () => {
  assert.equal(findName('<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Mega Wash &amp; Dry"}</script><title>Laundromat</title>'), 'Mega Wash & Dry');
  assert.equal(findName('<script type="application/ld+json">{"@type":"WebSite","name":"Site"}</script><meta property="og:site_name" content="Glenn Wayne Bakery">'), 'Glenn Wayne Bakery');
  assert.equal(findName('<script type="application/ld+json">{"@graph":[{"@type":"WebPage","name":"Home"},{"@type":"Organization","name":"PR 73"}]}</script>'), 'PR 73');
  assert.equal(findName('<title>PR 73 | Public Relations Agency in New York</title>'), 'PR 73');
  assert.equal(findName('<title>Glenn Wayne Bakery | Bohemia NY</title>'), 'Glenn Wayne Bakery', 'a place is not the name');
  assert.equal(findName('<title>Smith Dental | Boston</title>'), 'Smith Dental');
  assert.equal(findName('<script type="application/ld+json">{"@type":"SiteNavigationElement","name":"Home"}</script><meta property="og:site_name" content="PR 73">'), 'PR 73', 'a nav "Home" is skipped');
  assert.equal(findName('<title>Home - Otter Plumbing &amp; Heating</title>'), 'Otter Plumbing & Heating');
  assert.equal(findName('<title>Welcome to Glenn Wayne Bakery</title>'), 'Glenn Wayne Bakery');
  assert.equal(findName('<title>Home</title>'), '');
  assert.equal(findName(''), '');
});
