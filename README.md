# showcase-003-daily-news

**AIA x Claude Code 送件作品 #3**
**Owner:** Mark Chen <mark@aipm.com.tw>
**Target GitHub:** `aipmtw/showcase-003-daily-news` (public — transparency 是這個 showcase 的核心賣點)
**Live site:** `daily.aipm.com.tw`(custom domain 綁定中)/ `showcase-003-daily-news.vercel.app`(預設)
**Sibling showcases:**
- `showcase-001-genesis` — 一份 markdown 從零 Azure 到上線(工程力)
- `showcase-002-routines` — Claude Routines 接手自動化(未實作)
- **this**(003)— **把 Claude Code Routine 的執行 log 變成舞台主角**

---

## 一句話
**每天凌晨 08:00(Asia/Taipei)由 Claude Code Routine 自動上網抓 4 則 Claude Code + AI coding 新聞,英文原文 + 繁中翻譯入庫,網站展示當日 digest + 歷史 archive + 當日 routine 完整執行 log。**

## 敘事核心
評審打開 `daily.aipm.com.tw` 不只看到「當日新聞」,還能點進 `/runs/<run_id>` 看昨晚 08:00 Claude 是**怎麼搜尋、排名、翻譯、寫入**的。每一個工具呼叫、每一個判斷、每一次失敗重試,都以時間戳逐行呈現。**自動化從後台黑盒變成公開可觀測的表演。**

## 技術堆疊(刻意換軌)
| | 001 Genesis | this (003) |
|---|---|---|
| Compute | Azure Container Apps | **Vercel** |
| DB | Azure SQL Serverless | **Supabase**(Postgres) |
| Sponsorship | Toastmasters D67 Azure | markluce.ai production stack |
| Build time(0 → live) | ~14 min | **~5 min 目標** |

同檔名 `build.md`、同 iteration 協議、不同雲 → Infrastructure-as-Prose 不綁 Azure。

## 送件產物(5/7 前)
- `build.md` — 17 節從零建構手冊(Vercel + Supabase 版)
- `rebuild-checklist.md` — iteration §D.1-§D.5 協議
- `../spec/003/news-ranking.md` — 新聞排名 spec(extends `../spec/001/topic-sourcing.md`)
- `routines/daily.md` + `routines/daily-runner.mjs` — routine spec + 可執行腳本
- `evidence/` — iteration checkpoints + validation + logs
- `pdf/` — 3 頁送件 PDF
- `video/` — ≤90 秒影片

## Routine 核心流程
```
08:00 TPE
  ↓  Claude Code Routine fires
  ↓  INSERT routine_runs row (status=running)
  ↓  FOR source IN [CHANGELOG, anthropic-news, TC AI, HN 24h]:
  ↓    WebSearch / WebFetch source
  ↓    INSERT routine_log_entries(phase, intent, tool, input, output, decision, duration_ms)
  ↓    Rule 2 score candidates → pick top 1
  ↓  Aggregate 4 picks (dedup · fall back to 3 if needed)
  ↓  Translate EN → zh-Hant
  ↓  INSERT 4 news_items rows
  ↓  UPDATE routine_runs row (status=succeeded, items_produced=4)
  ↓
08:00:~30s TPE — 網站首頁自動顯示當日 4 則
```

## 與 001 的基礎建設共用
001 的 PDF / video 基礎建設(`/print` 路由、`scripts/print-pdf.mjs`、`/video-card/*`、`generate-video-vo.mjs`、`assemble.sh` ffmpeg recipe、`qrSvg` 工具)全部可 fork;**估 60% 直接可重用,40% 需要為 003 客製**。
