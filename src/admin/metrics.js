// src/admin/metrics.js — pure helpers for the /admin dashboard: escaping, formatting, period
// maths, the money summary, fixed-rule engine verdicts, the activity feed and form parsing.
// No I/O. Unit-tested in src/admin/test/.

export const TZ = 'America/New_York';

/** HTML-escape anything (business names, errors and emails are untrusted). */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** "$12.34"; amounts under $1 keep 4 decimals ("$0.0412") so per-call costs stay readable. */
export function usd(value, { precise = false } = {}) {
  const n = num(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const digits = precise || (abs > 0 && abs < 1) ? 4 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${n < 0 ? '−' : ''}$${s}`;
}

/** 0.1234 → "12%" (one decimal under 10%). */
export function pct(value) {
  const n = num(value);
  if (n == null) return '—';
  const p = n * 100;
  return `${p !== 0 && Math.abs(p) < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

/** Calendar date parts in New York time → "YYYY-MM-DD". */
export function nyDate(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Start of the current day / ISO week (Monday) / month in New York, as "YYYY-MM-DD" (matches v_money). */
export function periodStarts(now = new Date()) {
  const day = nyDate(now);
  const [y, m, d] = day.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const dow = (utc.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(utc.getTime() - dow * 86400000);
  return { day, week: monday.toISOString().slice(0, 10), month: `${day.slice(0, 7)}-01` };
}

const ZERO = { apiSpend: 0, expenses: 0, topups: 0, spent: 0, revenue: 0, net: 0 };

function moneyRow(r) {
  if (!r) return { ...ZERO };
  return {
    apiSpend: num(r.api_spend_usd) || 0,
    expenses: num(r.expenses_usd) || 0,
    topups: num(r.api_topups_usd) || 0,
    spent: num(r.spent_usd) || 0,
    revenue: num(r.revenue_usd) || 0,
    net: num(r.net_usd) || 0,
  };
}

/** v_money rows → { week, month, all } for "this week / this month / all time". */
export function moneySummary(rows = [], now = new Date()) {
  const p = periodStarts(now);
  const find = (period, start) => rows.find((r) => r.period === period && (start == null || String(r.period_start).slice(0, 10) === start));
  return {
    week: moneyRow(find('week', p.week)),
    month: moneyRow(find('month', p.month)),
    all: moneyRow(rows.find((r) => r.period === 'all')),
  };
}

/** Last `n` periods of one kind from v_money, oldest first, gaps filled with zero (for the trend strip). */
export function moneySeries(rows = [], period = 'week', n = 8, now = new Date()) {
  const p = periodStarts(now);
  const starts = [];
  const [y, m, d] = (period === 'month' ? p.month : p.week).split('-').map(Number);
  for (let i = n - 1; i >= 0; i--) {
    const dt = period === 'month' ? new Date(Date.UTC(y, m - 1 - i, 1)) : new Date(Date.UTC(y, m - 1, d - 7 * i));
    starts.push(dt.toISOString().slice(0, 10));
  }
  return starts.map((start) => ({ start, ...moneyRow(rows.find((r) => r.period === period && String(r.period_start).slice(0, 10) === start)) }));
}

const times = (x) => `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Plain-English verdict per engine from fixed rules (no model). First matching rule wins.
 * rows: v_engine_value rows. → rows plus { verdict, tone: 'good'|'warn'|'bad'|'neutral', costRatio }.
 */
export function engineVerdicts(rows = []) {
  const priced = rows.filter((r) => num(r.cost_per_answer_usd) != null && (num(r.ok_calls) || 0) > 0);
  const avg = priced.length ? priced.reduce((s, r) => s + num(r.cost_per_answer_usd), 0) / priced.length : null;
  return rows.map((r) => {
    const calls = num(r.calls) || 0;
    const scans = num(r.scans) || 0;
    const okRate = num(r.ok_rate);
    const cpa = num(r.cost_per_answer_usd);
    const unique = num(r.unique_competitors) || 0;
    const namedAny = num(r.named_any_rate);
    const headline = num(r.headline_share);
    const ratio = avg && cpa != null && avg > 0 ? cpa / avg : null;
    const inScans = `in the last ${plural(scans, 'scan')}`;
    let verdict;
    let tone;
    if (calls < 5) {
      verdict = `Not enough data yet: ${plural(calls, 'call')} so far.`;
      tone = 'neutral';
    } else if (okRate != null && okRate < 0.8) {
      verdict = `Unreliable: ${pct(1 - okRate)} of its calls failed ${inScans}.`;
      tone = 'bad';
    } else if (ratio != null && ratio >= 2 && unique === 0) {
      verdict = `Costs ${times(ratio)} the average per answer and surfaced no unique competitors ${inScans}.`;
      tone = 'bad';
    } else if (headline != null && headline >= 0.25) {
      verdict = `Worth keeping: its answer was the report headline in ${pct(headline)} of reports.`;
      tone = 'good';
    } else if (unique === 0 && namedAny != null && namedAny < 0.5) {
      verdict = `Low value: names a business in only ${pct(namedAny)} of answers and found no unique competitors ${inScans}.`;
      tone = 'warn';
    } else if (ratio != null && ratio >= 2) {
      verdict = `Pricey at ${times(ratio)} the average per answer, but surfaced ${plural(unique, 'competitor')} no other engine named.`;
      tone = 'warn';
    } else if (unique > 0) {
      verdict = `Pulls its weight: ${plural(unique, 'competitor')} only it named, at ${usd(cpa)} per answer.`;
      tone = 'good';
    } else {
      verdict = `Adds little on its own: no unique competitors ${inScans}, ${usd(cpa)} per answer.`;
      tone = 'neutral';
    }
    return { ...r, verdict, tone, costRatio: ratio };
  });
}

/** Recent events from several tables, newest first. Returns plain text (escape when rendering). */
export function activityFeed({ scans = [], requests = [], leads = [], payments = [] } = {}, limit = 25) {
  const items = [];
  for (const s of scans) {
    items.push({
      at: s.started_at || s.created_at, kind: 'scan', tone: s.status === 'failed' ? 'bad' : s.status === 'done' ? 'good' : 'neutral',
      text: `Scan ${s.status || ''}: ${s.business_name || 'unknown business'}${s.total_cost_usd != null ? ` (${usd(s.total_cost_usd)})` : ''}`,
    });
  }
  for (const r of requests) {
    items.push({
      at: r.requested_at, kind: 'request', tone: r.email ? 'good' : 'neutral',
      text: `Report request ${r.email ? 'with email' : 'without email'}: ${r.business_name || '?'}, ${r.town || '?'}${r.trade ? ` (${r.trade})` : ''}`,
    });
  }
  for (const l of leads) {
    items.push({ at: l.created_at, kind: 'lead', tone: 'good', text: `Lead from a report page${l.arm ? ` (${l.arm})` : ''}` });
  }
  for (const p of payments) {
    items.push({
      at: p.paid_at, kind: 'payment', tone: p.livemode === false ? 'neutral' : 'good',
      text: `${p.livemode === false ? 'Test payment' : 'Payment'}: ${usd((num(p.amount_cents) || 0) / 100)} ${p.tier || ''}${p.arm ? ` (${p.arm})` : ''}`.trim(),
    });
  }
  return items
    .filter((i) => i.at)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, limit);
}

export const EXPENSE_CATEGORIES = {
  postcards: 'Postcards / Lob',
  email: 'Email sending',
  domain: 'Domain',
  hosting: 'Cloudflare plan',
  database: 'Supabase plan',
  api_topup: 'API credit top-up',
  software: 'Other software',
  other: 'Other',
};

/** Validate the "Add expense" form. → { ok, row } | { ok: false, error } */
export function parseExpenseForm(f = {}, now = new Date()) {
  const category = String(f.category || '').trim();
  if (!EXPENSE_CATEGORIES[category]) return { ok: false, error: 'Pick a category.' };
  const amount = Number(String(f.amount_usd ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 100000) return { ok: false, error: 'Amount must be between $0.01 and $99,999.' };
  const spentOn = String(f.spent_on || '').trim() || nyDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || Number.isNaN(Date.parse(`${spentOn}T00:00:00Z`))) return { ok: false, error: 'Date must be YYYY-MM-DD.' };
  if (spentOn > nyDate(new Date(now.getTime() + 86400000))) return { ok: false, error: 'Date is in the future.' };
  return {
    ok: true,
    row: {
      spent_on: spentOn,
      category,
      vendor: String(f.vendor || '').trim().slice(0, 80) || null,
      description: String(f.description || '').trim().slice(0, 300) || null,
      amount_usd: Math.round(amount * 100) / 100,
    },
  };
}

/** The "Run scan" form (flat fields, engines as repeated values) → a parseScanRequest body. */
export function scanFormToBody(fields = {}, engines = []) {
  return {
    business: {
      name: fields.business_name, trade: fields.trade, address: fields.address, town: fields.town,
      state: fields.state || 'NY', zip: fields.zip, phone: fields.phone, website: fields.website,
    },
    engines,
    runs: fields.runs,
    questions: fields.questions,
    trigger: fields.trigger,
    notes: fields.notes,
  };
}

/** "Sep 24, 5:01pm" in New York time. */
export function shortTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    .format(d).replace(/[\s\u202f]*(AM|PM)/, (_, x) => x.toLowerCase());
}
