// src/lib/daily-pipeline.ts — server-side daily news pipeline.
//
// Pipeline: fetch 6 sources → score (gpt-4o) → global rank → top 6-8
// → bidirectional translate (zh-Hant ⇄ en) → daily synthesis paragraph
// → persist to Supabase + write log_entries.
//
// 2026-04-26 expansion (mirroring 004): added 3 sources (The Verge AI,
// INSIDE 硬塞, Lobsters AI tag), bumped target from 3 → 6 (max 8),
// bidirectional translate so 繁中 RSS sources don't lose their original
// zh, and a daily synthesis banner on top of the homepage.
//
// zh-Hant policy: gpt-4o produces English only; Translator does the
// en → zh-Hant pass (gpt-4o leaks Simplified — see backlog/2026-04-26-
// zh-hant-strict.md).
//
// Logs every phase to routine_log_entries so /runs/[id] still tells the
// full story even though the routine session itself only fired a curl.

import { type SupabaseClient } from "@supabase/supabase-js";
import { PROJECT } from "./supabase";

// ── Types ────────────────────────────────────────────────────────

type Candidate = {
  source: string;
  title: string;
  summary: string;
  url: string;
  published_at: string | null;
  recency_hint: number;
  // 繁中 RSS sources (INSIDE / iThome / etc.) carry zh natively; we then
  // translate zh → en for the English fields. en-native sources (HN, Verge,
  // TechCrunch, Anthropic, Lobsters) translate en → zh-Hant.
  native_zh?: { title?: string; summary?: string };
  score_valuable?: number;
  score_final?: number;
  title_en?: string;
  summary_en?: string;
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

async function azureTranslate(texts: string[], to: "zh-Hant" | "en" = "zh-Hant"): Promise<string[]> {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION || "southeastasia";
  const ep = process.env.AZURE_TRANSLATOR_ENDPOINT || "https://api.cognitive.microsofttranslator.com";
  if (!key) throw new Error("AZURE_TRANSLATOR_KEY required");
  const url = `${ep.replace(/\/$/, "")}/translate?api-version=3.0&to=${to}`;
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

const AI_CODING_KEYWORDS =
  /claude|anthropic|copilot|cursor|codex|gpt|llm|coding agent|ai coding|mcp|model context protocol|agentic|开发|開發|程式碼|程序员|工程師|軟體開發|軟件開發|代码|大模型|生成式|prompt|aider|tabnine|sourcegraph|llama|gemini|deepseek|mistral|grok/i;

// Decode HTML entities (named + numeric) so feeds like Lobsters that ship
// entity-encoded markup inside <description> don't leak `&lt;p&gt;` literals
// into summaries. Order: numeric first, then named, &amp; LAST to avoid
// double-decoding (`&amp;lt;` → `&lt;` → `<`). See:
// backlog/2026-04-29-encoding-regressions-on-003-live.md
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Generic RSS parser — same shape as 004's. Pulls <item><title><link><description><pubDate>.
function parseRssItems(xml: string, source: string, opts?: { native_zh?: boolean; max?: number }): Candidate[] {
  const max = opts?.max ?? 25;
  const out: Candidate[] = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && out.length < max) {
    const block = m[1];
    const grab = (tag: string) => {
      const r = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
      if (!r) return "";
      // decode entities first, then strip any tags revealed by decoding.
      return decodeHtmlEntities(r[1]).replace(/<[^>]+>/g, "").trim();
    };
    const title = grab("title");
    const link = grab("link");
    const desc = grab("description").slice(0, 400);
    const pub = grab("pubDate") || grab("dc:date");
    if (!title || !link) continue;
    const pubDate = pub ? new Date(pub).getTime() : NaN;
    const ageDays = Number.isFinite(pubDate) ? (Date.now() - pubDate) / 86400_000 : 5;
    out.push({
      source,
      title,
      summary: desc || title,
      url: link,
      published_at: Number.isFinite(pubDate) ? new Date(pubDate).toISOString() : null,
      recency_hint: Math.max(0, 1 - ageDays / 5),
      native_zh: opts?.native_zh ? { title, summary: desc || title } : undefined,
    });
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
    const title = decodeHtmlEntities((block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || "")).trim();
    const link = decodeHtmlEntities((block.match(/<link>(.*?)<\/link>/)?.[1] || "")).trim();
    const desc = decodeHtmlEntities((block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || ""))
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
  return (j.hits || [])
    .filter((h) => h.title && AI_CODING_KEYWORDS.test(h.title + " " + (h.url || "")))
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

async function fetchVergeAi(): Promise<Candidate[]> {
  const url = "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml";
  const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
  if (!r.ok) throw new Error(`verge HTTP ${r.status}`);
  const xml = await r.text();
  return parseRssItems(xml, "verge-ai", { max: 20 });
}

async function fetchInsideTw(): Promise<Candidate[]> {
  // INSIDE 硬塞的網路趨勢觀察 — Taiwan tech blog, AI-heavy
  const url = "https://www.inside.com.tw/feed";
  const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
  if (!r.ok) throw new Error(`inside HTTP ${r.status}`);
  const xml = await r.text();
  const items = parseRssItems(xml, "inside-tw", { native_zh: true, max: 30 });
  return items.filter((c) => AI_CODING_KEYWORDS.test(c.title + " " + c.summary));
}

async function fetchLobstersAi(): Promise<Candidate[]> {
  // Lobsters AI tag — curated alternative to HN
  const url = "https://lobste.rs/t/ai.rss";
  const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
  if (!r.ok) throw new Error(`lobsters HTTP ${r.status}`);
  const xml = await r.text();
  return parseRssItems(xml, "lobsters-ai", { max: 20 });
}

// ── Pipeline ─────────────────────────────────────────────────────

export async function runDailyPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const { runId, newsDate, sourceType = "routine_cloud", supabase } = opts;
  const startMs = Date.now();
  let seq = 0;

  async function log(phase: string, fields: { intent?: string; tool?: string; input?: unknown; output?: unknown; decision?: string; duration_ms?: number; level?: LogLevel } = {}) {
    seq += 1;
    const entry = {
      project: PROJECT,
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

  // 1. INIT — replace-on-rerun (cascades log_entries via FK).
  // Same idempotency story as news_items.delete().eq("news_date", ...) below:
  // re-running for the same run_id replaces the prior attempt cleanly.
  {
    const { error: delErr } = await supabase
      .from("routine_runs")
      .delete()
      .eq("project", PROJECT)
      .eq("run_id", runId);
    if (delErr) throw new Error(`routine_runs prior-delete: ${delErr.message}`);
    const { error } = await supabase.from("routine_runs").insert({
      project: PROJECT,
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

  // 2. FETCH 6 sources in parallel
  const sourceDefs = [
    { name: "anthropic-news", fn: fetchAnthropicNews },
    { name: "techcrunch-ai",  fn: fetchTechcrunchAi },
    { name: "hn-24h",         fn: fetchHn24h },
    { name: "verge-ai",       fn: fetchVergeAi },
    { name: "inside-tw",      fn: fetchInsideTw },
    { name: "lobsters-ai",    fn: fetchLobstersAi },
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

  // 3. SCORE — score TOP K candidates per source, then rank globally and take
  // top TARGET_PICKS unique. With 6 sources each contributing K candidates,
  // we have plenty of headroom even if 1-2 sources return 0.
  const TARGET_PICKS = 6;   // aim
  const MAX_PICKS = 8;      // cap
  const MIN_PICKS = 3;      // below = failed
  const PER_SOURCE_K = 4;
  const allScored: Candidate[] = [];
  for (const f of fetched) {
    if (!f.candidates.length) {
      if (!f.error) await log("score", { intent: `rank ${f.name}`, decision: "no candidates", level: "warn" });
      continue;
    }
    const top = f.candidates.slice(0, PER_SOURCE_K);
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
    allScored.push(...scored);
    await log("score", {
      intent: `rank ${f.name}`,
      tool: "azure-openai-gpt4o",
      input: { candidates: top.length },
      output: { top3: scored.slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), score: (s.score_final ?? 0).toFixed(3) })) },
      decision: `top of ${f.name}: ${scored[0].title.slice(0, 100)} (score=${(scored[0].score_final ?? 0).toFixed(3)})`,
      duration_ms: Date.now() - scoreStart,
    });
  }

  // 4. AGGREGATE — global ranking, dedup by URL, take MAX, slice to TARGET.
  allScored.sort((a, b) => (b.score_final ?? 0) - (a.score_final ?? 0));
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of allScored) {
    const key = (c.url || c.title).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
    if (deduped.length === MAX_PICKS) break;
  }

  await log("aggregate", {
    intent: `global rank + dedup top ${MAX_PICKS} across all sources`,
    output: {
      total_scored: allScored.length,
      after_dedup: deduped.length,
      sources_in_picks: [...new Set(deduped.map((d) => d.source))],
    },
    decision:
      deduped.length >= TARGET_PICKS
        ? `OK — ${deduped.length} unique picks (target=${TARGET_PICKS}, max=${MAX_PICKS})`
        : deduped.length >= MIN_PICKS
          ? `DEGRADED — ${deduped.length} unique picks (below target ${TARGET_PICKS})`
          : `FAILED — only ${deduped.length} unique picks (below floor ${MIN_PICKS})`,
    level: deduped.length < MIN_PICKS ? "error" : deduped.length < TARGET_PICKS ? "warn" : "info",
  });

  if (deduped.length < MIN_PICKS) {
    await supabase
      .from("routine_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        items_produced: 0,
        failure_reason: "all_sources_empty_or_drift",
      })
      .eq("project", PROJECT)
      .eq("run_id", runId);
    await log("finalize", { intent: "Run finished · status=failed", decision: "items_produced=0, reason=all_sources_empty_or_drift" });
    return { run_id: runId, news_date: newsDate, status: "failed", items_produced: 0, log_count: seq, elapsed_ms: Date.now() - startMs, failure_reason: "all_sources_empty_or_drift" };
  }

  // Cap at TARGET_PICKS for the day (MAX is just dedup headroom).
  const finalPicks = deduped.slice(0, Math.min(TARGET_PICKS, deduped.length));

  // 5. TRANSLATE — bidirectional. zh-native sources (INSIDE 硬塞) translate
  // zh → en for the English fields. en-native (HN, Anthropic, TechCrunch,
  // Verge, Lobsters) translate en → zh-Hant.
  const translateStart = Date.now();
  const enToZh: Array<{ p: Candidate; field: "title" | "summary" }> = [];
  const zhToEn: Array<{ p: Candidate; field: "title" | "summary" }> = [];
  for (const p of finalPicks) {
    if (p.native_zh) {
      p.title_zh = p.title;
      p.summary_zh = String(p.summary).slice(0, 500);
      zhToEn.push({ p, field: "title" }, { p, field: "summary" });
    } else {
      p.title_en = p.title;
      p.summary_en = String(p.summary).slice(0, 500);
      enToZh.push({ p, field: "title" }, { p, field: "summary" });
    }
  }
  if (enToZh.length) {
    const texts = enToZh.map(({ p, field }) => (field === "title" ? p.title_en! : p.summary_en!));
    const translated = await azureTranslate(texts, "zh-Hant");
    enToZh.forEach(({ p, field }, i) => {
      if (field === "title") p.title_zh = translated[i];
      else p.summary_zh = translated[i];
    });
  }
  if (zhToEn.length) {
    const texts = zhToEn.map(({ p, field }) => (field === "title" ? p.title_zh! : p.summary_zh!));
    const translated = await azureTranslate(texts, "en");
    zhToEn.forEach(({ p, field }, i) => {
      if (field === "title") p.title_en = translated[i];
      else p.summary_en = translated[i];
    });
  }
  await log("translate", {
    intent: `bidirectional translate ${finalPicks.length} picks (en↔zh-Hant as needed)`,
    tool: "azure-translator",
    input: { en_to_zh: enToZh.length, zh_to_en: zhToEn.length },
    duration_ms: Date.now() - translateStart,
  });

  // 6. DAILY SYNTHESIS — meta-narrative across picks. gpt-4o EN only;
  // Translator does zh-Hant (per backlog/2026-04-26-zh-hant-strict.md).
  let dailySummaryEn: string | null = null;
  let dailySummaryZh: string | null = null;
  const summaryStart = Date.now();
  try {
    const headlines = finalPicks
      .map((p, i) => `${i + 1}. [${p.source}] ${p.title_en}`)
      .join("\n");
    const text = await azureOpenAIChat(
      [
        {
          role: "system",
          content: "You are a senior staff engineer writing a daily AI-coding briefing for product/engineering teams in Taiwan. Synthesize today's stories into ONE paragraph (≤4 sentences). Output ONLY a JSON object {\"en\":\"...\"}. English only, no Chinese.",
        },
        {
          role: "user",
          content: `Today's AI-coding stories:\n\n${headlines}\n\nGive me the meta-narrative: dominant theme, what AI-coding practitioners (Claude Code / Cursor / Copilot users) should pay attention to. ≤4 sentences English. Return JSON {"en":"..."}.`,
        },
      ],
      400,
    );
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}") as { en?: string };
    dailySummaryEn = (j.en || "").trim().slice(0, 1500) || null;
    if (dailySummaryEn) {
      try {
        const [zh] = await azureTranslate([dailySummaryEn], "zh-Hant");
        dailySummaryZh = zh.slice(0, 1500);
      } catch (err) {
        await log("summary", { intent: "summary-zh translator failed", level: "warn", decision: (err as Error).message.slice(0, 200) });
      }
    }
    await log("summary", {
      intent: "daily meta-narrative across picks (gpt-4o EN + translator zh-Hant)",
      tool: "azure-openai-gpt4o",
      output: { en_chars: dailySummaryEn?.length || 0, zh_chars: dailySummaryZh?.length || 0 },
      duration_ms: Date.now() - summaryStart,
    });
  } catch (err) {
    await log("summary", { intent: "daily summary failed", level: "warn", decision: (err as Error).message.slice(0, 200) });
  }

  // 7. PERSIST
  const rows = finalPicks.map((p, i) => ({
    project: PROJECT,
    run_id: runId,
    news_date: newsDate,
    rank: i + 1,
    source_name: p.source,
    title_en: p.title_en || p.title,
    title_zh: p.title_zh || p.title,
    summary_en: p.summary_en || String(p.summary),
    summary_zh: p.summary_zh || String(p.summary),
    url: p.url,
    published_at: p.published_at,
    score: p.score_final != null ? p.score_final.toFixed(3) : null,
  }));
  await supabase
    .from("news_items")
    .delete()
    .eq("project", PROJECT)
    .eq("news_date", newsDate);
  const { error: insErr } = await supabase.from("news_items").insert(rows);
  if (insErr) throw new Error(`news_items insert: ${insErr.message}`);
  await log("persist", {
    intent: `persist ${rows.length} items to news_items`,
    tool: "supabase-insert",
    output: { rank_titles: rows.map((r) => `${r.rank}: ${r.title_en.slice(0, 60)}`) },
  });

  // 8. FINALIZE
  const status: "succeeded" | "degraded" =
    finalPicks.length >= TARGET_PICKS ? "succeeded" : "degraded";
  await supabase
    .from("routine_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      items_produced: finalPicks.length,
      daily_summary_en: dailySummaryEn,
      daily_summary_zh: dailySummaryZh,
    })
    .eq("project", PROJECT)
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
