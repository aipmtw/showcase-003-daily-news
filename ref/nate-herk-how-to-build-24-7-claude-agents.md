# Nate Herk · How to Build 24/7 Claude Agents. Easy.

**Channel:** Nate Herk | AI Automation
**URL:** https://www.youtube.com/watch?v=ehg4fhydTgs
**Video ID:** `ehg4fhydTgs`
**Length:** 16:25
**Published:** 2026-04-14 (the day Claude Code dropped Routines)
**Captured by:** Mark + AI session 2026-04-25

---

## Sectional outline (from description timestamps)

| Time | Section |
|---|---|
| 0:00 | What Are Routines? |
| 1:04 | Setting Up a New Routine |
| 2:15 | API "Gotchas" |
| 6:10 | What Won't Work Remotely |
| 8:29 | Environments, Security & Limits |
| 10:02 | Routines vs Scheduled Tasks |
| 14:52 | Common Questions |
| 16:04 | Final Thoughts |

---

## Key findings

### 1. GitHub repo is mandatory · 2:37–2:51, 13:14–13:21

A GitHub repository is required to set up and run Claude Code routines (2:37). When a routine runs, the system **clones your specified GitHub repo into the cloud** to access your project files, scripts, and `claude.md` configuration (2:41–2:49). Once the task completes that temporary environment is destroyed, but **any changes or branches the routine created get pushed back to your repository** (2:51, 13:14–13:21).

**Implication for us (showcase-003-daily-news):**
- Already satisfied — our routine is wired to `aipmtw/showcase-003-daily-news` (public repo).
- The routine cloud will see our `claude.md` / project files. **Make sure no secret leaks live in the repo** (we already have `.env.local` in `.gitignore`).
- Push-back capability means in principle a routine could commit to our repo (e.g. write a daily news digest snapshot as a markdown). Not used today, possible future enhancement (would let evidence land in git, not just Supabase).

### 2. Routine = a prompt run by "someone else" at your laptop · ~3:30–4:10

> "Think of a scheduled task or a routine as you basically typing in a prompt and then someone coming in to your laptop and typing it in for you. So it's the exact same type of interaction as you talking to claude code. But that's why once again you want to make sure it's specific enough so that it can basically one-shot it."

**Implication for us:**
- Our v2-trigger prompt is already one-shot (single curl + report). ✅
- The "someone else typing it" framing matches why hardcoded secrets in the prompt are uncomfortable but acceptable for a private routine — same trust boundary as your local terminal.

### 3. API key gotcha — env vars need explicit acknowledgement · 4:10–6:10

Nate tried to use a YouTube Data API key by saying "My YouTube API key is available as an environment variable. Use it directly." The key was set in the cloud env's environment variables but the routine still failed/required handholding to actually pick it up.

