-- AI Found Score — v5: the paid audit's full scan.
-- Paste into the Supabase SQL editor and run AFTER v4_ladder.sql. Safe to re-run.
-- Apply it BEFORE the Stripe links go live: a paid $49 audit (or Fix Kit / Be the Answer) starts a
-- scans row with trigger 'paid' (src/lib/auto-scan.js startPaidScan), which the old check rejects.
--
-- scans.trigger 'paid'   every question on every engine with a key, under the report's own token,
--                        started by the Stripe webhook once the money is in.

alter table public.scans drop constraint if exists scans_trigger_check;
alter table public.scans add constraint scans_trigger_check check (trigger in ('admin', 'request', 'recheck', 'paid'));
