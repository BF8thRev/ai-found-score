-- AI Found Score — scanner v2 schema (BUILD_PLAN "Report data model v2" / "Supabase").
-- Paste into the Supabase SQL editor and run after setup.sql. Safe to re-run.
--
-- scan_raw:     one row per engine API call (failed calls too), so any line in a report can be
--               traced to the call that produced it. Service key only: no anon access at all.
-- scan_results: gains `report` (the v2 report JSON), `version` and `scan_id`.
--               v1 rows keep version null/1 and render as today.

-- ---------------------------------------------------------------------------
-- scan_raw
-- ---------------------------------------------------------------------------
create table if not exists public.scan_raw (
  id            uuid primary key default gen_random_uuid(),
  scan_id       uuid not null,
  business_id   uuid,                         -- businesses.id when known (no FK: raw rows must never be lost)
  engine        text not null,
  question_id   text not null,                -- q1..q5
  question_text text,
  run           int  not null default 1,
  model         text,
  request       jsonb,                        -- request body + endpoint (never the API key)
  response      jsonb,                        -- full parsed API response
  answer_text   text,                         -- parsed answer text (verbatim)
  citations     jsonb not null default '[]'::jsonb,  -- parsed from the API's citation data
  ok            boolean not null default false,
  error         text,
  cost_usd      numeric(10, 6) not null default 0,
  asked_at      timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
-- Columns added after the first version of this file (no-ops on a fresh table).
alter table public.scan_raw add column if not exists question_text text;
alter table public.scan_raw add column if not exists model text;
alter table public.scan_raw add column if not exists answer_text text;
alter table public.scan_raw add column if not exists citations jsonb not null default '[]'::jsonb;

-- Engine list lives in scanner/config.js; the check is kept in sync here (re-runnable).
alter table public.scan_raw drop constraint if exists scan_raw_engine_check;
alter table public.scan_raw add constraint scan_raw_engine_check
  check (engine in ('chatgpt', 'gemini', 'google_ai_mode', 'perplexity', 'claude'));

create index if not exists scan_raw_scan_id_idx     on public.scan_raw(scan_id);
create index if not exists scan_raw_business_id_idx on public.scan_raw(business_id, asked_at desc);

alter table public.scan_raw enable row level security;
-- No policies for anon/authenticated: only the service key (which bypasses RLS) can read or write.
revoke all on public.scan_raw from anon, authenticated;

-- ---------------------------------------------------------------------------
-- scan_results: v2 report document
-- ---------------------------------------------------------------------------
alter table public.scan_results add column if not exists report  jsonb;
alter table public.scan_results add column if not exists version int;
alter table public.scan_results add column if not exists scan_id uuid;

create index if not exists scan_results_business_v2_idx
  on public.scan_results(business_id, scanned_at desc) where version = 2;

-- RLS stays on (enabled in setup.sql); the existing "worker read" select policy for anon
-- covers the new columns. Writes go through the service key only.
alter table public.scan_results enable row level security;


-- ---------------------------------------------------------------------------
-- report_requests: email is asked for AFTER the visitor sees their questions
-- ---------------------------------------------------------------------------
alter table public.report_requests alter column email drop not null;
alter table public.report_requests add column if not exists zip   text;
alter table public.report_requests add column if not exists phone text;
alter table public.report_requests add column if not exists email_added_at timestamptz;

-- ---------------------------------------------------------------------------
-- report_requests: attach the email to the first row (optional function)
-- ---------------------------------------------------------------------------
-- Step 1 saves the business (email null) under an id the Worker picks; step 2
-- optionally attaches an email through attach_report_request_email(), so anon
-- keeps INSERT only (no UPDATE/SELECT policy needed). Until this function
-- exists the Worker falls back to inserting a second row that carries the
-- business details plus the email, which the existing insert policy allows.

-- Fills an empty email on a request from the last 24 hours. The id is a random
-- uuid known only to the page that made the request, so it acts as the key.
create or replace function public.attach_report_request_email(p_id uuid, p_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
begin
  if p_id is null or p_email is null
     or length(p_email) > 160
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    return false;
  end if;
  update public.report_requests
     set email = lower(p_email), email_added_at = now()
   where id = p_id
     and email is null
     and requested_at > now() - interval '24 hours';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

revoke all on function public.attach_report_request_email(uuid, text) from public, authenticated;
grant execute on function public.attach_report_request_email(uuid, text) to anon;
