#!/usr/bin/env node
// routines/daily-runner.mjs — local-runnable equivalent of the daily-news routine.
//
// Same logic the Claude Code Routine runs at 08:00 Asia/Taipei, but callable from
// your own machine for Phase 1 manual seeding, local debugging, backfills.
//
// Contract: every significant step writes a row to routine_log_entries so the
// site's /runs/[id] page becomes a readable transcript of Claude's work.
//
// Usage:
//   export SUPABASE_URL="https://<ref>.supabase.co"
//   export SUPABASE_SERVICE_ROLE_KEY="<service-role>"
//   export ANTHROPIC_API_KEY="<key>"
//   node routines/daily-runner.mjs --run-id "2026-04-24-manual"
//
//   node routines/daily-runner.mjs --run-id "2026-04-24-manual" --news-date 2026-04-24
//   node routines/daily-runner.mjs --dry-run      # fetches + scores but no writes
//
// Exit codes:
//   0  succeeded (4 items written) or degraded (3 items written)
//   1  failed (< 3 picks after dedup / all sources unreachable)
//   2  environment / configuration error

import { parseArgs } from "node:util";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

// ── CLI args ──────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    "run-id": { type: "string" },
    "news-date": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "source-type": { type: "string", default: "manual_local" }, // or routine_cloud
  },
});

const NEWS_DATE = args["news-date"] || new Date().toISOString().slice(0, 10);
const RUN_ID = args["run-id"] || `${NEWS_DATE}-manual`;
const SOURCE_TYPE = args["source-type"];
const DRY_RUN = args["dry-run"];

// ── Env ───────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!DRY_RUN && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (or pass --dry-run)");
  process.exit(2);
}
if (!ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY required");
  process.exit(2);
}

const supabase = DRY_RUN
  ? null
  : createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
  await log("init", { intent: "Routine started", decision: `run_id=${RUN_ID}, news_date=${NEWS_DATE}` });
}

// ── Step 2 — FETCH 4 sources ──────────────────────────────────────

async function fetchChangelog() {
  const url = "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md";
  const { result: text, duration_ms } = await timed(async () => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  });
  await log("fetch", {
    intent: "fetch Claude Code CHANGELOG",
    tool: "fetch",
    input: { url },
    output: { bytes: text.length },
    duration_ms,
  });
  // Parse: each "## 2.1.X" is a release; take the latest 3 releases' top-level bullets.
  const releases = text.split(/^## /m).slice(1, 4); // skip pre-preamble; take first 3
  const candidates = [];
  for (const rel of releases) {
    const versionLine = rel.split("\n")[0].trim();
    const bullets = rel
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(0, 3)
      .map((l) => l.replace(/^- /, "").trim());
    for (const b of bullets) {
      candidates.push({
        source: "changelog",
        title: b.length > 140 ? b.slice(0, 137) + "…" : b,
        summary: b,
        url: `https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#${versionLine.toLowerCase().replace(/\./g, "")}`,
        published_at: null, // CHANGELOG doesn't carry dates
        recency_hint: 1.0, // Latest releases treated as max recency
      });
    }
  }
  return candidates;
}

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
  // Basic HTML scraping: grab <a href="/news/..."> anchors with nearby text
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
  const items = (json.hits || [])
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
  return items;
}

// ── Step 2.5 — score candidates per source via Opus, pick top 1 ──

async function scoreAndPick(candidates, sourceName) {
  if (!candidates.length) {
    await log("score", {
      intent: `rank ${sourceName}`,
      decision: "no candidates — skipping",
      level: "warn",
    });
    return null;
  }
  // Score first N via Opus (cap at 6 to save API calls)
  const top = candidates.slice(0, 6);
  const scored = [];
  for (const c of top) {
    const { result: score, duration_ms } = await timed(async () => {
      const response = await anthropic.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: `You score AI-coding news. Return JSON {score: 0-1}. The item is "most valuable" if engineers can take one actionable insight away. Deduct for vague hype / benchmark theater / funding without product implication.

Title: ${c.title}
Summary: ${c.summary.slice(0, 400)}
URL: ${c.url}
Published: ${c.published_at || "unknown"}

Return JSON only.`,
          },
        ],
      });
      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const m = text.match(/"score"\s*:\s*([\d.]+)/);
      return m ? parseFloat(m[1]) : 0.5;
    });
    const final = 0.4 * c.recency_hint + 0.6 * score;
    scored.push({ ...c, score_valuable: score, score_final: final });
  }
  scored.sort((a, b) => b.score_final - a.score_final);
  const pick = scored[0];
  await log("score", {
    intent: `rank ${sourceName}`,
    tool: "opus-score",
    input: { candidates: top.length },
    output: { top3: scored.slice(0, 3).map((s) => ({ title: s.title.slice(0, 80), score: s.score_final.toFixed(3) })) },
    decision: `pick: ${pick.title.slice(0, 100)} (score=${pick.score_final.toFixed(3)})`,
  });
  return pick;
}

