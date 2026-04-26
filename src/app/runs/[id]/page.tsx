import Link from "next/link";
import { notFound } from "next/navigation";
import { supabasePublic, PROJECT, type RoutineRun, type RoutineLogEntry } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PHASE_THEME: Record<string, string> = {
  init:      "bg-slate-900 text-white",
  fetch:     "bg-sky-700 text-white",
  score:     "bg-violet-700 text-white",
  aggregate: "bg-amber-700 text-white",
  translate: "bg-emerald-700 text-white",
  persist:   "bg-fuchsia-800 text-white",
  finalize:  "bg-slate-700 text-white",
};

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = supabasePublic();
  if (!supabase) return <div className="p-12 text-2xl text-slate-700">Supabase not configured.</div>;

  const { data: runData } = await supabase
    .from("routine_runs")
    .select("*")
    .eq("project", PROJECT)
    .eq("run_id", id)
    .limit(1);
  const run = runData?.[0] as RoutineRun | undefined;
  if (!run) notFound();

  const { data: entriesData } = await supabase
    .from("routine_log_entries")
    .select("*")
    .eq("project", PROJECT)
    .eq("run_id", id)
    .order("sequence_num", { ascending: true });
  const entries = (entriesData ?? []) as RoutineLogEntry[];

  const totalMs = run.finished_at
    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null;

  return (
    <div className="max-w-5xl mx-auto px-8 py-12">
      <Link href="/" className="text-base text-slate-600 hover:text-slate-900 font-semibold underline-offset-4 hover:underline">
        ← back to today
      </Link>
      <h1 className="text-5xl md:text-6xl font-black tracking-tight mt-4 mb-4 text-slate-900">Run transcript</h1>
      <div className="flex items-center gap-4 flex-wrap mb-8 text-lg">
        <code className="font-mono font-semibold text-slate-900 bg-slate-100 px-3 py-1 rounded">{run.run_id}</code>
        <StatusBadge status={run.status} />
        <span className="text-slate-700">news for <strong className="text-slate-900">{run.news_date}</strong></span>
        {totalMs != null && <span className="text-slate-700">{(totalMs / 1000).toFixed(1)}s total</span>}
        <span className="text-slate-500 font-mono text-base">{run.source_type}</span>
      </div>

      {run.status === "failed" && run.failure_reason && (
        <div className="mb-8 rounded-xl border-2 border-rose-300 bg-rose-50 p-6 text-lg text-rose-900">
          <strong className="text-xl">Failure reason:</strong> {run.failure_reason}
        </div>
      )}

      <div className="rounded-xl border-2 border-slate-300 overflow-hidden">
        <div className="bg-slate-900 text-white px-6 py-4 text-base font-mono flex items-center justify-between">
          <span className="font-bold uppercase tracking-wider">routine_log_entries</span>
          <span className="font-semibold">{entries.length} entries</span>
        </div>
        <div className="divide-y-2 divide-slate-200">
          {entries.length === 0 && (
            <div className="p-12 text-center text-xl text-slate-500 italic">
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

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    succeeded: "bg-emerald-700 text-white",
    degraded: "bg-amber-600 text-white",
    failed: "bg-rose-700 text-white",
    running: "bg-slate-700 text-white",
  };
  return (
    <span className={`px-3 py-1 rounded-md font-bold uppercase tracking-wider text-base ${styles[status] || styles.running}`}>
      {status}
    </span>
  );
}

function LogRow({ e }: { e: RoutineLogEntry }) {
  const levelAccent =
    e.level === "error"
      ? "border-l-rose-500 bg-rose-50"
      : e.level === "warn"
        ? "border-l-amber-500 bg-amber-50"
        : "border-l-slate-200 bg-white";
  const phaseTheme = PHASE_THEME[e.phase] ?? PHASE_THEME.finalize;

  return (
    <div className={`px-6 py-5 border-l-[6px] ${levelAccent}`}>
      <div className="flex items-baseline gap-4 flex-wrap">
        <span className="font-mono text-base font-bold text-slate-900 tabular-nums">
          {String(e.sequence_num).padStart(3, "0")}
        </span>
        <span className={`inline-flex items-center px-3 py-1 rounded-md text-sm font-bold uppercase tracking-wider ${phaseTheme}`}>
          {e.phase}
        </span>
        {e.tool && (
          <span className="font-mono text-sm px-2 py-0.5 rounded bg-slate-200 text-slate-800 font-semibold">
            {e.tool}
          </span>
        )}
        {e.duration_ms != null && (
          <span className="font-mono text-sm text-slate-700 font-semibold">{e.duration_ms}ms</span>
        )}
        <span className="text-sm text-slate-500 font-mono ml-auto tabular-nums">
          {new Date(e.logged_at).toISOString().slice(11, 19)}
        </span>
      </div>
      {e.intent && <div className="text-xl text-slate-900 mt-3 font-semibold leading-snug">{e.intent}</div>}
      {e.decision && <div className="text-base text-slate-700 mt-2 leading-relaxed">→ {e.decision}</div>}
      {(e.input != null || e.output != null) && (
        <details className="mt-4">
          <summary className="cursor-pointer text-base text-slate-600 font-semibold hover:text-slate-900">
            input / output
          </summary>
          {e.input != null && (
            <pre className="mt-2 p-4 bg-slate-950 text-slate-100 rounded-md overflow-x-auto text-sm leading-relaxed">
              {`input: ${JSON.stringify(e.input, null, 2)}`}
            </pre>
          )}
          {e.output != null && (
            <pre className="mt-2 p-4 bg-slate-950 text-slate-100 rounded-md overflow-x-auto text-sm leading-relaxed">
              {`output: ${JSON.stringify(e.output, null, 2)}`}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}
