// src/lib/daily-pipeline.ts — server-side daily news pipeline.
//
// Port of routines/daily-runner.mjs into the Next.js runtime so the routine
// can trigger us via /api/routine/run-daily and we do all the work here
// (Routines cloud egress allowlist blocks most hosts; Vercel has none).
//
// Pipeline: fetch 4 sources → score (Azure OpenAI gpt-4o) → dedup
// → translate (Azure Translator) → persist to Supabase + write log_entries.
//
// Logs every phase to routine_log_entries so /runs/[id] still tells the
// full story even though the routine session itself only fired a curl.

import { type SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────────

type Candidate = {
  source: string;
  title: string;
  summary: string;
  url: string;
  published_at: string | null;
  recency_hint: number;
  score_valuable?: number;
  score_final?: number;
  title_zh?: string;
  summary_zh?: string;
};

type LogLevel = "info" | "warn" | "error";

export type PipelineResult = {
  run_id: string;
  news_date: string;
  status: "succeeded" | "degraded" | "failed";
  items_produced: number;
  log_count: number;
  elapsed_ms: number;
  failure_reason?: string;
};

export type PipelineOpts = {
  runId: string;
  newsDate: string;
  sourceType?: string;
  supabase: SupabaseClient;
};

// ── Azure helpers (read env at call-time) ────────────────────────

function azureOpenAIChat(messages: Array<{ role: string; content: string }>, max_tokens = 80) {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt4o";
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
  if (!endpoint || !key) throw new Error("AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY required");
  const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  return fetch(url, {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens, temperature: 0.2 }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`AzureOpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return (j.choices?.[0]?.message?.content as string) ?? "";
  });
}

async function azureTranslate(texts: string[]): Promise<string[]> {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION || "southeastasia";
  const ep = process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  if (!key) throw new Error("AZURE_TRANSLATOR_KEY required");
  const url = `${ep.replace(/\/$/, "")}/translate?api-version=3.0&from=en&to=zh-Hant`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Ocp-Apim-Subscription-Region": region,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(texts.map((t) => ({ text: t }))),
  });
  if (!r.ok) throw new Error(`AzureTranslator ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as Array<{ translations: Array<{ text: string }> }>;
  return j.map((entry) => entry.translations[0].text);
}

// ── Sources ──────────────────────────────────────────────────────

async function fetchChangelog(): Promise<Candidate[]> {
  const url = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`changelog HTTP ${r.status}`);
  const text = await r.text();
  const releases = text.split(/^## /m).slice(1, 4);
  const out: Candidate[] = [];
  for (const rel of releases) {
    const versionLine = rel.split("\n")[0].trim();
    const bullets = rel
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(0, 3)
      .map((l) => l.replace(/^- /, "").trim());
    for (const b of bullets) {
      out.push({
        source: "changelog",
        title: b.length > 140 ? b.slice(0, 137) + "…" : b,
        summary: b,
        url: `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${versionLine.toLowerCase().replace(/\./g, "")}`,
        published_at: null,
        recency_hint: 1.0,
      });
    }
  }
  return out;
}

async function fetchAnthropicNews(): Promise<Candidate[]> {
  const url = "https://www.anthropic.com/news";
  const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
  if (!r.ok) throw new Error(`anthropic-news HTTP ${r.status}`);
  const html = await r.text();
  const out: Candidate[] = [];
  const re = /<a[^>]+href="(\/news\/[^"]+)"[^>]*>([^<]{10,200})<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({
      source: "anthropic-news",
      title: m[2].trim().replace(/\s+/g, " "),
      summary: m[2].trim(),
      url: `https://www.anthropic.com${m[1]}`,
      published_at: null,
      recency_hint: 0.9,
    });
    if (out.length >= 10) break;
  }
  return out;
}

async function fetchTechcrunchAi(): Promise<Candidate[]> {
  const url = "https://techcrunch.com/category/artificial-intelligence/feed/";
  const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
  if (!r.ok) throw new Error(`techcrunch HTTP ${r.status}`);
  const xml = await r.text();
  const out: Candidate[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || "").trim();
    const link = (block.match(/<link>(.*?)<\/link>/)?.[1] || "").trim();
    const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "")
      .replace(/<[^>]+>/g, "")
      .trim()
      .slice(0, 250);
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "").trim();
    const ageDays = pubDate ? (Date.now() - new Date(pubDate).getTime()) / 86400000 : 30;
    out.push({
      source: "techcrunch-ai",
      title,
      summary: desc || title,
      url: link,
      published_at: pubDate ? new Date(pubDate).toISOString() : null,
      recency_hint: Math.max(0, 1 - ageDays / 30),
    });
    if (out.length >= 15) break;
  }
  return out;
}

