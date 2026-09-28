-- AI Found Score — v12: cold-email tracking (the "email" arm). Run AFTER v11_gemini_free_tier.sql. Safe to re-run.
--
-- email_events becomes one row per event. A 'sent' row is written by /admin "Log a sent email"
-- (manual Gmail sends) or by the future Gmail API sender, both through src/lib/email-tracking.js.
-- It carries a random token per (business, campaign). The token then rides in:
--   /e/open?token=…           1px image          -> 'opened'
--   /e/click?token=…&to=…     every link          -> 'clicked', then a redirect (aifoundscore.com only)
--   /stop?ref=…               the unsubscribe link -> 'unsubscribed' + an unsubscribes row
-- First event wins: one 'opened' / 'clicked' / 'unsubscribed' per token (unique (token, event)).
--
-- report_requests.ref_token   the attribution token a free-report request arrived with (the afs_ref
--                             cookie /e/click sets, or a ?ref= the form posts). Generic: postcards and
--                             later channels reuse it. Written only when present; never required.
-- businesses.town             prospects added from /admin carry their town.
--
-- Funnel stages are derived, never typed in (v_email_timeline → v_email_prospects → v_email_funnel):
--   sent → opened → clicked → snapshot_started (a report_requests row with the token)
--        → snapshot_completed (a scan_results row for that request's report) → paid (live payment)
-- The legacy columns (sent_at, opened_at, replied_at, reply_text) stay: sent_at is filled on 'sent'.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
alter table public.email_events add column if not exists token text;
alter table public.email_events add column if not exists campaign text;
alter table public.email_events add column if not exists event text;
alter table public.email_events add column if not exists occurred_at timestamptz not null default now();
alter table public.email_events add column if not exists email text;          -- recipient (for unsubscribes)
alter table public.email_events add column if not exists town text;
alter table public.email_events add column if not exists report_token text;   -- the report the email linked to, if any
alter table public.email_events add column if not exists detail text;         -- e.g. the clicked path
-- Every event is stamped by the database clock, 'sent' included, so a sender's clock can't put an
-- open before its send.
alter table public.email_events alter column sent_at set default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_events_event_check') then
    alter table public.email_events add constraint email_events_event_check
      check (event is null or event in ('sent', 'opened', 'clicked', 'unsubscribed'));
  end if;
end $$;

create unique index if not exists email_events_token_event_uniq on public.email_events(token, event) where token is not null;
-- One token per (business, campaign).
create unique index if not exists email_events_business_campaign_sent_uniq
  on public.email_events(business_id, lower(campaign)) where event = 'sent';
create index if not exists email_events_business_idx on public.email_events(business_id);

alter table public.report_requests add column if not exists ref_token text;
create index if not exists report_requests_ref_token_idx on public.report_requests(ref_token) where ref_token is not null;

alter table public.businesses add column if not exists town text;

-- Nothing public writes email_events directly any more: 'sent' rows come with the service key,
-- the rest through log_email_event() below. (The anon insert policy from setup.sql let anyone add
-- fake 'sent' rows to the funnel.)
drop policy if exists "worker insert" on public.email_events;

-- ---------------------------------------------------------------------------
-- log_email_event(token, event): the pixel, the click redirect and /stop call this with the anon key.
-- Copies business/arm/campaign from the token's 'sent' row; first event wins. For 'unsubscribed' it
-- also writes the suppression row. false = unknown token or event.
-- ---------------------------------------------------------------------------
create or replace function public.log_email_event(p_token text, p_event text, p_detail text default null, p_user_agent text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.email_events%rowtype;
  n int;
begin
  if p_event is null or p_event not in ('opened', 'clicked', 'unsubscribed') then return false; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{12,64}$' then return false; end if;
  select * into s from public.email_events where token = p_token and event = 'sent' order by occurred_at limit 1;
  if not found then return false; end if;
  insert into public.email_events (business_id, arm, campaign, token, event, email, town, report_token, detail, occurred_at)
  values (s.business_id, s.arm, s.campaign, s.token, p_event, s.email, s.town, s.report_token, left(p_detail, 300), now())
  on conflict (token, event) where token is not null do nothing;
  get diagnostics n = row_count;
  -- The suppression row every time someone confirms (the sender checks it before every email).
  if p_event = 'unsubscribed' and (s.email is not null or s.report_token is not null) then
    insert into public.unsubscribes (report_token, email, user_agent)
    values (s.report_token, s.email, left(p_user_agent, 500));
  end if;
  return true;
end $$;

revoke all on function public.log_email_event(text, text, text, text) from public;
grant execute on function public.log_email_event(text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- v_email_timeline: every event per token, in order. kind is one of
--   sent, opened, clicked, unsubscribed, snapshot_started, scan, visit, payment, payment_test, payment_refunded
-- ---------------------------------------------------------------------------
create or replace view public.v_email_timeline with (security_invoker = true) as
with sent as (
  select distinct on (token) token, business_id, report_token, coalesce(sent_at, occurred_at) as sent_at
  from public.email_events
  where event = 'sent' and token is not null
  order by token, occurred_at
),
reqs as (
  select s.token, r.business_name, r.report_token, r.requested_at
  from sent s
  join public.report_requests r on r.ref_token = s.token
),
reports as (
  -- every report this email led to: the one it linked to, and the ones its clicks asked for
  select token, report_token from sent where report_token is not null
  union
  select token, report_token from reqs where report_token is not null
)
select e.token,
       e.event as kind,
       case when e.event = 'sent' then coalesce(e.sent_at, e.occurred_at) else e.occurred_at end as at,
       e.detail
from public.email_events e
join sent s on s.token = e.token
where e.event is not null
union all
select token, 'snapshot_started', requested_at, business_name from reqs
union all
select q.token, 'scan', sr.scanned_at, null
from reqs q
join public.scan_results sr on sr.report_token = q.report_token
union all
select s.token, 'visit', v.visited_at, v.report_token
from sent s
join reports r on r.token = s.token
join public.page_visits v on v.report_token = r.report_token and v.visited_at >= s.sent_at
union all
select s.token,
       case when p.livemode is not true then 'payment_test'
            when p.revoked_at is not null then 'payment_refunded'
            else 'payment' end,
       p.paid_at,
       coalesce(p.tier, '') || ' ' || to_char(coalesce(p.amount_cents, 0) / 100.0, 'FM$999990.00')
from sent s
join public.payments p on p.paid_at >= s.sent_at
 and (p.report_token in (select r.report_token from reports r where r.token = s.token)
      or (p.business_id is not null and p.business_id = s.business_id));

-- ---------------------------------------------------------------------------
-- v_email_prospects: one row per sent email (business + campaign), with the furthest stage reached.
-- stage_rank 0 sent · 1 opened · 2 clicked · 3 snapshot_started · 4 snapshot_completed · 5 paid
-- ---------------------------------------------------------------------------
create or replace view public.v_email_prospects with (security_invoker = true) as
with sent as (
  select distinct on (token) token, business_id, arm, campaign, email, town, report_token
  from public.email_events
  where event = 'sent' and token is not null
  order by token, occurred_at
),
t as (
  select token,
         min(at) filter (where kind = 'sent')             as sent_at,
         min(at) filter (where kind = 'opened')           as opened_at,
         min(at) filter (where kind = 'clicked')          as clicked_at,
         min(at) filter (where kind = 'snapshot_started') as snapshot_started_at,
         min(at) filter (where kind = 'scan')             as snapshot_completed_at,
         min(at) filter (where kind = 'payment')          as paid_at,
         min(at) filter (where kind = 'unsubscribed')     as unsubscribed_at,
         max(at)                                          as last_event_at,
         -- ties (same instant) go to the later stage
         (array_agg(kind order by at desc, array_position(array['sent', 'opened', 'clicked', 'visit', 'snapshot_started', 'scan',
           'payment_test', 'payment', 'payment_refunded', 'unsubscribed'], kind) desc nulls last))[1] as last_event
  from public.v_email_timeline
  group by token
),
j as (
  select s.token, s.business_id, b.name as business, coalesce(s.town, b.town) as town, s.arm, s.campaign, s.email,
         s.report_token, t.sent_at, t.opened_at, t.clicked_at, t.snapshot_started_at, t.snapshot_completed_at,
         t.paid_at, t.unsubscribed_at, t.last_event, t.last_event_at,
         case when t.paid_at is not null then 5
              when t.snapshot_completed_at is not null then 4
              when t.snapshot_started_at is not null then 3
              when t.clicked_at is not null then 2
              when t.opened_at is not null then 1
              else 0 end as stage_rank
  from sent s
  join t on t.token = s.token
  left join public.businesses b on b.id = s.business_id
)
select j.*,
       (array['sent', 'opened', 'clicked', 'snapshot_started', 'snapshot_completed', 'paid'])[j.stage_rank + 1] as stage
from j;

-- ---------------------------------------------------------------------------
-- v_email_funnel: per arm, how many emails reached each stage (or went past it), from
-- v_email_prospects, so the counts always match the Prospects table.
-- ---------------------------------------------------------------------------
create or replace view public.v_email_funnel with (security_invoker = true) as
select arm,
       count(*)                                       as sent,
       count(*) filter (where stage_rank >= 1)        as opened,
       count(*) filter (where stage_rank >= 2)        as clicked,
       count(*) filter (where stage_rank >= 3)        as snapshot_started,
       count(*) filter (where stage_rank >= 4)        as snapshot_completed,
       count(*) filter (where stage_rank >= 5)        as paid,
       count(*) filter (where unsubscribed_at is not null) as unsubscribed
from public.v_email_prospects
group by arm;

-- ---------------------------------------------------------------------------
-- v_mvp_gates: the email gates now read the 'email' arm (latest definition was v9_refunds.sql).
-- ---------------------------------------------------------------------------
create or replace view public.v_mvp_gates with (security_invoker = true) as
with latest as (
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
  where arm = 'email' and event = 'sent'
),
paid as (
  select count(*) as paying
  from public.v_email_prospects
  where arm = 'email' and paid_at is not null
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
       3, '3 of 5',
       null::numeric,
       'not tracked yet (re-check flow not built)',
       null::boolean;

-- Owner only (service key), like the other admin views.
revoke all on public.v_email_timeline, public.v_email_prospects, public.v_email_funnel, public.v_mvp_gates
  from anon, authenticated;
