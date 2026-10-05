-- AI Found Score — v14: batch tag on scans (scanner/batch.js). Run AFTER admin_v3.sql and v4_ladder.sql. Safe to re-run.
--
-- scans.batch_id    the batch a scan was started for, e.g. 'exp002-2026-10-04' (null for every other scan)
-- scans.batch_item  the prospect inside that batch (its businesses.id, or the list's own id)
--
-- The batch runner reads these back before each prospect: a strictly finished scan with the same
-- batch_id + batch_item means "skip, already paid for". Both columns are written only when a batch
-- passes them, so ordinary scans are unaffected (and work before this file is applied).

alter table public.scans add column if not exists batch_id   text;
alter table public.scans add column if not exists batch_item text;

create index if not exists scans_batch_idx on public.scans(batch_id, batch_item, created_at desc) where batch_id is not null;
