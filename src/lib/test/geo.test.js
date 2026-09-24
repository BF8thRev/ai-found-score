// src/lib/geo.js: sanitising request.cf, the fallback, and the HTMLRewriter output (real
// HTMLRewriter via Miniflare, which ships with wrangler) for the homepage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GEO, cleanTown, cleanZip, cleanState, geoFromCf, devGeoOverride, geoForRequest,
  nearbyTown, exampleQuestions, geoTag,
} from '../geo.js';
import { buildQuestions } from '../../../scanner/questions.js';

const INDEX = readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
const US = { country: 'US', city: 'Hicksville', region: 'New York', regionCode: 'NY', postalCode: '11801', latitude: '40.76', longitude: '-73.52', timezone: 'America/New_York' };

// ---- pure -----------------------------------------------------------------------------------

test('cleanTown: plain town names only', () => {
  assert.equal(cleanTown('Hicksville'), 'Hicksville');
  assert.equal(cleanTown('  North   Babylon '), 'North Babylon');
  assert.equal(cleanTown("Coeur d'Alene"), "Coeur d'Alene");
  assert.equal(cleanTown('Coeur d’Alene'), "Coeur d'Alene");
  assert.equal(cleanTown('Winston-Salem'), 'Winston-Salem');
  assert.equal(cleanTown('St. Louis'), 'St. Louis');
  assert.equal(cleanTown('Cañon City'), 'Cañon City');
  for (const bad of ['', ' ', '<script>alert(1)</script>', 'Town"><img src=x onerror=1>', 'A&B', 'Town, NY',
    '12345', "'Quoted", 'x'.repeat(41), 'Tab\u0000Town', null, undefined, 42, {}]) {
    assert.equal(cleanTown(bad), '', JSON.stringify(bad));
  }
  assert.equal(cleanTown('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(cleanTown('New\nYork'), 'New York');
});

test('cleanZip / cleanState', () => {
  assert.equal(cleanZip('11758'), '11758');
  assert.equal(cleanZip('11758-1234'), '11758');
  for (const bad of ['1175', '117580', 'SW1A 1AA', '<b>', '', null]) assert.equal(cleanZip(bad), '', String(bad));
  assert.equal(cleanState('NY'), 'NY');
  assert.equal(cleanState('nj'), 'NJ');
  assert.equal(cleanState('DC'), 'DC');
  for (const bad of ['XX', 'ON', 'New York', '', null, 'N"']) assert.equal(cleanState(bad), '', String(bad));
});

test('geoFromCf: a US request with a city is personalised', () => {
  assert.deepEqual(geoFromCf(US), { town: 'Hicksville', state: 'NY', stateName: 'New York', zip: '11801', country: 'US', source: 'ip' });
  assert.equal(geoFromCf({ ...US, postalCode: undefined }).zip, '');
  assert.equal(geoFromCf({ ...US, postalCode: 'nope' }).source, 'ip');
});

test('geoFromCf: everything else falls back to the default town', () => {
  const def = { ...DEFAULT_GEO };
  assert.deepEqual(geoFromCf(undefined), def);
  assert.deepEqual(geoFromCf({}), def);
  assert.deepEqual(geoFromCf({ ...US, country: 'CA', city: 'Toronto', regionCode: 'ON' }), def);
  assert.deepEqual(geoFromCf({ ...US, city: undefined }), def);
  assert.deepEqual(geoFromCf({ ...US, regionCode: 'ZZ' }), def);
  assert.deepEqual(geoFromCf({ ...US, city: '<img src=x onerror=alert(1)>' }), def);
  assert.equal(DEFAULT_GEO.source, 'default');
});

test('devGeoOverride: localhost only', () => {
  assert.deepEqual(devGeoOverride(new URL('http://localhost:8787/?geo=Hicksville,NY,11801')),
    { country: 'US', city: 'Hicksville', regionCode: 'NY', postalCode: '11801' });
  assert.deepEqual(devGeoOverride(new URL('http://127.0.0.1:8787/?geo=off')), {});
  assert.equal(devGeoOverride(new URL('http://localhost:8787/')), null);
  assert.equal(devGeoOverride(new URL('https://aifoundscore.com/?geo=Hicksville,NY,11801')), null);
  assert.equal(devGeoOverride(new URL('https://localhost.evil.com/?geo=Hicksville,NY,11801')), null);
});

test('geoForRequest: request.cf, never client headers; bots get the default', () => {
  const req = (url, { cf, ua = 'Mozilla/5.0', headers = {} } = {}) =>
    Object.assign(new Request(url, { headers: { 'User-Agent': ua, ...headers } }), { cf });
  assert.equal(geoForRequest(req('https://aifoundscore.com/', { cf: US })).town, 'Hicksville');
  // Spoofed location headers are ignored.
  const spoof = req('https://aifoundscore.com/', { headers: { 'CF-IPCity': 'Evilville', 'CF-Region-Code': 'CA', 'X-Geo': 'x' } });
  assert.deepEqual(geoForRequest(spoof), { ...DEFAULT_GEO });
  assert.equal(geoForRequest(req('https://aifoundscore.com/', { cf: US, ua: 'Googlebot/2.1' })).source, 'default');
  assert.equal(geoForRequest(req('https://aifoundscore.com/?geo=Deer Park,NY', { cf: US })).town, 'Hicksville');
  assert.equal(geoForRequest(req('http://localhost:8787/?geo=Deer Park,NY', { cf: US })).town, 'Deer Park');
});

test('example questions come from the scanner templates; neighbouring town on Long Island', () => {
  assert.equal(nearbyTown('North Babylon', 'NY'), 'Deer Park');
  assert.equal(nearbyTown('North Babylon', 'NJ'), '');
  assert.equal(nearbyTown('Albany', 'NY'), '');
  const g = geoFromCf(US);
  assert.deepEqual(exampleQuestions(g), buildQuestions({ trade: 'plumbing', town: 'Hicksville', state: 'NY', zip: '11801', nearbyTown: 'Plainview' }));
  const tx = geoFromCf({ country: 'US', city: 'Austin', regionCode: 'TX', postalCode: '78701' });
  assert.equal(exampleQuestions(tx)[0].text, "What's the best plumber in Austin, TX?");
  assert.equal(exampleQuestions(tx)[1].text, 'I need an emergency plumber near Austin tonight');
});

test('geoTag: empty for the default page, differs by town, hides the town', () => {
  assert.equal(geoTag(DEFAULT_GEO), '');
  const a = geoTag(geoFromCf(US));
  const b = geoTag(geoFromCf({ ...US, city: 'Deer Park', postalCode: '11729' }));
  assert.match(a, /^-geo\.[0-9a-z]+$/);
  assert.notEqual(a, b);
  assert.ok(!a.toLowerCase().includes('hicksville'));
});

test('static index.html reads correctly for the default town', () => {
  const list = /<ol[^>]*data-geo-questions="plumbing"[^>]*>(.*?)<\/ol>/s.exec(INDEX)[1];
  const items = [...list.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1].replace(/&#39;/g, "'"));
  assert.deepEqual(items, exampleQuestions(DEFAULT_GEO).map((q) => q.text));
  for (const m of INDEX.matchAll(/<span data-geo-town>([^<]*)<\/span>/g)) assert.equal(m[1], DEFAULT_GEO.town);
  for (const m of INDEX.matchAll(/<span data-geo-state>([^<]*)<\/span>/g)) assert.equal(m[1], DEFAULT_GEO.state);
  assert.match(INDEX, /name="town"[^>]*placeholder="Massapequa"[^>]*data-geo-placeholder="town"/);
  assert.match(INDEX, /name="zip"[^>]*placeholder="11758"[^>]*data-geo-placeholder="zip"/);
  assert.match(INDEX, /name="state" type="hidden" value="NY" data-geo-value="state"/);
  assert.match(INDEX, /data-geo-hint hidden/);
});

// ---- HTMLRewriter (Miniflare) ----------------------------------------------------------------

// A tiny Worker that runs addGeoHandlers over the HTML it is sent, with the cf object it is given.
const HARNESS = `
import { addGeoHandlers, geoFromCf } from '../geo.js';
export default {
  async fetch(request) {
    const html = await request.text();
    const res = new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return addGeoHandlers(new HTMLRewriter(), geoFromCf(request.cf)).transform(res);
  },
};`;

let mf;
let miniflareError = null;
async function render(cf) {
  if (!mf && !miniflareError) {
    try {
      // Both ship with wrangler. Bundle the harness + geo.js into one module, then run it.
      const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
      const { build } = await import('esbuild');
      const out = await build({
        stdin: { contents: HARNESS, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' },
        bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent',
      });
      // Classic (v3/v4) options; Miniflare 5 takes them through its converter.
      const opts = { modules: true, script: out.outputFiles[0].text, compatibilityDate: '2026-09-01' };
      mf = new Miniflare(typeof convertV4MiniflareOptions === 'function' ? convertV4MiniflareOptions(opts) : opts);
      await mf.ready;
    } catch (e) {
      miniflareError = e;
    }
  }
  if (miniflareError) throw miniflareError;
  const res = await mf.dispatchFetch('http://example.test/', { method: 'POST', body: INDEX, cf });
  return res.text();
}

test.after(async () => { if (mf) await mf.dispose(); });

test('HTMLRewriter: US request shows the visitor\'s town everywhere', async () => {
  const html = await render(US);
  assert.match(html, /a plumber in <span data-geo-town>Hicksville<\/span>, <span data-geo-state>NY<\/span> gets these/);
  const list = /<ol[^>]*data-geo-questions="plumbing"[^>]*>(.*?)<\/ol>/s.exec(html)[1];
  assert.equal(list, exampleQuestions(geoFromCf(US)).map((q) => `<li>${q.text.replace(/'/g, '&#39;')}</li>`).join(''));
  assert.match(list, /What&#39;s the best plumber in Hicksville, NY\?/);
  assert.match(list, /near Plainview tonight/);
  assert.match(list, /Affordable plumber near 11801/);
  assert.match(html, /name="town"[^>]*placeholder="Hicksville"/);
  assert.match(html, /name="zip"[^>]*placeholder="11801"/);
  assert.match(html, /name="state" type="hidden" value="NY"/);
  assert.match(html, /<p class="form-note geo-hint" data-geo-hint>We guessed <span data-geo-town>Hicksville<\/span>/);
  assert.ok(!/Massapequa|11758/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'default town left in the page');
});

test('HTMLRewriter: another state sets the hidden state; no ZIP → town-based question', async () => {
  const html = await render({ country: 'US', city: 'Stamford', regionCode: 'CT', postalCode: '' });
  assert.match(html, /name="state" type="hidden" value="CT"/);
  assert.match(html, /name="zip"[^>]*placeholder="5 digits"/);
  assert.match(html, /Affordable plumber near Stamford CT/);
});

test('HTMLRewriter: non-US request gets the default page, hint stays hidden', async () => {
  const html = await render({ country: 'GB', city: 'London', regionCode: 'ENG', postalCode: 'SW1A' });
  assert.ok(!html.includes('London'));
  assert.match(html, /a plumber in <span data-geo-town>Massapequa<\/span>, <span data-geo-state>NY<\/span>/);
  assert.match(html, /What&#39;s the best plumber in Massapequa, NY\?/);
  assert.match(html, /data-geo-hint hidden/);
  assert.match(html, /name="state" type="hidden" value="NY"/);
});

test('HTMLRewriter: a malicious city string never reaches the page', async () => {
  const evil = '"><script>alert(1)</script>';
  const html = await render({ ...US, city: evil, postalCode: '"><b>' });
  assert.ok(!html.includes('alert(1)'));
  assert.match(html, /placeholder="Massapequa"/);
  assert.match(html, /data-geo-hint hidden/);
  // And a clean-but-odd city with an apostrophe is escaped in the attribute and the list.
  const odd = await render({ ...US, city: "Coeur d'Alene", regionCode: 'ID', postalCode: '83814' });
  assert.match(odd, /What&#39;s the best plumber in Coeur d&#39;Alene, ID\?/);
  assert.match(odd, /placeholder="Coeur d'Alene"/);
});
