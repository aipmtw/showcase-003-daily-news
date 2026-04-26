#!/usr/bin/env node
// routines/daily-runner.mjs — local-runnable equivalent of the daily-news routine.
//
// Fully on D67 Azure Sponsorship: scoring uses Azure OpenAI gpt-4o,
// translation uses Azure Translator. Zero ANTHROPIC_API_KEY dependency.
//
// Usage:
//   export SUPABASE_URL="https://<ref>.supabase.co"
//   export SUPABASE_SERVICE_ROLE_KEY="<service-role>"
//   export AZURE_OPENAI_ENDPOINT="https://eastus.api.cognitive.microsoft.com/"
//   export AZURE_OPENAI_KEY="<key>"
//   export AZURE_OPENAI_DEPLOYMENT="gpt4o"
//   export AZURE_TRANSLATOR_KEY="<key>"
//   export AZURE_TRANSLATOR_REGION="southeastasia"
//   node routines/daily-runner.mjs --run-id "2026-04-24-manual"
//
// Exit codes: 0 succeeded/degraded · 1 failed · 2 env/config error

import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";

// ── CLI args ──────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    "run-id": { type: "string" },
    "news-date": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "source-type": { type: "string", default: "manual_local" },
  },
});

const NEWS_DATE = args["news-date"] || new Date().toISOString().slice(0, 10);
const RUN_ID = args["run-id"] || `${NEWS_DATE}-manual`;
const SOURCE_TYPE = args["source-type"];
const DRY_RUN = args["dry-run"];

// ── Env ───────────────────────────────────────────────────────────
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_DEPLOYMENT = "gpt4o",
  AZURE_OPENAI_API_VERSION = "2024-08-01-preview",
  AZURE_TRANSLATOR_KEY,
  AZURE_TRANSLATOR_REGION = "southeastasia",
  AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com",
} = process.env;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (or pass --dry-run)");
  process.exit(2);
}
if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_KEY) {
  console.error("AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY required");
  process.exit(2);
}
if (!AZURE_TRANSLATOR_KEY) {
  console.error("AZURE_TRANSLATOR_KEY required");
  process.exit(2);
}

const supabase = DRY_RUN
  ? null
  : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── Azure OpenAI helper ──────────────────────────────────────────
async function openaiChat({ messages, max_tokens = 300, temperature = 0.2 }) {
  const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "api-key": AZURE_OPENAI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens, temperature }),
  });
  if (!r.ok) throw new Error(`AzureOpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

// ── Azure Translator helper ──────────────────────────────────────
async function azureTranslate(texts, { from = "en", to = "zh-Hant" } = {}) {
  const url = `${AZURE_TRANSLATOR_ENDPOINT.replace(/\/$/, "")}/translate?api-version=3.0&from=${from}&to=${to}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_TRANSLATOR_KEY,
      "Ocp-Apim-Subscription-Region": AZURE_TRANSLATOR_REGION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(texts.map((t) => ({ text: t }))),
  });
  if (!r.ok) throw new Error(`AzureTranslator ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.map((entry) => entry.translations[0].text);
}

// ── Log helper ─────────────────────────────────────────────────────
let seq = 0;
async function log(phase, fields = {}) {
  seq += 1;
  const entry = {
    run_id: RUN_ID,
    sequence_num: seq,
    phase,
    level: fields.level || "info",
    intent: fields.intent || null,
    tool: fields.tool || null,
    input: fields.input || null,
    output: fields.output || null,
    decision: fields.decision || null,
    duration_ms: fields.duration_ms ?? null,
    logged_at: new Date().toISOString(),
  };
  console.log(`[${String(seq).padStart(3, "0")}] ${phase}${entry.intent ? ` · ${entry.intent}` : ""}`);
  if (!DRY_RUN) {
    const { error } = await supabase.from("routine_log_entries").insert(entry);
    if (error) console.error(`log insert failed: ${error.message}`);
  }
}

async function timed(fn) {
  const start = Date.now();
  const result = await fn();
  return { result, duration_ms: Date.now() - start };
}

// ── Step 1 — INIT ─────────────────────────────────────────────────
async function initRun() {
  if (DRY_RUN) {
    console.log(`[dry-run] skipping routine_runs INSERT (run_id=${RUN_ID}, news_date=${NEWS_DATE})`);
    return;
  }
  const { error } = await supabase.from("routine_runs").insert({
    run_id: RUN_ID,
    source_type: SOURCE_TYPE,
    news_date: NEWS_DATE,
    status: "running",
    started_at: new Date().toISOString(),
  });
  if (error) {
    console.error(`routine_runs insert failed: ${error.message}`);
    process.exit(2);
  }
  await log("init", {
    intent: "Routine started — fully on D67 Azure Sponsorship (OpenAI + Translator)",
    decision: `run_id=${RUN_ID}, news_date=${NEWS_DATE}, models=gpt-4o (score) + Translator (zh-Hant)`,
  });
}

// ── Step 2 — FETCH 3 internet sources ─────────────────────────────
// (Anthropic CHANGELOG dropped 2026-04-26 — same release-bullet kept
//  winning daily and repeating. We focus on news that moves day-to-day.)

async function fetchAnthropicNews() {
  const url = "https://www.anthropic.com/news";
  const { result: html, duration_ms } = await timed(async () => {
    const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  });
  await log("fetch", {
    intent: "fetch anthropic.com/news",
    tool: "fetch",
    input: { url },
    output: { bytes: html.length },
    duration_ms,
  });
  const items = [];
  const re = /<a[^>]+href="(\/news\/[^"]+)"[^>]*>([^<]{10,200})<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    items.push({
      source: "anthropic-news",
      title: m[2].trim().replace(/\s+/g, " "),
      summary: m[2].trim(),
      url: `https://www.anthropic.com${m[1]}`,
      published_at: null,
      recency_hint: 0.9,
    });
    if (items.length >= 10) break;
  }
  return items;
}

