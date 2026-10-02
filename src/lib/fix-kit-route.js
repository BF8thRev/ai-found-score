// src/lib/fix-kit-route.js — /api/fix-kit/<token>: the Fix Kit's details form and zip download.
//
//   GET  /api/fix-kit/<token>      → { ok, paid, confirmed, confirmedAt, sample, plan, details, kit? }
//                                    details = the saved details, else prefillDetails(report): the kit is
//                                    built before the owner does anything. kit (paid only) = kitView():
//                                    the jobs left for this business, each file's contents, what's already
//                                    done, the FAQ and the details we're missing. 404 when there is no report.
//   POST /api/fix-kit/<token>      JSON { preview: true, details } → validate, rebuild → { ok, details, kit }
//                                    (an edit on the kit page; nothing saved).
//                                    JSON { confirm: true, details } → validate, save → { ok, details, kit }:
//                                    the ownership tick, sent by the page right before the download.
//                                    422 { ok:false, errors:[{ field, message }] } when something needs fixing.
//                                    Only for a token paid for 'xray', 'fix_kit' or 'be_the_answer' (402 otherwise).
//                                    JSON { suggest: true, details } → { ok, suggestions: { slots, services } }: AI drafts for the
//                                    kit's blanks, read off the owner's own website and checked against it
//                                    (src/lib/fix-kit-suggest.js). Never applied by themselves; the page offers each one. Paid only,
//                                    cached per token for a week, its cost logged to scan_usage. A sample token gets none.
//                                    JSON { help: true, details, contact, phone?, wants[], note? } → { ok }: the "do it for me" button.
//                                    Emails us (the alert addresses) the request with the kit and report links, and the owner a
//                                    short "we got it". Paid only; one per token per day (idempotency key); a sample sends nothing.
//                                    (src/lib/done-for-you.js)
//   GET  /api/fix-kit/<token>.zip  → the zip (src/lib/fix-kit.js), paid AND ticked (saved) only (402 / 409).
//
// Paid = a payments row for the token whose tier (or amount, TIER_BY_CENTS) is one of FIX_KIT_TIERS,
// read with the service key (src/lib/db.js getPaidTiers). If that read fails the answer is "not paid",
// never an error page. POST and the zip go through the per-IP REQUEST_LIMITER (bucket 'fixkit').
// POST needs Content-Type: application/json, so another site can't post a plain form at it.
//
// sample-* tokens (the bundled fictional reports) are a working demo with no database: they count as
// paid, a POST is checked but not saved, and the zip is built from the sample's own details.
//
// The website builder (siteCheck.platform) makes the jobs and README specific ("In Wix: ..."). Reports
// scanned before the scanner recorded it get it here, paid only: one homepage fetch, cached by host
// (src/lib/site-platform.js). If that fails the kit is built as before, with the generic steps.

import { getReport, getPaidTiers, getFixKitDetails, saveFixKitDetails } from './db.js';
import { rateLimit } from './rate-limit.js';
import { FIX_KIT_TIERS, prefillDetails, validateDetails, buildKit, kitFaq, zipFiles, zipName } from './fix-kit.js';
import { suggestForKit } from './fix-kit-suggest.js';
import { saveUsage, usageRow, canStore } from '../../scanner/store.js';
import { validateHelp, helpEmails } from './done-for-you.js';
import { sendEmail } from './email.js';
import { alertEmails } from './alerts.js';
import { directoryChecklistTxt, googlePostsTxt } from './plan.js';
import { withPlatform } from './site-platform.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const MAX_BODY = 20_000;
const NO_STORE = { 'Cache-Control': 'private, no-store' };

const json = (body, status = 200) => Response.json(body, { status, headers: NO_STORE });
const notFound = () => json({ ok: false, error: 'Report not found' }, 404);
const notPaid = () => json({ ok: false, error: 'The Fix Kit comes with the AI Visibility Audit.' }, 402);

/**
 * deps (all optional; tests pass fakes): { mockReports, getReport, getPaidTiers, getFixKitDetails,
 * saveFixKitDetails, rateLimit, now, withPlatform, suggest, saveUsage, cache, sendEmail }
 */
