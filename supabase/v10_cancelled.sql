-- v10: /admin "Cancel" on a waiting request (src/lib/auto-scan.js cancelRequestScan).
alter table public.scans drop constraint if exists scans_status_check;
alter table public.scans add constraint scans_status_check check (status in ('queued', 'running', 'done', 'failed', 'cancelled'));
