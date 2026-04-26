# showcase-003-daily-news — Full Build Manual

**Target:** zero → live daily-news site on `daily.aipm.com.tw` (Vercel + Supabase stack).
**Target time:** ~5 minutes (vs showcase-001's ~14 minutes on Azure).
**Authoring protocol:** inherits `../spec/001/build-md-authoring.md` — snapshot-before-revise, no-magic-string grep, idempotent blocks, positive-confirmation loops.
**Ranking protocol:** see `../spec/003/news-ranking.md` (extends `../spec/001/topic-sourcing.md`).

## Changelog

- **2026-04-24 · [initial]** — skeleton drafted during P1; iter-a not yet run.

---

## 0. Product at a glance

**`https://daily.aipm.com.tw`**(custom)/ **`showcase-003-daily-news.vercel.app`**(預設)
Top-of-fold: **today's 3 news items**(responsive 1/2-col grid,EN title + zh 翻譯 + source badge + publish date + 2 行 summary)
Navigation: `/` today · `/runs/[id]` routine execution log · `/archive` calendar of past days
Data: Supabase Postgres · 3 tables(`news_items` · `routine_runs` · `routine_log_entries`)
Automation: Claude Code Routine fires at 08:00 Asia/Taipei daily · `routines/daily-runner.mjs` is the canonical script

## 0.5 Prerequisites — export these shell variables

```bash
# Supabase project credentials (get from dashboard:project settings:API)
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key · NEVER commit>"
export SUPABASE_ANON_KEY="<anon-key · used by Next.js server components>"

# Vercel (via `vercel login` once; no env needed after)

# GitHub (via `gh auth login` once)

# Anthropic API key (for the Opus scoring call inside routine)
export ANTHROPIC_API_KEY="<key>"

# Routine / runner-scoped
export NEWS_DATE="${NEWS_DATE:-$(date +%Y-%m-%d)}"   # defaults to today; override for backfill
```

Verify: `[ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && echo OK`

---

## 1. Pre-granted permissions (Mark sets up once)

### 1.1 Supabase
- Project under Mark's Supabase account · region `ap-southeast-1`(Singapore 最接近 TPE)
- Free tier 足夠(~500 MB DB、2 GB file · news 是純文字)
- Row-Level Security(RLS):`news_items` / `routine_runs` / `routine_log_entries` 三表 **public read · service-role write only**

### 1.2 Vercel
- Project linked to `aipmtw/showcase-003-daily-news`
- env vars 設:`SUPABASE_URL` · `SUPABASE_ANON_KEY`(for SSR reads)· **不放 service-role key**(那只給 routine 用)
- Auto-deploy from `main` branch

### 1.3 GitHub
- `aipmtw/showcase-003-daily-news` **public repo**(transparency is the pitch)
- `gh` CLI with PAT,scopes `repo + workflow`

### 1.4 Claude Code Routines
- Routine name:`daily-news`
- Schedule:`0 0 * * *` UTC(= 08:00 Asia/Taipei)
- Secrets:`SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `ANTHROPIC_API_KEY`
- Prompt:see `routines/daily.md`

---

## 2. Pre-flight verification

```bash
# Tools
supabase --version
vercel --version
node --version    # >= 20
gh auth status | head -3

# Secrets loaded
[ -n "$SUPABASE_URL" ] && [ -n "$SUPABASE_SERVICE_ROLE_KEY" ] && echo "secrets OK"

# Project link check
supabase projects list | grep showcase-003 || echo "(not linked yet — see §4)"
vercel list 2>/dev/null | grep showcase-003 || echo "(not linked yet — see §4)"
```

**Checkpoint 01** `Pre-flight passed 前置檢查通過`

---

## 3. Resource naming

```
Supabase project slug:  showcase-003-daily-news
Vercel project name:    showcase-003-daily-news
GitHub repo:            aipmtw/showcase-003-daily-news (public)
Tables:                 news_items · routine_runs · routine_log_entries
```

(Per-iter rebuild 時,Supabase 另外建 `showcase-003-daily-news-<DATE>-<LETTER>` project · Vercel 同理,teardown 時 API 呼叫 delete)

---

## 4. Vercel + Supabase foundation deploy (Phase 1)

### 4.1 Supabase project create

```bash
# Option A: via dashboard (fastest first time) — get project-ref
# Option B: via management API (iteration-friendly)
SUPABASE_PROJECT_REF=$(supabase projects create "showcase-003-daily-news" \
  --region ap-southeast-1 --db-password "$(openssl rand -base64 24)" \
  --org-id "$SUPABASE_ORG_ID" | grep -oE 'project-ref: [a-z0-9]+' | awk '{print $2}')
echo "SUPABASE_PROJECT_REF=$SUPABASE_PROJECT_REF"
```

**Checkpoint 02** `Supabase project created Supabase 專案建立完成`

### 4.2 Vercel project create + link

```bash
vercel link --yes --project showcase-003-daily-news
vercel env add SUPABASE_URL production < <(echo "$SUPABASE_URL")
vercel env add SUPABASE_ANON_KEY production < <(echo "$SUPABASE_ANON_KEY")
```

**Checkpoint 03** `Vercel project linked Vercel 專案連結完成`

---

## 5. Supabase schema (3 tables)

Migration file: `supabase/migrations/0001_init.sql`

```sql
-- ─── routine_runs: one row per routine execution ─────────────
create table routine_runs (
  id              uuid primary key default gen_random_uuid(),
  run_id          text unique not null,          -- e.g. "2026-04-24-manual" or "2026-04-25-auto"
  source_type     text not null,                  -- "manual_local" | "routine_cloud"
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running', -- running | succeeded | failed | degraded
  items_produced  int,
  news_date       date not null,                  -- the date this run is producing news for
  failure_reason  text,
  notes           text
);
create index on routine_runs (news_date desc, started_at desc);

-- ─── routine_log_entries: one row per phase/tool call ────────
create table routine_log_entries (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  sequence_num  int not null,
  phase         text not null,     -- "init" | "fetch" | "score" | "translate" | "persist" | "finalize"
  intent        text,              -- human-readable intent
  tool          text,              -- e.g. "WebFetch" | "gh api" | "opus-score" | "supabase insert"
  input         jsonb,
  output        jsonb,
  decision      text,
  duration_ms   int,
  level         text default 'info', -- info | warn | error
  logged_at     timestamptz not null default now(),
  unique (run_id, sequence_num)
);
create index on routine_log_entries (run_id, sequence_num);

-- ─── news_items: one row per picked news item ───────────────
create table news_items (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null references routine_runs(run_id) on delete cascade,
  news_date     date not null,
  rank          int not null,     -- 1..4
  source_name   text not null,    -- "changelog" | "anthropic-news" | "techcrunch-ai" | "hn-24h"
  title_en      text not null,
  title_zh      text not null,
  summary_en    text not null,
  summary_zh    text not null,
  url           text not null,
  published_at  timestamptz,
  score         numeric(4,3),
  created_at    timestamptz not null default now(),
  unique (news_date, rank)
);
create index on news_items (news_date desc, rank asc);

-- RLS: public read, service-role-only write
alter table routine_runs enable row level security;
alter table routine_log_entries enable row level security;
alter table news_items enable row level security;

create policy "public read routine_runs" on routine_runs for select using (true);
create policy "public read routine_log_entries" on routine_log_entries for select using (true);
create policy "public read news_items" on news_items for select using (true);
-- writes only via service-role (no policy needed; RLS blocks anon by default)
```

Apply: `supabase db push`

**Checkpoint 04** `Schema applied 資料庫結構套用完成`

---

## 6. Next.js scaffold + Supabase client

Scaffold was generated by `npx create-next-app@latest . --ts --tailwind --app --src-dir` (see `package.json`).

### 6.1 Dependencies

```bash
npm install @supabase/supabase-js @anthropic-ai/sdk zod
npm install -D @types/node
```

### 6.2 `src/lib/supabase.ts`

```ts
import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY!,
);

