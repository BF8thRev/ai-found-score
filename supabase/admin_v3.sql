-- AI Found Score — cost & business tracking for the admin dashboard (/admin).
-- Paste into the Supabase SQL editor and run AFTER setup.sql and scan_v2.sql. Safe to re-run.
--
-- scans       one row per scan (= scan_id in scan_raw / scan_results), written by the scan workflow
-- scan_usage  one row per paid API call that is NOT an engine answer (extractor calls, pings)
-- expenses    manual costs (postcards, domain, Cloudflare/Supabase plans, API credit top-ups)
-- v_*         read-outs for the dashboard
--
-- Everything here is service-key only: RLS on with no policies, and every grant revoked from
-- anon/authenticated. Views are security_invoker so they can never widen access.

-- ---------------------------------------------------------------------------
-- scans
-- ---------------------------------------------------------------------------
create table if not exists public.scans (
  id               uuid primary key,              -- = scan_id (also the Workflow instance id)
  business_id      uuid,                          -- businesses.id when known (no FK: a scan row must never be lost)
  business_name    text,                          -- copy, so the dashboard reads without a join
  report_token     text,
  status           text not null default 'queued',
  engines          text[] not null default '{}',
  runs             int  not null default 1,
  questions        int  not null default 5,
  started_at       timestamptz,
  finished_at      timestamptz,
  calls_total      int  not null default 0,
  calls_ok         int  not null default 0,
  engine_cost_usd  numeric(10, 6) not null default 0,
  extract_cost_usd numeric(10, 6) not null default 0,
  total_cost_usd   numeric(10, 6) not null default 0,
  named_you        int,
  first_you        int,
  answers          int,
  report_valid     boolean,
  errors           jsonb not null default '[]'::jsonb,
  trigger          text not null default 'admin',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.scans add column if not exists business_name text;
alter table public.scans add column if not exists updated_at timestamptz not null default now();

alter table public.scans drop constraint if exists scans_status_check;
alter table public.scans add constraint scans_status_check check (status in ('queued', 'running', 'done', 'failed'));
alter table public.scans drop constraint if exists scans_trigger_check;
alter table public.scans add constraint scans_trigger_check check (trigger in ('admin', 'request', 'recheck'));

create index if not exists scans_started_at_idx  on public.scans(started_at desc);
create index if not exists scans_business_id_idx on public.scans(business_id, started_at desc);

create or replace function public.scans_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists scans_touch on public.scans;
create trigger scans_touch before update on public.scans for each row execute function public.scans_touch();
revoke all on function public.scans_touch() from public, anon, authenticated;

alter table public.scans enable row level security;
revoke all on public.scans from anon, authenticated;

-- ---------------------------------------------------------------------------
-- scan_usage
-- ---------------------------------------------------------------------------
create table if not exists public.scan_usage (
  id            uuid primary key default gen_random_uuid(),
  scan_id       uuid,                               -- null for calls outside a scan (e.g. /api/admin/ping)
  kind          text not null default 'extract',
  provider      text not null,                      -- anthropic, openai, ...
  model         text,
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  searches      int not null default 0,
  cost_usd      numeric(10, 6) not null default 0,
  ok            boolean not null default true,
  error         text,
  answer_ref    text,                               -- engine:question:run of the answer it extracted
  created_at    timestamptz not null default now()
);
alter table public.scan_usage drop constraint if exists scan_usage_kind_check;
alter table public.scan_usage add constraint scan_usage_kind_check check (kind in ('extract', 'ping', 'listing', 'other'));
create index if not exists scan_usage_scan_id_idx    on public.scan_usage(scan_id);
create index if not exists scan_usage_created_at_idx on public.scan_usage(created_at desc);

alter table public.scan_usage enable row level security;
revoke all on public.scan_usage from anon, authenticated;

-- ---------------------------------------------------------------------------
-- expenses (entered by hand on /admin)
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id          uuid primary key default gen_random_uuid(),
  spent_on    date not null default current_date,
  category    text not null,
  vendor      text,
  description text,
  amount_usd  numeric(10, 2) not null,
  created_at  timestamptz not null default now()
);
alter table public.expenses drop constraint if exists expenses_category_check;
alter table public.expenses add constraint expenses_category_check
  check (category in ('postcards', 'email', 'domain', 'hosting', 'database', 'api_topup', 'software', 'other'));
alter table public.expenses drop constraint if exists expenses_amount_check;
alter table public.expenses add constraint expenses_amount_check check (amount_usd >= 0 and amount_usd < 100000);
create index if not exists expenses_spent_on_idx on public.expenses(spent_on desc);

alter table public.expenses enable row level security;
revoke all on public.expenses from anon, authenticated;

