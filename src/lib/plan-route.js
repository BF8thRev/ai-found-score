// src/lib/plan-route.js — the Be the Answer page's API (public/plan.html).
//
//   GET  /api/plan/[token]  → { ok, paid, sample, name, towns, maxTowns, months, startedAt, confirmed,
//                               directories, paste, posts }
//   POST /api/plan/[token]  → add towns: { towns: [{ town, state, zip }] } → { ok, towns }
//
// Only for a token paid for Be the Answer (402 otherwise). The directory checklist and the Google posts
// are built from the details the owner confirmed on the Fix Kit page (src/lib/fix-kit.js); until then
// `confirmed` is false and the page sends them there first. Each added town gets its own report token
// (plan_towns, supabase/v8_be_the_answer.sql) and its first scan right away; the monthly cron scans it
// with the plan after that (src/lib/auto-scan.js startDueMonthly). sample-* is a working demo with no
// database. Towns can be added, never swapped: every town is a real scan every month.

import { getReport, getPaidTiers, getFixKitDetails } from './db.js';
import { rateLimit } from './rate-limit.js';
import { prefillDetails, validateDetails } from './fix-kit.js';
import { directoriesFor, directoryPaste, googlePosts, PLAN_MAX_TOWNS, PLAN_MONTHS } from './plan.js';
import {
  newRequestToken, readPlanTowns, readPlanBusiness, startTownScan, townBusiness, PLAN_TIER,
} from './auto-scan.js';
import { resolveKeys, US_STATES } from '../../scanner/config.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;
const NO_STORE = { 'Cache-Control': 'private, no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });
const notFound = () => json({ ok: false, error: 'Plan not found' }, 404);
const notPaid = () => json({ ok: false, error: 'This page comes with Be the Answer.' }, 402);
const MAX_BODY = 4000;

function supa(env) {
  const k = resolveKeys(env);
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

/** The first Be the Answer payment's date for a token, or null. */
async function planStartedAt(env, token, fetchImpl) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/payments?report_token=eq.${encodeURIComponent(token)}&or=(tier.eq.${PLAN_TIER},amount_cents.eq.49900)&revoked_at=is.null&select=paid_at&order=paid_at.asc&limit=1`, { headers });
  if (!res.ok) return null;
  const [row] = await res.json();
  return row?.paid_at || null;
}

async function insertTown(env, row, fetchImpl) {
  const { base, headers } = supa(env);
  const res = await fetchImpl(`${base}/plan_towns`, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`plan_towns insert failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
}

const clean = (v) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim());

/** One town from the form → { ok, town: { town, state, zip } } | { ok: false, message }. */
export function validateTown(t) {
  const town = clean(t?.town).slice(0, 60);
  const state = clean(t?.state).toUpperCase();
  const zip = clean(t?.zip);
  if (!town) return { ok: false, message: 'Enter the town.' };
  if (!Object.hasOwn(US_STATES, state)) return { ok: false, message: 'Use the 2-letter state code, like NY.' };
  if (zip && !/^\d{5}$/.test(zip)) return { ok: false, message: 'ZIP must be 5 digits.' };
  return { ok: true, town: { town, state, zip: zip || null } };
}

/**
 * deps (all optional; tests pass fakes): { mockReports, getReport, getPaidTiers, getFixKitDetails, readPlanTowns,
 * readPlanBusiness, planStartedAt, insertTown, startTownScan, newToken, rateLimit, fetchImpl, now }
 */