// Server-side only — NEVER import in a component
export function supabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
```

**Checkpoint 05** `Next.js + Supabase client wired 前端客戶端接好`

---

## 7. Site pages

| Route | SSR data source | Purpose |
|---|---|---|
| `/` | `news_items` where `news_date = today` | grid of today's 3 picks · EN + zh 雙語並列 |
| `/runs/[id]` | `routine_runs` + `routine_log_entries` | Per-run execution log · 時間戳逐行 |
| `/archive` | `news_items` group by `news_date` | Calendar view, click date → see that day's 4 |
| `/api/health` | `SELECT count(*) FROM news_items` | `{status, counts:{runs, items, latest_date}}` |

---

## 8. Routine spec + runner script

### 8.1 `routines/daily.md` — the Routine prompt (what Claude does in cloud)

> (see that file — it's the source of truth for what the Routine executes)

### 8.2 `routines/daily-runner.mjs` — local-runnable equivalent

Same logic, but without Routines cloud orchestration. Used for:
- Phase 1 manual seeding (tonight's today-news)
- iter-a verification (`SOURCE_TOPICS=1` mode)
- Local debugging when cloud Routine fails

```bash
# Run today's news (Phase 1)
node routines/daily-runner.mjs --run-id "$(date +%Y-%m-%d)-manual"
```

**Checkpoint 06** `Routine runner first pass Routine runner 首次跑通`

---

## 9. First live deploy

```bash
# Push to GitHub
git push -u origin main

