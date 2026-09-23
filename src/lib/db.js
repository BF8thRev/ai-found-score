// lib/db.js — Supabase data access for AI Found Score.
//
// *** UPDATE WHEN SCHEMA CONFIRMED ***
// Table and column names below are PLACEHOLDERS guessed from the planned
// schema. Confirm them against the live Supabase project
// (https://piaaovvnuejbawpudhbp.supabase.co) before wiring real keys,
// then flip READY=true. Nothing else in the codebase touches Supabase
// directly — worker.js only calls the functions exported here.

export const TABLES = {
  BUSINESSES: 'businesses',
  SCAN_RESULTS: 'scan_results',
  PAGE_VISITS: 'page_visits',
  EMAIL_EVENTS: 'email_events',
  PAYMENTS: 'payments',
};

// Placeholder column names — replace with the real ones.
export const COLS = {
  BUSINESSES: {
    ID: 'id',
    NAME: 'name',
    PHONE: 'phone',
    WEBSITE: 'website',
    ADDRESS: 'address',
    TRADE: 'trade',
    COUNTY: 'county',
    EMAIL: 'email',
    CREATED_AT: 'created_at',
  },
  SCAN_RESULTS: {
    ID: 'id',
    BUSINESS_ID: 'business_id',
    REPORT_ID: 'report_id', // public token used in /report/[id] URLs
    SCORE: 'score',
    AI_RESULTS: 'ai_results', // jsonb
    LISTING_RESULTS: 'listing_results', // jsonb
    SCANNED_AT: 'scanned_at',
  },
  PAGE_VISITS: {
    ID: 'id',
    REPORT_ID: 'report_id',
    VISITED_AT: 'visited_at',
    SOURCE: 'source', // e.g. 'email', 'direct'
  },
  EMAIL_EVENTS: {
    ID: 'id',
    BUSINESS_ID: 'business_id',
    EVENT_TYPE: 'event_type', // sent | opened | clicked
    CREATED_AT: 'created_at',
  },
  PAYMENTS: {
    ID: 'id',
    BUSINESS_ID: 'business_id',
    REPORT_ID: 'report_id',
    TIER: 'tier', // snapshot | before_after | full_year | listing_fix
    AMOUNT_CENTS: 'amount_cents',
    CURRENCY: 'currency',
    STRIPE_SESSION_ID: 'stripe_session_id',
    STRIPE_PAYMENT_INTENT: 'stripe_payment_intent',
    CUSTOMER_EMAIL: 'customer_email',
    STATUS: 'status',
    CREATED_AT: 'created_at',
  },
};

// Set to true once SUPABASE_URL / SUPABASE_ANON_KEY env vars are live
// and the column names above match the real schema.
const READY = false;

/**
 * Write one row to the payments table via the Supabase REST API.
 * Currently a stub: returns { stubbed: true } until wired.
 *
 * @param {object} env - Worker env (SUPABASE_URL, SUPABASE_ANON_KEY)
 * @param {object} payment - keys matching COLS.PAYMENTS (plain names below)
 * @returns {Promise<object>}
 */
export async function recordPayment(env, payment) {
  if (!READY) {
    console.log('[db] stubbed payment write', JSON.stringify(payment));
    return { stubbed: true, payment };
  }

  const row = {
    [COLS.PAYMENTS.BUSINESS_ID]: payment.businessId ?? null,
    [COLS.PAYMENTS.REPORT_ID]: payment.reportId ?? null,
    [COLS.PAYMENTS.TIER]: payment.tier,
    [COLS.PAYMENTS.AMOUNT_CENTS]: payment.amountCents,
    [COLS.PAYMENTS.CURRENCY]: payment.currency || 'usd',
    [COLS.PAYMENTS.STRIPE_SESSION_ID]: payment.stripeSessionId,
    [COLS.PAYMENTS.STRIPE_PAYMENT_INTENT]: payment.stripePaymentIntent ?? null,
    [COLS.PAYMENTS.CUSTOMER_EMAIL]: payment.customerEmail ?? null,
    [COLS.PAYMENTS.STATUS]: payment.status || 'paid',
  };

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${TABLES.PAYMENTS}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
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
 * Fetch a report by its public id. Mock-only for now; will read
 * SCAN_RESULTS (+ BUSINESSES) from Supabase when wired.
 *
 * @param {object} env - Worker env
 * @param {string} reportId - public report token
 * @param {object} mockReports - id -> report JSON map (imported by worker)
 * @returns {Promise<object|null>}
 */
export async function getReport(env, reportId, mockReports) {
  if (!READY) {
    return mockReports[reportId] || null;
  }
  // Real path (uncomment/adapt after schema confirmed):
  // const res = await fetch(
  //   `${env.SUPABASE_URL}/rest/v1/${TABLES.SCAN_RESULTS}?` +
  //     `${COLS.SCAN_RESULTS.REPORT_ID}=eq.${encodeURIComponent(reportId)}&select=*`,
  //   { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${env.SUPABASE_ANON_KEY}` } }
  // );
  // const [scan] = await res.json();
  // ... join BUSINESSES, shape into report JSON ...
  return mockReports[reportId] || null;
}
