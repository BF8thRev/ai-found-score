// /admin "Follow-ups" through the real router (handleAdminRequest): the section on the page, "Mark
// replied", saving / resetting the copy (surveillance phrasing refused), "Run follow-ups now", and the
// three routes gated + CSRF-checked like the rest. Supabase, Google and Gmail are fakes: nothing is sent.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleAdminRequest } from '../routes.js';
import { signSession, SESSION_COOKIE } from '../session.js';
import { clearTokenCache } from '../../lib/gmail-sender.js';
import { GMAIL_ENV, withFetch } from '../../lib/test/fake-gmail.js';
import { fakeFollowups, prospect, ROOT, REPORT, DAY, NOW, iso } from '../../lib/test/fake-followups.js';

const SECRET = 'test-admin-token-1234567890';
const ORIGIN = 'https://aifoundscore.com';
const BEARER = { Authorization: `Bearer ${SECRET}` };
const FORM_H = { 'Content-Type': 'application/x-www-form-urlencoded' };
const ENV = { ...GMAIL_ENV, ADMIN_TOKEN: SECRET };
const ON = { ...ENV, GMAIL_OUTREACH: 'on', GMAIL_FOLLOWUPS: 'on' };
const REPORT_JSON = JSON.parse(readFileSync(new URL('../../../outreach/test/fixtures/fictional-laundromat.json', import.meta.url), 'utf8'));
const call = (env, path, { method = 'GET', headers = {}, body } = {}) => {
  const url = new URL(path, ORIGIN);
  return handleAdminRequest(new Request(url, { method, headers, body, redirect: 'manual' }), url, env);
};
const post = (path, fields, env = ENV) => call(env, path, { method: 'POST', headers: { ...BEARER, ...FORM_H }, body: new URLSearchParams(fields).toString() });
const loc = (r) => { const u = new URL(r.headers.get('Location')); return u.pathname + u.search + u.hash; };
const section = (html) => html.slice(html.indexOf('<section id="followups">'), html.indexOf('</section>', html.indexOf('<section id="followups">')));
const clicked = (over = {}) => prospect({ opened_at: iso(NOW - 3.5 * DAY), clicked_at: iso(NOW - 3 * DAY), ...over });
const page = async (env = ENV, path = '/admin') => section(await (await call(env, path, { headers: BEARER })).text());

test.beforeEach(() => clearTokenCache());
// Router calls use the real clock: pin it to a weekday morning in New York (NOW) so the queue and the
// send window don't depend on when the tests run.
test.beforeEach(() => mock.timers.enable({ apis: ['Date'], now: NOW }));
test.afterEach(() => mock.timers.reset());

