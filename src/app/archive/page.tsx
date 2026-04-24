import Link from "next/link";
import { supabasePublic, type NewsItem } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  "changelog": "Claude Code",
  "anthropic-news": "Anthropic",
  "techcrunch-ai": "TechCrunch",
  "hn-24h": "Hacker News",
};

export default async function ArchivePage() {
  const supabase = supabasePublic();
  if (!supabase) return <div className="p-10 text-slate-500">Supabase not configured.</div>;

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
    <div className="max-w-5xl mx-auto px-6 py-10">
      <h1 className="text-3xl font-semibold mb-6">Archive</h1>
      {byDate.size === 0 ? (
        <p className="text-slate-500 text-sm">No archived news yet.</p>
      ) : (
        <div className="space-y-8">
          {[...byDate.entries()].map(([date, dayItems]) => (
            <section key={date}>
              <h2 className="text-xl font-semibold mb-3 border-b border-slate-200 pb-1">
                {date}
                <span className="text-sm font-normal text-slate-500 ml-2">
                  {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
                </span>
              </h2>
              <ul className="space-y-2">
                {dayItems.map((it) => (
                  <li key={it.id} className="text-sm">
                    <span className="text-[10px] uppercase tracking-wider text-slate-500 font-mono mr-2">
                      {SOURCE_LABEL[it.source_name] || it.source_name}
                    </span>
                    <a href={it.url} target="_blank" rel="noreferrer" className="hover:underline">
                      {it.title_en}
                    </a>
                    <div className="text-xs text-slate-500 mt-0.5 ml-[84px]">{it.title_zh}</div>
                  </li>
                ))}
              </ul>
              <div className="mt-2 text-xs">
                <Link href={`/runs?date=${date}`} className="text-slate-500 hover:text-slate-900 underline decoration-dotted">
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
