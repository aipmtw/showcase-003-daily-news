import Link from "next/link";
import { supabasePublic, type RoutineRun } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function RunsListPage() {
  const supabase = supabasePublic();
  if (!supabase) return <div className="p-10 text-slate-500">Supabase not configured.</div>;

  const { data } = await supabase
    .from("routine_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(30);
  const runs = (data ?? []) as RoutineRun[];

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-semibold mb-6">Recent runs</h1>
      {runs.length === 0 ? (
        <p className="text-slate-500 text-sm">No runs yet.</p>
      ) : (
        <div className="rounded-lg border border-slate-200 divide-y divide-slate-200">
          {runs.map((r) => (
            <Link
              key={r.id}
              href={`/runs/${r.run_id}`}
              className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 text-sm"
            >
              <div className="flex items-center gap-3">
                <span className={`inline-block w-2 h-2 rounded-full ${dotColor(r.status)}`} />
                <span className="font-mono text-xs">{r.run_id}</span>
                <span className="text-xs text-slate-500">news {r.news_date}</span>
              </div>
              <div className="text-xs text-slate-500 flex items-center gap-3">
                <span>{r.status}</span>
                {r.items_produced != null && <span>{r.items_produced} items</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function dotColor(status: string) {
  switch (status) {
    case "succeeded":
      return "bg-emerald-500";
    case "degraded":
      return "bg-amber-500";
    case "failed":
      return "bg-rose-500";
    default:
      return "bg-slate-400";
  }
}
