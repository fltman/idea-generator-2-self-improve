# CLAUDE.md – Idea Generator 2, self-improving

Node 25 runs the TypeScript server directly; the frontend is vanilla ES modules. There is no build step. Port 8301, loopback only.

This fork improves itself. A self-improvement board generates changes to this app, and gold ideas are built in by a headless Claude Code agent (`server/builder.ts`). **If you are that agent, the prompt tells you your build number and journal folder; follow it and the rules below.**

## Commands

- `npm run dev` – server on http://localhost:8301 that restarts when `server/` changes. A merged build relies on this. (`npm start` does not restart.) `PORT`, `HOST` and `DB_FILE` override.
- `npm test` – 99 tests (`node --test`), with a fake LLM, fake provider servers, a fake `claude` CLI and a fake build agent. No network.
- `npm run self:setup` – creates the self-improvement board on a running server. `-- --new --title … --seed … --usd N --retire` starts a fresh one and switches the old ones to manual: the way to restart the loop once the old pool keeps proposing what is already built. The camera follows the self-improvement board whose autopilot runs.
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
  - Gold gate (build 0003): on a self-improvement board a jury gold that gets an automatic retrial (a 13) does not call `onGold` from `judge()`. `retrial()` calls it when `goldGate()` (`score.js`) says `'agreed'`, and emits a `contested` event when it says `'contested'`. `GET /api/builds` returns `contested` (such ideas with no build) for the Builds view. Clear gold (14–15), a gold where both roles share a model, and a hand-set gold still go to the builder at once.
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
  - Placebo trials (build 0004): `assignArm()` picks each breed's arm and stores it in `lift_arm`: `recipe`, `placebo` (by lot, `PLACEBO_RATE` 0.2; the prompt gets only `PLACEBO_TASK` "improve it", while `lift_type` keeps the withheld type) or `none` (no recipe; base is the best parent below gold). `trialStats()` / `trialVerdict()` feed the overview table. Old rows with a `lift_type` and no arm count as `recipe`. The engine's lot is `deps.trialRng` (tests fix it).
  - Diversity pressure (build 0005): `diversity()` measures the share of the last `DIVERSITY_WINDOW` (24) bred, keyword-tagged ideas that carry the most common jury keyword (ties alphabetical; seeds and guests excluded). From `MONOCULTURE_SHARE` (0.6) with at least `DIVERSITY_MIN` (12) ideas it is a monoculture, and `nextMove()` draws the first parent's tournament from ideas outside the theme (and expands the best unexpanded outsider on a mutation). Such a move carries `escape` (the keyword); `autoStep()` hands it to `doExpand`/`doCombine`, which store it in the `escape_kw` column (`ESCAPE` is an SQL keyword) as `idea.escape`. `diversitySeries()` / `pressureStats()` feed the overview gauge. `nextMove(…, { diversity: false })` turns it off.
  - Control siblings (build 0007): `autoStep()` counts the board's recipe-arm crosses after each cross; when `controlDue()` (every `CONTROL_EVERY`, 4) it crosses the same parents again via `doCombine(…, forced)` with arm `control` (no task text, `lift_type` the withheld type, same `lift_base`) and judges both in the same step. Only autopilot crosses get one; hand breeds and expands do not. `medalGain()` / `netLiftStats()` give per type the mean gain of recipe vs control children and `net` (null until both arms have data); `netNudge()` turns it into the tie-break and `breedScore(idea, stats, net)` uses it instead of the hit rate when it exists (`nextMove` passes it). `netChips()` in app.js draws the chips under the placebo table; `liftBlock()` shows the line for the idea's type.
  - Recipe check (build 0008): after `judge()` saves a verdict on a recipe-arm child, `checkLift()` in engine.ts calls `llm.checkLift` (judge model, schema `liftcheck`: `reason`, `applied` boolean) with parent, recipe and child, and stores `lift_applied` (1/0) and `lift_check` (`idea.liftApplied`, `idea.liftCheck`) via `repo.saveLiftCheck()`. Once per child (skipped if already set, if the parent's recipe is gone or changed type); a failure leaves it null and never fails the verdict. `liftHit()` returns null for an ignored child; `appliedStatus()` / `appliedStats()` feed `appliedSplit()` under the net-lift chips and `appliedLine()` in the panel.
  - Blind duel (build 0009): right after `checkLift()`, `duelLift()` in engine.ts calls `llm.duel` (judge model, schema `duel`: `reason`, then `originality`/`feasibility`/`impact` each `"A"`/`"B"`/`"tie"`) with only the two texts. A coin (`deps.duelRng`, tests fix it) decides whether the child is A or B; the engine maps the answer back to `child`/`parent`/`tie` and stores JSON in the `duel` column (`idea.duel`, with `childFirst`, `model`, `at`) via `repo.saveDuel()`. Recipe-arm children only, once per child; an incomplete answer or a failure leaves it null. `duelHit()` (`evolve.js`) is the child winning the recipe's criterion; `liftHit()` uses it when present, else the medal rule. `duelStats()` feeds `duelSplit()` in the overview; `duelLine()` shows the badges in the panel.
- `public/js/graph.js` – the canvas.
- `public/js/app.js` – the main app.
- `public/js/dashboard.js` and `public/js/report.js` – the trends and report views.

## Rules that matter

- **The medal comes from code, not the model:** a sum of three 1–5 scores, bronze from 9, silver from 11, gold from 13 (`score.js`). Left uncalibrated, an LLM jury gave 3/3 to the bare word "fire"; the calibration test keeps that from happening here.
- **The lift-recipe nudge stays below one point.** `breedScore()` adds the hit rate minus 0.5 (Laplace-smoothed, so strictly within ±0.5) to fitness. It may only reorder ideas the jury scored the same; the jury's score stays what selection rests on.
- **Diversity pressure narrows the pool, never the ranking.** In a monoculture it only restricts which ideas one parent may come from; inside that pool the tournament still compares `breedScore()`, and the other parent comes from the whole pool. It consumes the same rng draws as before, so a board without a monoculture breeds exactly as it did.
- **Placebos never steer breeding.** `liftHit()` and `liftStats()` count the recipe arm only; placebo and no-task (`none`) children are measured, not used. The placebo task must stay vague: no criterion, no recipe text.
- **Control siblings steer only through net lift, and only within ±0.5.** The `control` arm is the one non-recipe arm that is used: `netLiftStats()` subtracts its mean gain from the recipe arm's, and `netNudge()` keeps the result strictly inside ±0.5 (and shrinks it by `k/(k+2)`, k the smaller arm's n), so like the hit rate it only reorders ideas the jury scored the same. A control sibling must get no task text at all. `armOf()` must know `control`: a control child carries a `lift_type`, and an unknown arm would fall back to `recipe`.
- **The recipe check stays blind and only filters the hit rate.** `llm.checkLift` must never see scores, the reason or the medal, so its ruling cannot follow the medal. An ignored child is dropped from `liftStats()` (neither hit nor miss); unchecked children still count. `trialStats()` and `netLiftStats()` keep every recipe child (intention to treat), so the placebo and control comparisons are not biased by the check.
- **The blind duel decides hits, never medals, and stays blind.** `llm.duel` sees two texts labelled A and B and nothing else: no recipe, scores, reason, medal or which one is the parent. Keep the coin: a fixed order would let position bias pass for recipe skill. The duel only changes `liftHit()` (so `liftStats()` and the ±0.5 nudge); the scores, the medal, `trialStats()` and `netLiftStats()` stay on the medal rule, because placebo and control children are not duelled and mixing measures across arms would bias the comparison.
- **The second judge never changes the medal.** `confidenceBand()` (`score.js`) only shows the band; `doubtPenalty()` (`evolve.js`) subtracts half the gap between the two sums from `breedScore()`, and nothing for a hand-set medal. It can hold back a build (a contested gold waits for a human), but the gold medal stays on the idea. The second judge must stay blind: never pass it the jury's scores or reason. The `retrial` model (`claudecode:opus`) passed calibration on 2026-11-08 (see Measured). If you change it, run `npm run calibrate -- --model <it>` first.
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

- **`claudecode:opus` as second judge (retrial)** (2026-11-08, after build 0002):
  - weak ideas: mean 4.8, max 5 (no medal)
  - strong ideas: mean 9.8, 0 of 10 gold
  - run-to-run spread 0
  - $0.31 for 22 calls
  - PASS
  - It scores about like Sonnet, so the band measures disagreement, not a constant offset.

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
