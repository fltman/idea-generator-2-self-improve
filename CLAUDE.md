# CLAUDE.md – Idea Generator 2, self-improving

Node 25 runs the TypeScript server directly; the frontend is vanilla ES modules. There is no build step. Port 8301, loopback only.

This fork improves itself. A self-improvement board generates changes to this app, and gold ideas are built in by a headless Claude Code agent (`server/builder.ts`). **If you are that agent, the prompt tells you your build number and journal folder; follow it and the rules below.**

## Commands

- `npm run dev` – server on http://localhost:8301 that restarts when `server/` changes. A merged build relies on this. (`npm start` does not restart.) `PORT`, `HOST` and `DB_FILE` override.
- `npm test` – 78 tests (`node --test`), with a fake LLM, fake provider servers, a fake `claude` CLI and a fake build agent. No network.
- `npm run self:setup` – creates the self-improvement board on a running server.
- `node tools/shoot.ts --out file.png [--board N] [--eval js]…` – boots this checkout's server against a copy of `data/ideas.db` (autopilot and builder off), opens headless Chrome, and saves a PNG. `--help` lists the options.
- `npm run calibrate [-- --model provider:model]` – real judge against weak and strong reference ideas. It costs money. **Re-run it whenever the judge's prompt, schema or model changes.**

## Layout

- `server/providers.ts` – `provider:model` routing.
  - `claudecode` runs `claude -p --output-format json --json-schema … --system-prompt …`, with no tools and no settings, in a temp folder. The user text goes on stdin.
  - Ollama uses the native `/api/chat` with `think:false` and `format:schema`.
  - Anthropic uses the official SDK with `output_config.format`.
  - Everything else is OpenAI-compatible.
- `server/llm.ts` – every prompt, including the judge (`JUDGE_SYSTEM`). Each function takes `model`.
- `server/engine.ts` – every operation, the background judge queue (max 3) and the per-board event bus.
  - Second opinion: after a verdict on a medal edge (`onMedalEdge()` in `score.js`: sum exactly 9, 11 or 13) on a self-improvement board, `queueRetrial()` re-runs `llm.judge` with the `retrial` role's model (default `claudecode:opus`), blind, in the background, and stores the scores in `ideas.retrial` (JSON). Skipped if the retrial and judge models are the same. `POST /api/ideas/:id/retrial` does it by hand on any board. `saveJudgement()` clears it. `engine.idle()` waits for retrials too.
- `server/autopilot.ts` – the scheduler and the pure `rateCheck()`.
- `server/leads.ts` – the X and research scouts.
- `server/project.ts` – Claude Code folders.
- `server/builder.ts` – the self-improvement builder:
  - queue, worktree, the agent run (stream-json), verification, merge and the journal
  - `selfContext()`: the README feature list plus the merged builds, added to every prompt on self-improvement boards
