// lib/db.js — Supabase data access for AI Found Score.
//
// Live schema (project bahmemiydzpotfrxmlzw "ai-found-score", created by supabase/setup.sql 2026-09-24):
//   businesses:   id uuid, name text, trade text, county text, phone text,
//                 website text, address text, google_place_id text,
//                 created_at timestamptz
//   scan_results: id uuid, business_id uuid, scanned_at timestamptz,
//                 named_by_ai bool, ai_source text, listing_mismatches jsonb,
//                 report_token text, created_at timestamptz
//   page_visits:  id uuid, report_token text, visited_at timestamptz,
//                 referrer text, user_agent text
//   email_events: id uuid, business_id uuid, arm text, sent_at timestamptz,
//                 opened_at timestamptz, replied_at timestamptz, reply_text text
//   payments:     id uuid, business_id uuid, arm text, tier text,
//                 amount_cents int4, stripe_session_id text, paid_at timestamptz
//
// Added by supabase/setup.sql: page_visits.arm, payments.report_token, payments.livemode,
// report_links, leads, unsubscribes, report_requests, report_unlocked().
// Added by supabase/v12_email_tracking.sql: email_events is one row per event (token, campaign, event
// sent|opened|clicked|unsubscribed, occurred_at, email, town, report_token, detail; no anon insert:
// log_email_event() RPC), report_requests.ref_token, businesses.town. See src/lib/email-tracking.js.
// Added by supabase/scan_v2.sql: scan_results.report jsonb + scan_results.version int
// (the v2 report document), and scan_raw (one row per API call; no anon access).
//
// RLS is enabled on all tables. The anon key used by this Worker may:
//   SELECT businesses, scan_results, report_links
//   INSERT page_visits, payments, leads, unsubscribes, report_requests
//   EXECUTE report_unlocked(token), attach_report_request_email(id, email), log_email_event(...)
// (see "worker read/insert" policies in Supabase). Env vars SUPABASE_URL and
// SUPABASE_ANON_KEY are stored as Worker secrets, never in the repo.
// The Fix Kit helpers at the bottom (getPaidTiers, getFixKitDetails, saveFixKitDetails) use
// SUPABASE_SERVICE_KEY instead: payments and fix_kit_details (supabase/v6_fix_kit.sql) have no anon access.

import { resolveKeys } from '../../scanner/config.js';
import { TIER_BY_CENTS } from './stripe.js';

export const TABLES = {
  BUSINESSES: 'businesses',
  SCAN_RESULTS: 'scan_results',
  PAGE_VISITS: 'page_visits',
  EMAIL_EVENTS: 'email_events',
  PAYMENTS: 'payments',
  UNSUBSCRIBES: 'unsubscribes',
  REPORT_REQUESTS: 'report_requests',
  REPORT_LINKS: 'report_links',
  LEADS: 'leads',
  FIX_KIT_DETAILS: 'fix_kit_details',
};

