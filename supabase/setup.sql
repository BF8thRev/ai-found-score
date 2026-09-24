-- AI Found Score — one-time Supabase setup for the site + channel test.
-- Paste into the Supabase SQL editor and run. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Base tables (the schema src/lib/db.js expects). No-ops if they exist.
-- ---------------------------------------------------------------------------
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trade text,
  county text,
  phone text,
  website text,
  address text,
  google_place_id text,
  created_at timestamptz not null default now()
);

-- One row per assistant per scan, grouped by report_token.
create table if not exists public.scan_results (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses(id),
  scanned_at timestamptz not null default now(),
  named_by_ai boolean,
  ai_source text,
  listing_mismatches jsonb,
  report_token text not null,
  created_at timestamptz not null default now()
);
create index if not exists scan_results_report_token_idx on public.scan_results(report_token);

create table if not exists public.page_visits (
  id uuid primary key default gen_random_uuid(),
  report_token text,
  visited_at timestamptz not null default now(),
  referrer text,
  user_agent text
);

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  arm text,
  sent_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  reply_text text
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid,
  arm text,
  tier text,
  amount_cents int4,
  stripe_session_id text,
  paid_at timestamptz not null default now()
);

alter table public.businesses   enable row level security;
alter table public.scan_results enable row level security;
alter table public.page_visits  enable row level security;
alter table public.email_events enable row level security;
alter table public.payments     enable row level security;

drop policy if exists "worker read" on public.businesses;
create policy "worker read" on public.businesses for select to anon using (true);
drop policy if exists "worker read" on public.scan_results;
create policy "worker read" on public.scan_results for select to anon using (true);
drop policy if exists "worker insert" on public.page_visits;
create policy "worker insert" on public.page_visits for insert to anon with check (true);
drop policy if exists "worker insert" on public.email_events;
create policy "worker insert" on public.email_events for insert to anon with check (true);
drop policy if exists "worker insert" on public.payments;
create policy "worker insert" on public.payments for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- Additions for the channel test
-- ---------------------------------------------------------------------------

-- Visits and payments carry the arm (looked up server-side from the token)
-- and the report token, so every metric can be cut by channel.
alter table public.page_visits add column if not exists arm text;
alter table public.payments    add column if not exists report_token text;
-- false for Stripe sandbox purchases; the funnel ignores them.
alter table public.payments    add column if not exists livemode boolean not null default true;

-- ---------------------------------------------------------------------------
-- report_links: one row per recipient, written by the randomize job.
-- The Worker reads it to turn a short code into a report and to attribute
-- visits, leads and payments to an arm. Never trust ?arm= from the URL.
-- ---------------------------------------------------------------------------

-- 6 chars from an alphabet with no look-alikes (no 0/O, 1/I/L, U).
create or replace function public.gen_short_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  code text := '';
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return code;
end $$;

create table if not exists public.report_links (
  report_token text primary key,             -- same token as scan_results.report_token
  short_code   text not null unique default public.gen_short_code(),
  business_id  uuid,
  arm          text not null check (arm in ('mail', 'email_a', 'email_b')),
  town         text,
  created_at   timestamptz not null default now()
);
alter table public.report_links enable row level security;
drop policy if exists "worker read" on public.report_links;
create policy "worker read" on public.report_links for select to anon using (true);

-- ---------------------------------------------------------------------------
-- leads: "Email me this report" on the report page.
-- The sender picks up status = 'new' rows and emails the report link.
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  report_token text not null,
  email        text not null,
  arm          text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  status       text not null default 'new'
);
alter table public.leads enable row level security;
drop policy if exists "worker insert" on public.leads;
create policy "worker insert" on public.leads for insert to anon with check (true);

-- ---------------------------------------------------------------------------
-- Unlock check. Security definer so anon can ask "is this token paid?"
-- without being able to read the payments table.
-- ---------------------------------------------------------------------------
create or replace function public.report_unlocked(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payments where report_token = p_token);
$$;
revoke all on function public.report_unlocked(text) from public, authenticated;
grant execute on function public.report_unlocked(text) to anon;

-- ---------------------------------------------------------------------------
-- Tables from README (create if they weren't made yet)
-- ---------------------------------------------------------------------------
create table if not exists public.unsubscribes (
  id uuid primary key default gen_random_uuid(),
  report_token text,
  email text,
  user_agent text,
  unsubscribed_at timestamptz not null default now()
);
alter table public.unsubscribes enable row level security;
drop policy if exists "worker insert" on public.unsubscribes;
create policy "worker insert" on public.unsubscribes for insert to anon with check (true);

create table if not exists public.report_requests (
  id uuid primary key default gen_random_uuid(),
  business_name text not null,
  town text not null,
  email text not null,
  trade text,
  website text,
  user_agent text,
  requested_at timestamptz not null default now(),
  status text not null default 'new'
);
alter table public.report_requests enable row level security;
drop policy if exists "worker insert" on public.report_requests;
create policy "worker insert" on public.report_requests for insert to anon with check (true);

-- Explicit table grants for the Worker's key (RLS policies above still apply).
-- Newer Supabase projects don't grant these by default.
grant usage on schema public to anon;
grant select on public.businesses, public.scan_results, public.report_links to anon;
grant insert on public.page_visits, public.email_events, public.payments,
                public.leads, public.unsubscribes, public.report_requests to anon;

-- ---------------------------------------------------------------------------
-- Read-out helper: per-arm funnel. Visits are unique tokens, so repeat
-- visits and reloads count once.
-- ---------------------------------------------------------------------------
-- security_invoker: anon can't read the underlying tables, so it can't read this.
create or replace view public.channel_funnel with (security_invoker = true) as
select
  l.arm,
  count(*)                                                                         as recipients,
  count(*) filter (where exists (select 1 from public.page_visits v where v.report_token = l.report_token)) as visited,
  count(*) filter (where exists (select 1 from public.leads le where le.report_token = l.report_token))     as leads,
  count(*) filter (where exists (select 1 from public.payments p where p.report_token = l.report_token and p.livemode)) as paying,
  coalesce(sum((select sum(p.amount_cents) from public.payments p where p.report_token = l.report_token and p.livemode)), 0) / 100.0 as revenue_usd
from public.report_links l
group by l.arm;

-- Funnel is for the owner (service key / dashboard) only.
revoke all on public.channel_funnel from anon, authenticated;
