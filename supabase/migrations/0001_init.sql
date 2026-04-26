-- showcases-shared · Supabase schema init (canonical, multi-tenant)
--
-- ONE Supabase project hosts ALL `showcases-*` projects (003 daily-news,
-- 004 daily-mfg-news, future siblings). Each row carries a `project` text
-- discriminator that the app code filters on. Composite uniqueness
-- (project, run_id) and (project, news_date, rank) keeps tenants clean.
--
-- Apply once to a fresh Supabase project via dashboard SQL editor.
-- Idempotent: safe to re-run.

create extension if not exists pgcrypto;

-- ─── routine_runs: one row per routine execution ────────────
create table if not exists routine_runs (
  id                 uuid primary key default gen_random_uuid(),
  project            text not null,
  run_id             text not null,
  source_type        text not null,                  -- "manual_local" | "routine_cloud" | "api_recap"
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  status             text not null default 'running',-- running | succeeded | degraded | failed
  items_produced     int,
  news_date          date not null,
  failure_reason     text,
  notes              text,
  -- 004-introduced (nullable; 003 ignores)
  daily_summary_en   text,
  daily_summary_zh   text,
  unique (project, run_id)
);
create index if not exists routine_runs_project_news_date_idx
  on routine_runs (project, news_date desc, started_at desc);
create index if not exists routine_runs_status_idx
  on routine_runs (project, status);

-- ─── routine_log_entries: one row per phase/tool call ───────
create table if not exists routine_log_entries (
  id            uuid primary key default gen_random_uuid(),
  project       text not null,
  run_id        text not null,
  sequence_num  int not null,
  phase         text not null,
  intent        text,
  tool          text,
  input         jsonb,
  output        jsonb,
  decision      text,
  duration_ms   int,
  level         text default 'info',
  logged_at     timestamptz not null default now(),
  unique (project, run_id, sequence_num),
  foreign key (project, run_id) references routine_runs (project, run_id) on delete cascade
);
create index if not exists routine_log_entries_project_run_seq_idx
  on routine_log_entries (project, run_id, sequence_num);

-- ─── news_items: one row per picked news item ──────────────
create table if not exists news_items (
  id            uuid primary key default gen_random_uuid(),
  project       text not null,
  run_id        text not null,
  news_date     date not null,
  rank          int not null,
  source_name   text not null,
  title_en      text not null,
  title_zh      text not null,
  summary_en    text not null,
  summary_zh    text not null,
  -- 004-introduced (nullable; 003 ignores)
  impact_en     text,
  impact_zh     text,
  url           text not null,
  published_at  timestamptz,
  score         numeric(4,3),
  created_at    timestamptz not null default now(),
  unique (project, news_date, rank),
  foreign key (project, run_id) references routine_runs (project, run_id) on delete cascade
);
create index if not exists news_items_project_news_date_idx
  on news_items (project, news_date desc, rank asc);

-- ─── source_recaps: cache for /api/recap-source results ─────
-- URL-keyed (cross-tenant cache; recaps don't carry a project).
create table if not exists source_recaps (
  id            uuid primary key default gen_random_uuid(),
  url           text unique not null,
  title         text,
  recap_en      text,
  recap_zh      text,
  impact_en     text,
  impact_zh     text,
  fetched_at    timestamptz not null default now(),
  byte_size     int,
  failure       text
);
create index if not exists source_recaps_fetched_idx
  on source_recaps (fetched_at desc);

-- ─── Row-Level Security ─────────────────────────────────────
alter table routine_runs        enable row level security;
alter table routine_log_entries enable row level security;
alter table news_items          enable row level security;
alter table source_recaps       enable row level security;

drop policy if exists "public read routine_runs"        on routine_runs;
drop policy if exists "public read routine_log_entries" on routine_log_entries;
drop policy if exists "public read news_items"          on news_items;
drop policy if exists "public read source_recaps"       on source_recaps;

create policy "public read routine_runs"        on routine_runs        for select using (true);
create policy "public read routine_log_entries" on routine_log_entries for select using (true);
create policy "public read news_items"          on news_items          for select using (true);
create policy "public read source_recaps"       on source_recaps       for select using (true);

-- ─── Smoke check (paste-and-go) ─────────────────────────────
-- Right after running this migration, verify with:
--   select count(*) from routine_runs;        -- expect 0
--   select count(*) from news_items;          -- expect 0
--   select count(*) from source_recaps;       -- expect 0