-- ---------------------------------------------------------------------------
-- v_scan_costs: one row per scan (scans rows, plus older CLI scans that only have scan_raw),
-- with the per-engine breakdown from scan_raw and extraction from scan_usage.
-- ---------------------------------------------------------------------------
create or replace view public.v_scan_costs with (security_invoker = true) as
with ids as (
  select id as scan_id from public.scans
  union
  select distinct scan_id from public.scan_raw
),
eng as (
  select scan_id, engine, count(*) as calls, count(*) filter (where ok) as ok_calls,
         sum(cost_usd) as cost_usd, min(asked_at) as first_at
  from public.scan_raw group by scan_id, engine
),
eng_agg as (
  select scan_id,
         sum(cost_usd) as engine_cost_usd,
         sum(calls) as calls, sum(ok_calls) as ok_calls,
         min(first_at) as first_call_at,
         array_agg(engine order by engine) as engines,
         jsonb_object_agg(engine, jsonb_build_object('calls', calls, 'ok', ok_calls, 'cost_usd', round(cost_usd, 6))) as per_engine
  from eng
  group by scan_id
),
ext as (
  select scan_id, count(*) as extract_calls, count(*) filter (where not ok) as extract_failed, sum(cost_usd) as extract_cost_usd
  from public.scan_usage where scan_id is not null group by scan_id
),
rep as (
  select distinct on (scan_id) scan_id, report_token, business_id,
         (report->'totals'->>'answers')::int  as answers,
         (report->'totals'->>'namedYou')::int as named_you,
         (report->'totals'->>'firstYou')::int as first_you,
         report->'business'->>'name' as business_name
  from public.scan_results where version = 2 and scan_id is not null
  order by scan_id, scanned_at desc
)
select
  ids.scan_id,
  coalesce(s.business_id, rep.business_id)                         as business_id,
  coalesce(s.business_name, rep.business_name, b.name)             as business_name,
  coalesce(s.status, 'done')                                      as status,
  coalesce(s.trigger, 'admin')                                     as trigger,
  coalesce(s.started_at, ea.first_call_at)                         as started_at,
  s.finished_at,
  coalesce(s.report_token, rep.report_token)                       as report_token,
  (rep.scan_id is not null)                                        as report_saved,
  s.report_valid,
  coalesce(s.engines, ea.engines)                                  as engines,
  s.runs,
  greatest(coalesce(s.calls_total, 0), coalesce(ea.calls, 0))::int  as calls_total,
  coalesce(ea.ok_calls, 0)::int                                    as calls_ok,
  coalesce(s.answers, rep.answers)                                 as answers,
  coalesce(s.named_you, rep.named_you)                             as named_you,
  coalesce(s.first_you, rep.first_you)                             as first_you,
  round(coalesce(ea.engine_cost_usd, 0), 6)                        as engine_cost_usd,
  round(coalesce(ext.extract_cost_usd, 0), 6)                      as extract_cost_usd,
  round(coalesce(ea.engine_cost_usd, 0) + coalesce(ext.extract_cost_usd, 0), 6) as total_cost_usd,
  coalesce(ea.per_engine, '{}'::jsonb)                             as per_engine,
  coalesce(ext.extract_calls, 0)::int                              as extract_calls,
  coalesce(ext.extract_failed, 0)::int                             as extract_failed,
  coalesce(s.errors, '[]'::jsonb)                                  as errors
from ids
left join public.scans s   on s.id = ids.scan_id
left join eng_agg ea       on ea.scan_id = ids.scan_id
left join ext              on ext.scan_id = ids.scan_id
left join rep              on rep.scan_id = ids.scan_id
left join public.businesses b on b.id = coalesce(s.business_id, rep.business_id);