export async function handlePlan(request, url, env, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const d = {
    getReport, getPaidTiers, getFixKitDetails, rateLimit, mockReports: {}, now: () => new Date(),
    readPlanTowns: (e, t) => readPlanTowns(e, t, { fetchImpl }),
    readPlanBusiness: (e, t) => readPlanBusiness(e, t, { fetchImpl }),
    planStartedAt: (e, t) => planStartedAt(e, t, fetchImpl),
    insertTown: (e, row) => insertTown(e, row, fetchImpl),
    startTownScan: (e, x) => startTownScan(e, x, { fetchImpl }),
    newToken: newRequestToken,
    ...deps,
  };
  let token;
  try { token = decodeURIComponent(url.pathname.slice('/api/plan/'.length)); } catch { return notFound(); }
  if (!TOKEN_RE.test(token)) return notFound();
  const isSample = token.startsWith('sample-');

  if (request.method === 'POST') {
    const limited = await d.rateLimit(env, request, 'plan');
    if (limited) return limited;
  }

  let report;
  try {
    report = await d.getReport(env, token, d.mockReports);
  } catch (e) {
    console.error('[plan] report read failed', e);
    return json({ ok: false, error: 'Could not load your plan. Try again in a minute.' }, 500);
  }
  if (!report) return notFound();

  let paid = isSample;
  if (!isSample) {
    const tiers = await d.getPaidTiers(env, token).catch((e) => { console.error('[plan] paid check failed', e); return []; });
    paid = tiers.includes(PLAN_TIER);
  }
  if (!paid) return notPaid();

  const b = report.business || {};
  const own = { town: b.town || b.city || '', state: b.state || '', zip: b.zip || null, token, main: true };
  let towns = [];
  if (!isSample) {
    try {
      towns = (await d.readPlanTowns(env, token)).map((t) => ({ town: t.town, state: t.state, zip: t.zip || null, token: t.town_token }));
    } catch (e) {
      console.error('[plan] towns read failed', e);
      return json({ ok: false, error: 'Could not load your towns. Try again in a minute.' }, 503);
    }
  }

  if (request.method === 'POST') return addTowns(request, env, d, { token, isSample, own, towns });

  let details = null;
  let confirmed = false;
  if (isSample) {
    details = validateDetails(prefillDetails(report)).details;
    confirmed = true;
  } else {
    const saved = await d.getFixKitDetails(env, token).catch((e) => { console.error('[plan] details read failed', e); return null; });
    if (saved) { details = validateDetails(saved.details).details; confirmed = true; }
  }
  const startedAt = isSample ? d.now().toISOString() : await d.planStartedAt(env, token).catch(() => null);
  const start = startedAt ? new Date(startedAt) : d.now();
  return json({
    ok: true,
    paid: true,
    sample: isSample,
    name: b.name || '',
    towns: [own, ...towns],
    maxTowns: PLAN_MAX_TOWNS,
    months: PLAN_MONTHS,
    startedAt,
    confirmed,
    directories: directoriesFor(details?.trade || b.trade),
    paste: details ? directoryPaste(details) : null,
    posts: details ? googlePosts(details, { start }) : [],
  });
}

async function addTowns(request, env, d, { token, isSample, own, towns }) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return json({ ok: false, error: 'Send the towns as JSON.' }, 415);
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return json({ ok: false, error: 'Too much text.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const list = Array.isArray(body?.towns) ? body.towns : [];
  if (!list.length) return json({ ok: false, error: 'Add at least one town.' }, 422);

  const have = [own, ...towns];
  const key = (t) => `${String(t.town).toLowerCase()}|${String(t.state).toUpperCase()}`;
  const seen = new Set(have.map(key));
  const add = [];
  const errors = [];
  list.forEach((raw, i) => {
    const v = validateTown(raw);
    if (!v.ok) { errors.push({ index: i, message: v.message }); return; }
    if (seen.has(key(v.town))) { errors.push({ index: i, message: `${v.town.town} is already on your plan.` }); return; }
    seen.add(key(v.town));
    add.push(v.town);
  });
  if (errors.length) return json({ ok: false, errors }, 422);
  if (have.length + add.length > PLAN_MAX_TOWNS) {
    return json({ ok: false, error: `Your plan covers up to ${PLAN_MAX_TOWNS} towns. You have room for ${Math.max(0, PLAN_MAX_TOWNS - have.length)} more.` }, 422);
  }
  if (isSample) return json({ ok: true, sample: true, towns: [...have, ...add.map((t) => ({ ...t, token: null }))] });

  const business = await d.readPlanBusiness(env, token).catch(() => null);
  if (!business) return json({ ok: false, error: 'Could not load your business details. Try again in a minute.' }, 503);
  const added = [];
  for (const t of add) {
    const townToken = d.newToken();
    try {
      await d.insertTown(env, { report_token: token, town_token: townToken, town: t.town, state: t.state, zip: t.zip });
    } catch (e) {
      console.error('[plan] town insert failed', e);
      return json({ ok: false, error: 'Could not save that town. Try again in a minute.' }, 500);
    }
    const r = await d.startTownScan(env, { townToken, business: townBusiness(business, t) });
    if (!r.ok) console.error('[plan] town scan did not start', townToken, r.reason);
    added.push({ ...t, token: townToken });
  }
  return json({ ok: true, towns: [...have, ...added] });
}
