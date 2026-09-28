// Credit alerts: billing errors from every provider are recognised, an engine is 'out' only until
// it answers again, budgets give 'low', and the owner gets one idempotent email per engine/state/day.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isBillingError, creditStatus, sendCreditAlerts, noteBillingError, billingEvents, errorPieces,
  parseBudget, isLow, alertEmails, alertKey, creditAlertEmail, DEFAULT_ALERT_EMAILS, engineOf,
} from '../alerts.js';
import { RESEND_URL } from '../email.js';
import { creditBanner } from '../../admin/page.js';

const NOW = new Date('2026-09-27T15:00:00Z');
const ENV = {
  RESEND_API_KEY: 're_test', SUPABASE_URL: 'https://db.example.com', SUPABASE_SERVICE_KEY: 'svc',
  GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a',
};
const GEMINI_402 = 'HTTP 402: Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.';

// Fake Supabase (table → rows, eq./in. filters, offset paging) + Resend + DataForSEO.
function fake(tables = {}, { dfsBalance = null } = {}) {
  const sent = [];
  const urls = [];
  const f = async (input, init = {}) => {
    const s = String(input);
    urls.push(s);
    if (s === RESEND_URL) {
      sent.push({ body: JSON.parse(init.body), headers: init.headers });
      return Response.json({ id: `em_${sent.length}` });
    }
    if (s.includes('dataforseo.com')) {
      return Response.json({ status_code: 20000, tasks: [{ result: [{ money: { balance: dfsBalance } }] }] });
    }
    const u = new URL(s);
    let rows = tables[u.pathname.split('/').pop()] || [];
    for (const [k, v] of u.searchParams) {
      if (v.startsWith('eq.')) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      if (v.startsWith('in.')) { const set = v.slice(4, -1).split(','); rows = rows.filter((r) => set.includes(String(r[k]))); }
      if (v.startsWith('gte.')) rows = rows.filter((r) => Date.parse(r[k]) >= Date.parse(v.slice(4)));
    }
    const off = Number(u.searchParams.get('offset') || 0);
    const lim = Number(u.searchParams.get('limit') || 1000);
    return Response.json(rows.slice(off, off + lim));
  };
  return { f, sent, urls };
}

const at = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

test('isBillingError: every provider\'s out-of-credit wording, not rate limits', () => {
  for (const s of [
    GEMINI_402,
    'HTTP 429: You exceeded your current quota, please check your plan and billing details. (insufficient_quota)',
    'HTTP 400: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
    'HTTP 401: insufficient credits',
    'DataForSEO 40210: Insufficient Funds.',
    'HTTP 402: Payment Required',
  ]) assert.equal(isBillingError(s), true, s);
  for (const s of ['', null, 'HTTP 429: Quota exceeded for metric requests per minute', 'timeout after 120000ms', 'HTTP 500: internal']) {
    assert.equal(isBillingError(s), false, String(s));
  }
});

test('helpers: budgets, low threshold, recipients, engine names, error pieces', () => {
  assert.deepEqual(parseBudget('20@2026-09-27'), { usd: 20, since: '2026-09-27' });
  assert.equal(parseBudget('20'), null);
  assert.equal(parseBudget('0@2026-09-27'), null);
  assert.equal(isLow(4.99, 10), true);
  assert.equal(isLow(6, 10), false);
  assert.equal(isLow(24, 100), true);
  assert.deepEqual(alertEmails({}), DEFAULT_ALERT_EMAILS);
  assert.deepEqual(alertEmails({ ALERT_EMAILS: 'A@x.com, b@y.com' }), ['a@x.com', 'b@y.com']);
  assert.equal(engineOf('anthropic'), 'claude');
  assert.equal(engineOf('OpenAI'), 'chatgpt');
  assert.deepEqual(errorPieces(`gemini: ${GEMINI_402} | chatgpt: timeout`, 'chatgpt').map((p) => p.engine), ['gemini', 'chatgpt']);
  assert.equal(alertKey('gemini', 'out', NOW, 'A@x.com'), 'credit-alert:gemini:out:2026-09-27:a@x.com');
});

