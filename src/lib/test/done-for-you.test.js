// The Fix Kit's "do it for me" button (src/lib/done-for-you.js, POST { help: true } on /api/fix-kit/<token>,
// the box on public/fix-kit.html): one click emails us the request; the owner gets a short "we got it".
// Through the real Worker with a fake Supabase and a fake Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { validateHelp, helpEmails } from '../done-for-you.js';
import { officeReport } from './fixtures/office-report.js';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkflowEntrypoint {}', shortCircuit: true };
    return next(spec, ctx);
  }`));

const TOKEN = 'dFyT0kenAbCdEfGh12Ij34';
const reply = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const ASK = { help: true, contact: 'Pat@HarborLanePR.example.com', phone: '(212) 555-0100', wants: ['website', 'google'], note: 'My nephew built the site and is gone.' };

async function withWorker(fn, { tiers = ['xray'], resendStatus = 200 } = {}) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname === 'api.resend.com') {
      sent.push({ ...JSON.parse(init.body), idem: init.headers['Idempotency-Key'] });
      return resendStatus === 200 ? reply({ id: `em_${sent.length}` }) : new Response('boom', { status: resendStatus });
    }
    if (u.pathname === '/rest/v1/scan_results') {
      const r = officeReport();
      r.business.website = 'https://www.harborlanepr.example.com';
      r.siteCheck.platform = { id: 'webflow', seo: null };
      return reply([{ version: 2, report: r, scanned_at: '2026-10-01T17:51:00Z' }]);
    }
    if (u.pathname === '/rest/v1/payments') return reply(tiers.map((tier) => ({ tier, amount_cents: 4900, addons: [], livemode: true, paid_at: '2026-10-01T18:00:00Z' })));
    return reply([]);
  };
  try {
    globalThis.HTMLRewriter ||= class { on() { return this; } onDocument() { return this; } transform(res) { return res; } };
    const { default: worker } = await import('../../worker.js');
    const env = {
      SUPABASE_URL: 'https://sb.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_KEY: 'service', RESEND_API_KEY: 're_test',
      ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) },
    };
    const call = (path, init) => worker.fetch(new Request(`https://aifoundscore.com${path}`, init), env, { waitUntil() {} });
    const help = async (over = {}, token = TOKEN) => {
      const { details } = await (await call(`/api/fix-kit/${token}`)).json();
      return call(`/api/fix-kit/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ASK, details, ...over }) });
    };
    await fn({ call, help, sent });
  } finally {
    globalThis.fetch = real;
  }
}

test('validateHelp: an email to write to and something they want; the rest is optional', () => {
  assert.equal(validateHelp(ASK).ok, true);
  assert.equal(validateHelp(ASK).help.contact, 'pat@harborlanepr.example.com');
  assert.deepEqual(validateHelp({ ...ASK, contact: 'nope', wants: [], phone: '12' }).errors.map((e) => e.field), ['helpContact', 'helpPhone', 'helpWants']);
  assert.deepEqual(validateHelp({ ...ASK, wants: ['website', 'website', 'bitcoin'] }).help.wants, ['website'], 'only what the form offers, once');
  assert.deepEqual(validateHelp({ ...ASK, note: 'x'.repeat(601) }).errors.map((e) => e.field), ['helpNote']);
  assert.equal(validateHelp(null).ok, false);
});

test('router: the button emails us the request with everything we need to answer, and tells the owner we got it', async () => {
  await withWorker(async ({ help, sent }) => {
    const res = await help();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, contact: 'pat@harborlanepr.example.com' });
    const toUs = sent.filter((m) => /^Done-for-you request: Harbor Lane PR$/.test(m.subject));
    assert.equal(toUs.length, 2, 'every alert address');
    assert.notEqual(toUs[0].to[0], toUs[1].to[0]);
    assert.notEqual(toUs[0].idem, toUs[1].idem, 'one send per address, not collapsed into one');
    const text = toUs[0].text;
    assert.match(text, /Reply to: pat@harborlanepr\.example\.com · phone \(212\) 555-0100/);
    assert.match(text, /They want help with: My website \(a Questions page and the details Google reads\); My Google Business Profile/);
    assert.match(text, /Their note: My nephew built the site and is gone\./);
    assert.match(text, /Website: https:\/\/www\.harborlanepr\.example\.com · built on Webflow/);
    assert.match(text, /Paid for: xray/);
    assert.match(text, new RegExp(`https://aifoundscore\\.com/fix-kit/${TOKEN}`));
    assert.match(text, new RegExp(`https://aifoundscore\\.com/report/${TOKEN}`));
    assert.match(text, /Kit is missing: Missing phone number; Missing services; \d+ FAQ answers? still need a sentence/);
    assert.match(text, /We have not asked them for any login/);
    // The owner: a short, no-promise confirmation, to the address they typed.
    const toOwner = sent.find((m) => m.to[0] === 'pat@harborlanepr.example.com');
    assert.equal(toOwner.subject, 'We got your request');
    assert.match(toOwner.text, /will reply to this address by email with what we would do and what it would cost/);
    assert.match(toOwner.text, /never ask for a password/);
    assert.doesNotMatch(toOwner.text, /\$|within \d|hours|guarantee/i, 'no price, no deadline, no promise');
    assert.equal(sent.length, 3);
  });
});

