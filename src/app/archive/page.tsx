import Link from "next/link";
import { supabasePublic, type NewsItem } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  "anthropic-news": "Anthropic",
  "techcrunch-ai": "TechCrunch",
  "hn-24h": "Hacker News",
  "changelog": "Claude Code",
};

const SOURCE_THEME: Record<string, { bg: string; text: string; ring: string }> = {
  "anthropic-news": { bg: "bg-amber-950", text: "text-amber-50", ring: "ring-amber-700" },
  "techcrunch-ai":  { bg: "bg-emerald-950", text: "text-emerald-50", ring: "ring-emerald-700" },
  "hn-24h":         { bg: "bg-orange-700", text: "text-white", ring: "ring-orange-500" },
  "changelog":      { bg: "bg-slate-800", text: "text-slate-50", ring: "ring-slate-600" },
};

export default async function ArchivePage() {
  const supabase = supabasePublic();
  if (!supabase) return <div className="p-12 text-2xl text-slate-700">Supabase not configured.</div>;

  const { data } = await supabase
    .from("news_items")
    .select("*")
    .order("news_date", { ascending: false })
    .order("rank", { ascending: true })
    .limit(120);
  const items = (data ?? []) as NewsItem[];

  const byDate = new Map<string, NewsItem[]>();
  for (const it of items) {
    if (!byDate.has(it.news_date)) byDate.set(it.news_date, []);
    byDate.get(it.news_date)!.push(it);
  }

  return (
    <div className="max-w-5xl mx-auto px-8 py-12">
      <p className="text-base font-bold uppercase tracking-[0.25em] text-slate-500 mb-3">
        Daily history · since 2026-04-24
      </p>
      <h1 className="text-5xl md:text-6xl font-black tracking-tight mb-10 text-slate-900">Archive</h1>
      {byDate.size === 0 ? (
        <p className="text-xl text-slate-700">No archived news yet.</p>
      ) : (
        <div className="space-y-12">
          {[...byDate.entries()].map(([date, dayItems]) => (
            <section key={date}>
              <div className="flex items-baseline gap-4 mb-5 border-b-2 border-slate-300 pb-3">
                <h2 className="text-3xl font-black tabular-nums tracking-tight text-slate-900">{date}</h2>
                <span className="text-base font-semibold text-slate-600">
                  {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="space-y-4">
                {dayItems.map((it) => {
                  const theme = SOURCE_THEME[it.source_name] ?? SOURCE_THEME.changelog;
                  return (
                    <li key={it.id}>
                      <div className="flex items-start gap-4">
                        <span
                          className={`shrink-0 inline-flex items-center px-3 py-1 rounded-full ring-2 ${theme.bg} ${theme.text} ${theme.ring} text-xs font-bold uppercase tracking-wider whitespace-nowrap`}
                        >
                          {SOURCE_LABEL[it.source_name] || it.source_name}
                        </span>
                        <div className="flex-1 min-w-0">
                          <a
                            href={it.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xl font-semibold text-slate-900 hover:underline decoration-2 underline-offset-4 leading-snug block"
                          >
                            {it.title_en}
                          </a>
                          <div className="text-base text-slate-700 mt-1 leading-snug">{it.title_zh}</div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="mt-4">
                <Link
                  href={`/runs?date=${date}`}
                  className="text-base text-slate-600 hover:text-slate-900 font-semibold underline-offset-4 hover:underline"
                >
                  see runs for this date →
                </Link>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