async function fetchHn24h(): Promise<Candidate[]> {
  const since = Math.floor((Date.now() - 86400000) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since}&hitsPerPage=50`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`hn HTTP ${r.status}`);
  const j = (await r.json()) as { hits?: Array<{ title: string; url: string | null; objectID: string; created_at_i: number; points: number; num_comments: number }> };
  const keywords = /claude|anthropic|copilot|ai coding|coding agent|mcp|cursor|codex|openai|llm/i;
  return (j.hits || [])
    .filter((h) => h.title && keywords.test(h.title + " " + (h.url || "")))
    .map((h) => {
      const ageDays = (Date.now() - h.created_at_i * 1000) / 86400000;
      return {
        source: "hn-24h",
        title: h.title,
        summary: h.title + (h.points ? ` (${h.points} points, ${h.num_comments} comments)` : ""),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        published_at: new Date(h.created_at_i * 1000).toISOString(),
        recency_hint: Math.max(0, 1 - ageDays),
      } as Candidate;
    });
}

// ── Pipeline ─────────────────────────────────────────────────────

export async function runDailyPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const { runId, newsDate, sourceType = "routine_cloud", supabase } = opts;
  const startMs = Date.now();
  let seq = 0;

  async function log(phase: string, fields: { intent?: string; tool?: string; input?: unknown; output?: unknown; decision?: string; duration_ms?: number; level?: LogLevel } = {}) {
    seq += 1;
    const entry = {
      run_id: runId,
      sequence_num: seq,
      phase,
      level: fields.level || "info",
      intent: fields.intent || null,
      tool: fields.tool || null,
      input: fields.input ?? null,
      output: fields.output ?? null,
      decision: fields.decision || null,
      duration_ms: fields.duration_ms ?? null,
      logged_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("routine_log_entries").insert(entry);
    if (error) console.error(`log insert failed: ${error.message}`);
  }

  async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; duration_ms: number }> {
    const t0 = Date.now();
    const result = await fn();
    return { result, duration_ms: Date.now() - t0 };
  }

  // 1. INIT
  {
    const { error } = await supabase.from("routine_runs").insert({
      run_id: runId,
      source_type: sourceType,
      news_date: newsDate,
      status: "running",
      started_at: new Date().toISOString(),
    });
    if (error) throw new Error(`routine_runs insert: ${error.message}`);
  }
  await log("init", {
    intent: "Routine triggered Vercel pipeline (egress-allowlist pivot)",
    decision: `run_id=${runId}, news_date=${newsDate}, source_type=${sourceType}`,
  });

  // 2. FETCH 4 sources in parallel
  const sourceDefs = [
    { name: "changelog", fn: fetchChangelog },
    { name: "anthropic-news", fn: fetchAnthropicNews },
    { name: "techcrunch-ai", fn: fetchTechcrunchAi },
    { name: "hn-24h", fn: fetchHn24h },
  ];
  const fetched = await Promise.all(
    sourceDefs.map(async (s) => {
      try {
        const { result, duration_ms } = await timed(s.fn);
        return { name: s.name, candidates: result, duration_ms, error: null as string | null };
      } catch (err) {
        return { name: s.name, candidates: [], duration_ms: 0, error: (err as Error).message };
      }
    }),
  );
  for (const f of fetched) {
    if (f.error) {
      await log("fetch", { intent: `${f.name} failed`, level: "error", decision: f.error.slice(0, 200) });
    } else {
      await log("fetch", {
        intent: `fetch ${f.name}`,
        tool: "fetch",
        output: { candidates: f.candidates.length },
        duration_ms: f.duration_ms,
      });
    }
  }

  // 3. SCORE — per source, parallel within source, sources sequential to limit concurrency
  const picks: Candidate[] = [];
  for (const f of fetched) {
    if (!f.candidates.length) {
      if (!f.error) await log("score", { intent: `rank ${f.name}`, decision: "no candidates", level: "warn" });
      continue;
    }
    const top = f.candidates.slice(0, 4);
    const scoreStart = Date.now();
    const scored = await Promise.all(
      top.map(async (c) => {
        try {
          const text = await azureOpenAIChat(
            [
              {
                role: "user",
                content: `You score AI-coding news for a technical audience. Return JSON {"score": 0.0-1.0}. Most valuable = a dev gets one actionable insight. Deduct for hype / benchmark theater / funding-only.\n\nTitle: ${c.title}\nSummary: ${String(c.summary).slice(0, 400)}\nURL: ${c.url}\nPublished: ${c.published_at || "unknown"}\n\nReturn JSON only.`,
              },
            ],
            80,
          );
          const m = text.match(/"score"\s*:\s*([\d.]+)/);
          const v = m ? Math.min(1, Math.max(0, parseFloat(m[1]))) : 0.5;
          return { ...c, score_valuable: v, score_final: 0.4 * c.recency_hint + 0.6 * v };
        } catch {
          return { ...c, score_valuable: 0.5, score_final: 0.4 * c.recency_hint + 0.6 * 0.5 };
        }
      }),
    );
    scored.sort((a, b) => (b.score_final ?? 0) - (a.score_final ?? 0));
    const pick = scored[0];
    picks.push(pick);
    await log("score", {
      intent: `rank ${f.name}`,
      tool: "azure-openai-gpt4o",
      input: { candidates: top.length },
      output: { top3: scored.slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), score: (s.score_final ?? 0).toFixed(3) })) },
      decision: `pick: ${pick.title.slice(0, 100)} (score=${(pick.score_final ?? 0).toFixed(3)})`,
      duration_ms: Date.now() - scoreStart,
    });
  }

  // 4. DEDUP
  const canonical = new Map<string, Candidate>();
  for (const p of picks) {
    const key = (p.url || p.title).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
    if (!canonical.has(key)) canonical.set(key, p);
  }
  const deduped = [...canonical.values()];

  await log("aggregate", {
    intent: "aggregate + dedup picks across sources",
    output: { sources_delivered: picks.length, after_dedup: deduped.length },
    decision:
      deduped.length < 3
        ? "FAILED — dedup floor breach (<3)"
        : deduped.length === 3
          ? "DEGRADED — dedup floor reached 3"
          : "OK — 4 unique picks",
    level: deduped.length < 3 ? "error" : deduped.length === 3 ? "warn" : "info",
  });

  if (deduped.length < 3) {
    await supabase
      .from("routine_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        items_produced: 0,
        failure_reason: "dedup_floor_breach",
      })
      .eq("run_id", runId);
    await log("finalize", { intent: "Run finished · status=failed", decision: "items_produced=0, reason=dedup_floor_breach" });
    return { run_id: runId, news_date: newsDate, status: "failed", items_produced: 0, log_count: seq, elapsed_ms: Date.now() - startMs, failure_reason: "dedup_floor_breach" };
  }

  // 5. TRANSLATE
  const finalPicks = deduped.slice(0, 4);
  {
    const { result: translated, duration_ms } = await timed(async () => {
      const titles = finalPicks.map((p) => p.title);
      const summaries = finalPicks.map((p) => String(p.summary).slice(0, 500));
      const all = await azureTranslate([...titles, ...summaries]);
      const titlesZh = all.slice(0, finalPicks.length);
      const summariesZh = all.slice(finalPicks.length);
      return finalPicks.map((p, i) => ({ ...p, title_zh: titlesZh[i], summary_zh: summariesZh[i] }));
    });
    for (let i = 0; i < finalPicks.length; i++) {
      finalPicks[i].title_zh = translated[i].title_zh;
      finalPicks[i].summary_zh = translated[i].summary_zh;
    }
    await log("translate", {
      intent: `translate ${finalPicks.length} picks to zh-Hant`,
      tool: "azure-translator",
      input: { texts: finalPicks.length * 2, direction: "en→zh-Hant" },
      output: { samples: translated.map((t) => (t.title_zh || "").slice(0, 60)) },
      duration_ms,
    });
  }

  // 6. PERSIST
  const rows = finalPicks.map((p, i) => ({
    run_id: runId,
    news_date: newsDate,
    rank: i + 1,
    source_name: p.source,
    title_en: p.title,
    title_zh: p.title_zh || p.title,
    summary_en: p.summary,
    summary_zh: p.summary_zh || p.summary,
    url: p.url,
    published_at: p.published_at,
    score: p.score_final != null ? p.score_final.toFixed(3) : null,
  }));
  await supabase.from("news_items").delete().eq("news_date", newsDate);
  const { error: insErr } = await supabase.from("news_items").insert(rows);
  if (insErr) throw new Error(`news_items insert: ${insErr.message}`);
  await log("persist", {
    intent: `persist ${rows.length} items to news_items`,
    tool: "supabase-insert",
    output: { rank_titles: rows.map((r) => `${r.rank}: ${r.title_en.slice(0, 60)}`) },
  });

  // 7. FINALIZE
  const status: "succeeded" | "degraded" = finalPicks.length === 4 ? "succeeded" : "degraded";
  await supabase
    .from("routine_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      items_produced: finalPicks.length,
    })
    .eq("run_id", runId);
  await log("finalize", { intent: `Run finished · status=${status}`, decision: `items_produced=${finalPicks.length}` });

  return {
    run_id: runId,
    news_date: newsDate,
    status,
    items_produced: finalPicks.length,
    log_count: seq,
    elapsed_ms: Date.now() - startMs,
  };
}

// ── TPE date helper ──────────────────────────────────────────────

export function tpeDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
}
