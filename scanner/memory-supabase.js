// scanner/memory-supabase.js — a tiny in-memory stand-in for the Supabase REST API (PostgREST),
// just enough for scanner/store.js: eq / not.is.null filters, order, limit, upserts on id
// (merge- or ignore-duplicates) and return=representation. Used by `scanner/run.js --dry-run`
// and the tests. Nothing leaves the process.

const CHECKS = {
  scans: {
    status: ['queued', 'running', 'done', 'failed'],
    trigger: ['admin', 'request', 'recheck'],
  },
  scan_usage: { kind: ['extract', 'ping', 'listing', 'other'] },
  report_links: { arm: ['mail', 'email_a', 'email_b'] },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function matches(row, col, cond) {
  const v = row[col];
  if (cond.startsWith('eq.')) return v != null && String(v) === decodeURIComponent(cond.slice(3));
  if (cond === 'not.is.null') return v != null;
  if (cond === 'is.null') return v == null;
  return true; // lt./gt. etc.: not needed by the runner, treated as "match"
}

/**
 * memorySupabase() → { tables, handle(url, init), failNext(table, status?) }
 * `tables` maps table name → array of rows (inspect it in tests).
 */
export function memorySupabase() {
  const tables = {};
  const failures = {};
  const rows = (t) => (tables[t] ||= []);

  async function handle(url, init = {}) {
    const u = new URL(String(url));
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    const method = (init.method || 'GET').toUpperCase();
    if (failures[table]?.length) {
      const status = failures[table].shift();
      return new Response(`memory-supabase: forced failure on ${table}`, { status });
    }
    if (method === 'GET') {
      let out = rows(table).filter((r) => [...u.searchParams].every(([k, v]) =>
        ['select', 'order', 'limit', 'on_conflict'].includes(k) || matches(r, k, v)));
      const order = u.searchParams.get('order');
      if (order) {
        const [col, dir] = order.split(',')[0].split('.');
        out = [...out].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')) * (dir === 'desc' ? -1 : 1));
      }
      const limit = Number(u.searchParams.get('limit'));
      if (limit) out = out.slice(0, limit);
      return json(out.map((r) => structuredClone(r)));
    }
    if (method === 'POST') {
      const prefer = String(init.headers?.Prefer || init.headers?.prefer || '');
      let body;
      try { body = JSON.parse(init.body); } catch { return new Response('bad json', { status: 400 }); }
      const list = Array.isArray(body) ? body : [body];
      for (const r of list) {
        for (const [col, allowed] of Object.entries(CHECKS[table] || {})) {
          if (r[col] !== undefined && !allowed.includes(r[col])) {
            return new Response(`new row for relation "${table}" violates check constraint "${table}_${col}_check"`, { status: 400 });
          }
        }
      }
      const upsert = u.searchParams.get('on_conflict') === 'id';
      const out = [];
      const now = new Date().toISOString();
      for (const r of list) {
        const existing = upsert && r.id ? rows(table).find((x) => x.id === r.id) : null;
        if (existing) {
          if (/resolution=merge-duplicates/.test(prefer)) Object.assign(existing, structuredClone(r), { updated_at: now });
          out.push(existing);
          continue;
        }
        if (!upsert && r.id && rows(table).some((x) => x.id === r.id)) {
          return new Response(`duplicate key value violates unique constraint "${table}_pkey"`, { status: 409 });
        }
        const row = { id: globalThis.crypto.randomUUID(), created_at: now, ...structuredClone(r) };
        rows(table).push(row);
        out.push(row);
      }
      return /return=representation/.test(prefer) ? json(out.map((r) => structuredClone(r)), 201) : new Response(null, { status: 201 });
    }
    return new Response(`memory-supabase: ${method} not supported`, { status: 405 });
  }

  return {
    tables,
    handle,
    /** Make the next request to `table` fail with `status` (tests). */
    failNext(table, status = 500) { (failures[table] ||= []).push(status); },
  };
}