// ── Step 3 — aggregate + dedup ───────────────────────────────────
function dedup(picks) {
  const canonical = new Map();
  for (const p of picks) {
    const key = (p.url || p.title).toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
    if (!canonical.has(key)) canonical.set(key, p);
  }
  return [...canonical.values()];
}

// ── Step 4 — translate EN → zh-Hant via Opus ─────────────────────
async function translate(pick) {
  const { result: translated, duration_ms } = await timed(async () => {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: `Translate to Traditional Chinese (繁體中文 · Taiwan 用法). Return JSON {title_zh, summary_zh}. Keep technical terms accurate (e.g. MCP, hook, routine, API). Title ≤ 60 chars, summary ≤ 200 chars.

Title: ${pick.title}
Summary: ${pick.summary.slice(0, 500)}

Return JSON only.`,
        },
      ],
    });
    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { title_zh: pick.title, summary_zh: pick.summary };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { title_zh: pick.title, summary_zh: pick.summary };
    }
  });
  await log("translate", {
    intent: `translate "${pick.title.slice(0, 60)}"`,
    tool: "opus-translate",
    duration_ms,
    output: { title_zh: translated.title_zh?.slice(0, 60) },
  });
  return { ...pick, title_zh: translated.title_zh, summary_zh: translated.summary_zh };
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
    score: p.score_final?.toFixed(3),
  }));
  // Delete any existing items for this date first (re-run same day overwrites)
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

  // Run 4 fetches sequentially (easier to read in log view; cheap enough).
  const sources = [
    { name: "changelog", fn: fetchChangelog },
    { name: "anthropic-news", fn: fetchAnthropicNews },
    { name: "techcrunch-ai", fn: fetchTechcrunchAi },
    { name: "hn-24h", fn: fetchHn24h },
  ];

  const picks = [];
  for (const s of sources) {
    try {
      const candidates = await s.fn();
      if (!candidates.length) {
        await log("fetch", {
          intent: `${s.name} returned 0 candidates`,
          level: "warn",
        });
        continue;
      }
      const pick = await scoreAndPick(candidates, s.name);
      if (pick) picks.push(pick);
    } catch (err) {
      await log("fetch", {
        intent: `${s.name} failed`,
        level: "error",
        decision: err.message,
      });
    }
  }

  const deduped = dedup(picks);
  await log("aggregate", {
    intent: "aggregate + dedup picks across sources",
    output: { sources_delivered: picks.length, after_dedup: deduped.length },
    decision: deduped.length < 3
      ? "FAILED — dedup floor breach (<3)"
      : deduped.length === 3
        ? "DEGRADED — dedup floor reached 3"
        : "OK — 4 unique picks",
    level: deduped.length < 3 ? "error" : deduped.length === 3 ? "warn" : "info",
  });

  if (deduped.length < 3) {
    await finalize("failed", 0, "dedup_floor_breach");
    process.exit(1);
  }

  // Translate each
  const translated = [];
  for (const p of deduped.slice(0, 4)) {
    translated.push(await translate(p));
  }

  await persist(translated);
  const status = translated.length === 4 ? "succeeded" : "degraded";
  await finalize(status, translated.length);

  const totalMs = Date.now() - overallStart;
  console.log(`\n✓ done · status=${status} · items=${translated.length} · elapsed=${(totalMs / 1000).toFixed(1)}s`);
  process.exit(0);
} catch (err) {
  console.error("FATAL:", err);
  await log("finalize", {
    intent: "Unhandled exception",
    level: "error",
    decision: err.message,
  });
  try {
    await finalize("failed", 0, err.message.slice(0, 200));
  } catch {}
  process.exit(1);
}
