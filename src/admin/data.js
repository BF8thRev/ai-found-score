// src/admin/data.js — server-side reads for /admin, through the Supabase service key.
// Every view/table used here is service-key only (supabase/admin_v3.sql, setup.sql). Nothing
// read here is ever sent to a browser except as escaped HTML on the authenticated page.

import { resolveKeys } from '../../scanner/config.js';
import { redact } from './redact.js';
import { creditStatus } from '../lib/alerts.js';

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

// PostgREST answers 401 PGRST303 "JWT issued at future" when the key's iat is a moment ahead of the
// clock of whichever Supabase node served the call. The key is fine and the next call passes: retry.
const isClockSkew = (status, text) => status === 401 && /PGRST303|issued at future/i.test(text);

async function get(env, s, path) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${s.base}/${path}`, { headers: s.headers });
    if (res.ok || res.status !== 401 || attempt >= 2) break;
    if (!isClockSkew(res.status, await res.clone().text().catch(() => ''))) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    // PostgREST's "relation does not exist" → the SQL hasn't been applied yet.
    if (res.status === 404 || /does not exist|PGRST205|schema cache/i.test(text)) {
      const table = path.split('?')[0];
      throw new Error(`${table} not found — apply ${MIGRATION_FOR[table] || 'supabase/admin_v3.sql'}`);
    }
    throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${redact(env, text, 200)}`);
  }
  return res.json();
}

// Which SQL file creates a table/view, for the "not found" message (default admin_v3.sql).
const MIGRATION_FOR = {
  refund_requests: 'supabase/v4_ladder.sql',
  v_gemini_searches: 'supabase/v11_gemini_free_tier.sql',
  v_email_funnel: 'supabase/v12_email_tracking.sql',
  v_email_prospects: 'supabase/v12_email_tracking.sql',
  v_email_timeline: 'supabase/v12_email_tracking.sql',
  sender_state: 'supabase/v13_gmail_sender.sql',
  v_gmail_today: 'supabase/v13_gmail_sender.sql',
  gmail_sends: 'supabase/v13_gmail_sender.sql',
};

const QUERIES = {
  money: 'v_money?select=*',
  kpis: 'v_kpis?select=*',
  scans: 'v_scan_costs?select=*&order=started_at.desc.nullslast&limit=30',
  engines: 'v_engine_value?select=*&order=engine.asc',
  funnel: 'v_funnel?select=*&order=arm.asc',
  gates: 'v_mvp_gates?select=*&order=sort.asc',
  expenses: 'expenses?select=*&order=spent_on.desc,created_at.desc&limit=10',
  requests: 'report_requests?select=business_name,town,trade,email,requested_at&order=requested_at.desc&limit=10',
  // Finished free (request) and paid scans: real cost per report for "Costs and break-even".
  // v_scan_costs, not scans.total_cost_usd: its Gemini cost leaves out the free searches (supabase/v11_gemini_free_tier.sql).
  unitScans: 'v_scan_costs?select=trigger,total_cost_usd&status=eq.done&trigger=in.(request,paid)&total_cost_usd=gt.0&order=started_at.desc.nullslast&limit=200',
  // Gemini search queries this month against the 5,000 free (supabase/v11_gemini_free_tier.sql).
  gemini: 'v_gemini_searches?select=*&order=month.desc&limit=1',
  leads: 'leads?select=arm,status,created_at&order=created_at.desc&limit=10',
  payments: 'payments?select=tier,amount_cents,arm,livemode,paid_at,refunded_cents,revoked_at&order=paid_at.desc&limit=10',
  // Free-report request scans still waiting (queued), in progress (running) or needing a person (failed).
  requestScans: 'scans?select=id,business_name,report_token,status,created_at,started_at,notes,errors&trigger=eq.request&status=in.(queued,running,failed)&order=created_at.desc&limit=30',
  // Refund requests (supabase/v4_ladder.sql). Refunds themselves are done by a person in Stripe.
  refunds: 'refund_requests?select=id,report_token,email,reason,status,created_at&order=created_at.desc&limit=30',
  // The cold-email arm (supabase/v12_email_tracking.sql, src/admin/outreach.js).
  emailFunnel: 'v_email_funnel?select=*&order=arm.asc',
  prospects: 'v_email_prospects?select=*&order=last_event_at.desc.nullslast&limit=1000',
  timeline: 'v_email_timeline?select=token,kind,at,detail&order=at.asc&limit=20000',
  // Businesses to pick from in "Log a sent email" (select=*: businesses.town only exists from v12).
  prospectBusinesses: 'businesses?select=*&order=name.asc&limit=2000',
  // The Gmail sender (supabase/v13_gmail_sender.sql, src/lib/gmail-sender.js).
  gmailState: 'sender_state?select=*&id=eq.gmail',
  gmailToday: 'v_gmail_today?select=*',
  gmailSends: 'gmail_sends?select=created_at,kind,to_email,subject,status,message_id,error&order=created_at.desc&limit=10',
};