test('billingEvents: live-preview rows, scan_raw and scans.errors', () => {
  const ev = billingEvents({
    usage: [{ provider: 'chatgpt', ok: true, error: `gemini: ${GEMINI_402}`, created_at: at(1) }],
    raw: [{ engine: 'claude', ok: false, error: 'HTTP 400: Your credit balance is too low', created_at: at(2) }],
    scans: [{ created_at: at(3), errors: [{ kind: 'engine', engine: 'perplexity', error: 'HTTP 402: Payment Required' }] }],
  });
  assert.ok(ev.gemini.lastBillingAt);
  assert.ok(ev.chatgpt.lastOkAt && !ev.chatgpt.lastBillingAt);
  assert.ok(ev.claude.lastBillingAt);
  assert.ok(ev.perplexity.lastBillingAt);
});

test('creditStatus: out from a recent billing error, recovered after a success, low from a budget, unknown otherwise', async () => {
  const { f } = fake({
    scan_usage: [
      { provider: 'chatgpt', ok: true, error: `gemini: ${GEMINI_402}`, created_at: at(1), cost_usd: 0.01 },
      { provider: 'anthropic', ok: false, error: 'HTTP 400: Your credit balance is too low', created_at: at(3), cost_usd: 0 },
      { provider: 'anthropic', ok: true, error: null, created_at: at(2), cost_usd: 0.5 },
      { provider: 'openai', ok: true, error: null, created_at: at(40), cost_usd: 16 },
    ],
    scan_raw: [{ engine: 'chatgpt', ok: true, error: null, created_at: at(30), cost_usd: 1.5 }],
    // Spend reads the billed view (Gemini's free searches taken off); the errors still come from scan_raw.
    v_scan_raw_billed: [{ engine: 'chatgpt', ok: true, error: null, created_at: at(30), cost_usd: 1.5 }],
    scans: [],
  });
  const env = { ...ENV, CREDIT_BUDGET_OPENAI: `20@${at(48).slice(0, 10)}` };
  const s = await creditStatus(env, { fetchImpl: f, now: NOW });
  const by = Object.fromEntries(s.map((x) => [x.engine, x]));
  assert.equal(by.gemini.state, 'out');
  assert.match(by.gemini.detail, /prepayment credits are depleted/);
  assert.equal(by.claude.state, 'unknown'); // recovered: a success after the billing error
  assert.match(by.claude.detail, /recovered/);
  assert.equal(by.chatgpt.state, 'low'); // $20 − $1.50 − $16.01 ≈ $2.49
  assert.equal(by.chatgpt.remainingUsd, 2.49);
  assert.equal(by.perplexity, undefined); // no key → not listed
});

test('creditStatus: DataForSEO balance, and a billing error older than 6 h is ignored', async () => {
  const env = { ...ENV, DATAFORSEO_LOGIN: 'l', DATAFORSEO_PASSWORD: 'p' };
  const { f } = fake({ scan_usage: [{ provider: 'gemini', ok: false, error: GEMINI_402, created_at: at(7) }], scan_raw: [], scans: [] }, { dfsBalance: 3.2 });
  const by = Object.fromEntries((await creditStatus(env, { fetchImpl: f, now: NOW })).map((x) => [x.engine, x]));
  assert.equal(by.google_ai_mode.state, 'low');
  assert.equal(by.google_ai_mode.remainingUsd, 3.2);
  assert.equal(by.gemini.state, 'unknown');
});

test('creditStatus never throws (Supabase down → nothing out)', async () => {
  const s = await creditStatus(ENV, { fetchImpl: async () => { throw new Error('down'); }, now: NOW });
  assert.ok(s.every((x) => x.state !== 'out'));
});

