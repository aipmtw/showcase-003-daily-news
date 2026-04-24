import Link from "next/link";
import { notFound } from "next/navigation";
import { supabasePublic, type RoutineRun, type RoutineLogEntry } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = supabasePublic();
  if (!supabase) return <div className="p-10 text-slate-500">Supabase not configured.</div>;

  const { data: runData } = await supabase.from("routine_runs").select("*").eq("run_id", id).limit(1);
  const run = runData?.[0] as RoutineRun | undefined;
  if (!run) notFound();

  const { data: entriesData } = await supabase
    .from("routine_log_entries")
    .select("*")
    .eq("run_id", id)
    .order("sequence_num", { ascending: true });
  const entries = (entriesData ?? []) as RoutineLogEntry[];

  const totalMs = run.finished_at
    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <Link href="/" className="text-sm text-slate-500 hover:text-slate-900">← today</Link>
      <h1 className="text-3xl font-semibold mt-3 mb-2">Run transcript</h1>
      <div className="text-sm text-slate-600 mb-6">
        <code className="font-mono">{run.run_id}</code>
        {" · "}<span className={statusColor(run.status)}>{run.status}</span>
        {" · "}news for <strong>{run.news_date}</strong>
        {totalMs != null && ` · ${(totalMs / 1000).toFixed(1)}s total`}
        {" · "}source: <span className="font-mono text-xs">{run.source_type}</span>
      </div>

      {run.status === "failed" && run.failure_reason && (
        <div className="mb-6 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          <strong>Failure reason:</strong> {run.failure_reason}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="bg-slate-50 border-b border-slate-200 px-4 py-2 text-xs font-mono text-slate-600 flex items-center justify-between">
          <span>routine_log_entries</span>
          <span>{entries.length} entries</span>
        </div>
        <div className="divide-y divide-slate-200">
          {entries.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400 italic">
              No log entries recorded for this run.
            </div>
          )}
          {entries.map((e) => (
            <LogRow key={e.id} e={e} />
          ))}
        </div>
      </div>
    </div>
  );
}

function statusColor(status: string) {
  switch (status) {
    case "succeeded":
      return "text-emerald-700 font-semibold";
    case "degraded":
      return "text-amber-700 font-semibold";
    case "failed":
      return "text-rose-700 font-semibold";
    default:
      return "text-slate-600";
  }
}

function LogRow({ e }: { e: RoutineLogEntry }) {
  const levelColor =
    e.level === "error"
      ? "border-l-rose-400 bg-rose-50"
      : e.level === "warn"
        ? "border-l-amber-400 bg-amber-50"
        : "border-l-slate-200 bg-white";

  return (
    <div className={`px-4 py-3 border-l-4 ${levelColor} text-sm`}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-mono text-xs text-slate-400 tabular-nums">
          {String(e.sequence_num).padStart(3, "0")}
        </span>
        <span className="font-mono text-xs uppercase tracking-wider text-slate-500">
          {e.phase}
        </span>
        {e.tool && <span className="font-mono text-[10px] px-1 rounded bg-slate-100 text-slate-600">{e.tool}</span>}
        {e.duration_ms != null && (
          <span className="font-mono text-[10px] text-slate-400">{e.duration_ms}ms</span>
        )}
        <span className="text-[10px] text-slate-400 ml-auto">
          {new Date(e.logged_at).toISOString().slice(11, 19)}
        </span>
      </div>
      {e.intent && <div className="text-slate-800 mt-1">{e.intent}</div>}
      {e.decision && <div className="text-slate-600 text-xs mt-1">→ {e.decision}</div>}
      {(e.input != null || e.output != null) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-slate-500">input/output</summary>
          {e.input != null && (
            <pre className="mt-1 p-2 bg-slate-950 text-slate-100 rounded overflow-x-auto text-[10px]">
              {`input: ${JSON.stringify(e.input, null, 2)}`}
            </pre>
          )}
          {e.output != null && (
            <pre className="mt-1 p-2 bg-slate-950 text-slate-100 rounded overflow-x-auto text-[10px]">
              {`output: ${JSON.stringify(e.output, null, 2)}`}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}