/**
 * Everything the dashboard shows, read in parallel. A failed read never breaks the page:
 * that section gets an error message instead ({ data: {...}, errors: { key: message } }).
 */
export async function loadDashboard(env) {
  const s = supa(env);
  if (!s) return { configured: false, data: {}, errors: {} };
  const keys = Object.keys(QUERIES);
  // Credits (src/lib/alerts.js): the red/amber banner at the top. creditStatus never throws.
  const [settled, credits] = await Promise.all([
    Promise.allSettled(keys.map((k) => get(env, s, QUERIES[k]))),
    creditStatus(env).catch(() => []),
  ]);
  const data = {};
  const errors = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else errors[keys[i]] = redact(env, r.reason?.message || r.reason, 300);
  });
  data.kpis = Array.isArray(data.kpis) ? data.kpis[0] || null : null;
  data.credits = credits;
  try {
    data.rechecks = await loadRechecks(env, s);
  } catch (e) {
    errors.rechecks = redact(env, e?.message || e, 300);
  }
  return { configured: true, data, errors };
}

/**
 * The free 30-day re-checks (src/lib/auto-scan.js startDueRechecks), newest first, each with the
 * re-check's totals and the audit's (the report's baseline): who to offer Be the Answer.
 * → [{ id, business_name, report_token, status, created_at, now: {namedYou, answers} | null, before: {…} | null }]
 */
export async function loadRechecks(env, s = supa(env)) {
  if (!s) return [];
  const scans = await get(env, s, 'scans?select=id,business_name,report_token,status,created_at&trigger=eq.recheck&order=created_at.desc&limit=30');
  const ids = scans.map((r) => r.id).filter(Boolean);
  const results = ids.length
    ? await get(env, s, `scan_results?select=scan_id,totals:report->totals,before:report->baseline->totals&scan_id=in.(${ids.join(',')})`)
    : [];
  const byScan = new Map(results.map((r) => [r.scan_id, r]));
  return scans.map((r) => ({ ...r, now: byScan.get(r.id)?.totals || null, before: byScan.get(r.id)?.before || null }));
}

/** Insert one expense row (already validated by parseExpenseForm). Throws on failure. */
export async function insertExpense(env, row) {
  const s = supa(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const res = await fetch(`${s.base}/expenses`, { method: 'POST', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`expenses insert failed: HTTP ${res.status} ${redact(env, await res.text().catch(() => ''), 200)}`);
}

/** Add a prospect to businesses (parseProspectForm row). The exact name already there → that one, not a copy. */
export async function insertProspect(env, row) {
  const s = supa(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  // Exact name, like scanner/store.js ensureBusiness (a scan of the same business finds this row).
  const found = await get(env, s, `businesses?select=id,name&name=eq.${encodeURIComponent(row.name)}&limit=1`);
  if (found[0]) return { id: found[0].id, existing: true };
  const res = await fetch(`${s.base}/businesses`, { method: 'POST', headers: { ...s.headers, Prefer: 'return=representation' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`businesses insert failed: HTTP ${res.status} ${redact(env, await res.text().catch(() => ''), 200)}`);
  const [saved] = await res.json();
  return { id: saved?.id, existing: false };
}

/** A business's town (businesses.town, v12) and its latest saved report token, for a 'sent' row. */
export async function prospectDetails(env, businessId) {
  const s = supa(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const id = encodeURIComponent(businessId);
  const [biz, rep] = await Promise.all([
    get(env, s, `businesses?select=*&id=eq.${id}&limit=1`),
    get(env, s, `scan_results?select=report_token&business_id=eq.${id}&report=not.is.null&report_token=not.is.null&order=scanned_at.desc&limit=1`),
  ]);
  if (!biz[0]) return null;
  return { name: biz[0].name, town: biz[0].town || null, reportToken: rep[0]?.report_token || null };
}
