-- showcase-003-daily-news · Supabase schema init
-- Apply once via Supabase dashboard → SQL Editor → paste this entire file → Run.
-- Idempotent: safe to re-run (all creates use IF NOT EXISTS).

-- ─── Extensions ─────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ─── routine_runs: one row per routine execution ────────────
create table if not exists routine_runs (
  id              uuid primary key default gen_random_uuid(),
  run_id          text unique not null,          -- e.g. "2026-04-24-manual" or "2026-04-25-auto"
  source_type     text not null,                  -- "manual_local" | "routine_cloud"
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',-- running | succeeded | degraded | failed
  items_produced  int,
  news_date       date not null,                  -- the date this run is producing news for
  failure_reason  text,
  notes           text
);
create index if not exists routine_runs_news_date_idx
  on routine_runs (news_date desc, started_at desc);
create index if not exists routine_runs_status_idx
  on routine_runs (status);

-- ─── routine_log_entries: one row per phase/tool call ───────
create table if not exists routine_log_entries (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  sequence_num  int not null,
  phase         text not null,     -- init | fetch | score | translate | persist | finalize
  intent        text,              -- human-readable intent
  tool          text,              -- WebFetch | gh api | opus-score | supabase insert | ...
  input         jsonb,
  output        jsonb,
  decision      text,
  duration_ms   int,
  level         text default 'info', -- info | warn | error
  logged_at     timestamptz not null default now(),
  unique (run_id, sequence_num)
);
create index if not exists routine_log_entries_run_seq_idx
  on routine_log_entries (run_id, sequence_num);

-- ─── news_items: one row per picked news item ──────────────
create table if not exists news_items (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  news_date     date not null,
  rank          int not null,     -- 1..4
  source_name   text not null,    -- changelog | anthropic-news | techcrunch-ai | hn-24h
  title_en      text not null,
  title_zh      text not null,
  summary_en    text not null,
  summary_zh    text not null,
  url           text not null,
  published_at  timestamptz,
  score         numeric(4,3),
  created_at    timestamptz not null default now(),
  unique (news_date, rank)
);
create index if not exists news_items_news_date_idx
  on news_items (news_date desc, rank asc);

-- ─── Row-Level Security ─────────────────────────────────────
-- Anon / public users: read-only everywhere.
-- Service-role: bypass RLS (implicit); the routine uses service-role key for writes.

alter table routine_runs enable row level security;
alter table routine_log_entries enable row level security;
alter table news_items enable row level security;

drop policy if exists "public read routine_runs" on routine_runs;
drop policy if exists "public read routine_log_entries" on routine_log_entries;
drop policy if exists "public read news_items" on news_items;

create policy "public read routine_runs" on routine_runs for select using (true);
create policy "public read routine_log_entries" on routine_log_entries for select using (true);
create policy "public read news_items" on news_items for select using (true);

-- ─── Helpful views for the site ─────────────────────────────

create or replace view latest_run as
  select r.*
  from routine_runs r
  order by r.started_at desc
  limit 1;

create or replace view news_today as
  select ni.*
  from news_items ni
  where ni.news_date = current_date
  order by ni.rank asc;

-- ─── Grant view access (RLS-less, read-only) ────────────────
grant select on latest_run to anon, authenticated;
grant select on news_today to anon, authenticated;

-- ─── Done ───────────────────────────────────────────────────
-- Verify with:
--   select count(*) from routine_runs;      -- expect 0 on first apply
--   select count(*) from routine_log_entries;
--   select count(*) from news_items;