async function fetchTechcrunchAi() {
  const url = "https://techcrunch.com/category/artificial-intelligence/feed/";
  const { result: xml, duration_ms } = await timed(async () => {
    const r = await fetch(url, { headers: { "User-Agent": "daily-news-routine/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  });
  await log("fetch", {
    intent: "fetch TechCrunch AI RSS",
    tool: "fetch",
    input: { url },
    output: { bytes: xml.length },
    duration_ms,
  });
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
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
    items.push({
      source: "techcrunch-ai",
      title,
      summary: desc || title,
      url: link,
      published_at: pubDate ? new Date(pubDate).toISOString() : null,
      recency_hint: Math.max(0, 1 - ageDays / 30),
    });
    if (items.length >= 15) break;
  }
  return items;
}

async function fetchHn24h() {
  const since = Math.floor((Date.now() - 86400000) / 1000);
  const url = `https://hn.algolia.com/api/v1/search?tags=story&numericFilters=created_at_i>${since}&hitsPerPage=50`;
  const { result: json, duration_ms } = await timed(async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  });
  await log("fetch", {
    intent: "fetch Hacker News 24h stories",
    tool: "fetch",
    input: { url },
    output: { hits: json.hits?.length || 0 },
    duration_ms,
  });
  const keywords = /claude|anthropic|copilot|ai coding|coding agent|mcp|cursor|codex|openai|llm/i;
  return (json.hits || [])
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
      };
    });
}

// ── Step 2.5 — score candidates per source via Azure OpenAI, pick top 1 ──
async function scoreAndPick(candidates, sourceName) {
  if (!candidates.length) {
    await log("score", {
      intent: `rank ${sourceName}`,
      decision: "no candidates — skipping",
      level: "warn",
    });
    return null;
  }
  const top = candidates.slice(0, 6);
  const scored = [];
  for (const c of top) {
    const { result: score, duration_ms } = await timed(async () => {
      const content = `You score AI-coding news for a technical audience. Return JSON {"score": 0.0-1.0}. The item is "most valuable" if a dev can take one actionable insight away. Deduct for vague hype / benchmark theater / funding-without-product implication.

Title: ${c.title}
Summary: ${String(c.summary).slice(0, 400)}
URL: ${c.url}
Published: ${c.published_at || "unknown"}

Return JSON only.`;
      const text = await openaiChat({ messages: [{ role: "user", content }], max_tokens: 80 });
      const m = text.match(/"score"\s*:\s*([\d.]+)/);
      return m ? Math.min(1, Math.max(0, parseFloat(m[1]))) : 0.5;
    });
    const final = 0.4 * c.recency_hint + 0.6 * score;
    scored.push({ ...c, score_valuable: score, score_final: final });
  }
  scored.sort((a, b) => b.score_final - a.score_final);
  const pick = scored[0];
  await log("score", {
    intent: `rank ${sourceName}`,
    tool: "azure-openai-gpt4o",
    input: { candidates: top.length },
    output: { top3: scored.slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), score: s.score_final.toFixed(3) })) },
    decision: `pick: ${pick.title.slice(0, 100)} (score=${pick.score_final.toFixed(3)})`,
  });
  return pick;
}

// ── Step 3 — dedup ────────────────────────────────────────────────
function dedup(picks) {
  const canonical = new Map();
  for (const p of picks) {
    const key = (p.url || p.title).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
    if (!canonical.has(key)) canonical.set(key, p);
  }
  return [...canonical.values()];
}

