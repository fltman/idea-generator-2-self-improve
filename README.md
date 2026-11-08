# Idégeneratorn, self-improving

[![Support me on Patreon](https://img.shields.io/badge/Patreon-Support%20my%20work-FF424D?style=flat&logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

An experiment: an idea generator that thinks about how to improve **itself**, and a Claude Code agent that builds the best of those ideas into its code while it runs.

It is a fork of [Idea Generator 2](https://github.com/fltman/idea-generator-2), an idea board where language models branch, cross and judge ideas and an evolution autopilot breeds the best ones. This fork adds three things:

1. **Claude Code is the model.** Every role (branch, cross, judge, summary, brief…) runs on the local `claude` CLI headless, using your own Claude login. No API key is needed in the app. Only the X scout stays on OpenRouter, since Grok is the only route that can search X.
2. **A self-improvement board.** Its goal is to make this app a better idea generator. Every prompt on it gets the app's current README feature list and the list of features the loop has already built, so the ideas are concrete changes to this codebase. The jury is told what "buildable in one session" means here.
3. **A builder.** When an idea on that board gets gold (from the jury, or from you), the server hands it to a headless Claude Code agent in its own git worktree. The agent implements it, adds tests, takes before/after screenshots and writes a journal entry. The server then checks the work itself (`npm test` plus booting the new server) and merges it into `main`. The running app restarts and the page reloads with the new feature. Every build, including the failures, leaves a write-up in [`journal/`](journal/INDEX.md), so the whole history can later be cut into a film.

## The loop

```
seed → branch / cross (claudecode:sonnet) → jury (calibrated, claudecode:sonnet)
     → 🥇 gold → builder: git worktree → claude -p (opus) builds, tests, screenshots, journal, commit
     → server re-runs npm test + boot check → merge --no-ff into main → app restarts, browser reloads
     → README grows → next generation of ideas knows the new feature
```

- **One build at a time.** The jury may start `buildsPerDay` builds per board per day (default 4). Builds you start by hand are not capped. Each build's agent has a budget (`BUILD_MAX_USD`, default 15) and a one-hour timeout.
- **Verified by the server, not the agent.** The builder re-runs the tests and boots the server from the worktree before it merges. A failing build keeps its branch (`build/NNNN-slug`) and still gets its journal entry in `main`.
- **Scoped agent.** The agent runs with `--permission-mode acceptEdits` and an explicit tool allowlist: file edits in its worktree, `npm test`, `node tools/shoot.ts`, and local git (add, commit, diff, log). Everything else is denied automatically, including push, checkout, reset, merge, rm, curl, npm install and web access. Running the tests does run code the agent wrote, so the worktree and the jury gate are the boundary, as in any CI.
- **Not pushed by default.** Merges stay local until you push. Set `BUILD_PUSH=1` to push `main` after each merge.
- **Progress camera.** The server screenshots the live board into `progress/` (gitignored): every 10 minutes (`CAMERA_MINUTES`, `CAMERA=0` turns it off), at every gold idea, when a build starts or ends, and after every restart, which includes right after a merge. `progress/latest.png` is always the newest picture, and `progress/README.md` logs every one inline, so you can follow along in any Markdown viewer and later cut it into a timelapse.
- **Live.** A ticker in the corner streams what the agent is doing (reads, edits, commands, its own remarks). 🔨 **Builds** in the top bar shows every build with its summary, cost, screenshots, journal and full log.

## What it does

- **Boards with their own goal and setup.** Each board has its own creation flow (prompts), jury guidance, scouts, models, autopilot and limits. Templates only seed a new board.
- **Canvas.** Infinite pan and zoom with a force layout, so families cluster. Drag an idea onto another to cross them. Hovering lights up an idea's whole lineage, and a ball grows with its score.
- **Explainable jury.** Originality, feasibility and impact are scored 1–5 each, with a one-sentence reason and 2–4 keywords. The medal is computed in code: bronze from 9/15, silver from 11, gold from 13. It is calibrated against reference ideas (`npm run calibrate`), and gold is rare on purpose.
- **Evolution autopilot (server-side).** Boards set to *automatic* breed parents by tournament selection on the jury score, and now and then expand a strong idea instead. The autopilot keeps running with no browser open, within its limits:
  - steps per hour
  - USD per day per board
  - a global USD per day
  - error backoff
- **Lift recipes with a measured hit rate.** For every idea the jury also writes a *lift recipe*: the one change that would earn it the next medal, typed by the criterion it raises (originality, feasibility or impact). Every child bred from that idea, by hand or by the autopilot, gets the recipe as its task and remembers its parent's medal; once the child is judged, the recipe either lifted the medal or it did not. The idea panel shows the recipe, how often recipes of that type have worked on the board, and for a child its task and ✓/✗. The overview shows the hits per type. Breeding uses the numbers: a cross hands on whichever parent's recipe type has the better record, and in tournament selection the hit rate nudges the score by at most ±0.5, so it breaks ties between ideas the jury scored the same but never outweighs a point of score.
- **A second opinion on borderline verdicts.** A jury sum exactly on a medal threshold (9, 11 or 13) is one point from a different medal. On a self-improvement board such a verdict is re-scored in the background by a second judge on another model (the *Second judge* role, default `claudecode:opus`), which runs the same judge prompt and never sees the first verdict. The idea panel shows a confidence band on the 3–15 scale with the medal lines, both sums, the second judge's reason and whether the medals agree. The medal stays the jury's, but in tournament selection a disagreement costs the idea half the gap (a 13 that the second judge puts at 11 breeds like a 12). On any board, *Ask a second judge* in the panel does the same by hand. Re-judging clears the old second opinion.
- **Scouts.**
  - *X trends*: Grok with live X search via OpenRouter. A lead is kept only if its post is among the search engine's own citations.
  - *AI research*: Hugging Face daily and semantic paper search, aimed at the goal.
  - Drag a lead onto the board to seed it.
- **Across boards.**
  - *Announce* an idea to other boards. It arrives as a guest, is judged against the new board's goal, and cross-breeds there.
  - Spin an idea off into a *new board* where it is the goal.
- **Self-improvement.** A board marked *self-improvement* proposes changes to this app, and its gold ideas are built in by Claude Code (see [The loop](#the-loop)). An idea's panel there has 🔨 *Build it into the app* instead of the project button, and setting its medal to 🥇 by hand starts a build too.
- **Claude Code projects.** One click, or the jury on gold, writes a folder containing `CLAUDE.md` (brief, MVP, first steps, open questions, lineage, verdict), `README.md`, `idea.json`, a gitignored `vault/`, and runs `git init`.
- **Board summary, keyword trend dashboard, report.**
  - *Summary*: themes, strongest ideas, gaps and next steps for one board.
  - *Dashboard*: keyword trends across boards, with sparklines and drill-down.
  - *Report*: totals, cross-board conclusions, every project with its start command, and one card per board. Exports to Markdown.
- **Exhibition mode.** Fullscreen, the camera follows new ideas, and visitors type seeds. It runs together with automatic mode.
- **Providers per role.** Every role has its own model, written `provider:model`. The roles are distill, branch, cross, judge, summary, research scout, X scout, project brief and second judge.
  - **Claude Code:** `claudecode:sonnet`, `claudecode:opus`, `claudecode:haiku` or a full model ID. Runs the local `claude` CLI headless with no tools and no settings, one process per call (2–5 s).
  - **Hosted:** OpenRouter, Anthropic (official SDK) and OpenAI.
  - **Copilot models:** neither GitHub Copilot nor Microsoft Copilot has a completion API for apps, and GitHub Models was retired on 30 July 2026. GitHub points to Microsoft Foundry, so the models behind both Copilots are reached through the Azure OpenAI / Microsoft Foundry provider.
  - **Local:** Ollama, MLX (`mlx_lm.server`), LM Studio, or any OpenAI-compatible URL.
- **Swedish and English** interface. Generated text follows the language of its seed.

## Run

Needs Node 25 or newer, which runs TypeScript directly (there is no build step), Claude Code installed and logged in (`claude`), git, and Google Chrome for the journal screenshots.

```bash
npm install             # one dependency: @anthropic-ai/sdk
npm run dev             # http://localhost:8301 — restarts itself when a build is merged
npm run self:setup      # once, in another terminal: creates the self-improvement board (autopilot on)
npm test                # 78 tests, fake LLM, fake claude CLI, fake agent; no network
npm run calibrate       # real judge vs. reference ideas (claudecode:sonnet ≈ $0.13)
npm run shoot -- --help # the screenshot tool the builder's agent uses
```

Use `npm run dev`, not `npm start`, for the loop: a merge changes `server/`, and only the watcher restarts the server so the new code runs. The default port is 8301 rather than the original app's 8300, so both can run at once and each keeps its own browser settings.

All app settings live in the browser (localStorage), including API keys, models per role, provider addresses, the projects folder and the global budget. The browser pushes them to the local server, which keeps them in memory only and never writes keys to disk. Environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) work as a fallback. The self-improvement board sets its own models, so it runs on Claude Code even with no browser open.

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST`, `DB_FILE` | 8301, 127.0.0.1, `data/ideas.db` | |
| `BUILD_PUSH` | off | `1` pushes `main` after each merged build |
| `BUILD_MAX_USD` | 15 | budget per build (`claude --max-budget-usd`) |
| `CLAUDE_BIN` | `claude` | the CLI the builder runs |
| `CAMERA_MINUTES`, `CAMERA` | 10, on | timelapse interval for `progress/`; `CAMERA=0` turns the camera off |
| `IDEAGEN_NO_BUILDER`, `IDEAGEN_NO_AUTOPILOT` | off | `1` turns them off (screenshots and boot checks do this) |

The server listens on 127.0.0.1 only. There is no login, and keys pass through it, so **do not expose it** as is.

## License

MIT