- `server/camera.ts` – the progress camera: screenshots of the live board go to `progress/` (gitignored). It shoots on a timer and at every gold idea, build and restart, and keeps `latest.png` and a `README.md` log. It uses `?camera` so the headless browser never pushes settings.
- `journal/` – one folder per build (`NNNN-slug/`: the agent's README.md, screenshots, build.json) and `INDEX.md`. Committed and public.
- `data/worktrees/`, `data/builds/` – live worktrees, and each build's log.txt and full transcript.jsonl. Gitignored.
- `server/db.ts` – SQLite (`node:sqlite`), plus `report()` and `dashboard()` queries.
- `server/app.ts` – HTTP, SSE (`/api/boards/:id/events`) and Markdown exports.
- `public/js/score.js` and `public/js/evolve.js` – pure modules shared by the server, browser and tests.
  - Lift recipes live in `evolve.js` (`liftStats`, `recipeOf`, `pickRecipe`, `breedScore`). The jury writes `liftType` + `lift` (saved as `recipe_type`, `recipe`); a child bred under a recipe stores `lift_type`, `lift_from` and `lift_base` (the parent's medal then). A hit is the child's medal above `lift_base`. `openDb()` adds the columns to older databases.
- `public/js/graph.js` – the canvas.
- `public/js/app.js` – the main app.
- `public/js/dashboard.js` and `public/js/report.js` – the trends and report views.

## Rules that matter

- **The medal comes from code, not the model:** a sum of three 1–5 scores, bronze from 9, silver from 11, gold from 13 (`score.js`). Left uncalibrated, an LLM jury gave 3/3 to the bare word "fire"; the calibration test keeps that from happening here.
- **The lift-recipe nudge stays below one point.** `breedScore()` adds the hit rate minus 0.5 (Laplace-smoothed, so strictly within ±0.5) to fitness. It may only reorder ideas the jury scored the same; the jury's score stays what selection rests on.
- **The second judge never changes the medal.** `confidenceBand()` (`score.js`) only shows the band; `doubtPenalty()` (`evolve.js`) subtracts half the gap between the two sums from `breedScore()`, and nothing for a hand-set medal. The second judge must stay blind: never pass it the jury's scores or reason. The `retrial` model is not calibrated; if you change it, run `npm run calibrate -- --model <it>` first.
- **Never put integer `minimum`/`maximum` in a JSON schema.** Anthropic rejects them. Put the range in the description and clamp in code.
- **Anthropic native: send no `temperature`.** API version 2026-10-21 rejects it. Use effort `low`. The SDK sends the key as a Bearer token.
- **OpenRouter: send `reasoning:{enabled:false}`** and retry without it on a 400 that mentions reasoning (some models insist on reasoning).
- **X scout:** a lead is kept only if its URL is in the search engine's `url_citation` annotations. Never trust a URL the model wrote. Only OpenRouter (Grok) can search X.
- **App settings live in the browser's localStorage.** The server holds them in memory, and the SSE `hello` tells the browser to push them again after a restart. Board configuration lives in the DB.
- **Dollar limits only see providers that report cost** (OpenRouter `usage.cost`, Anthropic via the price table, Claude Code `total_cost_usd`). A limit of 0 means free models only.
- **Text goes into the DOM as text nodes, never `innerHTML`** (`dom.js`). Ideas are written by models and by visitors.
- **Builds are verified by the server, never by the agent's word.** The builder re-runs `npm test` and boots `server/index.ts` from the worktree, and merges with `--no-ff` only after both pass. The journal is committed on the branch before the merge, because the merge restarts the server under `npm run dev`; nothing that matters may come after it.
- **The build agent is scoped.** It runs `--permission-mode acceptEdits` with an allowlist (`AGENT_ALLOWED` in builder.ts): edits, `npm test`, `node tools/shoot.ts`, and local git add/commit/diff/log. It may not push, checkout, reset, merge, rm, curl, `npm install`, or use the web. Never run it with `--dangerously-skip-permissions`.
- **No new npm dependencies.** The worktree's `node_modules` is a symlink to the main one. **A build never commits `node_modules` or `data/`.** Build 0001 merged that symlink and took the live server down (a trailing slash in `.gitignore` does not match a symlink). The builder now writes both into `info/exclude` and refuses any branch that touches them.
- **Anything started inside a worktree gets `IDEAGEN_NO_AUTOPILOT=1 IDEAGEN_NO_BUILDER=1`** and never the live `PORT` or `DB_FILE`.
- **Project folders never overwrite.** They are created with a non-recursive `mkdir`, and a taken name gets `-2`.

## Measured

- **`claudecode:sonnet` judge after build 0001** (2026-11-08; adds `liftType` and `lift` after the scores, `maxTokens` 600):
  - weak ideas: mean 5.2, max 8 (no medal)
  - strong ideas: mean 9.6, 0 of 10 gold
  - run-to-run spread 1
  - $0.13
  - PASS

- **`claudecode:sonnet` judge before build 0001** (2026-11-08):
  - weak ideas: mean 4.9, max 7 (no medal)
  - strong ideas: mean 9.5, 0 of 10 gold
  - run-to-run spread 1
  - $0.13 for the 22 calls (Claude Code's list-price estimate)
  - about 2–5 s per call

- **Sonnet 5.5 judge** (2026-11-02):
  - weak ideas: mean 4.7, max 5
  - strong ideas: mean 9.8
  - run-to-run spread 0
  - about $0.003 per judgement
- **`ollama:qwen3:8b` as judge FAILS calibration:**
  - gave bronze to "Solpaneler på taken"
  - gave gold to 5 of 10 strong runs
  - spread 4 between runs
  - long reasons and Swedish errors

  Use local models to generate ideas, not to judge them.
- **X scout:** about 48 s and $0.04 per refresh; 5 of 6 leads were cited.
- **Providers tested live:** OpenRouter, OpenAI and Ollama (generation and model listing). Not yet tested against the live services: Azure / Microsoft Foundry, MLX, LM Studio, and Anthropic direct (only against a fake server). GitHub Models was removed: GitHub retired it on 30 July 2026 (every endpoint now answers a bare `200 OK`). Use the Test button in Settings.