-- ---------------------------------------------------------------------------
-- v_engine_value: per engine across every scan.
--   cost + reliability from scan_raw; what the answers did from the stored v2 reports.
--   unique_competitors: competitors (not the owner) that, within one report, only this engine named.
--   headlines: times this engine's answer was the report headline.
-- ---------------------------------------------------------------------------
create or replace view public.v_engine_value with (security_invoker = true) as
with raw as (
  select engine,
         count(*) as calls,
         count(*) filter (where ok) as ok_calls,
         sum(cost_usd) as cost_usd,
         count(distinct scan_id) as scans
  from public.scan_raw group by engine
),
rep as (
  select distinct on (report_token) report_token, report
  from public.scan_results
  where version = 2 and report is not null
  order by report_token, scanned_at desc
),
ans as (
  select r.report_token,
         a->>'engine' as engine,
         coalesce((a->>'namedYou')::boolean, false) as named_you,
         coalesce((a->>'namedYouFirst')::boolean, false) as first_you,
         jsonb_array_length(coalesce(a->'businessesNamed', '[]'::jsonb)) as n_named,
         (r.report->'headline'->>'answerId') is not distinct from (a->>'id') as is_headline
  from rep r
  cross join lateral jsonb_array_elements(coalesce(r.report->'answers', '[]'::jsonb)) a
),
ment as (
  select r.report_token, a->>'engine' as engine, coalesce(b->>'entityId', lower(b->>'name')) as ent
  from rep r
  cross join lateral jsonb_array_elements(coalesce(r.report->'answers', '[]'::jsonb)) a
  cross join lateral jsonb_array_elements(coalesce(a->'businessesNamed', '[]'::jsonb)) b
  where coalesce((b->>'isYou')::boolean, false) = false
),
uniq as (
  select engine, count(*) as unique_competitors
  from (
    select report_token, ent, min(engine) as engine
    from ment group by report_token, ent
    having count(distinct engine) = 1
  ) u
  group by engine
),
agg as (
  select engine,
         count(*) as answers,
         count(*) filter (where named_you) as named_you,
         count(*) filter (where first_you) as first_you,
         count(*) filter (where n_named > 0) as named_any,
         count(*) filter (where is_headline) as headlines,
         count(distinct report_token) as reports
  from ans group by engine
),
engines as (
  select engine from raw union select engine from agg
),
tot as (
  select count(*) filter (where report->'headline'->>'answerId' is not null) as reports_with_headline from rep
)
select
  e.engine,
  coalesce(raw.scans, 0)::int                                            as scans,
  coalesce(raw.calls, 0)::int                                            as calls,
  coalesce(raw.ok_calls, 0)::int                                         as ok_calls,
  case when coalesce(raw.calls, 0) > 0 then round(raw.ok_calls::numeric / raw.calls, 4) end as ok_rate,
  round(coalesce(raw.cost_usd, 0), 6)                                    as total_cost_usd,
  case when coalesce(raw.ok_calls, 0) > 0 then round(raw.cost_usd / raw.ok_calls, 6) end as cost_per_answer_usd,
  coalesce(agg.answers, 0)::int                                          as answers,
  case when coalesce(agg.answers, 0) > 0 then round(agg.named_you::numeric / agg.answers, 4) end as owner_named_rate,
  case when coalesce(agg.answers, 0) > 0 then round(agg.first_you::numeric / agg.answers, 4) end as owner_first_rate,
  case when coalesce(agg.answers, 0) > 0 then round(agg.named_any::numeric / agg.answers, 4) end as named_any_rate,
  coalesce(uniq.unique_competitors, 0)::int                              as unique_competitors,
  coalesce(agg.headlines, 0)::int                                        as headlines,
  coalesce(agg.reports, 0)::int                                          as reports,
  case when tot.reports_with_headline > 0 then round(coalesce(agg.headlines, 0)::numeric / tot.reports_with_headline, 4) end as headline_share
from engines e
left join raw  on raw.engine = e.engine
left join agg  on agg.engine = e.engine
left join uniq on uniq.engine = e.engine
cross join tot;

-- ---------------------------------------------------------------------------
-- v_money: money in and out by day / week / month (America/New_York) plus an 'all' row.
--   api_spend_usd  metered API cost (scan_raw engine calls + scan_usage extractor/ping calls)
--   expenses_usd   manual expenses except API credit top-ups
--   api_topups_usd prepaid API credits bought (cash out; NOT added to spent, the metered
--                  cost above already counts what the credits were used for)
--   revenue_usd    live Stripe payments only (livemode = true)
--   net_usd        revenue - api spend - expenses
-- ---------------------------------------------------------------------------
create or replace view public.v_money with (security_invoker = true) as
with ev as (
  select (asked_at at time zone 'America/New_York')::date as d, cost_usd as api, 0::numeric as exp, 0::numeric as topup, 0::numeric as rev
    from public.scan_raw
  union all
  select (created_at at time zone 'America/New_York')::date, cost_usd, 0, 0, 0 from public.scan_usage
  union all
  select spent_on,
         0,
         case when category = 'api_topup' then 0 else amount_usd end,
         case when category = 'api_topup' then amount_usd else 0 end,
         0
    from public.expenses
  union all
  select (paid_at at time zone 'America/New_York')::date, 0, 0, 0, coalesce(amount_cents, 0) / 100.0
    from public.payments where livemode
),
periods as (
  select 'day'::text as period, d as period_start, api, exp, topup, rev from ev
  union all select 'week',  date_trunc('week',  d)::date, api, exp, topup, rev from ev
  union all select 'month', date_trunc('month', d)::date, api, exp, topup, rev from ev
  union all select 'all',   null::date, api, exp, topup, rev from ev
)
select period,
       period_start,
       round(sum(api), 6)                           as api_spend_usd,
       round(sum(exp), 2)                           as expenses_usd,
       round(sum(topup), 2)                         as api_topups_usd,
       round(sum(api) + sum(exp), 6)                as spent_usd,
       round(sum(rev), 2)                           as revenue_usd,
       round(sum(rev) - sum(api) - sum(exp), 6)     as net_usd
