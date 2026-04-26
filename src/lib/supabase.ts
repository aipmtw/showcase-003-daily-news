import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Single source of truth for the multi-tenant discriminator added by
// supabase migration 0002. Every read filters on this; every write sets it.
// Sibling repos (004 / future showcases) declare their own value here.
export const PROJECT = "showcase-003-daily-news" as const;

// Public (anon-key) client — safe for SSR and client components.
// Returns null if env not configured (e.g. during first Vercel deploy before
// Mark has pasted secrets). Callers should handle null by showing an empty
// state rather than crashing.
export function supabasePublic(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export type NewsItem = {
  id: string;
  run_id: string;
  news_date: string;
  rank: number;
  source_name: string;
  title_en: string;
  title_zh: string;
  summary_en: string;
  summary_zh: string;
  url: string;
  published_at: string | null;
  score: number | null;
};

export type RoutineRun = {
  id: string;
  run_id: string;
  source_type: string;
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "degraded" | "failed";
  items_produced: number | null;
  news_date: string;
  failure_reason: string | null;
  notes: string | null;
  // 2026-04-26: meta-narrative across the day's picks (drives the
  // "今日整體判讀" panel on the homepage). Same shape as 004 — both
  // showcases share the schema since the Supabase project is shared.
  daily_summary_en: string | null;
  daily_summary_zh: string | null;
};

export type RoutineLogEntry = {
  id: string;
  run_id: string;
  sequence_num: number;
  phase: string;
  intent: string | null;
  tool: string | null;
  input: unknown;
  output: unknown;
  decision: string | null;
  duration_ms: number | null;
  level: "info" | "warn" | "error";
  logged_at: string;
};
