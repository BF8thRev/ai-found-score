// lib/db.js — Supabase data access for AI Found Score.
//
// Live schema (confirmed 2026-09-23 against project piaaovvnuejbawpudhbp):
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
// RLS is enabled on all five tables. The anon key used by this Worker may:
//   SELECT businesses, scan_results
//   INSERT page_visits, email_events, payments
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
};

/**
 * Write one row for a free-report request from the landing page.
 *
 * Table (create in Supabase; anon needs INSERT only):
 *   report_requests: id uuid default gen_random_uuid() pk, business_name text,
 *                    town text, email text, trade text, website text,
 *                    user_agent text, requested_at timestamptz, status text
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_ANON_KEY)
 * @param {object} r - {businessName, town, email, trade, website, userAgent}
 */
export async function recordReportRequest(env, r) {
  const row = {
    business_name: r.businessName,
    town: r.town,
    email: r.email,
    trade: r.trade ?? null,
    website: r.website ?? null,
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

// Wired to the live schema.
const READY = true;

function supaHeaders(env) {
  const key = env.SUPABASE_ANON_KEY;
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
 * @param {object} payment - {businessId, arm, tier, amountCents, stripeSessionId}
 * @returns {Promise<object>}
 */
export async function recordPayment(env, payment) {
  const row = {
    business_id: payment.businessId ?? null,
    arm: payment.arm ?? null,
    tier: payment.tier ?? 'unknown',
    amount_cents: payment.amountCents ?? null,
    stripe_session_id: payment.stripeSessionId ?? null,
    paid_at: new Date().toISOString(),
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLES.PAYMENTS}`, {
    method: 'POST',
    headers: { ...supaHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase payments insert failed: ${res.status} ${text}`);
  }
  const [inserted] = await res.json();
  return { stubbed: false, row: inserted };
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
 * Anything else is read live from scan_results + businesses.
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
  const businessId = rows[0].business_id;
  const [business] = await supaGet(
    env,
    TABLES.BUSINESSES,
    `id=eq.${encodeURIComponent(businessId)}`
  );
  if (!business) return null;
  return shapeRealReport(reportId, rows, business);
}