/** Insert one row; throws with the Supabase error text on failure. */
async function supaInsert(env, table, row) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table} insert failed: ${res.status} ${text}`);
  }
}

/**
 * Look up a recipient's link row by report token or by printed short code.
 * Returns {report_token, short_code, business_id, arm, town} or null.
 */
export async function getReportLink(env, { token, code }) {
  const q = token
    ? `report_token=eq.${encodeURIComponent(token)}`
    : `short_code=eq.${encodeURIComponent(code)}`;
  const [row] = await supaGet(env, TABLES.REPORT_LINKS, `${q}&limit=1`);
  return row || null;
}

/** True once any payment exists for this report token. */
export async function isReportUnlocked(env, token) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/report_unlocked`, {
    method: 'POST',
    headers: supaHeaders(env),
    body: JSON.stringify({ p_token: token }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase report_unlocked failed: ${res.status} ${text}`);
  }
  return (await res.json()) === true;
}

/** One report-page view (sent by the page after it renders, bots filtered). */
export async function recordVisit(env, v) {
  await supaInsert(env, TABLES.PAGE_VISITS, {
    report_token: v.token,
    arm: v.arm ?? null,
    referrer: v.referrer ?? null,
    user_agent: v.userAgent ?? null,
    visited_at: new Date().toISOString(),
  });
}

/** "Email me this report" capture. */
export async function recordLead(env, l) {
  await supaInsert(env, TABLES.LEADS, {
    report_token: l.token,
    email: l.email,
    arm: l.arm ?? null,
    user_agent: l.userAgent ?? null,
  });
}

/**
 * Write one row for a free-report request from the landing page.
 *
 * Table (create in Supabase; anon needs INSERT only):
 *   report_requests: id uuid default gen_random_uuid() pk, business_name text,
 *                    town text, email text (nullable), trade text, website text,
 *                    user_agent text, requested_at timestamptz, status text,
 *                    zip text, phone text, email_added_at timestamptz
 *   (email nullable + zip/phone/email_added_at: supabase/scan_v2.sql; state is not stored, the form is NY-only)
 *
 * The Worker picks the id (anon can't read the row back) and hands it to the
 * page, which uses it to attach an email later via attachReportRequestEmail.
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_ANON_KEY)
 * @param {object} r - {id?, businessName, town, zip, email?, trade, website, phone, userAgent, refToken?}
 */
export async function recordReportRequest(env, r) {
  const row = {
    ...(r.id ? { id: r.id } : {}),
    business_name: r.businessName,
    town: r.town,
    zip: r.zip ?? null,
    email: r.email ?? null,
    email_added_at: r.email ? new Date().toISOString() : null,
    trade: r.trade ?? null,
    website: r.website ?? null,
    phone: r.phone ?? null,
    user_agent: r.userAgent ?? null,
    requested_at: new Date().toISOString(),
    status: 'new',
    ...(r.refToken ? { ref_token: r.refToken } : {}),
  };
  const post = (body) => fetch(`${env.SUPABASE_URL}/rest/v1/${TABLES.REPORT_REQUESTS}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  let res = await post(row);
  // Attribution must never cost a request: if the row with ref_token is refused (say the column
  // isn't there yet, supabase/v12_email_tracking.sql), save it without.
  if (!res.ok && row.ref_token) {
    console.warn('[request] saved without ref_token', res.status, (await res.text().catch(() => '')).slice(0, 200));
    delete row.ref_token;
    res = await post(row);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase report_requests insert failed: ${res.status} ${text}`);
  }
  return { row };
}

/**
 * Attach an email to a report request saved earlier (the page's second step).
 * Goes through the attach_report_request_email() RPC (security definer, see
 * supabase/scan_v2.sql) so anon never needs UPDATE or SELECT on the table.
 * The RPC only fills an empty email on a row from the last 24 hours.
 * @returns {Promise<boolean>} true if a row was updated
 */
export async function attachReportRequestEmail(env, { id, email }) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/attach_report_request_email`, {
    method: 'POST',
    headers: supaHeaders(env),
    body: JSON.stringify({ p_id: id, p_email: email }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase attach_report_request_email failed: ${res.status} ${text}`);
  }
  return (await res.json()) === true;
}

// Wired to the live schema.
const READY = true;

function supaHeaders(env) {
  // Trim: a pasted secret often carries a trailing space or newline.
  const key = String(env.SUPABASE_ANON_KEY || '').trim();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function supaGet(env, table, query) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?${query}&select=*`,
    { headers: supaHeaders(env) }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Write one row to the payments table via the Supabase REST API.
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_ANON_KEY)
 * @param {object} payment - {businessId, reportToken, arm, tier, amountCents, stripeSessionId, livemode}
 * @returns {Promise<object>}
 */
export async function recordPayment(env, payment) {
  const row = {
    business_id: payment.businessId ?? null,
    report_token: payment.reportToken ?? null,
    arm: payment.arm ?? null,
    tier: payment.tier ?? 'unknown',
    amount_cents: payment.amountCents ?? null,
    stripe_session_id: payment.stripeSessionId ?? null,
    // How a refund or dispute event finds this row (supabase/v9_refunds.sql, src/lib/refunds.js).
    stripe_payment_intent: payment.stripePaymentIntent ?? null,
    livemode: payment.livemode ?? true,
    // The checkout email, for the receipt, the full-audit and 30-day re-check emails (supabase/v7_email.sql).
    customer_email: payment.customerEmail ? String(payment.customerEmail).trim().toLowerCase().slice(0, 200) : null,
    // Add-ons bought in the same checkout, e.g. ['competitor_breakdown'] (supabase/v8_be_the_answer.sql).
    addons: Array.isArray(payment.addons) ? payment.addons : [],
    paid_at: new Date().toISOString(),
  };

  // Service key only (v8 revokes anon inserts: a payment row unlocks a report). One row per
  // Checkout Session: a retried webhook hits the unique stripe_session_id and is ignored.
  const s = supaService(env);
  const res = await fetch(`${s.base}/${TABLES.PAYMENTS}${row.stripe_session_id ? '?on_conflict=stripe_session_id' : ''}`, {
    method: 'POST',
    headers: { ...s.headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`Supabase ${TABLES.PAYMENTS} insert failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { row };
}

/**
 * Write one row to the unsubscribes suppression table. The sender must
 * check this table (by email and by report_token) before every send.
 *
 * Table (create in Supabase; anon needs INSERT only):
 *   unsubscribes: id uuid default gen_random_uuid() pk, report_token text,
 *                 email text, user_agent text, unsubscribed_at timestamptz
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_ANON_KEY)
 * @param {object} u - {token, email, userAgent}
 * @returns {Promise<object>}
 */
export async function recordUnsubscribe(env, u) {
  const row = {
    report_token: u.token ?? null,
    email: u.email ?? null,
    user_agent: u.userAgent ?? null,
    unsubscribed_at: new Date().toISOString(),
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLES.UNSUBSCRIBES}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase unsubscribes insert failed: ${res.status} ${text}`);
  }
  return { row };
}

const PLATFORMS = ['Google', 'Apple', 'Bing', 'Yelp', 'Facebook'];

/** Collect the set of platforms with a recorded listing mismatch. */
function mismatchPlatforms(rows) {
  const out = new Map(); // platform -> details string
  for (const r of rows) {
    const m = r.listing_mismatches;
    if (!m) continue;
    if (Array.isArray(m)) {
      for (const x of m) {
        if (typeof x === 'string') out.set(x, '');
        else if (x && typeof x === 'object' && x.platform) {
          out.set(x.platform, x.details || x.description || '');
        }
      }
    } else if (typeof m === 'object') {
      for (const [k, v] of Object.entries(m)) {
        out.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }
  }
  return out;
}

/**
 * Shape live scan rows + business row into the report JSON the frontend
 * renders. Scoring is a provisional heuristic until the scanner stores
 * per-assistant/per-platform detail; revisit when kill-gate-1 scanner lands.
 */
function shapeRealReport(reportToken, rows, business) {
  const mismatches = mismatchPlatforms(rows);
  const unnamed = rows.filter((r) => !r.named_by_ai);
  const named = rows.filter((r) => r.named_by_ai);

  let score = 100 - unnamed.length * 20 - mismatches.size * 10;
  score = Math.max(5, Math.min(100, score));
  const scoreLabel = score >= 80 ? 'Looking good' : score >= 50 ? 'Needs attention' : 'Needs work';

  const aiResults = rows.map((r) => ({
    assistant: r.ai_source || 'AI assistant',
    named: !!r.named_by_ai,
    quote: '',
    note: r.named_by_ai
      ? `${r.ai_source || 'This assistant'} named ${business.name}.`
      : `${r.ai_source || 'This assistant'} didn’t name ${business.name}.`,
  }));

  const listings = PLATFORMS.map((platform) => {
    if (mismatches.has(platform)) {
      return {
        platform,
        status: 'mismatch',
        details: mismatches.get(platform) || `Your ${platform} listing doesn’t match your other listings.`,
        fields: { name: business.name, phone: business.phone || '', hours: '' },
      };
    }
    return {
      platform,
      status: 'match',
      details: 'Matches your other listings.',
      fields: { name: business.name, phone: business.phone || '', hours: '' },
    };
  });

  const issues = [];
  if (unnamed.length > 0) {
    issues.push({
      severity: 'high',
      title: `${unnamed.length} of ${rows.length} AI assistants didn’t name you`,
      description: `Asked for a ${business.trade || 'local business'} in your area, ${unnamed.length} of ${rows.length} assistants named other businesses.`,
    });
  }
  for (const [platform, details] of mismatches) {
    issues.push({
      severity: 'medium',
      title: `Listing mismatch on ${platform}`,
      description: details || `Your ${platform} listing doesn’t match your other listings.`,
    });
  }
  if (issues.length === 0) {
    issues.push({
      severity: 'low',
      title: 'No problems found',
      description: 'The latest scan found no listing mismatches and no missed AI mentions.',
    });
  }

  const generatedAt = rows[0]?.scanned_at || rows[0]?.created_at || new Date().toISOString().slice(0, 10);

  return {
    id: reportToken,
    generatedAt: String(generatedAt).slice(0, 10),
    sample: false,
    business: {
      name: business.name,
      trade: business.trade || '',
      phone: business.phone || '',
      website: business.website || '',
      address: business.address || '',
      city: '',
      state: '',
      zip: '',
      county: business.county || '',
    },
    score,
    scoreLabel,
    scoreExplanation:
      `${named.length} of ${rows.length} AI assistants named you. ` +
      `${mismatches.size} of ${PLATFORMS.length} listings need${mismatches.size === 1 ? 's' : ''} a fix. ` +
      `Scanned ${String(generatedAt).slice(0, 10)}.`,
    aiResults,
    listings,
    issues,
    summary:
      `${named.length} of ${rows.length} AI assistants named ${business.name}. ` +
      `${mismatches.size} of ${PLATFORMS.length} listings across Google, Apple, Bing, Yelp, and Facebook need${mismatches.size === 1 ? 's' : ''} a fix.`,
  };
}

/**
 * Fetch a report by its public token. Sample reports (id starting with
 * "sample-") keep serving the bundled mock so the demo page always works.
 * Anything else is read live from scan_results: a row with `version = 2`
 * returns its stored `report` jsonb as-is (see DATA_MODEL.md, v2); older
 * rows are shaped into the legacy v1 report from scan_results + businesses.
 *
 * @param {object} env - Worker env
 * @param {string} reportId - public report token
 * @param {object} mockReports - id -> report JSON map (imported by worker)
 * @returns {Promise<object|null>}
 */
export async function getReport(env, reportId, mockReports) {
  if (!READY || reportId.startsWith('sample-')) {
    return mockReports[reportId] || null;
  }
  const rows = await supaGet(
    env,
    TABLES.SCAN_RESULTS,
    `report_token=eq.${encodeURIComponent(reportId)}`
  );
  if (!rows.length) return null;

  // v2: the scanner stores the finished report document on the row. The
  // newest v2 row wins; the Worker validates it before serving.
  const v2 = rows
    .filter((r) => r.version === 2 && r.report && typeof r.report === 'object')
    .sort((a, b) => String(b.scanned_at || b.created_at || '').localeCompare(String(a.scanned_at || a.created_at || '')))[0];
  if (v2) return { ...v2.report, id: reportId, version: 2 };

  const businessId = rows[0].business_id;
  const [business] = await supaGet(
    env,
    TABLES.BUSINESSES,
    `id=eq.${encodeURIComponent(businessId)}`
  );
  if (!business) return null;
  return shapeRealReport(reportId, rows, business);
}

// ---------------------------------------------------------------------------
// Fix Kit (supabase/v6_fix_kit.sql; routes in src/lib/fix-kit-route.js)
// ---------------------------------------------------------------------------
// payments and fix_kit_details are service-key only (anon can't read either), so these use
// SUPABASE_SERVICE_KEY, server-side only. Without it they throw; the route treats that as "not paid".

function supaService(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

/**
 * The plans paid for on this report token, e.g. ['xray', 'fix_kit']: each payment's tier, or the tier
 * for its amount (TIER_BY_CENTS) when no tier was recorded. Test-mode payments count too, as in
 * report_unlocked(), so a sandbox checkout can be tried end to end.
 */
export async function getPaidTiers(env, token) {
  const s = supaService(env);
  const rows = await getPayments(env, token);
  const tiers = new Set();
  for (const p of rows) {
    const t = p.tier && p.tier !== 'unknown' ? p.tier : TIER_BY_CENTS[p.amount_cents];
    if (t) tiers.add(t);
    for (const a of Array.isArray(p.addons) ? p.addons : []) tiers.add(a);
  }
  return [...tiers];
}

/** Every payment on a report token that isn't refunded in full: [{ tier, amount_cents, addons, livemode }]. Service key. */
export async function getPayments(env, token) {
  const s = supaService(env);
  const res = await fetch(`${s.base}/${TABLES.PAYMENTS}?report_token=eq.${encodeURIComponent(token)}&revoked_at=is.null&select=tier,amount_cents,addons,livemode`, { headers: s.headers });
  if (!res.ok) throw new Error(`Supabase GET payments failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** The confirmed Fix Kit details for a token → { details, confirmed_at, updated_at } or null. */
export async function getFixKitDetails(env, token) {
  const s = supaService(env);
  const res = await fetch(`${s.base}/${TABLES.FIX_KIT_DETAILS}?report_token=eq.${encodeURIComponent(token)}&select=details,confirmed_at,updated_at&limit=1`, { headers: s.headers });
  if (!res.ok) throw new Error(`Supabase GET fix_kit_details failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const [row] = await res.json();
  return row || null;
}

/** Save (insert or replace) the owner's confirmed details for a token. */
export async function saveFixKitDetails(env, token, details) {
  const s = supaService(env);
  const now = new Date().toISOString();
  const res = await fetch(`${s.base}/${TABLES.FIX_KIT_DETAILS}?on_conflict=report_token`, {
    method: 'POST',
    headers: { ...s.headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ report_token: token, details, confirmed_at: now, updated_at: now }),
  });
  if (!res.ok) throw new Error(`Supabase fix_kit_details upsert failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Free-report requests by report token (the report page while a report is being made).
// Service key: `scans` and reading `report_requests` have no anon access. The email itself is
// never returned, only whether one is on file.
// ---------------------------------------------------------------------------

/**
 * Who a report token is for, while its report is being made → { business: {name, town, state} | null,
 * hasEmail }. Business comes from the newest `scans` row for the token; hasEmail is true when any
 * request tied to the token (report_requests.report_token) has an email.
 */
export async function getRequestInfo(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supaService(env);
  const t = encodeURIComponent(token);
  const [scanRes, reqRes] = await Promise.all([
    fetchImpl(`${s.base}/scans?report_token=eq.${t}&select=id,status,business,business_name,calls_total&order=created_at.desc&limit=1`, { headers: s.headers, signal: AbortSignal.timeout(8000) }),
    fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}?report_token=eq.${t}&email=not.is.null&select=id&limit=1`, { headers: s.headers, signal: AbortSignal.timeout(8000) }),
  ]);
  const [scan] = scanRes.ok ? await scanRes.json() : [];
  const reqs = reqRes.ok ? await reqRes.json() : [];
  const b = scan && scan.business && typeof scan.business === 'object' ? scan.business : {};
  const name = String(b.name || scan?.business_name || '').slice(0, 120);
  // Answers in so far: one scan_raw row per engine call (the workflow writes each as it lands).
  let progress = null;
  if (scan?.id && scan.status === 'running' && Number(scan.calls_total) > 0) {
    const raw = await fetchImpl(`${s.base}/scan_raw?scan_id=eq.${encodeURIComponent(scan.id)}&select=id`, { headers: s.headers, signal: AbortSignal.timeout(8000) }).catch(() => null);
    const rows = raw && raw.ok ? await raw.json().catch(() => []) : [];
    progress = { done: Math.min(rows.length, Number(scan.calls_total)), total: Number(scan.calls_total) };
  }
  return {
    business: name ? {
      name, town: String(b.town || '').slice(0, 80) || null, state: String(b.state || '').slice(0, 20) || null,
      trade: String(b.trade || '').slice(0, 60) || null, zip: String(b.zip || '').slice(0, 10) || null,
    } : null,
    hasEmail: reqs.length > 0,
    progress,
  };
}

/**
 * The reports tied to an email address (newest first, one per token, at most 3) → [{ token, name }].
 * For "Lost your report link?": the tokens go to the owner's own inbox only, never to the page. A
 * request with no report token yet is skipped.
 */
export async function findReportsByEmail(env, email, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supaService(env);
  const res = await fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}?email=eq.${encodeURIComponent(email)}&report_token=not.is.null&select=report_token,business_name&order=requested_at.desc&limit=10`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Supabase GET report_requests failed: ${res.status}`);
  const seen = new Set();
  const out = [];
  for (const r of await res.json()) {
    const token = String(r.report_token || '');
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push({ token, name: String(r.business_name || '').slice(0, 120) });
    if (out.length === 3) break;
  }
  return out;
}

/** Whether any request tied to this report token has an email on file. */
export async function requestHasEmail(env, token, { fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = supaService(env);
  const res = await fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}?report_token=eq.${encodeURIComponent(token)}&email=not.is.null&select=id&limit=1`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Supabase GET report_requests failed: ${res.status}`);
  return (await res.json()).length > 0;
}

/**
 * "Email me when it's ready" on a report that is still being made: put the email on the request tied
 * to this token, so the scan's own "report ready" email (src/lib/notify.js notifyScanDone) goes to it.
 * Fills an empty email first; if every request already has one (or none is tied to the token, e.g. an
 * admin scan), saves a new request row for the same token with the business from its `scans` row.
 * → { id } of the row that now carries the email.
 */
export async function attachRequestEmailByToken(env, { token, email, userAgent = null }, { fetchImpl = (...a) => fetch(...a), uuid = () => crypto.randomUUID() } = {}) {
  const s = supaService(env);
  const t = encodeURIComponent(token);
  const now = new Date().toISOString();
  const patch = await fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}?report_token=eq.${t}&email=is.null&select=id`, {
    method: 'PATCH',
    headers: { ...s.headers, Prefer: 'return=representation' },
    body: JSON.stringify({ email, email_added_at: now }),
    signal: AbortSignal.timeout(8000),
  });
  if (!patch.ok) throw new Error(`Supabase report_requests update failed: ${patch.status} ${(await patch.text()).slice(0, 200)}`);
  const [updated] = await patch.json();
  if (updated && updated.id) return { id: updated.id };
  // Already on file for this token? Nothing to add.
  const same = await fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}?report_token=eq.${t}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  if (same.ok) {
    const [row] = await same.json();
    if (row && row.id) return { id: row.id };
  }
  const scanRes = await fetchImpl(`${s.base}/scans?report_token=eq.${t}&select=business,business_name&order=created_at.desc&limit=1`, { headers: s.headers, signal: AbortSignal.timeout(8000) });
  const [scan] = scanRes.ok ? await scanRes.json() : [];
  const b = scan && scan.business && typeof scan.business === 'object' ? scan.business : {};
  const id = uuid();
  const res = await fetchImpl(`${s.base}/${TABLES.REPORT_REQUESTS}`, {
    method: 'POST',
    headers: { ...s.headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      id,
      business_name: String(b.name || scan?.business_name || 'unknown').slice(0, 120),
      town: String(b.town || 'unknown').slice(0, 80),
      zip: b.zip ?? null,
      trade: b.trade ?? null,
      website: b.website ?? null,
      phone: b.phone ?? null,
      email,
      email_added_at: now,
      user_agent: userAgent,
      requested_at: now,
      status: 'email-added',
      report_token: token,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Supabase report_requests insert failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { id };
}
