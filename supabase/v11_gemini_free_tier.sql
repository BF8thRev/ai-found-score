-- v11: Gemini's free search allowance in /admin costs. Run after admin_v3.sql and v9_refunds.sql (safe to re-run).
--
-- Grounding with Google Search is free for the first 5,000 search queries a month, then $14 / 1k
-- (scanner/config.js PRICES.gemini). Each scan_raw row keeps its list price in cost_usd (the
-- engine can't know the month's count when it prices a call). Here every Gemini row's searches
-- are counted in call order within the month (UTC), and the ones inside the first 5,000 are
-- taken off its cost. The admin views read costs from v_scan_raw_billed instead of scan_raw.

-- One row per scan_raw row. cost_usd = what we're really billed; list_cost_usd = as stored.
create or replace view public.v_scan_raw_billed with (security_invoker = true) as
with q as (
  select r.*,
         case when r.engine <> 'gemini' then 0
              when jsonb_typeof(r.response->'candidates'->0->'groundingMetadata'->'webSearchQueries') = 'array'
                   and jsonb_array_length(r.response->'candidates'->0->'groundingMetadata'->'webSearchQueries') > 0
                then jsonb_array_length(r.response->'candidates'->0->'groundingMetadata'->'webSearchQueries')
              -- Same rule as scanner/engines/gemini.js: citations with no query list count as 1 search.
              when jsonb_typeof(r.response->'candidates'->0->'groundingMetadata'->'groundingChunks') = 'array'
                   and jsonb_array_length(r.response->'candidates'->0->'groundingMetadata'->'groundingChunks') > 0
                then 1
              else 0 end as search_queries
  from public.scan_raw r
),
run as (
  select q.*,
         date_trunc('month', q.asked_at at time zone 'UTC')::date as search_month,
         sum(q.search_queries) over (
           partition by q.engine, date_trunc('month', q.asked_at at time zone 'UTC')
           order by q.asked_at, q.id rows between unbounded preceding and current row
         ) - q.search_queries as queries_before
  from q
)
select id, scan_id, business_id, engine, question_id, question_text, run, model, request, response,
       answer_text, citations, ok, error, asked_at, created_at,
       search_queries,
       search_month,
       greatest(0, least(search_queries, 5000 - queries_before))::int as free_queries,
       cost_usd as list_cost_usd,
       greatest(0, cost_usd - 0.014 * greatest(0, least(search_queries, 5000 - queries_before)))::numeric(12, 6) as cost_usd
from run;

-- Gemini searches per month against the 5,000 free.
create or replace view public.v_gemini_searches with (security_invoker = true) as
select search_month as month,
       sum(search_queries)::int                           as queries,
       least(sum(search_queries), 5000)::int              as free_used,
       greatest(5000 - sum(search_queries), 0)::int       as free_left,
       greatest(sum(search_queries) - 5000, 0)::int       as paid_queries,
       round(sum(list_cost_usd - cost_usd), 6)            as saved_usd
from public.v_scan_raw_billed
where engine = 'gemini'
group by search_month;

-- The admin views, unchanged except that they read v_scan_raw_billed (latest definitions:
-- v_scan_costs and v_engine_value from admin_v3.sql, v_money from v9_refunds.sql).
create or replace view public.v_scan_costs with (security_invoker = true) as
with ids as (
  select id as scan_id from public.scans
  union
  select distinct scan_id from public.scan_raw
),
eng as (
  select scan_id, engine, count(*) as calls, count(*) filter (where ok) as ok_calls,
         sum(cost_usd) as cost_usd, min(asked_at) as first_at
  from public.v_scan_raw_billed group by scan_id, engine
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

create or replace view public.v_engine_value with (security_invoker = true) as
with raw as (
  select engine,
         count(*) as calls,
         count(*) filter (where ok) as ok_calls,
         sum(cost_usd) as cost_usd,
         count(distinct scan_id) as scans
  from public.v_scan_raw_billed group by engine
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

create or replace view public.v_money with (security_invoker = true) as
with ev as (
  select (asked_at at time zone 'America/New_York')::date as d, cost_usd as api, 0::numeric as exp, 0::numeric as topup, 0::numeric as rev
    from public.v_scan_raw_billed
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
  union all
  -- v9: a refund is money out on the day it was refunded.
  select (refunded_at at time zone 'America/New_York')::date, 0, 0, 0, -refunded_cents / 100.0
    from public.payments where livemode and refunded_cents > 0 and refunded_at is not null
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

revoke all on public.v_scan_raw_billed, public.v_gemini_searches, public.v_scan_costs, public.v_engine_value, public.v_money
  from anon, authenticated;
