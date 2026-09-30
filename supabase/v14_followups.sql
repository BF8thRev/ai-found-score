-- AI Found Score — v14: the EXP-002 follow-up funnel (src/lib/followups.js). Run AFTER v13_gmail_sender.sql. Safe to re-run.
--
-- A follow-up is its own 'sent' row in email_events with its own token (so its opens, clicks,
-- unsubscribes and payments track on their own), linked to the prospect's first email:
--   parent_token     the first email's token (the prospect). null on a first email.
--   followup_stage   'followup1' (clicked, 3 days), 'followup2' (clicked, 7 days) or 'bump' (no open,
--                    no click, 5 days). null on a first email.
-- One token per (business, campaign) now holds for first emails only (the index is rebuilt below);
-- each stage goes out at most once per prospect and at most 2 follow-ups ever (claim_followup_send).
-- NOTE: re-running v12_email_tracking.sql after this puts back the old one-sent-row-per-campaign index,
-- which makes every follow-up claim fail (nothing sends). Run this file again after it.
--
-- claim_followup_send()   the only way a follow-up starts: under a per-prospect lock it refuses a
--                         prospect who replied, unsubscribed or paid anything (any payment row on the
--                         business, its reports, or the prospect's email), a stage already sent, or a
--                         third follow-up; then writes the 'sent' row. Service key only.
-- release_followup_send() takes a claimed row back when Gmail refused before sending (paused, cap, …).
-- mark_email_replied()    /admin "Mark replied": the Gmail credential is send-only, so replies are
--                         marked by a person. Sets replied_at on the first email and on the latest
--                         follow-up (the one they answered), which stops all follow-ups.
-- outreach_templates      follow-up copy saved from /admin; overrides the placeholder copy in
--                         outreach/followup-templates.js without a code change.
-- v_followup_candidates   one row per first email: what the runner decides from.
-- v_followup_funnel       per campaign and stage: sent → opened → clicked → replied → paid.

-- ---------------------------------------------------------------------------
-- Columns and indexes
-- ---------------------------------------------------------------------------
alter table public.email_events add column if not exists parent_token text;
alter table public.email_events add column if not exists followup_stage text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'email_events_followup_stage_check') then
    alter table public.email_events add constraint email_events_followup_stage_check
      check ((parent_token is null and followup_stage is null)
          or (parent_token is not null and followup_stage in ('followup1', 'followup2', 'bump')));
  end if;
end $$;

drop index if exists public.email_events_business_campaign_sent_uniq;
create unique index if not exists email_events_business_campaign_first_uniq
  on public.email_events(business_id, lower(campaign)) where event = 'sent' and parent_token is null;
create unique index if not exists email_events_parent_stage_uniq
  on public.email_events(parent_token, followup_stage) where event = 'sent' and parent_token is not null;
create index if not exists email_events_parent_idx on public.email_events(parent_token) where parent_token is not null;

-- ---------------------------------------------------------------------------
-- log_email_event: as in v12, and the event row also carries the follow-up link.
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
  insert into public.email_events (business_id, arm, campaign, token, event, email, town, report_token, detail, occurred_at, parent_token, followup_stage)
  values (s.business_id, s.arm, s.campaign, s.token, p_event, s.email, s.town, s.report_token, left(p_detail, 300), now(), s.parent_token, s.followup_stage)
  on conflict (token, event) where token is not null do nothing;
  get diagnostics n = row_count;
  if p_event = 'unsubscribed' and (s.email is not null or s.report_token is not null) then
    insert into public.unsubscribes (report_token, email, user_agent)
    values (s.report_token, s.email, left(p_user_agent, 500));
  end if;
  return true;
end $$;

