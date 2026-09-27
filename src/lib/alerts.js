// src/lib/alerts.js — email the owner when an AI engine's credits are running low or are out.
//
// Why: on Sep 27 2026 Gemini's prepaid credits ran out (HTTP 402 "Your prepayment credits are
// depleted") and nobody knew: live answers failed and paid scans quietly dropped an engine.
//
//   creditStatus(env)          → one line per engine with a key: 'ok' | 'low' | 'out' | 'unknown'
//   sendCreditAlerts(env)      the cron (worker.js scheduled()): emails every 'low' / 'out' engine
//   noteBillingError(env, engine, errorText)
//                              called the moment a live call fails; a billing error emails 'out' now
//
// 'out'  = a billing/credits error in the last 6 hours (scan_usage.error, scan_raw.error,
//          scans.errors) with no successful call from that engine after it.
// 'low'  = DataForSEO: its real balance (GET /v3/appendix/user_data) is under $5.
//          Everyone else has no balance API, so the owner can set a budget var per engine:
//          CREDIT_BUDGET_GEMINI="20@2026-09-27" means $20 loaded on that date; remaining = $20 minus
//          what we logged spending with that provider since. Low when remaining < max($5, 25%).
//          No budget var → 'unknown' (shown on /admin, never emailed).
//
//   ALERT_EMAILS   comma-separated recipients (wrangler.jsonc vars; DEFAULT_ALERT_EMAILS otherwise).
//
// Every email carries an Idempotency-Key credit-alert:<engine>:<state>:<YYYY-MM-DD>:<address>, and
// Resend keeps a key for 24 h, so a half-hourly cron sends at most one per engine/state/day/address.
// (The address is part of the key because Resend rejects the same key with a different body.)
// Nothing here throws: alerts are never the reason a request or a cron run fails.

import { resolveKeys, enginesConfigured, ENGINE_IDS, ENGINE_NAMES } from '../../scanner/config.js';
import { BILLING_ERROR_RE } from '../../scanner/engines/_common.js';
import { ping as dataforseoPing } from '../../scanner/engines/google_ai_mode.js';
import { sendEmail, siteUrl } from './email.js';

export const DEFAULT_ALERT_EMAILS = ['bryan.fields@8threv.com', 'bryan@getaifoundscore.com'];
export const OUT_WINDOW_MS = 6 * 60 * 60 * 1000;
export const LOW_FLOOR_USD = 5;
export const LOW_SHARE = 0.25;

// Refusals the shared BILLING_ERROR_RE (scanner/engines/_common.js) doesn't already cover:
// Anthropic "Your credit balance is too low", OpenAI "You exceeded your current quota",
// Perplexity "insufficient credits"/"Payment Required", DataForSEO 40200 / 40210 "Insufficient Funds".
// Deliberately NOT a bare "quota exceeded": Gemini says that for per-minute rate limits (HTTP 429).
const EXTRA_BILLING_RE = /credit balance is too low|exceeded your current quota|insufficient[ _](credits?|funds|balance)|payment required|\b402(00|10)\b|out of credits/i;

/** True for out-of-credit / billing refusals from any provider we use. Cheap; never throws. */
export function isBillingError(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return BILLING_ERROR_RE.test(s) || EXTRA_BILLING_RE.test(s);
}

// Each engine and the provider account that pays for it. `providers` = the scan_usage.provider
// values billed to that account (live previews and pings write the engine id; the extractor writes
// 'anthropic', which is the same Anthropic account as the Claude engine).
export const ACCOUNTS = {
  chatgpt: { providers: ['chatgpt', 'openai'], budgetVars: ['CREDIT_BUDGET_OPENAI', 'CREDIT_BUDGET_CHATGPT'], company: 'OpenAI', topUp: 'https://platform.openai.com/settings/organization/billing' },
  gemini: { providers: ['gemini', 'google'], budgetVars: ['CREDIT_BUDGET_GEMINI'], company: 'Google AI Studio', topUp: 'https://aistudio.google.com/ (Billing / plan)' },
  claude: { providers: ['claude', 'anthropic'], budgetVars: ['CREDIT_BUDGET_ANTHROPIC', 'CREDIT_BUDGET_CLAUDE'], company: 'Anthropic', topUp: 'https://console.anthropic.com/settings/billing' },
  perplexity: { providers: ['perplexity'], budgetVars: ['CREDIT_BUDGET_PERPLEXITY'], company: 'Perplexity', topUp: 'https://www.perplexity.ai/account/api/billing' },
  google_ai_mode: { providers: ['google_ai_mode', 'dataforseo'], budgetVars: [], company: 'DataForSEO', topUp: 'https://app.dataforseo.com/ (Billing / Add funds)' },
};

