#!/usr/bin/env node
// scripts/smoke-trigger.mjs — B-layer test: curl Vercel /api/routine/run-daily
// from your machine, using ROUTINE_INGEST_SECRET from .env.local.
//
// Run with:  npm run trigger:smoke
//
// Exits 0 on ok=true, 1 otherwise. Prints the JSON response either way.

const SECRET = process.env.ROUTINE_INGEST_SECRET;
const URL = process.env.TRIGGER_URL || "https://showcase-003-daily-news.vercel.app/api/routine/run-daily";

if (!SECRET) {
  console.error("ROUTINE_INGEST_SECRET not set. Run `npm run env:pull` first.");
  process.exit(2);
}

const t0 = Date.now();
console.log(`POST ${URL} ...`);
const r = await fetch(URL, {
  method: "POST",
  headers: { "X-Routine-Secret": SECRET, "Content-Type": "application/json" },
  body: "{}",
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const text = await r.text();
let body;
try { body = JSON.parse(text); } catch { body = text; }

console.log(`HTTP ${r.status} · ${elapsed}s`);
console.log(JSON.stringify(body, null, 2));

const ok = r.ok && body && body.ok === true;
process.exit(ok ? 0 : 1);
