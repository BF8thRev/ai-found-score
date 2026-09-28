-- v9: per-connection daily limit on free scans (src/lib/auto-scan.js ipDailyHit).
-- ip_hash is a keyed one-way code (live-preview.js ipCode), never the address itself.
alter table public.scans add column if not exists ip_hash text;
create index if not exists scans_request_ip_day on public.scans (ip_hash, created_at) where trigger = 'request';
