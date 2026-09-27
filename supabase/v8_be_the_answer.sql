-- v8: Be the Answer ($499, one year) and the $25 Competitor Breakdown. Safe to re-run.
-- Apply after v7_email.sql.
--
-- scans.trigger 'monthly'   a Be the Answer re-scan (src/lib/auto-scan.js startDueMonthly), and the
--                           first scan of an extra town the owner adds (src/lib/plan-route.js)
-- plan_towns                the extra towns on a Be the Answer plan (up to 2, plus the report's own
--                           town). Each gets its own report token, scanned every month with the plan.
-- report_unlocked(token)    a payment unlocks the full report, except the $25 Competitor Breakdown
--                           on its own (it is an add-on to the audit, never a way into it). A town
--                           token is unlocked by its plan's Be the Answer payment.

alter table public.scans drop constraint if exists scans_trigger_check;
alter table public.scans add constraint scans_trigger_check
  check (trigger in ('admin', 'request', 'recheck', 'paid', 'monthly'));

create table if not exists public.plan_towns (
  id            uuid primary key default gen_random_uuid(),
  report_token  text not null,          -- the plan's own report (the one Be the Answer was bought on)
  town_token    text not null unique,   -- this town's report token
  town          text not null,
  state         text not null,
  zip           text,
  created_at    timestamptz not null default now()
);
create index if not exists plan_towns_report_token_idx on public.plan_towns(report_token);

-- Service key only (the Worker reads and writes it server-side).
alter table public.plan_towns enable row level security;
revoke all on public.plan_towns from anon, authenticated;

create or replace function public.report_unlocked(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.payments
    where report_token = p_token
      and coalesce(tier, 'unknown') <> 'competitor_breakdown'
      and not (coalesce(tier, 'unknown') = 'unknown' and amount_cents = 2500)
  ) or exists (
    select 1 from public.plan_towns t
    join public.payments p on p.report_token = t.report_token
    where t.town_token = p_token
      and (p.tier = 'be_the_answer' or (coalesce(p.tier, 'unknown') = 'unknown' and p.amount_cents = 49900))
  );
$$;
revoke all on function public.report_unlocked(text) from public, authenticated;
grant execute on function public.report_unlocked(text) to anon;
