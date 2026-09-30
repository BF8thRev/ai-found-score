// A fake for the follow-up funnel's database (supabase/v14_followups.sql) on top of fakeGmail: the
// v_followup_candidates view (follow-ups derived from the claimed rows, like the real view),
// outreach_templates, scan_results (reports), and the RPCs claim_followup_send (same refusals as the
// SQL: replied, unsubscribed, purchased, max 2, stage once), release_followup_send and
// mark_email_replied. Everything else goes to fakeGmail (Gmail, Google, claim_gmail_send, unsubscribes).
// Not a *.test.js file: imported by src/lib/test/followups.test.js and src/admin/test/followups.test.js.

import { fakeGmail } from './fake-gmail.js';

export const ROOT = 'Root_token_abcdefghij1';
export const BIZ = '22222222-2222-4222-8222-222222222222';
export const REPORT = 'rep_bluebird_1';
export const DAY = 24 * 3600 * 1000;
// Wednesday Sep 30 2026, 11:00 New York: inside the send window.
export const NOW = Date.parse('2026-09-30T15:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();

/** One first email (a v_followup_candidates row without `followups`). */
export function prospect(over = {}) {
  return {
    token: ROOT, business_id: BIZ, business: 'Bluebird Wash & Fold', town: 'Seaford', trade: 'laundromat', arm: 'email',
    campaign: 'exp002', email: 'owner@bluebird.example', report_token: REPORT, sent_at: iso(NOW - 10 * DAY),
    opened_at: null, clicked_at: null, replied_at: null, unsubscribed_at: null, purchased: false, ...over,
  };
}

export function fakeFollowups({ prospects = [], templates = [], reports = {}, rows = [], fail = [], claimDown = false, ...gmailOpts } = {}) {
  const g = fakeGmail(gmailOpts);
  const f = {
    g,
    prospects: prospects.map((p) => ({ ...p })),
    // Follow-up 'sent' rows: { token, parent_token, stage, sent_at, detail, hidden? } (hidden: in the
    // database but not yet in the view the runner read, i.e. a concurrent run claimed it).
    rows: rows.map((r) => ({ ...r })),
    templates: templates.map((t) => ({ ...t })),
    reports,
    claims: [],
    releases: [],
    patches: [],
    replied: [],
    writes: [],
    reads: [],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const view = () => f.prospects.map((p) => ({
    ...p,
    followups: f.rows.filter((r) => r.parent_token === p.token && !r.hidden)
      .map((r) => ({ stage: r.stage, token: r.token, sent_at: r.sent_at, note: r.detail || null })),
  }));
  f.impl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    if (url.hostname !== 'db.example') return g.impl(input, init);
    const table = url.pathname.replace('/rest/v1/', '');
    if (method === 'GET') f.reads.push(table);
    if (fail.includes(table)) return new Response('boom', { status: 500 });
    if (table === 'v_followup_candidates' && method === 'GET') return json(view());
    if (table === 'outreach_templates') {
      if (method === 'GET') return json(f.templates);
      if (method === 'POST') {
        const b = JSON.parse(init.body);
        f.writes.push({ table, method, body: b });
        f.templates = [...f.templates.filter((t) => t.key !== b.key), b];
        return new Response(null, { status: 201 });
      }
      if (method === 'DELETE') {
        const key = url.searchParams.get('key').replace(/^eq\./, '');
        f.writes.push({ table, method, key });
        f.templates = f.templates.filter((t) => t.key !== key);
        return new Response(null, { status: 204 });
      }
    }
    if (table === 'scan_results' && method === 'GET') {
      const tok = (url.searchParams.get('report_token') || '').replace(/^eq\./, '');
      return json(f.reports[tok] ? [{ report: f.reports[tok] }] : []);
    }
    if (table === 'rpc/claim_followup_send') {
      const b = JSON.parse(init.body);
      f.claims.push(b);
      if (claimDown) return new Response('down', { status: 503 });
      const p = f.prospects.find((x) => x.token === b.p_parent);
      if (!p) return json({ ok: false, reason: 'unknown prospect' });
      if (p.replied_at) return json({ ok: false, reason: 'replied' });
      if (p.unsubscribed_at) return json({ ok: false, reason: 'unsubscribed' });
      if (p.purchased !== false) return json({ ok: false, reason: 'purchased' });
      const mine = f.rows.filter((r) => r.parent_token === b.p_parent);
      if (mine.length >= 2) return json({ ok: false, reason: 'max', followups: mine.length });
      if (mine.some((r) => r.stage === b.p_stage)) return json({ ok: false, reason: 'already' });
      f.rows.push({ token: b.p_token, parent_token: b.p_parent, stage: b.p_stage, sent_at: iso(g.clock), detail: null, campaign: p.campaign, email: p.email, report_token: p.report_token });
      return json({ ok: true, followups: mine.length + 1 });
    }
    if (table === 'rpc/release_followup_send') {
      const b = JSON.parse(init.body);
      f.releases.push(b.p_token);
      const before = f.rows.length;
      f.rows = f.rows.filter((r) => r.token !== b.p_token);
      return json(f.rows.length < before);
    }
    if (table === 'rpc/mark_email_replied') {
      const b = JSON.parse(init.body);
      f.replied.push(b.p_root);
      const p = f.prospects.find((x) => x.token === b.p_root);
      if (!p) return json(false);
      p.replied_at = iso(g.clock);
      return json(true);
    }
    if (table === 'email_events' && method === 'PATCH') {
      const tok = url.searchParams.get('token').replace(/^eq\./, '');
      const b = JSON.parse(init.body);
      f.patches.push({ token: tok, ...b });
      const r = f.rows.find((x) => x.token === tok);
      if (r) Object.assign(r, b);
      return new Response(null, { status: 204 });
    }
    return g.impl(input, init);
  };
  return f;
}
