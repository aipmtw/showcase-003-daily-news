import Link from "next/link";
import { supabasePublic, type NewsItem, type RoutineRun } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  "changelog": "Claude Code",
  "anthropic-news": "Anthropic",
  "techcrunch-ai": "TechCrunch",
  "hn-24h": "Hacker News",
};

function fmt(d: string) {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Taipei" })
    .format(new Date(d));
}

export default async function HomePage() {
  const supabase = supabasePublic();

  if (!supabase) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-16 text-center text-slate-500">
        <h1 className="text-2xl text-slate-900 mb-3">Site up — waiting for Supabase credentials</h1>
        <p className="text-sm">
          Once Mark pastes <code className="bg-slate-100 px-1 py-0.5 rounded">SUPABASE_URL</code> +
          {" "}<code className="bg-slate-100 px-1 py-0.5 rounded">SUPABASE_ANON_KEY</code> into Vercel env,
          today&apos;s 4 picks will appear here.
        </p>
      </div>
    );
  }

  const { data: runData } = await supabase
    .from("routine_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(1);
  const latestRun = runData?.[0] as RoutineRun | undefined;

  const newsDate = latestRun?.news_date ?? new Date().toISOString().slice(0, 10);

  const { data: itemsData } = await supabase
    .from("news_items")
    .select("*")
    .eq("news_date", newsDate)
    .order("rank", { ascending: true });
  const items = (itemsData ?? []) as NewsItem[];

  return (
    <div className="max-w-5xl mx-auto px-6 py-10">
      <section className="mb-8">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            <span className="text-slate-900">Today&apos;s digest</span>
            <span className="text-slate-500 ml-3 text-base font-normal">· {newsDate}</span>
          </h1>
          {latestRun && (
            <Link
              href={`/runs/${latestRun.run_id}`}
              className="text-sm text-slate-600 hover:text-slate-900 underline decoration-dotted"
            >
              see how this was picked →
            </Link>
          )}
        </div>
        {latestRun && (
          <div className="mt-2 text-xs text-slate-500">
            Last run: <span className={statusColor(latestRun.status)}>{latestRun.status}</span>
            {" · "}ID <code className="font-mono">{latestRun.run_id}</code>
            {" · "}
            {latestRun.finished_at
              ? `${Math.round((new Date(latestRun.finished_at).getTime() - new Date(latestRun.started_at).getTime()) / 1000)}s`
              : "in progress"}
          </div>
        )}
      </section>

      {items.length === 0 ? (
        <div className="border border-dashed border-slate-300 rounded-lg p-10 text-center text-slate-500">
          <p className="text-sm">No news items yet for {newsDate}.</p>
          <p className="text-xs mt-2">The next Routine run fires at 08:00 Asia/Taipei.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((item) => (
            <NewsCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function statusColor(status: string) {
  switch (status) {
    case "succeeded":
      return "text-emerald-600";
    case "degraded":
      return "text-amber-600";
    case "failed":
      return "text-rose-600";
    default:
      return "text-slate-500";
  }
}

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <article
      data-news-card={item.rank}
      className="rounded-lg border border-slate-200 p-5 hover:border-slate-300 transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          #{item.rank} · {SOURCE_LABEL[item.source_name] || item.source_name}
        </span>
        {item.score != null && (
          <span className="text-[10px] font-mono text-slate-400">score {item.score}</span>
        )}
      </div>
      <h2 className="text-lg font-semibold leading-snug mb-1">
        <a href={item.url} target="_blank" rel="noreferrer" className="hover:underline">
          {item.title_en}
        </a>
      </h2>
      <h3 className="text-sm text-slate-600 mb-3">{item.title_zh}</h3>
      <p className="text-sm text-slate-700 leading-relaxed mb-2">{item.summary_en}</p>
      <p className="text-xs text-slate-500 leading-relaxed">{item.summary_zh}</p>
      {item.published_at && (
        <p className="mt-3 text-[10px] text-slate-400 font-mono">{fmt(item.published_at)}</p>
      )}
    </article>
  );
}