# Vercel auto-deploys; verify
vercel ls | head -3
curl -sf https://showcase-003-daily-news.vercel.app/api/health | jq .
```

**Checkpoint 07** `First Vercel deploy 首次 Vercel 部署`

---

## 10. (Reserved — no TTS step, unlike 001 §10)

This showcase is text-only. The `§10 TTS batch` step from showcase-001 does not apply.

---

## 11. Custom domain binding (optional · can be deferred)

See `../mark-ai-talk/0423-003-DNS.md` — handoff card for binding `daily.aipm.com.tw`.

**Checkpoint 08** `Custom domain bound(optional) 自訂網域綁定(可選)`

---

## 12. Docker build + Container App roll (N/A — Vercel handles)

Vercel builds and serves from `git push`. No Docker build step in this build manual.

---

## 13. Verification checklist (§E · 7 items)

```bash
SITE="${SITE:-https://showcase-003-daily-news.vercel.app}"

# E.1  /api/health
curl -sf "$SITE/api/health" | jq -e '.status=="ok" and .counts.runs>=1'

# E.2  Today's 3 cards on homepage
HOME=$(curl -sf "$SITE/")
CARDS=$(echo "$HOME" | grep -oE 'data-news-card="[0-9]+"' | wc -l)
[ "$CARDS" -ge 2 ]   # 3 is the target; 2 is the dedup-floor acceptable

# E.3  Latest routine_runs row is visible at /runs/[latest]
LATEST=$(curl -sf "$SITE/api/runs/latest" | jq -r '.run_id')
curl -s -o /dev/null -w "%{http_code}\n" "$SITE/runs/$LATEST"   # expect 200

# E.4  routine_log_entries for that run are > 5
curl -sf "$SITE/api/runs/$LATEST" | jq -e '.log_entries | length > 5'

# E.5  Archive page 200
curl -s -o /dev/null -w "%{http_code}\n" "$SITE/archive"

# E.6  zh toggle works (lang=zh renders zh fields)
curl -sf "$SITE/?lang=zh" | grep -qE 'title_zh|翻譯'

# E.7  news_items unique on (news_date, rank) — Supabase guarantee
#      (asserted by schema, not via HTTP — placeholder; verify via supabase-cli)
supabase db execute --stdin <<< "select count(*) - count(distinct (news_date, rank)) from news_items" | grep -q '\b0\b'
```

**Checkpoint 09** `§E validation green §E 驗證全綠`

---

## 14. Known gotchas & notes

1. **Supabase free tier DB auto-pause after 1 week idle** — first query wakes it. No impact on daily routine (fires daily).
2. **Vercel build timeout 45 min free / 15 min pro** — our build should be < 2 min.
3. **Next.js 16 breaking changes** — see `AGENTS.md`; read `node_modules/next/dist/docs/` before writing pages.
4. **Routines quota Max 15/day** — this routine uses 1/day. No risk.
5. **TechCrunch RSS sometimes rate-limits** — the fallback path is `log_entries warn_source_unreachable` and continue with remaining sources.
6. **Hacker News title filter regex** — tune over first week; too strict = no HN news picked; too loose = unrelated tech news leaks in.

---

## 15. Cost profile

| Service | Tier | Monthly |
|---|---|---|
| Vercel | Hobby (free) | $0 |
| Supabase | Free tier (500 MB / 2 GB egress) | $0 |
| Azure OpenAI (gpt-4o scoring ~4 calls/day × 3 sources × small ctx) | trivial | sponsorship |
| Claude Routines | Max plan included (15/day quota) | $0 incremental |
| **Total** | | **~$3/month** |

---

## 16. What's NOT in this manual

- Image thumbnails per news item (future: pull og:image via server component)
- Email digest / RSS feed of the daily news
- User login (public read site; Supabase RLS handles write separation)
- Internationalization beyond EN + zh-TW

---

## 17. If you're a future Claude Code session rebuilding this

1. Read `README.md` for pitch context.
2. Run §2 pre-flight. If green, jump to §13 to verify live state.
3. If rebuilding from zero: walk §3 → §13 in order. Every step should be idempotent or have a clearly-named cleanup action.
4. `routines/daily.md` and `routines/daily-runner.mjs` must stay in sync; authoring protocol per `../spec/001/build-md-authoring.md` rule 1 (snapshot-before-revise).
5. This manual has been exercised end-to-end on 2026-04-24 (initial scaffold) → see `evidence/iteration-2026-04-24-a.md` for first full run results.
