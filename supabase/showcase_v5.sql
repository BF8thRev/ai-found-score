-- AI Found Score — v5 homepage "real AI answer" card (showcase_answers).
-- Paste into the Supabase SQL editor and run AFTER setup.sql … v4_ladder.sql. Safe to re-run.
--
-- One row per (trade, town, state): the answer an assistant gave to that trade's "best" question
-- ("What's the best plumber in Massapequa, NY?"), asked by `node scanner/showcase.js` and refreshed
-- weekly. The homepage hero shows a short verbatim excerpt for the visitor's town (src/lib/showcase.js).
--
-- excerpt      a prefix of the answer as displayed (markdown links/bold removed, words unchanged),
--              cut at a sentence end, ~60 words, with no phone number or street address
-- spans        [[start, end], ...] character ranges of the businesses the answer names, inside excerpt
-- answer       the full raw answer, for checking the excerpt against
-- active       false hides a row (takedown requests: set it false here; the next refresh keeps it off)
--
-- Public read (anon select, active rows only) because it is shown on the public homepage.
-- Writes are service-key only.

create table if not exists public.showcase_answers (
  trade      text not null,
  town       text not null,
  state      text not null,
  question   text not null,
  excerpt    text not null,
  spans      jsonb not null default '[]'::jsonb,
  truncated  boolean not null default true,
  answer     text not null,
  engine     text not null,
  asked_at   timestamptz not null,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (trade, town, state)
);

alter table public.showcase_answers enable row level security;
revoke all on public.showcase_answers from anon, authenticated;
grant select (trade, town, state, question, excerpt, spans, truncated, asked_at, active) on public.showcase_answers to anon;
drop policy if exists "public read active" on public.showcase_answers;
create policy "public read active" on public.showcase_answers for select to anon using (active);
