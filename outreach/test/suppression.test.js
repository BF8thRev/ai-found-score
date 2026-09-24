import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSuppressed } from '../suppression.js';

const env = { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_SERVICE_KEY: ' sb_secret_test \n' };

// Mock Supabase REST: report_links and unsubscribes tables in memory.
function mockFetch({ links = [], unsubs = [], fail = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const u = new URL(url);
    const table = u.pathname.split('/').pop();
    if (fail === table) return new Response('boom', { status: 500 });
    const p = u.searchParams;
    let rows = [];
    if (table === 'report_links') {
      const tok = p.get('report_token');
      const biz = p.get('business_id');
      rows = links.filter((l) => (tok ? `eq.${l.report_token}` === tok : true) && (biz ? `eq.${l.business_id}` === biz : true));
    } else if (table === 'unsubscribes') {
      const or = p.get('or'); // (email.ilike."x",report_token.in.("a","b"))
      const emailM = /email\.ilike\."((?:[^"\\]|\\.)*)"/.exec(or);
      const tokM = /report_token\.in\.\(([^)]*)\)/.exec(or);
      const email = emailM ? emailM[1].replace(/\\(.)/g, '$1').toLowerCase() : null;
      const toks = tokM ? tokM[1].split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
      rows = unsubs.filter((r) => (email && r.email && r.email.toLowerCase() === email) || (r.report_token && toks.includes(r.report_token)));
    }
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('suppressed by email, case-insensitive', async () => {
  const f = mockFetch({ unsubs: [{ email: 'Owner@Example.com' }] });
  assert.equal(await isSuppressed(env, { email: 'owner@example.com' }, f), true);
  // service key sent trimmed as apikey + bearer, base URL without trailing slash
  const { url, init } = f.calls[0];
  assert.ok(url.startsWith('https://example.supabase.co/rest/v1/unsubscribes?'));
  assert.equal(init.headers.apikey, 'sb_secret_test');
  assert.equal(init.headers.Authorization, 'Bearer sb_secret_test');
});

test('not suppressed when nothing matches', async () => {
  const f = mockFetch({ links: [{ report_token: 't1', business_id: 'b1' }], unsubs: [{ email: 'someone@else.com' }] });
  assert.equal(await isSuppressed(env, { email: 'owner@example.com', reportToken: 't1' }, f), false);
});

test('a token unsubscribe suppresses the whole business (other tokens, mail and email)', async () => {
  const links = [
    { report_token: 'mail_tok', business_id: 'b1' },
    { report_token: 'email_tok', business_id: 'b1' },
    { report_token: 'other_biz', business_id: 'b2' },
  ];
  const f = mockFetch({ links, unsubs: [{ report_token: 'mail_tok' }] });
  assert.equal(await isSuppressed(env, { reportToken: 'email_tok' }, f), true);
  assert.equal(await isSuppressed(env, { businessId: 'b1' }, mockFetch({ links, unsubs: [{ report_token: 'mail_tok' }] })), true);
  assert.equal(await isSuppressed(env, { reportToken: 'other_biz' }, mockFetch({ links, unsubs: [{ report_token: 'mail_tok' }] })), false);
});

test('email wildcards are escaped: "_" does not match any character', async () => {
  const f = mockFetch({ unsubs: [{ email: 'aXb@example.com' }] });
  assert.equal(await isSuppressed(env, { email: 'a_b@example.com' }, f), false);
  // ilike escape "\_", with the backslash doubled inside a PostgREST quoted value
  assert.ok(decodeURIComponent(f.calls[0].url).includes('email.ilike."a\\\\_b@example.com"'));
});

test('fails closed: lookup error or missing config throws', async () => {
  await assert.rejects(isSuppressed(env, { email: 'a@b.co' }, mockFetch({ fail: 'unsubscribes' })), /500/);
  await assert.rejects(isSuppressed({ SUPABASE_URL: 'https://x' }, { email: 'a@b.co' }, mockFetch()), /SUPABASE_SERVICE_KEY/);
  await assert.rejects(isSuppressed(env, {}, mockFetch()), /needs an email/);
});
