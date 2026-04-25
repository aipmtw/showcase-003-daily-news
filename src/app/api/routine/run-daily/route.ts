import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runDailyPipeline, tpeDate } from "@/lib/daily-pipeline";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// POST /api/routine/run-daily
//
// V2 pivot: Routines cloud egress allowlist blocks Supabase, Azure, and most
// news sources. Routine becomes a 1-curl trigger; this endpoint runs the
// whole fetch → score → translate → persist pipeline in Vercel where
// outbound is unrestricted.
//
// Auth: X-Routine-Secret header must match ROUTINE_INGEST_SECRET env var
// (same secret as /api/routine/ingest — single shared trigger key).
//
// Body (optional):
//   { run_id?: "2026-04-25-auto", news_date?: "2026-04-25", source_type?: "routine_cloud" }
//
// Defaults: news_date = today in Asia/Taipei; run_id = "<news_date>-auto".

export async function POST(req: Request) {
  const secret = process.env.ROUTINE_INGEST_SECRET;
  const provided = req.headers.get("x-routine-secret");
  if (!secret) return NextResponse.json({ error: "server_misconfigured" }, { status: 500 });
  if (!provided || provided !== secret) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { run_id?: string; news_date?: string; source_type?: string } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const newsDate = body.news_date || tpeDate();
  const runId = body.run_id || `${newsDate}-auto`;
  const sourceType = body.source_type || "routine_cloud";

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "db_env_missing" }, { status: 500 });
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  try {
    const result = await runDailyPipeline({ runId, newsDate, sourceType, supabase });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 300) || String(err);
    try {
      await supabase
        .from("routine_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          items_produced: 0,
          failure_reason: msg.slice(0, 200),
        })
        .eq("run_id", runId);
    } catch {}
    return NextResponse.json({ ok: false, error: "pipeline_failed", detail: msg, run_id: runId }, { status: 500 });
  }
}