test('route: the page shows Follow-ups: switches off, the per-stage funnel, each prospect with what is next, the copy', async () => {
  const f = fakeFollowups({ prospects: [clicked(), prospect({ token: 'Replied_prospect_1234', business: 'Harbor Co', replied_at: iso(NOW - DAY) })] });
  f.funnel = [{ campaign: 'exp002', followup_stage: 'initial', sent: 40, opened: 20, clicked: 8, replied: 2, paid: 1, unsubscribed: 1 },
    { campaign: 'exp002', followup_stage: 'followup1', sent: 5, opened: 3, clicked: 2, replied: 1, paid: 0, unsubscribed: 0 }];
  const orig = f.impl;
  f.impl = async (input, init) => (String(input).includes('/v_followup_funnel') ? Response.json(f.funnel) : orig(input, init));
  await withFetch(f, async () => {
    const r = await call(ENV, '/admin', { headers: BEARER });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<a href="#followups">Follow-ups<\/a>/);
    const s = section(html);
    assert.match(s, /<b>Follow-ups:<\/b> <span class="badge t-neutral">Off<\/span>/);
    assert.match(s, /GMAIL_OUTREACH\):<\/b> <span class="badge t-neutral">Off/);
    // Funnel: every stage in order, zeros where nothing went out, % of that email's sends.
    assert.match(s, /<b>First email<\/b><\/td><td class="n">40<\/td><td class="n">20<div class="small">50%<\/div>/);
    assert.match(s, /<b>Bump<\/b><\/td><td class="n">0<\/td>/);
    assert.match(s, /<b>Follow-up 1<\/b><\/td><td class="n">5<\/td><td class="n">3<div class="small">60%/);
    assert.match(s, /Replied/);
    // The queue: the clicked prospect is due, with a Mark replied button for its token; the replied one isn't.
    assert.match(s, /Follow-up 1 due now/);
    assert.match(s, /Due now:<\/b> 1/);
    assert.ok(s.includes(`<input type="hidden" name="token" value="${ROOT}">`));
    assert.match(s, /Replied: no more follow-ups/);
    // The copy editor: 6 templates, all placeholder, each posting to the template route.
    assert.equal((s.match(/action="\/admin\/followups\/template"/g) || []).length, 6);
    assert.equal((s.match(/badge t-neutral">placeholder/g) || []).length, 6);
    assert.match(s, /action="\/admin\/followups\/run"/);
  });
});

test('route: Mark replied → mark_email_replied for that prospect → no longer due', async () => {
  const f = fakeFollowups({ prospects: [clicked()] });
  await withFetch(f, async () => {
    const r = await post('/admin/followups/replied', { token: ROOT });
    assert.equal(r.status, 303);
    assert.equal(loc(r), '/admin?followups=replied#followups');
    assert.deepEqual(f.replied, [ROOT]);
    const s = await page(ENV, '/admin?followups=replied');
    assert.match(s, /Marked replied\. No more follow-ups go to them\./);
    assert.match(s, /Replied: no more follow-ups/);
    assert.doesNotMatch(s, /Follow-up 1 due now/);
    assert.match(s, /Due now:<\/b> 0/);
    // And a run sends it nothing.
    const run = await post('/admin/followups/run', {}, ON);
    assert.equal(loc(run), '/admin?followups=ran&sent=0&due=0#followups');
    assert.equal(f.g.gmail.length, 0);
  });
});

test('route: Mark replied refuses a bad or unknown prospect', async () => {
  const f = fakeFollowups({ prospects: [clicked()] });
  await withFetch(f, async () => {
    const bad = await post('/admin/followups/replied', { token: 'x' });
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /Bad prospect/);
    const unknown = await post('/admin/followups/replied', { token: 'Unknown_prospect_12345' });
    assert.equal(unknown.status, 422);
    assert.match(await unknown.text(), /isn’t in the database/);
  });
});