test('sendCreditAlerts: one email per recipient for each low/out engine, idempotent keys, transactional', async () => {
  const { f, sent } = fake({ scan_usage: [{ provider: 'gemini', ok: false, error: GEMINI_402, created_at: at(1) }], scan_raw: [], scans: [] });
  const r = await sendCreditAlerts(ENV, { fetchImpl: f, now: NOW });
  assert.equal(r.alerts.length, 1);
  assert.equal(r.alerts[0].sent, 2);
  assert.deepEqual(sent.map((m) => m.body.to[0]).sort(), [...DEFAULT_ALERT_EMAILS].sort());
  assert.equal(sent[0].headers['Idempotency-Key'], `credit-alert:gemini:out:2026-09-27:${sent[0].body.to[0]}`);
  assert.match(sent[0].body.subject, /Gemini is out of credits/);
  assert.match(sent[0].body.text, /aistudio\.google\.com/);
  assert.match(sent[0].body.text, /https:\/\/aifoundscore\.com\/admin/);
});

test('sendCreditAlerts never throws', async () => {
  const r = await sendCreditAlerts(ENV, { creditStatus: async () => { throw new Error('boom'); }, now: NOW });
  assert.equal(r.alerts.length, 0);
});

test('noteBillingError: emails at once for a billing error, nothing otherwise, memoised per isolate', async () => {
  const { f, sent } = fake();
  const none = await noteBillingError(ENV, 'gemini', 'HTTP 500: oops', { fetchImpl: f, now: NOW });
  assert.equal(none.alerted, false);
  assert.equal(sent.length, 0);
  const yes = await noteBillingError(ENV, 'anthropic', 'Your credit balance is too low', { fetchImpl: f, now: NOW });
  assert.equal(yes.alerted, true);
  assert.equal(sent.length, 2);
  assert.match(sent[0].body.subject, /Claude is out of credits/);
  const again = await noteBillingError(ENV, 'claude', 'Your credit balance is too low', { fetchImpl: f, now: NOW });
  assert.equal(again.alerted, false);
  assert.equal(sent.length, 2);
});

test('low email subject names what is left', () => {
  const m = creditAlertEmail(ENV, { engine: 'chatgpt', state: 'low', remainingUsd: 3.1, detail: 'x' });
  assert.equal(m.subject, 'ChatGPT credits are low: about $3.10 left');
  assert.match(m.text, /platform\.openai\.com/);
});

test('admin banner: red for out, amber for low, escaped, empty when fine', () => {
  const html = creditBanner([
    { engine: 'gemini', name: 'Gemini', state: 'out', detail: '<script>x</script>' },
    { engine: 'chatgpt', name: 'ChatGPT', state: 'low', detail: 'about $3 left' },
    { engine: 'claude', name: 'Claude', state: 'unknown', detail: 'n/a' },
  ]);
  assert.match(html, /credit-alert out/);
  assert.match(html, /credit-alert low/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Claude/);
  assert.equal(creditBanner([{ engine: 'x', state: 'ok' }]), '');
  assert.equal(creditBanner(undefined), '');
});

test('paid scan alert: every alert address, transactional, one per scan and stage; never throws', async () => {
  const { sendPaidScanAlert, paidScanAlertEmail } = await import('../alerts.js');
  const sent = [];
  const r = await sendPaidScanAlert({ ALERT_EMAILS: 'a@x.com, b@y.com' }, { token: 'tok_12345', stage: 'start', reason: 'no-engine', key: 'cs_1' }, {
    sendEmail: async (env, m) => { sent.push(m); return { ok: true }; },
  });
  assert.equal(r.sent, 2);
  assert.deepEqual(sent.map((m) => m.to), ['a@x.com', 'b@y.com']);
  assert.ok(sent.every((m) => m.transactional === true));
  assert.equal(sent[0].idempotencyKey, 'paid-scan-alert:start:cs_1:a@x.com');
  assert.match(sent[0].subject, /didn’t start/);
  assert.match(sent[0].text, /\/report\/tok_12345/);
  assert.match(paidScanAlertEmail({}, { token: 't', stage: 'scan', reason: '<b>x</b>' }).html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.deepEqual(await sendPaidScanAlert({}, { token: 't', stage: 'scan' }, { sendEmail: async () => { throw new Error('boom'); } }), { sent: 0 });
});