export async function handleFixKit(request, url, env, deps = {}) {
  const d = {
    getReport, getPaidTiers, getFixKitDetails, saveFixKitDetails, rateLimit, mockReports: {}, now: () => new Date(),
    withPlatform: (r) => withPlatform(r),
    suggest: suggestForKit, saveUsage, sendEmail, cache: typeof caches !== 'undefined' ? caches.default : null,
    ...deps,
  };
  let raw;
  try { raw = decodeURIComponent(url.pathname.slice('/api/fix-kit/'.length)); } catch { return notFound(); }
  const wantZip = raw.endsWith('.zip');
  const token = wantZip ? raw.slice(0, -4) : raw;
  if (!TOKEN_RE.test(token)) return notFound();
  if (wantZip && request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);
  const isSample = token.startsWith('sample-');

  if (request.method === 'POST' || wantZip) {
    const limited = await d.rateLimit(env, request, 'fixkit');
    if (limited) return limited;
  }

  let report;
  try {
    report = await d.getReport(env, token, d.mockReports);
  } catch (e) {
    console.error('[fix-kit] report read failed', e);
    return json({ ok: false, error: 'Could not load your details. Try again in a minute.' }, 500);
  }
  if (!report) return notFound();

  let paid = isSample;
  let onPlan = isSample;
  let tiers = [];
  if (!isSample) {
    tiers = await d.getPaidTiers(env, token).catch((e) => { console.error('[fix-kit] paid check failed', e); return []; });
    paid = tiers.some((t) => FIX_KIT_TIERS.includes(t));
    onPlan = tiers.includes('be_the_answer');
  }
  // Which site builder, for reports scanned before we recorded it. Never holds the kit up on failure.
  if (paid && !isSample) report = await d.withPlatform(report).catch(() => report);

  if (request.method === 'POST') return postDetails(request, env, d, token, paid, isSample, report, url, tiers);

  if (wantZip) {
    if (!paid) return notPaid();
    let details;
    if (isSample) {
      details = validateDetails(prefillDetails(report)).details;
    } else {
      let saved;
      try { saved = await d.getFixKitDetails(env, token); } catch (e) {
        console.error('[fix-kit] details read failed', e);
        return json({ ok: false, error: 'Could not load your details. Try again in a minute.' }, 503);
      }
      if (!saved) return json({ ok: false, error: 'Tick the box to confirm you own or manage this business first.' }, 409);
      // Re-checked on the way out, so the files only ever carry clean, capped values.
      details = validateDetails(saved.details).details;
    }
    const files = buildKit(details, report, { origin: url.origin, token, date: d.now() }).files;
    // Be the Answer adds the directory checklist and the year's Google posts (src/lib/plan.js).
    if (onPlan) {
      files.push({ path: 'directory-checklist.txt', content: directoryChecklistTxt(details) });
      files.push({ path: 'google-posts.txt', content: googlePostsTxt(details, { start: d.now() }) });
    }
    return new Response(zipFiles(files, { date: d.now() }), {
      headers: {
        ...NO_STORE,
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName(details)}"`,
      },
    });
  }

  let saved = null;
  if (!isSample && paid) {
    saved = await d.getFixKitDetails(env, token).catch((e) => { console.error('[fix-kit] details read failed', e); return null; });
  }
  const details = saved?.details || prefillDetails(report);
  const v = validateDetails(details);
  return json({
    ok: true,
    paid,
    confirmed: !!saved,
    confirmedAt: saved?.confirmed_at || null,
    sample: isSample,
    plan: onPlan,
    details,
    // Built from what we know before the owner touches anything; what's wrong or missing is flagged.
    ...(paid ? { kit: kitView(v.details, report, { origin: url.origin, token, date: d.now() }), problems: v.errors } : {}),
  });
}

/** The kit for the page: each job with its files' contents, what's already done, the FAQ, what's missing. */
export function kitView(details, report, opts) {
  const kit = buildKit(details, report, opts);
  const content = new Map(kit.files.map((f) => [f.path, f.content]));
  return {
    jobs: kit.jobs.map((j) => ({ ...j, files: j.files.map((path) => ({ path, content: content.get(path) })) })),
    done: kit.done,
    faq: { items: kit.faq.items, attributes: kit.faq.attributes, needs: kit.faq.needs },
    missing: kit.missing,
    notes: kit.notes || [],
    readme: content.get('README.txt'),
    check: content.get('check-it-worked.txt'),
    ...(kit.platform ? { platform: kit.platform } : {}),
  };
}

