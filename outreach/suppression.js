// Suppression check: must pass before every postcard or email.
//
// Runtime-agnostic ES module. Reads Supabase over REST with the service key
// (env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY). Never reads process.env.
//
// A row in `unsubscribes` suppresses:
//   - that email address (case-insensitive), and
//   - the business behind that report token, for mail and email: every
//     report_links token that shares its business_id counts (README:
//     "a token row suppresses that business for mail and email").
// `unsubscribes` has no business_id column, so businessId is resolved to its
// report tokens through `report_links`.
//
// Fails closed: any lookup error throws. Callers treat a throw as "do not send".

function headers(env) {
  const key = String(env.SUPABASE_SERVICE_KEY || '').trim();
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set');
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
}

async function get(env, fetchImpl, table, query) {
  const base = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not set');
  const res = await fetchImpl(`${base}/rest/v1/${table}?${query}`, { headers: headers(env) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${table} failed: ${res.status} ${body}`.trim());
  }
  return res.json();
}

// PostgREST filter value in double quotes (safe for commas, dots, parens).
const quote = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// ilike without wildcards: escape % and _ so the match is exact but case-insensitive.
const exactIlike = (v) => String(v).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

/**
 * isSuppressed(env, { email?, reportToken?, businessId? }, fetchImpl?) → Promise<boolean>
 */
export async function isSuppressed(env, { email, reportToken, businessId } = {}, fetchImpl = globalThis.fetch) {
  const addr = String(email || '').trim();
  const token = String(reportToken || '').trim();
  let biz = String(businessId || '').trim();
  if (!addr && !token && !biz) throw new Error('isSuppressed needs an email, reportToken or businessId');

  const tokens = new Set(token ? [token] : []);
  if (token && !biz) {
    const rows = await get(env, fetchImpl, 'report_links',
      `report_token=eq.${encodeURIComponent(token)}&select=business_id&limit=1`);
    biz = (rows[0] && rows[0].business_id) || '';
  }
  if (biz) {
    const rows = await get(env, fetchImpl, 'report_links',
      `business_id=eq.${encodeURIComponent(biz)}&select=report_token`);
    for (const r of rows) if (r.report_token) tokens.add(r.report_token);
  }

  const ors = [];
  if (addr) ors.push(`email.ilike.${quote(exactIlike(addr))}`);
  if (tokens.size) ors.push(`report_token.in.(${[...tokens].map(quote).join(',')})`);
  if (!ors.length) return false;
  const rows = await get(env, fetchImpl, 'unsubscribes',
    `select=id&limit=1&or=${encodeURIComponent(`(${ors.join(',')})`)}`);
  return rows.length > 0;
}
