-- Migration 0002 — share this Supabase project across multiple showcases.
--
-- Adds a `project` text discriminator column to the three shared tables and
-- swaps unique/foreign-key constraints to composite (project, ...). Existing
-- rows are tagged 'showcase-003-daily-news' (the original tenant). New
-- siblings (e.g. 'showcase-004-daily-mfg-news') write with their own project
-- value and read filtered by it.
--
-- Also lands two 004-introduced columns that 003 never uses (nullable, no
-- impact on 003 reads), and the new `source_recaps` table for the
-- /api/recap-source endpoint (also 004-introduced).
--
-- Idempotent: each ALTER guards on absence; safe to re-run.
-- Apply order matters: this migration must run BEFORE 004 starts writing.

-- ── 1. Add `project` discriminator (default '003' so existing rows tag self)

alter table routine_runs        add column if not exists project text not null default 'showcase-003-daily-news';
alter table routine_log_entries add column if not exists project text not null default 'showcase-003-daily-news';
alter table news_items          add column if not exists project text not null default 'showcase-003-daily-news';

-- Belt-and-suspenders: backfill anything that somehow got null.
update routine_runs        set project = 'showcase-003-daily-news' where project is null;
update routine_log_entries set project = 'showcase-003-daily-news' where project is null;
update news_items          set project = 'showcase-003-daily-news' where project is null;

-- ── 2. Drop existing uniques + FKs (they assume single-tenant)

-- routine_log_entries → routine_runs FK
alter table routine_log_entries drop constraint if exists routine_log_entries_run_id_fkey;
-- news_items → routine_runs FK
alter table news_items drop constraint if exists news_items_run_id_fkey;

-- routine_runs.run_id was UNIQUE; needs to become composite (project, run_id)
alter table routine_runs drop constraint if exists routine_runs_run_id_key;

-- news_items unique (news_date, rank) → composite (project, news_date, rank)
alter table news_items drop constraint if exists news_items_news_date_rank_key;

-- routine_log_entries unique (run_id, sequence_num) → composite
alter table routine_log_entries drop constraint if exists routine_log_entries_run_id_sequence_num_key;

-- ── 3. Add composite uniques

alter table routine_runs
  add constraint routine_runs_project_run_id_key unique (project, run_id);

alter table news_items
  add constraint news_items_project_news_date_rank_key unique (project, news_date, rank);

alter table routine_log_entries
  add constraint routine_log_entries_project_run_id_seq_key unique (project, run_id, sequence_num);

-- ── 4. Recreate FKs as composite

alter table news_items
  add constraint news_items_project_run_id_fkey
  foreign key (project, run_id)
  references routine_runs (project, run_id)
  on delete cascade;

alter table routine_log_entries
  add constraint routine_log_entries_project_run_id_fkey
  foreign key (project, run_id)
  references routine_runs (project, run_id)
  on delete cascade;

-- ── 5. Indices for project-filtered reads

create index if not exists routine_runs_project_news_date_idx
  on routine_runs (project, news_date desc, started_at desc);

create index if not exists news_items_project_news_date_idx
  on news_items (project, news_date desc, rank asc);

create index if not exists routine_log_entries_project_run_seq_idx
  on routine_log_entries (project, run_id, sequence_num);

-- ── 6. 004-introduced columns (nullable; 003 ignores them)

alter table routine_runs add column if not exists daily_summary_en text;
alter table routine_runs add column if not exists daily_summary_zh text;
alter table news_items   add column if not exists impact_en        text;
alter table news_items   add column if not exists impact_zh        text;

-- ── 7. New table: source_recaps (004's /api/recap-source cache)

create table if not exists source_recaps (
  id            uuid primary key default gen_random_uuid(),
  project       text not null default 'shared',  -- recaps are URL-keyed; the 'shared' tag = any showcase can hit a cached row
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

alter table source_recaps enable row level security;
drop policy if exists "public read source_recaps" on source_recaps;
create policy "public read source_recaps" on source_recaps for select using (true);

-- ── 8. Refresh helper views (now project-filtered defaults to 003 for back-compat)

create or replace view latest_run as
  select r.*
  from routine_runs r
  where r.project = 'showcase-003-daily-news'
  order by r.started_at desc
  limit 1;

create or replace view news_today as
  select ni.*
  from news_items ni
  where ni.project = 'showcase-003-daily-news'
    and ni.news_date = current_date
  order by ni.rank asc;

grant select on latest_run to anon, authenticated;
grant select on news_today to anon, authenticated;

-- ── 9. Verify post-migration

-- Expected: existing 003 rows all tagged 'showcase-003-daily-news', no nulls, FKs
-- intact. Run these as smoke checks after the migration:
--   select count(*) from routine_runs        where project is null;  -- 0
--   select count(*) from routine_log_entries where project is null;  -- 0
--   select count(*) from news_items          where project is null;  -- 0
--   select project, count(*) from routine_runs group by project;