test('router: a request that is missing something sends nothing and says what; unpaid is refused; a sample sends nothing', async () => {
  await withWorker(async ({ help, sent }) => {
    const bad = await help({ contact: '', wants: [] });
    assert.equal(bad.status, 422);
    assert.deepEqual((await bad.json()).errors.map((e) => e.field), ['helpContact', 'helpWants']);
    assert.equal(sent.length, 0);
  });
  await withWorker(async ({ help, sent }) => {
    assert.equal((await help()).status, 402);
    assert.equal(sent.length, 0);
  }, { tiers: [] });
  await withWorker(async ({ call, sent }) => {
    const res = await call('/api/fix-kit/sample-001', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...ASK, details: { name: 'Harborview Plumbing', town: 'Massapequa', state: 'NY' } }) });
    assert.deepEqual(await res.json(), { ok: true, sample: true });
    assert.equal(sent.length, 0);
  });
});

test('router: if the email to us cannot be sent the owner is told to write to us, and is not told "we got it"', async () => {
  await withWorker(async ({ help, sent }) => {
    const res = await help();
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /Email hello@aifoundscore\.com/);
    assert.ok(!sent.some((m) => m.subject === 'We got your request'), 'no false confirmation');
  }, { resendStatus: 500 });
});

test('helpEmails: one request per token per day', () => {
  const base = { origin: 'https://aifoundscore.com', token: 't', tiers: ['xray'], details: { name: 'X', town: 'Y', state: 'NY' }, report: {}, kit: { missing: [], faq: { needs: 0 } }, help: validateHelp(ASK).help };
  const a = helpEmails({}, { ...base, date: new Date('2026-10-02T10:00:00Z') });
  const b = helpEmails({}, { ...base, date: new Date('2026-10-02T23:00:00Z') });
  const c = helpEmails({}, { ...base, date: new Date('2026-10-03T01:00:00Z') });
  assert.equal(a.toUs.idempotencyKey, b.toUs.idempotencyKey);
  assert.notEqual(a.toUs.idempotencyKey, c.toUs.idempotencyKey);
});

test('the kit page: three sections, the website jobs on their own, and the box that sends the request', () => {
  const html = readFileSync(new URL('../../../public/fix-kit.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../../../public/js/fix-kit.js', import.meta.url), 'utf8');
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('Do these yourself, today') < at('For whoever runs your website'));
  assert.ok(at('For whoever runs your website') < at('Nobody to do the website part? We can help.'));
  assert.ok(at('Nobody to do the website part? We can help.') < at('After it&rsquo;s live'));
  for (const hook of ['data-jobs-you', 'data-jobs-web', 'data-jobs-after', 'data-help-send', 'data-help-form']) assert.ok(html.includes(hook), hook);
  assert.match(html, /you don&rsquo;t owe anything unless you say yes in writing[^]*we never ask for a password here/);
  assert.match(js, /post\(\{ help: true, details: current, contact:/);
  assert.match(js, /j\.who === 'you' \? lists\.you : lists\.web/, 'the owner\'s jobs and the website jobs are drawn apart');
  assert.match(js, /lists\.after\.appendChild\(c\)/);
});

test('the kit page: section headings get real space above them, and the download box points to "do it for me"', async () => {
  const html = readFileSync(new URL('../../../public/fix-kit.html', import.meta.url), 'utf8');
  // `.fk h2 { margin: 0 ... }` outranks a plain `.fk-section` rule, so the headings sat flush on the card above.
  const rule = html.match(/\.fk h2\.fk-section\s*\{\s*margin:\s*(\d+)px/);
  assert.ok(rule, 'section headings need a rule at least as specific as `.fk h2`');
  assert.ok(Number(rule[1]) >= 40, `section heading top margin is ${rule[1]}px`);
  // The download box and the website section both link to the help box.
  const dl = html.slice(html.indexOf('id="fk-dl-h"'), html.indexOf('id="fk-needs"'));
  assert.match(dl, /href="#fk-help">We can do it for you</);
  assert.match(html, /Hand over the folder, or <a href="#fk-help">ask us to do it<\/a>/);
  assert.ok(html.includes('id="fk-help"'));
  // The sticky header (67px) would cover the box's heading when the link jumps to it.
  const land = html.match(/\.fk-box\[id\]\s*\{\s*scroll-margin-top:\s*(\d+)px/);
  assert.ok(land && Number(land[1]) >= 80, 'linked boxes land below the sticky header');
  // Served through the real router.
  await withWorker(async ({ call }) => {
    const res = await call(`/fix-kit/${TOKEN}`);
    assert.equal(res.status, 200);
  });
});

test('not paid: the Fix Kit answer names only the audit (Be the Answer is off sale)', async () => {
  await withWorker(async ({ call }) => {
    const res = await call(`/api/fix-kit/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true, details: { name: 'PR73' } }) });
    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.error, 'The Fix Kit comes with the AI Visibility Audit.');
  }, { tiers: [] });
  const html = readFileSync(new URL('../../../public/fix-kit.html', import.meta.url), 'utf8');
  const unpaid = html.slice(html.indexOf('data-state="unpaid"'), html.indexOf('data-state="error"'));
  assert.doesNotMatch(unpaid, /Be the Answer/);
});
