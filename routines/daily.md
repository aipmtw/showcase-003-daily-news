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
  2. Fetch 4 sources: changelog · anthropic-news · techcrunch-ai · hn-24h
  3. Score candidates per source via Azure OpenAI gpt-4o (0.4*recency + 0.6*valuableness)
  4. Dedup → 4 picks (3 = degraded, <3 = failed)
  5. Translate to zh-Hant via Azure Translator
  6. INSERT 4 news_items + ~15-25 routine_log_entries
  7. UPDATE routine_runs (status=succeeded|degraded|failed)

Expected response on success:
  {"ok":true,"run_id":"<YYYY-MM-DD>-auto","news_date":"<YYYY-MM-DD>",
   "status":"succeeded"|"degraded","items_produced":3-4,"log_count":15-25,
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

(Unchanged from v1 — same tables, same shape, same `/runs/[id]` UI.)

- `routine_runs`: **1 row** (status=succeeded · items_produced=4 · duration ~30-60 sec)
- `routine_log_entries`: **~15-25 rows** (init + 4 fetch + 4 score + 1 aggregate + 1 translate + 1 persist + 1 finalize)
- `news_items`: **4 rows** (rank 1..4 for that `news_date`)

---

## Degraded modes

| Situation | Run status | news_items | Site behavior |
|---|---|---|---|
| All 4 sources OK, 4 picks after dedup | `succeeded` | 4 rows | 2×2 grid full |
| Dedup reduces to 3 | `degraded` | 3 rows | 3-card layout · warn 標在頁面一角 |
| < 3 picks after all retry | `failed` | 0 rows | 首頁顯示前一天的 items + `失敗原因` 區塊 |
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
