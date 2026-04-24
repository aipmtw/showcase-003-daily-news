# routines/daily.md — Claude Code Routine spec

**Routine name:** `daily-news`
**Schedule:** `0 0 * * *` UTC = **08:00 Asia/Taipei daily**
**Quota:** 1/day against Max plan's 15/day
**Purpose:** Fetch + rank + translate + persist the day's 4 AI-coding news items to Supabase.

**Paired executable:** `routines/daily-runner.mjs`(the local-runnable equivalent · same logic,no Routines-cloud orchestration)

**Ranking spec:** `../../spec/003/news-ranking.md`

---

## Secrets required in Routines console

- `SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase dashboard · project settings · API · service_role
- `ANTHROPIC_API_KEY` — for the Opus scoring calls inside the routine

---

## Routine prompt(paste into Routines console)

> **Note:** the actual executable lives in `routines/daily-runner.mjs`. This prompt is for Routines cloud to run the equivalent logic using WebSearch + WebFetch + direct Supabase REST calls.

```
You are the `daily-news` routine for showcase-003-daily-news. Your job:
fetch AI-coding news from 4 sources, score them per spec/003/news-ranking.md,
translate the 4 winners to Traditional Chinese, and persist everything to
Supabase along with a full execution log.

RUN_ID = today's ISO date + "-auto" (e.g. "2026-04-25-auto")

Step 1 — INIT: insert a routine_runs row with status="running", source_type="routine_cloud",
news_date=today.

Step 2 — For each of these 4 sources, in order:
  a. source="changelog"       fetch https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
  b. source="anthropic-news"  fetch https://www.anthropic.com/news
  c. source="techcrunch-ai"   fetch https://techcrunch.com/category/artificial-intelligence/feed/
  d. source="hn-24h"          fetch https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>{24h_ago}

  For EACH source:
    - INSERT a routine_log_entries row with phase="fetch", tool="WebFetch",
      input={url}, output={truncated response snippet}, duration_ms=<measured>.
    - Extract candidate items from the fetched content.
    - For each candidate, call Claude Opus with the valuableness prompt in
      spec/003/news-ranking.md §Appendix A. Compute score = 0.4*recency + 0.6*valuableness.
    - INSERT a routine_log_entries row with phase="score", intent="rank <source>",
      output={candidates:[{title,score}]}, decision="pick top 1: <title>".
    - Keep the top 1.

Step 3 — AGGREGATE: combine the 4 picks (one per source).
  - Apply dedup rule from spec/003 §Rule 2 (URL canonical + title cosine 0.85).
  - If dedup leaves 4 → proceed with 4. If 3 → log warn_dedup_floor and proceed with 3.
  - If < 3 → UPDATE routine_runs row with status="failed", failure_reason="dedup_floor_breach",
    and STOP. Do NOT write to news_items.

Step 4 — TRANSLATE: for each surviving pick, call Opus to produce Traditional Chinese
title + summary (<=140 chars for title, <=250 for summary). Log one phase="translate"
entry per item.

Step 5 — PERSIST: INSERT N rows into news_items (rank=1..N by score descending),
with run_id, news_date, source_name, title_en/zh, summary_en/zh, url, published_at, score.

Step 6 — FINALIZE: UPDATE routine_runs row with status="succeeded" (or "degraded" if 3),
items_produced=N, finished_at=now().

At every step, if a source is unreachable after 3 retries with 30s backoff, log
warn_source_unreachable and CONTINUE to next source. The run succeeds if >=2
sources delivered picks.
```

---

## What gets written to Supabase on a successful run

- `routine_runs`: **1 row**(status=succeeded · items_produced=4 · duration ~30-90 sec)
- `routine_log_entries`: **~15-25 rows**(4 fetch + 4 score + up to 4 translate + 1 aggregate + 1 persist + 1 finalize + warns)
- `news_items`: **4 rows**(rank 1..4 for that `news_date`)

---

## Degraded modes

| Situation | Run status | news_items | Site behavior |
|---|---|---|---|
| All 4 sources OK, 4 picks after dedup | `succeeded` | 4 rows | 2×2 grid full |
| Dedup reduces to 3 | `degraded` | 3 rows | 3-card layout · warn 標在頁面一角 |
| < 3 picks after all retry | `failed` | 0 rows | 首頁顯示前一天的 items + `失敗原因` 區塊 |
| 1 source down | `succeeded`(if other 3 make 4 picks via internal rank, unusual)or `degraded` | 3-4 | 標該 source 灰 |

---

## Local-equivalent execution (Phase 1)

```bash
# Phase 1 (tonight) — run locally against the same Supabase instance
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export ANTHROPIC_API_KEY=...
node routines/daily-runner.mjs --run-id "2026-04-24-manual"
```

When the cloud Routine later fires, it does the same steps with `--run-id "2026-04-25-auto"`. Both write to the same Supabase; the site shows whichever is latest by `started_at`.

---

## Authoring protocol

This file's editing rules inherit from `../../spec/001/build-md-authoring.md`:
- snapshot-before-revise for source bugs(rename old to `daily-<YYYY-MM-DD_HHMMSS>.md`)
- positive-confirmation for retry loops
- no `grep -q <magic-string>` against evolving stdout