revoke all on function public.log_email_event(text, text, text, text) from public;
grant execute on function public.log_email_event(text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Has this prospect (a first email's token) paid anything, ever? Any payments row counts (test and
-- refunded ones too): the check errs toward not emailing. Matches the business, the report the email
-- linked to, reports its clicks asked for, and the prospect's email address.
-- ---------------------------------------------------------------------------
create or replace function public.followup_purchased(p_root text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with r as (
    select business_id, report_token, email from public.email_events
    where token = p_root and event = 'sent' and parent_token is null
    order by occurred_at limit 1
  ),
  chain as (
    select token from public.email_events where event = 'sent' and (token = p_root or parent_token = p_root)
  ),
  reps as (
    select report_token from r where report_token is not null
    union
    select q.report_token from public.report_requests q join chain c on q.ref_token = c.token where q.report_token is not null
  )
  select exists (
    select 1 from public.payments p, r
    where (r.business_id is not null and p.business_id = r.business_id)
       or p.report_token in (select report_token from reps)
       or (r.email is not null and lower(p.customer_email) = lower(r.email))
  )
$$;

revoke all on function public.followup_purchased(text) from public, anon, authenticated;
grant execute on function public.followup_purchased(text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_followup_send(parent, stage, token): the gate every follow-up goes through.
-- ---------------------------------------------------------------------------
create or replace function public.claim_followup_send(p_parent text, p_stage text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  root public.email_events%rowtype;
  n int;
begin
  if p_stage is null or p_stage not in ('followup1', 'followup2', 'bump') then
    return jsonb_build_object('ok', false, 'reason', 'bad stage');
  end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{12,64}$' or p_parent is null or p_parent = p_token then
    return jsonb_build_object('ok', false, 'reason', 'bad token');
  end if;
  -- One claim per prospect at a time, so two runs can't both pass the cap.
  perform pg_advisory_xact_lock(hashtext('claim_followup_send:' || p_parent));

  select * into root from public.email_events
  where token = p_parent and event = 'sent' and parent_token is null
  order by occurred_at limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown prospect'); end if;

  if exists (select 1 from public.email_events
             where event = 'sent' and (token = p_parent or parent_token = p_parent) and replied_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'replied');
  end if;
  -- Events are matched through the 'sent' rows' tokens, not their own parent_token, so this holds even
  -- if an older log_email_event (v12) wrote them.
  if exists (select 1 from public.email_events
             where event = 'unsubscribed'
               and token in (select token from public.email_events where event = 'sent' and (token = p_parent or parent_token = p_parent)))
     or exists (select 1 from public.unsubscribes u
                where (root.email is not null and lower(u.email) = lower(root.email))
                   or (root.report_token is not null and u.report_token = root.report_token)) then
    return jsonb_build_object('ok', false, 'reason', 'unsubscribed');
  end if;
  if public.followup_purchased(p_parent) then
    return jsonb_build_object('ok', false, 'reason', 'purchased');
  end if;

  -- Max 2 follow-ups per prospect, ever (a claimed one that failed to send still counts).
  select count(*) into n from public.email_events where event = 'sent' and parent_token = p_parent;
  if n >= 2 then return jsonb_build_object('ok', false, 'reason', 'max', 'followups', n); end if;
  if exists (select 1 from public.email_events where event = 'sent' and parent_token = p_parent and followup_stage = p_stage) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;

  insert into public.email_events (business_id, arm, campaign, token, event, email, town, report_token, parent_token, followup_stage)
  values (root.business_id, root.arm, root.campaign, p_token, 'sent', root.email, root.town, root.report_token, p_parent, p_stage);
  return jsonb_build_object('ok', true, 'followups', n + 1);
end $$;

revoke all on function public.claim_followup_send(text, text, text) from public, anon, authenticated;
grant execute on function public.claim_followup_send(text, text, text) to service_role;

-- Take back a claimed follow-up that never went out (only while nothing has happened on its token).
create or replace function public.release_followup_send(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  delete from public.email_events e
  where e.token = p_token and e.event = 'sent' and e.parent_token is not null
    and not exists (select 1 from public.email_events x where x.token = p_token and x.event is distinct from 'sent');
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.release_followup_send(text) from public, anon, authenticated;
grant execute on function public.release_followup_send(text) to service_role;

-- /admin "Mark replied" on a prospect (the first email's token).
create or replace function public.mark_email_replied(p_root text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  latest text;
begin
  update public.email_events set replied_at = coalesce(replied_at, now())
  where token = p_root and event = 'sent' and parent_token is null;
  if not found then return false; end if;
  select token into latest from public.email_events
  where event = 'sent' and parent_token = p_root order by occurred_at desc limit 1;
  if latest is not null then
    update public.email_events set replied_at = coalesce(replied_at, now()) where token = latest and event = 'sent';
  end if;
  return true;
end $$;

revoke all on function public.mark_email_replied(text) from public, anon, authenticated;
grant execute on function public.mark_email_replied(text) to service_role;

-- ---------------------------------------------------------------------------
-- Follow-up copy saved from /admin (key: '<stage>.<variant>', e.g. 'followup1.gap').
-- ---------------------------------------------------------------------------
create table if not exists public.outreach_templates (
  key text primary key check (key ~ '^(followup1|followup2|bump)\.(gap|generic)$'),
  subject text not null,
  body text not null,
  updated_at timestamptz not null default now()
);
alter table public.outreach_templates enable row level security;
revoke all on public.outreach_templates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Views. v_email_timeline gains 'replied'; v_email_prospects gains the follow-up columns (at the end);
-- the first-email funnel and gates count first emails only, so follow-ups don't inflate them.
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
      or (p.business_id is not null and p.business_id = s.business_id))
union all
select e.token, 'replied', e.replied_at, null
from public.email_events e
join sent s on s.token = e.token
where e.event = 'sent' and e.replied_at is not null;

create or replace view public.v_email_prospects with (security_invoker = true) as
with sent as (
  select distinct on (token) token, business_id, arm, campaign, email, town, report_token
  from public.email_events
  where event = 'sent' and token is not null
  order by token, occurred_at
),
x as (
  select distinct on (token) token, parent_token, followup_stage, replied_at, detail
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
       (array['sent', 'opened', 'clicked', 'snapshot_started', 'snapshot_completed', 'paid'])[j.stage_rank + 1] as stage,
       x.parent_token,
       x.followup_stage,
       x.replied_at,
       x.detail as send_note
from j
join x on x.token = j.token;

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
where parent_token is null
group by arm;

-- Per campaign and email (first email = 'initial', then each follow-up stage). Each row counts the
-- emails of that stage that reached each step. A follow-up that was claimed but never went out
-- (send_note 'not sent: …') is left out.
create or replace view public.v_followup_funnel with (security_invoker = true) as
select campaign,
       coalesce(followup_stage, 'initial')             as followup_stage,
       count(*)                                        as sent,
       count(*) filter (where stage_rank >= 1)         as opened,
       count(*) filter (where stage_rank >= 2)         as clicked,
       count(*) filter (where replied_at is not null)  as replied,
       count(*) filter (where paid_at is not null)     as paid,
       count(*) filter (where unsubscribed_at is not null) as unsubscribed
from public.v_email_prospects
where coalesce(send_note, '') not like 'not sent%'
group by campaign, coalesce(followup_stage, 'initial');

-- One row per first email, with everything the follow-up rules need (src/lib/followups.js nextFollowup).
create or replace view public.v_followup_candidates with (security_invoker = true) as
with root as (
  select distinct on (token) token, business_id, arm, campaign, email, town, report_token,
         coalesce(sent_at, occurred_at) as sent_at
  from public.email_events
  where event = 'sent' and token is not null and parent_token is null
  order by token, occurred_at
),
-- The prospect's tokens: its first email and every follow-up's. Events join on these tokens (not on
-- their own parent_token), so opens / clicks / unsubscribes count whichever log_email_event wrote them.
tokens as (
  select r.token as root_token, r.token from root r
  union
  select e.parent_token, e.token from public.email_events e join root r on r.token = e.parent_token
  where e.event = 'sent'
),
chain as (
  select t.root_token, e.token, e.event, e.occurred_at, e.replied_at, e.followup_stage, e.detail,
         coalesce(e.sent_at, e.occurred_at) as sent_at
  from tokens t
  join public.email_events e on e.token = t.token
)
select r.token, r.business_id, b.name as business, coalesce(r.town, b.town) as town, b.trade,
       r.arm, r.campaign, r.email, r.report_token, r.sent_at,
       (select min(c.occurred_at) from chain c where c.root_token = r.token and c.token = r.token and c.event = 'opened') as opened_at,
       (select min(c.occurred_at) from chain c where c.root_token = r.token and c.event = 'clicked') as clicked_at,
       (select min(c.replied_at) from chain c where c.root_token = r.token and c.event = 'sent') as replied_at,
       (select min(c.occurred_at) from chain c where c.root_token = r.token and c.event = 'unsubscribed') as unsubscribed_at,
       public.followup_purchased(r.token) as purchased,
       coalesce((select jsonb_agg(jsonb_build_object('stage', c.followup_stage, 'token', c.token, 'sent_at', c.sent_at, 'note', c.detail)
                                  order by c.occurred_at)
                 from chain c where c.root_token = r.token and c.event = 'sent' and c.followup_stage is not null), '[]'::jsonb) as followups
from root r
left join public.businesses b on b.id = r.business_id;

-- v_mvp_gates (v12) with the email counts on first emails only.
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
  where arm = 'email' and event = 'sent' and parent_token is null
),
paid as (
  select count(*) as paying
  from public.v_email_prospects
  where arm = 'email' and paid_at is not null and parent_token is null
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

revoke all on public.v_email_timeline, public.v_email_prospects, public.v_email_funnel, public.v_mvp_gates,
  public.v_followup_funnel, public.v_followup_candidates
  from anon, authenticated;
