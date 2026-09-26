-- AI Found Score — v6 Fix Kit: the business details an owner confirmed on /fix-kit/<token>.
-- Paste into the Supabase SQL editor and run AFTER setup.sql … showcase_v5.sql. Safe to re-run.
--
-- The $149 Fix Kit ('fix_kit') and $499 Be the Answer ('be_the_answer') plans come with a zip of
-- ready-to-install files (robots.txt, llms.txt, LocalBusiness schema, FAQ page, Google Business Profile
-- text, review QR code), built by the Worker from these details (src/lib/fix-kit.js). The owner checks
-- the details, ticks "I own or manage this business", confirms, then downloads the zip. No manual step.
--
-- report_token   the report the kit belongs to (the payment is looked up by the same token)
-- details        the confirmed details as validateDetails() returns them: name, trade, phone, street,
--                town, state, zip, website, hours, services[], serviceTowns[], description,
--                googleMapsUrl, googleReviewUrl
-- confirmed_at   when the owner last confirmed (each confirm rewrites the row)
-- updated_at     kept current by the trigger below
--
-- Service-key only: RLS on with no policies, every grant revoked from anon/authenticated. The Worker
-- reads and writes it with SUPABASE_SERVICE_KEY (src/lib/db.js getFixKitDetails / saveFixKitDetails).

create table if not exists public.fix_kit_details (
  report_token  text primary key,
  details       jsonb not null,
  confirmed_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace function public.fix_kit_details_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists fix_kit_details_touch on public.fix_kit_details;
create trigger fix_kit_details_touch before update on public.fix_kit_details for each row execute function public.fix_kit_details_touch();
revoke all on function public.fix_kit_details_touch() from public, anon, authenticated;

alter table public.fix_kit_details enable row level security;
revoke all on public.fix_kit_details from anon, authenticated;

-- The Fix Kit page asks which plans a token was paid for (payments.tier); that read is service-key
-- only too, so anon still never reads payments. This index keeps the per-token lookup cheap.
create index if not exists payments_report_token_idx on public.payments(report_token);