**Implication for us (matches 2026-04-25 finding):**
- We already saw env-var injection unreliable in our v3 attempt (`$SUPABASE_URL` etc. weren't visible in shell). Nate's video corroborates: env vars exist on paper but routines often can't or don't reach them as expected.
- Our v2-trigger sidesteps this entirely — secret hardcoded into prompt, no reliance on env-var injection.

### 4. Browser-based automations don't work remotely · 6:10–~7:30

Nate tried to migrate a Skool engagement automation that used Playwright CLI. It failed because:

> "When you do this, it spins up a browser, but **there's no cookies because all of this is running remotely**, and all I have to look at is the GitHub repo. I can't look at the local cookies that we've used in the last couple sessions of this automation."

The cloud session has no persisted browser state (cookies, localStorage, sessions). Anything that depends on a logged-in browser context won't work.

**Implication for us:**
- We don't need a browser for the news pipeline (all sources are HTTP APIs or HTML pages with simple regex), so this doesn't bite us. ✅
- For future routines that touch authenticated web UIs (e.g., scraping a logged-in dashboard), we'd need to do that work on our Vercel side too, not in the routine.

### 5. Quota — 15 routine runs/day on Max $200 plan · ~7:50

> "If I go to my usage… we have daily included routine runs… we are at 0 of 15. So I could only have 15 automations running with routines per day because I'm on the Max $200 a month plan. Your limits would be less if you're on Pro."

**Implication for us:** our routine = 1/day. Plenty of headroom even on Pro. (Memory `reference_claude_accounts.md` already notes Mark's `mark@aipm.com.tw` is Pro × 1 month — confirm 15/day vs Pro number before counting on it.)

### 6. cloud.md is auto-read on every run · ~8:50–9:30

> "Because of the fact that this is working off of a cloned repo, it's going to read the cloud.md file automatically every time. So if you have a massive project like a Herk-2 project for example with tons of context and tons of stuff, maybe you don't want to put that repo into the cloud to be a routine run because there's a lot of context in that cloud.md and in that whole GitHub repo that might not matter."

**Implication for us:** our `showcase-003-daily-news` repo is small and focused; CLAUDE.md is short. ✅. But — every routine fire pays the token cost of reading the whole CLAUDE.md + relevant tree. Keep CLAUDE.md tight.

### 7. Routines vs Scheduled Tasks vs /loop — the comparison table · 10:02–11:30

| | Routines | Scheduled tasks | /loop |
|---|---|---|---|
| Where it runs | **Anthropic cloud** | Your machine | Your machine |
| Machine on? | **No** | Yes | Yes |
| Session open? | No | No | **Yes** |
| Survives restart? | Yes | Yes | **No (in-session only)** |
| Local file access | **No** (only GitHub repo + APIs) | Yes | Yes |
| Permission prompts | **Fully autonomous** | Configurable | Configurable |
| Minimum interval | **1 hour** | 1 minute | 1 minute |

**Implication for us:** Routines is the right choice for our 08:00 TPE daily fire. Loop and scheduled tasks both require Mark's machine on, defeating the "ambient daily news" narrative.

### 8. Permissions — "Trusted hosts" vs "Full" · ~11:30–12:00

> "If Claude reads malicious content during a run, then it theoretically could be tricked into sending data to an external server, and with **trusted [hosts] that outbound request would get blocked**. Now practical risk for private repos where you control the inputs is very low, but I definitely just wanted to at least acknowledge that."

**This is the official rationale for the egress allowlist** that bit us all day. It's a prompt-injection defense, not a config bug. Our 2026-04-25 finding (UI allowlist additions don't reliably take effect) sits on top of this baseline restriction.

**Implication for us:** **embrace the constraint** rather than fight it. v2-trigger model reduces our routine's outbound surface to a single Vercel host — the safest possible profile, and the model the security design favors.

### 9. .env files — gitignore only buys safety if you don't push · ~12:00–12:30

> "Obviously, your .env is gitignored unless you push it into the GitHub repo. You know, ultimately if you push it into a private repo, you're probably okay, but you want to be really really really careful…"

**Implication for us:** repo is **public** (`aipmtw/showcase-003-daily-news`). `.env*` MUST stay gitignored. Verify before any commit:
```
grep -E "^\\.env" .gitignore   # should match .env, .env.local, etc.
git ls-files | grep -E "\\.env"  # should be empty
```

### 10. Connectors vs API keys are different · ~12:30–13:00

Connectors = Slack / ClickUp / Gmail / GitHub-as-app — same concept as Claude Chat / Claude.ai connectors. Plain API keys (Anthropic, OpenAI, etc.) are configured separately as part of the prompt or env.

**Implication for us:** we don't use connectors today. If we ever want a "routine fails → Slack me" hook, that's a clean connector path (Nate's idea, item 11 below).

### 11. Cleanup behavior + how to test · 13:00–14:55

> "When the cloned repo gets destroyed, the Claude branches gets pushed to your GitHub repo and the session also stays. So as you saw, if I came into here and I looked at all of these tasks, I could see all of the past runs and I could go look at them to see if something's going wrong. But the actual cloud environment that gets cloned will be destroyed."

> "Test it multiple times before it goes live. You just go into the routine, you hit run now, and then it will pop up as running. And then you just watch it… you can inject, and you can help it correct itself so that you have confidence that once it shoots off the prompt next time, you won't have to get in the way at all."

**Implication for us:** Mark today's flow = paste §B → Run now → watch + correct → only after a clean Run now should we let the cron fire. Don't trust cron-only on first deploy.

### 12. Common Questions · 14:52–16:04

| Q | A |
|---|---|
| How do I create a routine? | Just describe what you want in natural language |
| Can it access my local files? | **No.** Only what's in your GitHub repo or APIs |
| What model? | Any of the available models |
| Watch it work in real time? | Yes via Run now; can interrupt + continue |
| Use my MCP? | **Yes** — that's what connectors are |
| Can teammates use my routines? | **No** (account-bound; team plan may share — untested) |
| What's the cost? | Just normal subscription usage |
| What if a run fails? | Stored in history; can configure routine to Slack-message you on fail |
| Can I test before going live? | Yes — Run now, watch, correct, repeat until confident |

### 13. Final thoughts · 16:04–end

Encouragement to migrate scheduled tasks → routines so you stop having to keep your hardware on. No new technical content.

---

## ✅ Open questions resolved

- **8:29 Environments / Limits** — covered: 15/day on Max ($200), less on Pro.
- **10:02 Routines vs Scheduled Tasks** — covered: cloud + autonomous + 1h-min vs local-machine + 1m-min. Routines is right for us.
- **14:52 Common Questions** — covered above (item 12).
- **Push-back disable?** — **Not addressed in video.** Behavior described as automatic ("Claude branches get pushed"). Need to test ourselves whether read-only routines (no file edits) skip the push, or if we'll see noise branches in `aipmtw/showcase-003-daily-news`. Action: after first successful Run now, check `git ls-remote --heads origin` for `claude/*` branches.

---

## How this changes our 003 settings

| Setting | Before | After (informed by this video) |
|---|---|---|
| Routine prompt secrets | v1 hardcoded SUPABASE/Azure JWTs | **v2 hardcode only `ROUTINE_INGEST_SECRET`** — single shared secret, no DB credentials in the cloned repo's prompt |
| Cloud env Network access | Allowlist UI with 8 hosts(supabase, azure, news…)| Custom + **only `*.vercel.app`** — corroborated that allowlist UI is unreliable; minimum surface is best |
| Env var injection | Tried v3 `$VAR` reads | **Don't rely on it.** Hardcode into prompt or call out to Vercel where env actually works |
| Where the work happens | Routine cloud does fetch + score + translate + persist | **Routine cloud does only the trigger curl;** Vercel does everything (no egress restrictions, real env vars, real secrets) |
| What the routine sees in our repo | (didn't matter when it tried direct DB writes) | Now sees `claude.md` + `routines/daily.md` + `src/` — **make sure these are clean public docs, no secrets** |

---

## Concrete action items for our 003 routine (informed by the video)

1. ✅ **CLAUDE.md is tight** — verified 2026-04-25: `CLAUDE.md` = 1 line (`@AGENTS.md`); `AGENTS.md` = 5 lines (Next.js 16 caveat). Routine fire pays minimal context tax.
2. ✅ **No `.env*` in git** — verified: `git ls-files | grep -E '\.env'` returns nothing; `.gitignore` covers `.env*` and `.env.iter.local`.
3. ⏳ **Run now × 2-3 times** before trusting the cron. Watch the log; interrupt + correct if anything looks off; only let 08:00 TPE fire after a clean Run now. (Mark's next move.)
4. ⏳ **After first Run now**, check `git ls-remote --heads origin` for `claude/*` branches — our routine doesn't edit files so push-back may be a no-op, but verify. If branches appear, decide: tolerate / periodically prune / amend prompt to skip push-back.
5. ⏸ **(Future) Slack failure hook** — add Slack connector + amend prompt: "If trigger response has ok=false, send Slack #me with detail." Free observability.
6. ✅ **Don't use env-var injection** — already abandoned in v2-trigger; Nate's video corroborates flakiness. Trigger secret hardcoded into prompt.

---

## Source recap protocol

This file is built incrementally. As Mark watches more of the video and pastes findings, append them under "Key findings" with a timestamp range and a "Implication for us" line. When all sections are covered, update the action items at the bottom.
