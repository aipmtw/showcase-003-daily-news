# routines/daily.md — Claude Code Routine spec (v2 · trigger model)

**Routine name:** `daily-news`
**Schedule:** `0 0 * * *` UTC = **08:00 Asia/Taipei daily**
**Quota:** 1/day against Max plan's 15/day
**Purpose:** Trigger the Vercel-hosted daily news pipeline; the pipeline does fetch + score + translate + persist.

**Architecture pivot (v2 · 2026-04-25):** Routines cloud egress allowlist blocks Supabase, Azure, and the news sources themselves (only `raw.githubusercontent.com` is reachable). The routine no longer does the work — it triggers `POST /api/routine/run-daily` on Vercel, which has no outbound restrictions. The Vercel handler runs the full pipeline (Azure OpenAI scoring + Azure Translator + Supabase writes) and writes all `routine_log_entries` server-side, so the `/runs/[id]` log UI is unaffected.

**Paired executable:** `routines/daily-runner.mjs` — local-runnable equivalent of the same pipeline (Phase 1 fallback if Vercel is down).

**Pipeline source:** `src/lib/daily-pipeline.ts` (TS port of daily-runner.mjs, the canonical Vercel-side implementation).

---

## Allowlist requirement (cloud env `daily-news-env`)

Only **one** non-default host needs to be on the routine env's Custom network allowlist:

```
*.vercel.app
```

Default list covers `api.anthropic.com`. Everything else (Supabase, Azure, news sources) is hit from Vercel, not the routine.

---

## Routine prompt (paste into Routines console)

```
You are the daily-news trigger for showcase-003-daily-news.

Your only job: POST to the Vercel pipeline endpoint with the auth header,
read the JSON response, and report.

curl -sS -w "\n[HTTP %{http_code} · %{time_total}s]\n" \
  -X POST "https://showcase-003-daily-news.vercel.app/api/routine/run-daily" \
  -H "X-Routine-Secret: $ROUTINE_INGEST_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}'

The Vercel pipeline (src/lib/daily-pipeline.ts) does:
  1. INSERT routine_runs row (status=running)
  2. Fetch 3 internet sources: anthropic-news · techcrunch-ai · hn-24h
  3. Score candidates per source via Azure OpenAI gpt-4o (0.4*recency + 0.6*valuableness)
  4. Dedup → up to 3 picks (2 = degraded, <2 = failed)
  5. Translate to zh-Hant via Azure Translator
  6. INSERT 2-3 news_items + ~12-20 routine_log_entries
  7. UPDATE routine_runs (status=succeeded|degraded|failed)

(The Anthropic CHANGELOG source was dropped 2026-04-26 — it doesn't update
daily, so the same release-bullet kept winning the score and repeating
across days. The pipeline now focuses on internet news that moves day-to-day.)

Expected response on success:
  {"ok":true,"run_id":"<YYYY-MM-DD>-auto","news_date":"<YYYY-MM-DD>",
   "status":"succeeded"|"degraded","items_produced":2-3,"log_count":12-20,
   "elapsed_ms":<N>}

If HTTP != 200 or ok=false, print the response body verbatim and report failed.
Do not retry — the Vercel handler has its own error handling and writes
failed status to routine_runs even on pipeline error.

Final console output:
  ✓ daily-news triggered · run_id=<id> · status=<status> · items=<N> · elapsed=<ms>ms
```

---

## Secrets required in cloud env

- `ROUTINE_INGEST_SECRET` — shared secret (same one used by `/api/routine/ingest`); routine puts it in `X-Routine-Secret` header

That's it. **No more Supabase URL / service key / Azure keys in the routine prompt.** All credentials live in Vercel env.

---

## What gets written to Supabase on a successful run

Same tables / shape / `/runs/[id]` UI; only the counts shrink with the
3-source pipeline.

- `routine_runs`: **1 row** (status=succeeded · items_produced=3 · duration ~15-30 sec)
- `routine_log_entries`: **~12-20 rows** (init + 3 fetch + 3 score + 1 aggregate + 1 translate + 1 persist + 1 finalize)
- `news_items`: **3 rows** (rank 1..3 for that `news_date`)

---

## Degraded modes

| Situation | Run status | news_items | Site behavior |
|---|---|---|---|
| All 3 sources OK, 3 unique picks after dedup | `succeeded` | 3 rows | full 3-card row |
| Dedup or one source fail reduces to 2 | `degraded` | 2 rows | 2-card layout |
| < 2 picks after all retry | `failed` | 0 rows | 首頁顯示前一天的 items + `失敗原因` 區塊 |
| Pipeline throws unhandled | `failed` | 0 rows | failure_reason recorded; routine logs HTTP 500 body |

---

## Local-equivalent execution (Phase 1 fallback)

```bash
# Same logic, no Routines cloud — useful when Vercel/Supabase is being changed
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
export AZURE_OPENAI_ENDPOINT=...
export AZURE_OPENAI_KEY=...
export AZURE_TRANSLATOR_KEY=...
node routines/daily-runner.mjs --run-id "2026-04-25-manual"
```

---

## Authoring protocol

This file's editing rules inherit from `../../spec/001/build-md-authoring.md`:
- snapshot-before-revise for source bugs (rename old to `daily-<YYYY-MM-DD_HHMMSS>.md`)
- positive-confirmation for retry loops
- no `grep -q <magic-string>` against evolving stdout
