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
// Added by supabase/scan_v2.sql: scan_results.report jsonb + scan_results.version int
// (the v2 report document), and scan_raw (one row per API call; no anon access).
//
// RLS is enabled on all tables. The anon key used by this Worker may:
//   SELECT businesses, scan_results, report_links
//   INSERT page_visits, email_events, payments, leads, unsubscribes, report_requests
//   EXECUTE report_unlocked(token), attach_report_request_email(id, email)
// (see "worker read/insert" policies in Supabase). Env vars SUPABASE_URL and
// SUPABASE_ANON_KEY are stored as Worker secrets, never in the repo.

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
 * @param {object} r - {id?, businessName, town, zip, email?, trade, website, phone, userAgent}
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
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLES.REPORT_REQUESTS}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
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
    livemode: payment.livemode ?? true,
    paid_at: new Date().toISOString(),
  };

  // return=minimal: anon has no SELECT on payments, so asking for the
  // inserted row back would fail the insert under RLS.
  await supaInsert(env, TABLES.PAYMENTS, row);
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