test('route: save copy → outreach_templates row → the page shows it saved; reset drops it', async () => {
  const f = fakeFollowups({ prospects: [] });
  await withFetch(f, async () => {
    const r = await post('/admin/followups/template', { stage: 'followup1', variant: 'gap', subject: '{competitor} in {town}', body: 'Winning-arm copy for {business}.\r\n\r\nReport: {link}' });
    assert.equal(r.status, 303);
    assert.equal(loc(r), '/admin?followups=saved#followups');
    assert.equal(f.writes.length, 1);
    assert.deepEqual({ key: f.writes[0].body.key, subject: f.writes[0].body.subject, body: f.writes[0].body.body },
      { key: 'followup1.gap', subject: '{competitor} in {town}', body: 'Winning-arm copy for {business}.\n\nReport: {link}' });
    const s = await page(ENV, '/admin?followups=saved');
    assert.match(s, /Copy saved\./);
    assert.match(s, /value="\{competitor\} in \{town\}"/);
    assert.equal((s.match(/badge t-good">saved/g) || []).length, 1);
    const reset = await post('/admin/followups/template', { stage: 'followup1', variant: 'gap', reset: '1' });
    assert.equal(loc(reset), '/admin?followups=reset#followups');
    assert.deepEqual(f.writes[1], { table: 'outreach_templates', method: 'DELETE', key: 'followup1.gap' });
    assert.equal(f.templates.length, 0);
  });
});

test('route: saving copy with surveillance phrasing (or gap slots in the generic copy) is refused; nothing written', async () => {
  const f = fakeFollowups({ prospects: [] });
  await withFetch(f, async () => {
    const cases = [
      [{ stage: 'bump', variant: 'generic', subject: 'Hi', body: 'Saw you checked out your report: {link}' }, /“Saw you” in the body/],
      [{ stage: 'followup2', variant: 'gap', subject: 'Noticed you were busy', body: '{link}' }, /“Noticed you” in the subject/],
      [{ stage: 'followup1', variant: 'generic', subject: 'Hi', body: 'Thanks for checking. You checked out {link}' }, /“checked out”/],
      [{ stage: 'followup1', variant: 'generic', subject: 'Hi', body: '{competitor} is ahead: {link}' }, /only the gap version/],
      [{ stage: 'nope', variant: 'gap', subject: 'Hi', body: '{link}' }, /Unknown template/],
    ];
    for (const [fields, re] of cases) {
      const r = await post('/admin/followups/template', fields);
      assert.equal(r.status, 422, JSON.stringify(fields));
      const s = section(await r.text());
      assert.match(s, /Not saved\./);
      assert.match(s, re);
    }
    assert.equal(f.writes.length, 0);
  });
});

test('route: Run follow-ups now sends what is due (one Gmail message, linked to the prospect) and says so', async () => {
  const f = fakeFollowups({ prospects: [clicked()], reports: { [REPORT]: REPORT_JSON } });
  await withFetch(f, async () => {
    const r = await post('/admin/followups/run', {}, ON);
    assert.equal(r.status, 303);
    assert.equal(loc(r), '/admin?followups=ran&sent=1&due=1#followups');
    assert.equal(f.g.gmail.length, 1);
    assert.equal(f.claims[0].p_parent, ROOT);
    assert.equal(f.g.sends[0].token, f.claims[0].p_token);
    const s = await page(ON, '/admin?followups=ran&sent=1&due=1');
    assert.match(s, /Follow-ups sent: 1 of 1 due\./);
    assert.match(s, /<b>Follow-ups:<\/b> <span class="badge t-warn">On/);
    assert.match(s, /Follow-up 1 [A-Z][a-z]{2} \d+/, 'the queue lists the follow-up sent');
  });
});

test('route: Run follow-ups now while off, or outside hours → nothing sent, and why', async () => {
  const f = fakeFollowups({ prospects: [clicked()], reports: { [REPORT]: REPORT_JSON } });
  await withFetch(f, async () => {
    const off = await post('/admin/followups/run', {});
    assert.equal(loc(off), '/admin?followups=skipped&why=followups%20off#followups');
    assert.match(await page(ENV, loc(off)), /Nothing sent: follow-ups are off \(GMAIL_FOLLOWUPS\)\./);
    mock.timers.setTime(Date.parse('2026-10-03T15:00:00Z')); // Saturday
    const sat = await post('/admin/followups/run', {}, ON);
    assert.equal(loc(sat), '/admin?followups=skipped&why=outside%20hours#followups');
    assert.match(await page(ON, loc(sat)), /only go out on weekdays, 9am–5pm New York time/);
    assert.equal(f.claims.length + f.g.gmail.length, 0);
  });
});

test('route: a failed run (candidates unreadable) says nothing was sent', async () => {
  const f = fakeFollowups({ prospects: [clicked()], fail: ['v_followup_candidates'] });
  await withFetch(f, async () => {
    const r = await post('/admin/followups/run', {}, ON);
    assert.equal(r.status, 500);
    assert.match(section(await r.text()), /Nothing sent: v_followup_candidates: HTTP 500/);
    assert.equal(f.g.gmail.length, 0);
  });
});

test('route: the Follow-ups routes are gated and CSRF-checked like the rest', async () => {
  const f = fakeFollowups({ prospects: [clicked()], reports: { [REPORT]: REPORT_JSON } });
  await withFetch(f, async () => {
    const cookie = `${SESSION_COOKIE}=${await signSession(SECRET)}`;
    for (const path of ['/admin/followups/run', '/admin/followups/replied', '/admin/followups/template']) {
      const body = new URLSearchParams({ token: ROOT, stage: 'bump', variant: 'generic', subject: 'S', body: '{link}' }).toString();
      assert.equal((await call({ ...ON, ADMIN_TOKEN: ' ' }, path, { method: 'POST', headers: FORM_H, body })).status, 404, `${path}: no ADMIN_TOKEN`);
      const anon = await call(ON, path, { method: 'POST', headers: { ...FORM_H, Origin: ORIGIN }, body });
      assert.equal(anon.status, 303);
      assert.equal(loc(anon), '/admin', `${path}: to the sign-in page`);
      const csrf = await call(ON, path, { method: 'POST', headers: { ...FORM_H, Cookie: cookie, Origin: 'https://evil.example' }, body });
      assert.equal(csrf.status, 403, `${path}: CSRF`);
      const get = await call(ON, path, { headers: BEARER });
      assert.equal(get.status, 303, `${path}: GET goes back to the page`);
      assert.equal(loc(get), '/admin#followups');
    }
    assert.equal(f.claims.length + f.g.gmail.length + f.replied.length + f.writes.length, 0);
    // With a signed-in cookie and our own Origin, the form works (what the browser does).
    const ok = await call(ON, '/admin/followups/replied', { method: 'POST', headers: { ...FORM_H, Cookie: cookie, Origin: ORIGIN }, body: `token=${ROOT}` });
    assert.equal(ok.status, 303);
    assert.deepEqual(f.replied, [ROOT]);
  });
});
