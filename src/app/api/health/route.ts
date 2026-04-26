import { NextResponse } from "next/server";
import { supabasePublic, PROJECT } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = supabasePublic();
  if (!supabase) {
    return NextResponse.json({
      status: "waiting_credentials",
      app: "showcase-003-daily-news",
      counts: { runs: 0, items: 0, latest_date: null },
      timestamp: new Date().toISOString(),
    });
  }

  const [runsRes, itemsRes, latestRes] = await Promise.all([
    supabase.from("routine_runs").select("*", { count: "exact", head: true }).eq("project", PROJECT),
    supabase.from("news_items").select("*", { count: "exact", head: true }).eq("project", PROJECT),
    supabase.from("news_items").select("news_date").eq("project", PROJECT).order("news_date", { ascending: false }).limit(1),
  ]);

  return NextResponse.json({
    status: "ok",
    app: "showcase-003-daily-news",
    counts: {
      runs: runsRes.count ?? 0,
      items: itemsRes.count ?? 0,
      latest_date: latestRes.data?.[0]?.news_date ?? null,
    },
    timestamp: new Date().toISOString(),
  });
}
