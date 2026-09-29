-- AI Found Score — v13: the Gmail API sender (src/lib/gmail-sender.js). Run AFTER v12_email_tracking.sql. Safe to re-run.
--
-- gmail_sends        one row per send attempt through Gmail: kind ('test' to our own addresses,
--                    'outreach' to a prospect), recipient, subject, and the Gmail message id or the
--                    error. Outreach rows carry the email_events token: join on token for the funnel.
-- sender_state       one row, id 'gmail': the Pause switch on /admin. paused = nothing sends.
-- claim_gmail_send() the only way a send starts. Under one lock it checks the switch, the daily cap
--                    (America/New_York day; every attempt counts, failed ones too) and the gap since
--                    the last attempt (5 s), then writes the attempt row. Service key only.
-- v_gmail_today      today's attempts and the last one, for /admin.
--
-- The credential is send-only (gmail.send), so bounces and spam complaints are never seen here: a
-- person watches the bounce inbox and Google Postmaster Tools and presses Pause.

create table if not exists public.gmail_sends (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('test', 'outreach')),
  to_email text not null,
  subject text,
  token text,                 -- email_events token (outreach)
  campaign text,
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  message_id text,            -- Gmail's id for the sent message
  error text,
  finished_at timestamptz
);
create index if not exists gmail_sends_created_idx on public.gmail_sends(created_at desc);
alter table public.gmail_sends enable row level security;

create table if not exists public.sender_state (
  id text primary key,
  paused boolean not null default false,
  reason text,
  changed_at timestamptz not null default now()
);
alter table public.sender_state enable row level security;
insert into public.sender_state (id) values ('gmail') on conflict (id) do nothing;

-- No anon/authenticated access at all (RLS has no policies; this also drops the default grants).
revoke all on public.gmail_sends, public.sender_state from anon, authenticated;

create or replace function public.gmail_day_start()
returns timestamptz
language sql
stable
set search_path = public
as $$
  select date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
$$;

create or replace function public.claim_gmail_send(
  p_kind text,
  p_to text,
  p_subject text,
  p_token text default null,
  p_campaign text default null,
  p_daily_cap int default 150,
  p_gap_seconds int default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  st public.sender_state%rowtype;
  n int;
  last_at timestamptz;
  new_id uuid;
begin
  -- One claim at a time, so two sends can't both pass the cap or the gap.
  perform pg_advisory_xact_lock(hashtext('claim_gmail_send'));

  select * into st from public.sender_state where id = 'gmail';
  if found and st.paused then
    return jsonb_build_object('ok', false, 'reason', 'paused', 'detail', st.reason);
  end if;

  select count(*) into n from public.gmail_sends where created_at >= public.gmail_day_start();
  if p_daily_cap is null or n >= p_daily_cap then
    return jsonb_build_object('ok', false, 'reason', 'cap', 'sent_today', n);
  end if;

  select max(created_at) into last_at from public.gmail_sends;
  if last_at is not null and last_at > now() - make_interval(secs => coalesce(p_gap_seconds, 5)) then
    return jsonb_build_object('ok', false, 'reason', 'rate',
      'retry_after', greatest(1, ceil(extract(epoch from (last_at + make_interval(secs => coalesce(p_gap_seconds, 5)) - now())))));
  end if;

  insert into public.gmail_sends (kind, to_email, subject, token, campaign)
  values (p_kind, lower(left(p_to, 200)), left(p_subject, 300), p_token, left(p_campaign, 80))
  returning id into new_id;
  return jsonb_build_object('ok', true, 'id', new_id, 'sent_today', n + 1);
end $$;

revoke all on function public.claim_gmail_send(text, text, text, text, text, int, int) from public, anon, authenticated;
grant execute on function public.claim_gmail_send(text, text, text, text, text, int, int) to service_role;
revoke all on function public.gmail_day_start() from public, anon, authenticated;
grant execute on function public.gmail_day_start() to service_role;

create or replace view public.v_gmail_today with (security_invoker = true) as
select count(*)::int as sent_today,
       (count(*) filter (where status = 'failed'))::int as failed_today,
       max(created_at) as last_at
from public.gmail_sends
where created_at >= public.gmail_day_start();

revoke all on public.v_gmail_today from anon, authenticated;
