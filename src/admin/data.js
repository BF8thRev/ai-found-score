// src/admin/data.js — server-side reads for /admin, through the Supabase service key.
// Every view/table used here is service-key only (supabase/admin_v3.sql, setup.sql). Nothing
// read here is ever sent to a browser except as escaped HTML on the authenticated page.

import { resolveKeys } from '../../scanner/config.js';
import { redact } from './redact.js';

function supa(env) {
  const k = resolveKeys(env);
  if (!k.supabaseUrl || !k.supabaseServiceKey) return null;
  return {
    base: `${k.supabaseUrl}/rest/v1`,
    headers: { apikey: k.supabaseServiceKey, Authorization: `Bearer ${k.supabaseServiceKey}`, 'Content-Type': 'application/json' },
  };
}

async function get(env, s, path) {
  const res = await fetch(`${s.base}/${path}`, { headers: s.headers });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    // PostgREST's "relation does not exist" → the SQL hasn't been applied yet.
    if (res.status === 404 || /does not exist|PGRST205|schema cache/i.test(text)) {
      throw new Error(`${path.split('?')[0]} not found — apply supabase/admin_v3.sql`);
    }
    throw new Error(`${path.split('?')[0]}: HTTP ${res.status} ${redact(env, text, 200)}`);
  }
  return res.json();
}

const QUERIES = {
  money: 'v_money?select=*',
  kpis: 'v_kpis?select=*',
  scans: 'v_scan_costs?select=*&order=started_at.desc.nullslast&limit=30',
  engines: 'v_engine_value?select=*&order=engine.asc',
  funnel: 'v_funnel?select=*&order=arm.asc',
  gates: 'v_mvp_gates?select=*&order=sort.asc',
  expenses: 'expenses?select=*&order=spent_on.desc,created_at.desc&limit=10',
  requests: 'report_requests?select=business_name,town,trade,email,requested_at&order=requested_at.desc&limit=10',
  leads: 'leads?select=arm,status,created_at&order=created_at.desc&limit=10',
  payments: 'payments?select=tier,amount_cents,arm,livemode,paid_at&order=paid_at.desc&limit=10',
};

/**
 * Everything the dashboard shows, read in parallel. A failed read never breaks the page:
 * that section gets an error message instead ({ data: {...}, errors: { key: message } }).
 */
export async function loadDashboard(env) {
  const s = supa(env);
  if (!s) return { configured: false, data: {}, errors: {} };
  const keys = Object.keys(QUERIES);
  const settled = await Promise.allSettled(keys.map((k) => get(env, s, QUERIES[k])));
  const data = {};
  const errors = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') data[keys[i]] = r.value;
    else errors[keys[i]] = redact(env, r.reason?.message || r.reason, 300);
  });
  data.kpis = Array.isArray(data.kpis) ? data.kpis[0] || null : null;
  return { configured: true, data, errors };
}

/** Insert one expense row (already validated by parseExpenseForm). Throws on failure. */
export async function insertExpense(env, row) {
  const s = supa(env);
  if (!s) throw new Error('SUPABASE_SERVICE_KEY is not set');
  const res = await fetch(`${s.base}/expenses`, { method: 'POST', headers: { ...s.headers, Prefer: 'return=minimal' }, body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`expenses insert failed: HTTP ${res.status} ${redact(env, await res.text().catch(() => ''), 200)}`);
}
