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

## Next gate

C-layer (Routines cloud "Run now") still pending Mark's paste of §A/§B from `mark-ai-talk/0425-003-ROUTINES.md` into the Routines console. With this fix, Mark can press "Run now" multiple times in a row without hitting the unique-constraint trap.
