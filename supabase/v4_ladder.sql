-- AI Found Score — v4 offer ladder: $49 AI Visibility X-Ray, automatic free-report scans, refund requests.
-- Paste into the Supabase SQL editor and run AFTER setup.sql, scan_v2.sql and admin_v3.sql. Safe to re-run.
-- Apply it BEFORE setting AUTO_SCAN=on (the Worker writes the new scans columns for every free-report request).
--
-- scans.request_key    normalized "business name|zip" of a free-report request: the 7-day dedupe key
-- scans.business       the business as the form sent it (name, trade, town, state, zip, website, phone),
--                      so a queued request can be started later from /admin ("Run now")
-- scans.est_cost_usd   the cost reserved before an automatic scan starts (daily spend cap, src/lib/auto-scan.js)
-- refund_requests      "if we can't show you 3 things to fix, it's free" claims. No public form yet; rows are
--                      added by hand or by a later form. Refunds are done by a person in the Stripe dashboard.
--
-- Everything here is service-key only: RLS on with no policies, every grant revoked from anon/authenticated.

-- ---------------------------------------------------------------------------
-- scans: request columns
-- ---------------------------------------------------------------------------
alter table public.scans add column if not exists request_key  text;
alter table public.scans add column if not exists business     jsonb;
alter table public.scans add column if not exists est_cost_usd numeric(10, 6) not null default 0;

-- Dedupe lookups (same key within 7 days) and the daily caps (today's request scans).
create index if not exists scans_request_key_idx on public.scans(request_key, created_at desc) where request_key is not null;
create index if not exists scans_trigger_created_idx on public.scans(trigger, created_at desc);
-- The report page looks a pending report up by its token.
create index if not exists scans_report_token_idx on public.scans(report_token);

-- ---------------------------------------------------------------------------
-- refund_requests
-- ---------------------------------------------------------------------------
create table if not exists public.refund_requests (
  id            uuid primary key default gen_random_uuid(),
  report_token  text,
  email         text,
  reason        text,
  status        text not null default 'open',
  created_at    timestamptz not null default now()
);
alter table public.refund_requests drop constraint if exists refund_requests_status_check;
alter table public.refund_requests add constraint refund_requests_status_check check (status in ('open', 'refunded', 'declined'));
create index if not exists refund_requests_created_idx on public.refund_requests(created_at desc);

alter table public.refund_requests enable row level security;
revoke all on public.refund_requests from anon, authenticated;
