import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { PROJECT } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/routine/ingest
//
// Called by the Claude Code Routine in the cloud sandbox. The sandbox can NOT
// directly reach Supabase (outbound-host allowlist on the routine side), so
// the routine sends us its picks + log as a single JSON payload, and we
// fan-out the INSERTs server-side using the service-role key.
//
// Auth: X-Routine-Secret header must match ROUTINE_INGEST_SECRET env var.
//
// Expected body shape (trusted — routine is authenticated):
// {
//   run_id:        "2026-04-25-auto",
//   news_date:     "2026-04-25",
//   source_type:   "routine_cloud" | "manual_local",
//   status:        "succeeded" | "degraded" | "failed",
//   started_at:    ISO-8601 string,
//   finished_at:   ISO-8601 string,
//   items_produced: 4,
//   failure_reason: string | null,
//   picks: [
//     { rank: 1..N, source_name, title_en, title_zh, summary_en, summary_zh,
//       url, published_at, score }
//   ],
//   log_entries: [
//     { sequence_num, phase, intent, tool, input, output, decision,
//       duration_ms, level }
//   ]
// }

type Pick = {
  rank: number;
  source_name: string;
  title_en: string;
  title_zh: string;
  summary_en: string;
  summary_zh: string;
  url: string;
  published_at?: string | null;
  score?: number | string | null;
};

type LogEntry = {
  sequence_num: number;
  phase: string;
  intent?: string | null;
  tool?: string | null;
  input?: unknown;
  output?: unknown;
  decision?: string | null;
  duration_ms?: number | null;
  level?: "info" | "warn" | "error";
};

type Payload = {
  run_id: string;
  news_date: string;
  source_type?: string;
  status: "succeeded" | "degraded" | "failed";
  started_at: string;
  finished_at: string;
  items_produced?: number;
  failure_reason?: string | null;
  picks: Pick[];
  log_entries?: LogEntry[];
};

export async function POST(req: Request) {
  // Auth
  const secret = process.env.ROUTINE_INGEST_SECRET;
  const provided = req.headers.get("x-routine-secret");
  if (!secret) {
    return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  }
  if (!provided || provided !== secret) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.run_id || !body.news_date) {
    return NextResponse.json({ error: "missing run_id or news_date" }, { status: 400 });
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "db_env_missing" }, { status: 500 });
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  // 1. Upsert routine_runs row (the routine can call this mid-run if it wants,
  //    or just once at the end — we're liberal about what counts as complete).
  const { error: runErr } = await supabase
    .from("routine_runs")
    .upsert(
      {
        project: PROJECT,
        run_id: body.run_id,
        news_date: body.news_date,
        source_type: body.source_type ?? "routine_cloud",
        status: body.status,
        started_at: body.started_at,
        finished_at: body.finished_at,
        items_produced: body.items_produced ?? body.picks.length,
        failure_reason: body.failure_reason ?? null,
      },
      { onConflict: "project,run_id" },
    );
  if (runErr) {
    return NextResponse.json({ error: "runs_upsert_failed", detail: runErr.message }, { status: 500 });
  }

  // 2. Insert log entries if provided (delete any existing for idempotency)
  if (body.log_entries && body.log_entries.length > 0) {
    await supabase.from("routine_log_entries").delete().eq("project", PROJECT).eq("run_id", body.run_id);
    const rows = body.log_entries.map((e) => ({
      project: PROJECT,
      run_id: body.run_id,
      sequence_num: e.sequence_num,
      phase: e.phase,
      intent: e.intent ?? null,
      tool: e.tool ?? null,
      input: e.input ?? null,
      output: e.output ?? null,
      decision: e.decision ?? null,
      duration_ms: e.duration_ms ?? null,
      level: e.level ?? "info",
      logged_at: new Date().toISOString(),
    }));
    const { error: logErr } = await supabase.from("routine_log_entries").insert(rows);
    if (logErr) {
      return NextResponse.json({ error: "logs_insert_failed", detail: logErr.message }, { status: 500 });
    }
  }

  // 3. Insert news_items (delete any existing for this date — last run wins)
  if (body.picks && body.picks.length > 0 && body.status !== "failed") {
    await supabase.from("news_items").delete().eq("project", PROJECT).eq("news_date", body.news_date);
    const rows = body.picks.map((p) => ({
      project: PROJECT,
      run_id: body.run_id,
      news_date: body.news_date,
      rank: p.rank,
      source_name: p.source_name,
      title_en: p.title_en,
      title_zh: p.title_zh,
      summary_en: p.summary_en,
      summary_zh: p.summary_zh,
      url: p.url,
      published_at: p.published_at ?? null,
      score: p.score != null ? String(p.score) : null,
    }));
    const { error: itemsErr } = await supabase.from("news_items").insert(rows);
    if (itemsErr) {
      return NextResponse.json({ error: "items_insert_failed", detail: itemsErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    run_id: body.run_id,
    news_date: body.news_date,
    status: body.status,
    items_count: body.picks?.length ?? 0,
    log_count: body.log_entries?.length ?? 0,
  });
}