// ── Step 4 — translate via Azure Translator ──────────────────────
async function translateAll(picks) {
  const { result: translated, duration_ms } = await timed(async () => {
    const titles = picks.map((p) => p.title);
    const summaries = picks.map((p) => String(p.summary).slice(0, 500));
    const allTexts = [...titles, ...summaries];
    const results = await azureTranslate(allTexts, { from: "en", to: "zh-Hant" });
    const titlesZh = results.slice(0, picks.length);
    const summariesZh = results.slice(picks.length);
    return picks.map((p, i) => ({
      ...p,
      title_zh: titlesZh[i],
      summary_zh: summariesZh[i],
    }));
  });
  await log("translate", {
    intent: `translate ${picks.length} picks to zh-Hant`,
    tool: "azure-translator",
    input: { texts: picks.length * 2, direction: "en→zh-Hant" },
    output: { samples: translated.map((t) => t.title_zh.slice(0, 60)) },
    duration_ms,
  });
  return translated;
}

// ── Step 5 — persist to news_items ───────────────────────────────
async function persist(picks) {
  if (DRY_RUN) {
    console.log(`[dry-run] would INSERT ${picks.length} news_items:`);
    for (const p of picks) console.log(`  rank=${p.rank} [${p.source}] ${p.title.slice(0, 80)}`);
    return;
  }
  const rows = picks.map((p, i) => ({
    run_id: RUN_ID,
    news_date: NEWS_DATE,
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
  await supabase.from("news_items").delete().eq("news_date", NEWS_DATE);
  const { error } = await supabase.from("news_items").insert(rows);
  if (error) throw new Error(`news_items insert: ${error.message}`);
  await log("persist", {
    intent: `persist ${rows.length} items to news_items`,
    tool: "supabase-insert",
    output: { rank_titles: rows.map((r) => `${r.rank}: ${r.title_en.slice(0, 60)}`) },
  });
}

// ── Step 6 — finalize routine_runs row ───────────────────────────
async function finalize(status, itemsProduced, failureReason) {
  if (DRY_RUN) {
    console.log(`[dry-run] would UPDATE routine_runs status=${status}, items=${itemsProduced}`);
    return;
  }
  await supabase
    .from("routine_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      items_produced: itemsProduced,
      failure_reason: failureReason || null,
    })
    .eq("run_id", RUN_ID);
  await log("finalize", {
    intent: `Run finished · status=${status}`,
    decision: `items_produced=${itemsProduced}${failureReason ? `, reason=${failureReason}` : ""}`,
  });
}

// ── Main orchestration ──────────────────────────────────────────
const overallStart = Date.now();

try {
  await initRun();

  const sources = [
    { name: "anthropic-news", fn: fetchAnthropicNews },
    { name: "techcrunch-ai", fn: fetchTechcrunchAi },
    { name: "hn-24h", fn: fetchHn24h },
  ];

  const picks = [];
  for (const s of sources) {
    try {
      const candidates = await s.fn();
      if (!candidates.length) {
        await log("fetch", { intent: `${s.name} returned 0 candidates`, level: "warn" });
        continue;
      }
      const pick = await scoreAndPick(candidates, s.name);
      if (pick) picks.push(pick);
    } catch (err) {
      await log("fetch", {
        intent: `${s.name} failed`,
        level: "error",
        decision: err.message.slice(0, 200),
      });
    }
  }

  const deduped = dedup(picks);
  await log("aggregate", {
    intent: "aggregate + dedup picks across sources",
    output: { sources_delivered: picks.length, after_dedup: deduped.length },
    decision: deduped.length < 2
      ? "FAILED — dedup floor breach (<2)"
      : deduped.length < 3
        ? "DEGRADED — fewer than 3 unique picks"
        : "OK — 3 unique picks",
    level: deduped.length < 2 ? "error" : deduped.length < 3 ? "warn" : "info",
  });

  if (deduped.length < 2) {
    await finalize("failed", 0, "dedup_floor_breach");
    process.exit(1);
  }

  const translated = await translateAll(deduped.slice(0, 3));
  await persist(translated);

  const status = translated.length === 3 ? "succeeded" : "degraded";
  await finalize(status, translated.length);

  const totalMs = Date.now() - overallStart;
  console.log(`\n✓ done · status=${status} · items=${translated.length} · elapsed=${(totalMs / 1000).toFixed(1)}s`);
  process.exit(0);
} catch (err) {
  console.error("FATAL:", err);
  await log("finalize", {
    intent: "Unhandled exception",
    level: "error",
    decision: err.message?.slice(0, 200) || String(err),
  });
  try {
    await finalize("failed", 0, String(err.message || err).slice(0, 200));
  } catch {}
  process.exit(1);
}
