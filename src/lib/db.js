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
};

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
  const scoreLabel = score >= 80 ? 'Looking good' : score >= 50 ? 'Needs attention' : 'At risk';

  const aiResults = rows.map((r) => ({
    assistant: r.ai_source || 'AI assistant',
    named: !!r.named_by_ai,
    quote: '',
    note: r.named_by_ai
      ? `${r.ai_source || 'This assistant'} mentioned ${business.name} by name.`
      : `${r.ai_source || 'This assistant'} did not mention ${business.name}.`,
  }));

  const listings = PLATFORMS.map((platform) => {
    if (mismatches.has(platform)) {
      return {
        platform,
        status: 'mismatch',
        details: mismatches.get(platform) || `Our scan found a mismatch on ${platform}.`,
        fields: { name: business.name, phone: business.phone || '', hours: '' },
      };
    }
    return {
      platform,
      status: 'match',
      details: 'No mismatch recorded in the latest scan.',
      fields: { name: business.name, phone: business.phone || '', hours: '' },
    };
  });

  const issues = [];
  if (unnamed.length > 0) {
    issues.push({
      severity: 'high',
      title: 'AI assistants are not recommending you',
      description: `${unnamed.length} of ${rows.length} AI assistants checked did not mention ${business.name} by name. When customers ask an AI for a ${business.trade || 'local business'}, your name is not coming up.`,
    });
  }
  for (const [platform, details] of mismatches) {
    issues.push({
      severity: 'medium',
      title: `Listing mismatch on ${platform}`,
      description: details || `Your ${platform} listing disagrees with your other listings.`,
    });
  }
  if (issues.length === 0) {
    issues.push({
      severity: 'low',
      title: 'Nothing major found',
      description: 'The latest scan did not find AI visibility or listing problems. Nice work — check back periodically.',
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
      `Based on ${rows.length} AI assistant check${rows.length === 1 ? '' : 's'} and a ` +
      `5-platform listing scan from ${String(generatedAt).slice(0, 10)}. ` +
      `${named.length} of ${rows.length} assistants mentioned you by name; ` +
      `${mismatches.size} listing${mismatches.size === 1 ? '' : 's'} need${mismatches.size === 1 ? 's' : ''} fixing.`,
    aiResults,
    listings,
    issues,
    summary:
      `${business.name} was mentioned by ${named.length} of ${rows.length} AI assistants checked, ` +
      `with ${mismatches.size} listing mismatch${mismatches.size === 1 ? '' : 'es'} across Google, Apple, Bing, Yelp, and Facebook.`,
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