from periods
group by period, period_start;

-- ---------------------------------------------------------------------------
-- v_kpis: one row of headline numbers (cost per scan / per report).
-- ---------------------------------------------------------------------------
create or replace view public.v_kpis with (security_invoker = true) as
select
  count(*)::int                                                       as scans,
  count(*) filter (where status = 'done')::int                        as scans_done,
  count(*) filter (where report_saved)::int                           as reports_saved,
  round(coalesce(sum(total_cost_usd), 0), 6)                          as scan_cost_usd,
  case when count(*) > 0 then round(sum(total_cost_usd) / count(*), 6) end as avg_cost_per_scan_usd,
  case when count(*) filter (where report_saved) > 0
       then round(sum(total_cost_usd) / count(*) filter (where report_saved), 6) end as cost_per_report_usd,
  coalesce(sum(answers), 0)::int                                      as answers
from public.v_scan_costs;

-- ---------------------------------------------------------------------------
-- v_funnel: the channel test funnel per arm, with rates.
-- ---------------------------------------------------------------------------
create or replace view public.v_funnel with (security_invoker = true) as
select arm,
       recipients,
       visited,
       leads,
       paying,
       round(revenue_usd, 2) as revenue_usd,
       case when recipients > 0 then round(visited::numeric / recipients, 4) end as visit_rate,
       case when recipients > 0 then round(leads::numeric   / recipients, 4) end as lead_rate,
       case when recipients > 0 then round(paying::numeric  / recipients, 4) end as pay_rate
from public.channel_funnel;

-- ---------------------------------------------------------------------------
-- v_mvp_gates: the plan's MVP gates, target vs actual.
-- ---------------------------------------------------------------------------
create or replace view public.v_mvp_gates with (security_invoker = true) as
with latest as (
  -- latest v2 report per business (or per token when the business is unknown)
  select distinct on (coalesce(business_id::text, report_token))
         (report->'totals'->>'answers')::int  as answers,
         (report->'totals'->>'namedYou')::int as named_you
  from public.scan_results
  where version = 2 and report is not null
  order by coalesce(business_id::text, report_token), scanned_at desc
),
unnamed as (
  select count(*) filter (where answers > 0) as scanned,
         count(*) filter (where answers > 0 and named_you * 2 < answers) as unnamed_most
  from latest
),
mail as (
  select count(*) filter (where sent_at is not null)    as sent,
         count(*) filter (where replied_at is not null) as replied
  from public.email_events
),
paid as (
  select count(*) as paying
  from public.payments
  where livemode and arm in ('email_a', 'email_b')
)
select 1 as sort, 'unnamed_most'::text as gate,
       'Scanned businesses unnamed in most answers'::text as label,
       0.60::numeric as target, '60% or more'::text as target_label,
       case when u.scanned > 0 then round(u.unnamed_most::numeric / u.scanned, 4) end as actual,
       u.unnamed_most || ' of ' || u.scanned || ' businesses' as detail,
       case when u.scanned > 0 then u.unnamed_most::numeric / u.scanned >= 0.60 end as met
from unnamed u
union all
select 2, 'email_reply_rate', 'Email reply rate',
       0.03, '3% or more',
       case when m.sent > 0 then round(m.replied::numeric / m.sent, 4) end,
       m.replied || ' replies to ' || m.sent || ' emails',
       case when m.sent > 0 then m.replied::numeric / m.sent >= 0.03 end
from mail m
union all
select 3, 'payments_per_300_emails', 'Payments from email (per 300 sent)',
       2, '2 per 300 emails',
       case when m.sent > 0 then round(p.paying::numeric * 300 / m.sent, 2) end,
       p.paying || ' live payments from ' || m.sent || ' emails',
       case when m.sent >= 300 then p.paying::numeric * 300 / m.sent >= 2 end
from mail m cross join paid p
union all
select 4, 'recheck_listed', 'Friendly businesses listed on every cited site within 30 days',
       3, '3 of 5', null::numeric, 'not tracked yet (re-check flow not built)', null::boolean;

-- ---------------------------------------------------------------------------
-- Lock every new object to the service key.
-- ---------------------------------------------------------------------------
revoke all on public.v_scan_costs, public.v_engine_value, public.v_money, public.v_kpis,
              public.v_funnel, public.v_mvp_gates
  from anon, authenticated;
