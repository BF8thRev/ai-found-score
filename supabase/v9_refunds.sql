-- v9: Stripe refunds and lost disputes take back what the payment unlocked. Safe to re-run.
-- Apply after v8_be_the_answer.sql, and BEFORE deploying the Worker that reads these columns
-- (every payments read filters on revoked_at; without the column those reads fail).
--
-- payments.stripe_payment_intent  the checkout's PaymentIntent: how a charge.refunded or
--                                  charge.dispute.closed event finds its payment row
-- payments.refunded_cents         total refunded so far (Stripe's charge.amount_refunded)
-- payments.refunded_at            when the latest refund landed (money out on that day in v_money)
-- payments.revoked_at             set on a full refund or a lost dispute: the payment no longer
--                                 unlocks the report, the Fix Kit or the plan, and no re-check or
--                                 monthly scan is started for it. A partial refund keeps access
--                                 (except a refunded $25 Competitor Breakdown add-on, which the
--                                 Worker removes from payments.addons).
-- report_unlocked(token)          as v8, ignoring revoked payments
-- channel_funnel, v_money,        revenue net of refunds; revoked payments don't count as paying
-- v_mvp_gates

alter table public.payments add column if not exists stripe_payment_intent text;
alter table public.payments add column if not exists refunded_cents int4 not null default 0;
alter table public.payments add column if not exists refunded_at timestamptz;
alter table public.payments add column if not exists revoked_at timestamptz;
create index if not exists payments_stripe_payment_intent_idx on public.payments(stripe_payment_intent);

create or replace function public.report_unlocked(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.payments
    where report_token = p_token
      and revoked_at is null
      and coalesce(tier, 'unknown') <> 'competitor_breakdown'
      and not (coalesce(tier, 'unknown') = 'unknown' and amount_cents = 2500)
  ) or exists (
    select 1 from public.plan_towns t
    join public.payments p on p.report_token = t.report_token
    where t.town_token = p_token
      and p.revoked_at is null
      and (p.tier = 'be_the_answer' or (coalesce(p.tier, 'unknown') = 'unknown' and p.amount_cents = 49900))
  );
$$;
revoke all on function public.report_unlocked(text) from public, authenticated;
grant execute on function public.report_unlocked(text) to anon;

-- Revenue views (setup.sql, admin_v3.sql), refunds netted out.
create or replace view public.channel_funnel with (security_invoker = true) as
select
  l.arm,
  count(*)                                                                         as recipients,
  count(*) filter (where exists (select 1 from public.page_visits v where v.report_token = l.report_token)) as visited,
  count(*) filter (where exists (select 1 from public.leads le where le.report_token = l.report_token))     as leads,
  count(*) filter (where exists (select 1 from public.payments p where p.report_token = l.report_token and p.livemode and p.revoked_at is null)) as paying,
  coalesce(sum((select sum(coalesce(p.amount_cents, 0) - coalesce(p.refunded_cents, 0)) from public.payments p where p.report_token = l.report_token and p.livemode)), 0) / 100.0 as revenue_usd
from public.report_links l
group by l.arm;
revoke all on public.channel_funnel from anon, authenticated;

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
  where livemode and revoked_at is null and arm in ('email_a', 'email_b')
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

revoke all on public.v_money, public.v_mvp_gates from anon, authenticated;
