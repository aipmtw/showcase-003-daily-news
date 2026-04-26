# Evidence — B-layer smoke green (2026-04-26)

**Trigger:** `npm run trigger:smoke` from this repo at 2026-04-26 ~10:43 TPE
**Endpoint:** `POST https://showcase-003-daily-news.vercel.app/api/routine/run-daily`
**Result:** HTTP 200 · ok=true · 16.8s

```
{
  "ok": true,
  "run_id": "2026-04-26-auto",
  "news_date": "2026-04-26",
  "status": "degraded",
  "items_produced": 3,
  "log_count": 13,
  "elapsed_ms": 15679
}
```

## What this proves

- Vercel `/api/routine/run-daily` reachable, auth check passes, pipeline runs end-to-end.
- Azure OpenAI scoring + Azure Translator + Supabase writes all functioning from the Vercel runtime.
- `news_items` for `2026-04-26` populated (3 rows; degraded mode = dedup floor reached, all sources fetched OK).
- `routine_log_entries` count 13 (init + 4 fetch + 4 score + aggregate + translate + persist + finalize).
- `routine_runs` row updated to `status=degraded · items_produced=3 · finished_at=now()`.

## Live verification

| Check | Result |
|---|---|
| `GET /api/health` | `{status:ok, runs:4, items:9, latest_date:"2026-04-26"}` |
| `GET /` | 3 cards rendered (degraded layout) |
| `GET /runs/2026-04-26-auto` | 44 KB HTML, all phases present (init · fetch ×4 · score ×4 · aggregate · translate · persist · finalize) |

## What got fixed to make this green

First smoke attempt 500'd: `duplicate key value violates unique constraint "routine_runs_run_id_key"` — `2026-04-26-auto` already existed from earlier today's run.

Fix in `src/lib/daily-pipeline.ts` step 1 (commit `9a2471b`):

```ts
const { error: delErr } = await supabase.from("routine_runs").delete().eq("run_id", runId);
if (delErr) throw new Error(`routine_runs prior-delete: ${delErr.message}`);
```

Cascades to `routine_log_entries` via the existing FK `on delete cascade`. Same idempotency pattern as the `news_items.delete().eq("news_date", ...)` already present in step 6.

This means re-triggering the same run_id (smoke test, Routines "Run now") now cleanly replaces the prior attempt.

## C-layer (Routines cloud) — also green 2026-04-26

Three independent cloud→Vercel triggers prove the path:

| Run | Trigger | Result |
|---|---|---|
| 8:10 AM scheduled (cron) | `0 0 * * *` UTC | ✅ `OK · run_id=2026-04-26-auto · status=degraded · items=3 · elapsed=14806ms` |
| 9:49 AM Run now (manual) | console button | ❌ HTTP 503 "DNS cache overflow" — transient (overlapped with local smoke) |
| 9:50 AM Run now (manual) | console button | ✅ `OK · run_id=2026-04-26-auto · status=degraded · items=3 · elapsed=15673ms` |

C green criterion (≥2 successful runs, including ≥1 scheduled) is met. The 503 is logged as transient; if it recurs, the mitigation is to make the 4 source fetches sequential instead of `Promise.all` to reduce DNS pressure on the Vercel runtime.

## Status

All three test layers (A pipeline / B Vercel endpoint / C Routines cloud) are now green. `routines/daily.md` v2 architecture works end-to-end. Cron will fire next at 08:00 TPE on 2026-04-27.