async function postDetails(request, env, d, token, paid, isSample, report, url, tiers = []) {
  if (!paid) return notPaid();
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    return json({ ok: false, error: 'Send the details as JSON.' }, 415);
  }
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return json({ ok: false, error: 'That is too much text. Shorten the long fields and try again.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'Bad request' }, 400);

  const v = validateDetails(body.details);
  const errors = [...v.errors];
  const kit = () => kitView(v.details, report, { origin: url.origin, token, date: d.now() });
  if (body.help === true) {
    const h = validateHelp(body);
    const all = [...errors, ...h.errors];
    if (all.length) return json({ ok: false, errors: all }, 422);
    if (isSample) return json({ ok: true, sample: true });
    return askForHelp(env, d, { origin: url.origin, token, tiers, details: v.details, report, kit: kit(), help: h.help });
  }
  if (body.suggest === true) {
    if (errors.length) return json({ ok: false, errors }, 422);
    return suggestions(env, d, token, isSample, v.details, report);
  }
  if (body.preview === true) {
    if (errors.length) return json({ ok: false, errors }, 422);
    return json({ ok: true, preview: true, details: v.details, kit: kit() });
  }
  if (body.confirm !== true) errors.push({ field: 'confirm', message: 'Tick the box to confirm you own or manage this business and the details are right.' });
  if (errors.length) return json({ ok: false, errors }, 422);

  if (isSample) return json({ ok: true, sample: true, details: v.details, kit: kit() });
  try {
    await d.saveFixKitDetails(env, token, v.details);
  } catch (e) {
    console.error('[fix-kit] save failed', e);
    return json({ ok: false, error: 'Could not save your details. Try again in a minute.' }, 500);
  }
  return json({ ok: true, details: v.details, kit: kit() });
}

const EMPTY = { slots: {}, services: [] };
const SUGGEST_TTL = 7 * 24 * 3600;
const suggestKey = (token) => new Request(`https://aifoundscore.com/__cache/kit-suggest/v1/${encodeURIComponent(token)}`, { method: 'GET' });

/**
 * AI drafts for the blanks in this kit (the [bracket] answers, and services when there are none), read off
 * the owner's website and verified against it. A repeat visit is answered from the cache, not the model.
 */
async function suggestions(env, d, token, isSample, details, report) {
  if (isSample) return json({ ok: true, sample: true, suggestions: EMPTY });
  const types = [...new Set(kitFaq(details, report).items.filter((i) => i.slot && !i.complete).map((i) => i.slot.type))];
  const wantServices = !details.services.length;
  if (!types.length && !wantServices) return json({ ok: true, suggestions: EMPTY });
  const key = suggestKey(token);
  try {
    const hit = d.cache && await d.cache.match(key);
    const c = hit && await hit.json();
    if (c && c.website === details.website && types.every((t) => c.types.includes(t)) && (!wantServices || c.wantServices)) {
      return json({ ok: true, cached: true, suggestions: { slots: Object.fromEntries(types.filter((t) => c.slots[t]).map((t) => [t, c.slots[t]])), services: wantServices ? c.services : [] } });
    }
  } catch { /* no cache: ask the model */ }
  let r;
  try {
    r = await d.suggest({ details, types, wantServices, env });
  } catch (e) {
    console.error('[fix-kit] suggest failed', e);
    return json({ ok: true, unavailable: true, suggestions: EMPTY });
  }
  if (r.usage && canStore(env)) {
    await d.saveUsage(env, [usageRow({ kind: 'other', model: r.model, usage: r.usage, costUsd: r.costUsd, ok: r.ok, error: r.error, answerRef: 'kit-prefill:' + token.slice(0, 8) })]);
  }
  if (!r.ok) return json({ ok: true, unavailable: true, suggestions: EMPTY });
  if (d.cache) {
    const put = d.cache.put(key, Response.json({ website: details.website, types, wantServices, slots: r.slots, services: r.services }, { headers: { 'Cache-Control': `public, max-age=${SUGGEST_TTL}` } }));
    await put.catch(() => {});
  }
  return json({ ok: true, suggestions: { slots: r.slots, services: r.services } });
}

/** "Do it for me": one email to us with everything needed to answer, one short "we got it" to the owner. */
async function askForHelp(env, d, ctx) {
  const mail = helpEmails(env, { ...ctx, date: d.now() });
  const sends = [];
  for (const to of alertEmails(env)) sends.push(await d.sendEmail(env, { ...mail.toUs, to, idempotencyKey: `${mail.toUs.idempotencyKey}-${to}` }));
  if (!sends.some((r) => r && r.ok)) {
    console.error('[fix-kit] help request not sent', JSON.stringify(sends));
    return json({ ok: false, error: 'We could not send that just now. Email hello@aifoundscore.com and we will help.' }, 503);
  }
  await d.sendEmail(env, mail.toOwner);
  return json({ ok: true, contact: ctx.help.contact });
}
