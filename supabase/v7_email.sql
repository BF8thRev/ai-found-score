-- AI Found Score — v7: email (Resend) for people who asked for it. Run AFTER v6_fix_kit.sql. Safe to re-run.
--
-- report_requests.report_token   the report link a free-report request got (src/lib/auto-scan.js), so the
--                                "your report is ready" email can find the address the owner left
-- payments.customer_email        the Stripe checkout email: receipt, "full audit ready", 30-day re-check
--
-- Both are read with the service key only (src/lib/notify.js); anon keeps INSERT only.

alter table public.report_requests add column if not exists report_token text;
create index if not exists report_requests_report_token_idx on public.report_requests(report_token) where report_token is not null;

alter table public.payments add column if not exists customer_email text;