const ALIASES = { openai: 'chatgpt', gpt: 'chatgpt', anthropic: 'claude', extract: 'claude', google: 'gemini', dataforseo: 'google_ai_mode', pplx: 'perplexity' };

/** 'OpenAI' / 'anthropic' / 'extract' / 'gemini' → the engine id ('chatgpt', 'claude', …), or null. */
export function engineOf(name) {
  const s = String(name || '').trim().toLowerCase();
  if (ACCOUNTS[s]) return s;
  return ALIASES[s] || null;
}

const engineLabel = (e) => ENGINE_NAMES[e] || e;

/** ALERT_EMAILS ("a@x.com, b@y.com") → ['a@x.com', 'b@y.com']; the defaults when unset/empty. */
export function alertEmails(env) {
  const list = String(env?.ALERT_EMAILS || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'));
  return list.length ? [...new Set(list)] : [...DEFAULT_ALERT_EMAILS];
}

/** "20@2026-09-27" → { usd: 20, since: '2026-09-27' }; anything else → null. */
export function parseBudget(v) {
  const m = /^\s*\$?(\d+(?:\.\d+)?)\s*@\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const usd = Number(m[1]);
  if (!(usd > 0) || Number.isNaN(Date.parse(`${m[2]}T00:00:00Z`))) return null;
  return { usd, since: m[2] };
}

/** The budget var for an engine (first alias that parses), or null. */
export function budgetFor(env, engine) {
  for (const name of ACCOUNTS[engine]?.budgetVars || []) {
    const b = parseBudget(env?.[name]);
    if (b) return { ...b, varName: name };
  }
  return null;
}

/** Low when what's left is under max($5, 25% of what was loaded). */
export function isLow(remainingUsd, budgetUsd = 0) {
  return Number(remainingUsd) < Math.max(LOW_FLOOR_USD, LOW_SHARE * (Number(budgetUsd) || 0));
}

const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
const ts = (v) => { const t = Date.parse(v || ''); return Number.isNaN(t) ? 0 : t; };

/**
 * Split one stored error into (engine, text) pieces. A live preview stores every engine it tried as
 * "gemini: HTTP 402 … | chatgpt: …" under the provider that answered last, so each piece names its
 * own engine; a piece without a known engine prefix belongs to `fallbackEngine`.
 */
export function errorPieces(text, fallbackEngine = null) {
  return String(text || '').split(/\s\|\s/).map((piece) => {
    const m = /^\s*([a-z_]+)\s*:\s*/i.exec(piece);
    const e = m ? engineOf(m[1]) : null;
    return { engine: e || fallbackEngine, text: e ? piece.slice(m[0].length) : piece };
  }).filter((p) => p.engine && p.text);
}

/**
 * Pure: the latest billing error and the latest success per engine, from rows already read.
 *   usage: scan_usage rows { provider, ok, error, created_at }
 *   raw:   scan_raw rows   { engine, ok, error, created_at }
 *   scans: scans rows      { errors: [...], finished_at, created_at }
 * → { [engine]: { lastBillingAt, lastBillingError, lastOkAt } }
 */
export function billingEvents({ usage = [], raw = [], scans = [] } = {}) {
  const out = {};
  const slot = (e) => (out[e] ||= { lastBillingAt: 0, lastBillingError: null, lastOkAt: 0 });
  const billing = (e, at, text) => {
    if (!e || !isBillingError(text)) return;
    const s = slot(e);
    if (at >= s.lastBillingAt) { s.lastBillingAt = at; s.lastBillingError = String(text).slice(0, 300); }
  };
  const success = (e, at) => { if (e) { const s = slot(e); if (at > s.lastOkAt) s.lastOkAt = at; } };

  for (const r of Array.isArray(usage) ? usage : []) {
    const at = ts(r.created_at);
    const e = engineOf(r.provider);
    if (r.ok) success(e, at);
    for (const p of errorPieces(r.error, e)) billing(p.engine, at, p.text);
  }
  for (const r of Array.isArray(raw) ? raw : []) {
    const at = ts(r.created_at || r.asked_at);
    const e = engineOf(r.engine);
    if (r.ok) success(e, at);
    else billing(e, at, r.error);
  }
  for (const s of Array.isArray(scans) ? scans : []) {
    const at = ts(s.finished_at || s.created_at);
    for (const item of Array.isArray(s.errors) ? s.errors : []) {
      if (item && typeof item === 'object') {
        const e = engineOf(item.engine) || (item.kind === 'extract' ? 'claude' : null);
        if (e) billing(e, at, item.error);
        else for (const p of errorPieces(item.error)) billing(p.engine, at, p.text);
      } else {
        for (const p of errorPieces(item)) billing(p.engine, at, p.text);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Supabase reads (service key; same REST pattern as live-preview.js readTodayUsage)
// ---------------------------------------------------------------------------

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return { base: `${k.supabaseUrl}/rest/v1`, headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}` } };
}

async function readRows(fetchImpl, s, path) {
  const res = await fetchImpl(`${s.base}/${path}`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${path.split('?')[0]} read failed: HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/** Every row of a query, 1000 at a time (Supabase caps a response at 1000 rows). */
async function readAll(fetchImpl, s, path, { pageSize = 1000, maxPages = 50 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page++) {
    const rows = await readRows(fetchImpl, s, `${path}&limit=${pageSize}&offset=${page * pageSize}`);
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

const sumCost = (rows) => Math.round(rows.reduce((t, r) => t + (Number(r.cost_usd) || 0), 0) * 1e6) / 1e6;

/** What we logged spending on an engine's account since a date (scan_raw + scan_usage). */
export async function spentSince(env, engine, sinceDay, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supa(env);
  if (!s) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY not set');
  const since = encodeURIComponent(`${sinceDay}T00:00:00Z`);
  const providers = ACCOUNTS[engine].providers.join(',');
  const [raw, usage] = await Promise.all([
    readAll(fetchImpl, s, `scan_raw?engine=eq.${engine}&created_at=gte.${since}&select=cost_usd&order=created_at.asc`),
    readAll(fetchImpl, s, `scan_usage?provider=in.(${providers})&created_at=gte.${since}&select=cost_usd&order=created_at.asc`),
  ]);
  return Math.round((sumCost(raw) + sumCost(usage)) * 1e6) / 1e6;
}

/** The last 6 hours of calls and errors, for billingEvents(). Missing tables → empty lists. */
async function readRecent(env, fetchImpl, now) {
  const s = supa(env);
  if (!s) return { usage: [], raw: [], scans: [], error: 'SUPABASE_URL / SUPABASE_SERVICE_KEY not set' };
  const since = encodeURIComponent(new Date(now.getTime() - OUT_WINDOW_MS).toISOString());
  const settled = await Promise.allSettled([
    readAll(fetchImpl, s, `scan_usage?created_at=gte.${since}&select=provider,ok,error,created_at&order=created_at.asc`),
    readAll(fetchImpl, s, `scan_raw?created_at=gte.${since}&select=engine,ok,error,created_at&order=created_at.asc`),
    readRows(fetchImpl, s, `scans?created_at=gte.${since}&select=errors,created_at,finished_at&order=created_at.desc&limit=200`),
  ]);
  const val = (i) => (settled[i].status === 'fulfilled' ? settled[i].value : []);
  const failed = settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason).slice(0, 160));
  return { usage: val(0), raw: val(1), scans: val(2), error: failed.length ? failed.join('; ') : null };
}

// ---------------------------------------------------------------------------
// creditStatus
// ---------------------------------------------------------------------------

/**
 * One line per engine that has a key:
 *   { engine, name, state: 'ok'|'low'|'out'|'unknown', detail, remainingUsd?, lastErrorAt? }
 * deps: { fetchImpl, now: Date, dataforseoBalance: async (env) => number|null }. Never throws.
 */
export async function creditStatus(env, deps = {}) {
  try {
    const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
    const now = deps.now || new Date();
    const configured = enginesConfigured(env);
    const engines = ENGINE_IDS.filter((e) => configured[e] && ACCOUNTS[e]);
    if (!engines.length) return [];

    const recent = await readRecent(env, fetchImpl, now);
    const events = billingEvents(recent);

    return await Promise.all(engines.map(async (engine) => {
      const base = { engine, name: engineLabel(engine) };
      try {
        const ev = events[engine];
        if (ev && ev.lastBillingAt && ev.lastBillingAt > ev.lastOkAt) {
          return {
            ...base, state: 'out', lastErrorAt: new Date(ev.lastBillingAt).toISOString(),
            detail: `Out of credits: billing error at ${new Date(ev.lastBillingAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, no successful call since. "${ev.lastBillingError}"`,
          };
        }
        const recovered = ev && ev.lastBillingAt ? ' (recovered from a billing error in the last 6 h)' : '';

        if (engine === 'google_ai_mode') {
          const balance = await (deps.dataforseoBalance || ((e) => dataforseoBalance(e, { fetchImpl })))(env);
          if (balance == null) return { ...base, state: 'unknown', detail: `DataForSEO balance could not be read${recovered}.` };
          if (balance <= 0) return { ...base, state: 'out', remainingUsd: balance, detail: `DataForSEO balance is ${money(balance)}.` };
          if (isLow(balance)) return { ...base, state: 'low', remainingUsd: balance, detail: `DataForSEO balance is ${money(balance)} (low under ${money(LOW_FLOOR_USD)}).` };
          return { ...base, state: 'ok', remainingUsd: balance, detail: `DataForSEO balance ${money(balance)}${recovered}.` };
        }

        const budget = budgetFor(env, engine);
        if (!budget) {
          return { ...base, state: 'unknown', detail: `No balance API. Set ${ACCOUNTS[engine].budgetVars[0]}="<usd>@<YYYY-MM-DD>" to get low-credit warnings${recovered}.` };
        }
        const spent = await (deps.spentSince || ((e, en, d) => spentSince(e, en, d, { fetchImpl })))(env, engine, budget.since);
        const remaining = Math.round((budget.usd - spent) * 100) / 100;
        const words = `about ${money(remaining)} left of ${money(budget.usd)} loaded ${budget.since} (${money(spent)} spent since)`;
        if (isLow(remaining, budget.usd)) return { ...base, state: 'low', remainingUsd: remaining, detail: `Low: ${words}.` };
        return { ...base, state: 'ok', remainingUsd: remaining, detail: `${words}${recovered}.` };
      } catch (e) {
        return { ...base, state: 'unknown', detail: `Check failed: ${String(e?.message || e).slice(0, 160)}` };
      }
    }));
  } catch (e) {
    console.error('[alerts] creditStatus failed', String(e?.message || e).slice(0, 200));
    return [];
  }
}

/** DataForSEO account balance in USD (free call), or null when it can't be read. Never throws. */
export async function dataforseoBalance(env, { fetchImpl = (...a) => fetch(...a) } = {}) {
  try {
    const r = await dataforseoPing(env, { fetchImpl, timeoutMs: 8000 });
    const b = r?.detail?.balanceUsd;
    return r?.ok && b != null && Number.isFinite(Number(b)) ? Number(b) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The alert email for one engine line ({ engine, state, detail, remainingUsd }). Pure. */
export function creditAlertEmail(env, { engine, state, detail = '', remainingUsd = null }) {
  const name = engineLabel(engine);
  const acct = ACCOUNTS[engine] || { company: name, topUp: '' };
  const subject = state === 'out'
    ? `${name} is out of credits — live answers and scans are skipping it`
    : `${name} credits are low${remainingUsd != null ? `: about ${money(remainingUsd)} left` : ''}`;
  const admin = `${siteUrl(env)}/admin`;
  const paragraphs = [
    state === 'out'
      ? `${name} (${acct.company}) is refusing calls because the account is out of credits.`
      : `${name} (${acct.company}) is running low on credits.`,
    `What this affects: live answers on the homepage fall back to the next engine, and paid scans come back missing ${name} until it is topped up.`,
    `Top up here: ${acct.topUp}`,
    detail ? `Details: ${detail}` : '',
    `Dashboard: ${admin}`,
    'You get at most one of these per engine per day. It stops by itself once a call succeeds again.',
  ].filter(Boolean);
  const text = paragraphs.join('\n\n');
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a2233;padding:16px">
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escHtml(p)}</p>`).join('\n')}
<p><a href="${escHtml(admin)}">Open /admin</a></p></body></html>`;
  return { subject, text, html };
}

const dayOf = (now) => now.toISOString().slice(0, 10);

/** credit-alert:<engine>:<state>:<YYYY-MM-DD>:<address> */
export function alertKey(engine, state, now, to) {
  return `credit-alert:${engine}:${state}:${dayOf(now)}:${String(to).toLowerCase()}`;
}

async function sendOne(env, line, now, deps) {
  const mail = creditAlertEmail(env, line);
  const send = deps.sendEmail || sendEmail;
  const results = await Promise.all(alertEmails(env).map((to) => send(env, {
    to, ...mail, transactional: true, idempotencyKey: alertKey(line.engine, line.state, now, to),
  }, { fetchImpl: deps.fetchImpl || ((...a) => fetch(...a)) }).catch((e) => ({ ok: false, reason: String(e?.message || e) }))));
  return { engine: line.engine, state: line.state, sent: results.filter((r) => r?.ok).length, failed: results.filter((r) => !r?.ok).map((r) => r?.reason || 'failed') };
}

/**
 * The cron: check every engine and email ALERT_EMAILS about each 'low' / 'out' one.
 * → { checked, alerts: [{ engine, state, sent, failed }], statuses }. Never throws.
 */
export async function sendCreditAlerts(env, deps = {}) {
  try {
    const now = deps.now || new Date();
    const statuses = await (deps.creditStatus || creditStatus)(env, { ...deps, now });
    const alerts = [];
    for (const line of statuses.filter((s) => s.state === 'low' || s.state === 'out')) {
      alerts.push(await sendOne(env, line, now, deps));
    }
    return { checked: statuses.length, alerts, statuses: statuses.map(({ engine, state }) => ({ engine, state })) };
  } catch (e) {
    console.error('[alerts] sendCreditAlerts failed', String(e?.message || e).slice(0, 200));
    return { checked: 0, alerts: [], statuses: [], error: String(e?.message || e).slice(0, 200) };
  }
}

// Keys already sent by this isolate, so a burst of failing live calls hits Resend once.
const sentHere = new Set();

/**
 * Right after a live call fails: a billing error emails the 'out' alert now (same keys as the cron,
 * so it's one email per engine per day either way). Anything else returns at once.
 * → { alerted: boolean, reason?, … }. Never throws.
 */
export async function noteBillingError(env, engine, errorText, deps = {}) {
  try {
    if (!isBillingError(errorText)) return { alerted: false, reason: 'not a billing error' };
    const e = engineOf(engine);
    if (!e) return { alerted: false, reason: 'unknown engine' };
    const now = deps.now || new Date();
    const memo = `${e}:out:${dayOf(now)}`;
    if (!deps.noMemo && sentHere.has(memo)) return { alerted: false, reason: 'already sent today' };
    sentHere.add(memo);
    const detail = `Error seen just now: "${String(errorText).slice(0, 300)}"`;
    const r = await sendOne(env, { engine: e, state: 'out', detail }, now, deps);
    if (!r.sent) sentHere.delete(memo);
    return { alerted: r.sent > 0, ...r };
  } catch (err) {
    console.error('[alerts] noteBillingError failed', String(err?.message || err).slice(0, 200));
    return { alerted: false, reason: String(err?.message || err).slice(0, 200) };
  }
}
