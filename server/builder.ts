// The self-improvement builder. A gold idea on a self-improvement board is a
// change to THIS app; the builder hands it to a headless Claude Code agent and
// merges the result into main when it holds up.
//
// One build at a time:
//   1. a fresh git worktree on branch build/NNNN-slug (data/worktrees/, gitignored),
//      with node_modules linked and a snapshot of the live database for screenshots
//   2. `claude -p` implements the idea, takes before/after screenshots with
//      tools/shoot.ts and writes journal/NNNN-slug/README.md, then commits
//   3. the builder does not take the agent's word for it: it re-runs `npm test`
//      and boots the server from the worktree itself
//   4. merge --no-ff into main (the running app restarts under `npm run dev`),
//      then journal/NNNN-slug/build.json and journal/INDEX.md are committed
// A failed or declined build keeps its branch, and its journal still lands in
// main: the failures belong in the film too.
//
// The agent runs with acceptEdits and an explicit tool allowlist: it can edit
// files in its worktree, run the tests, the screenshot tool and local git, and
// nothing else (no push, no web). Note that running tests means running code the
// agent wrote; the worktree and the jury gate are the boundary, as in any CI.

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Build, Idea, Repo } from './db.ts';
import { slugify } from './project.ts';
import { run } from './providers.ts';
import { scoreSum } from '../public/js/score.js';

export type AgentSpec = { cmd: string; args: (o: { model: string }) => string[] };
export type BuildEvent = { type: 'build'; build: Build } | { type: 'buildLog'; id: number; lines: string[] };

type Deps = {
  repo: Repo;
  /** The app's own git repository (its main working tree). */
  root: string;
  /** Broadcast to every open board. */
  emit: (e: BuildEvent) => void;
  agent?: AgentSpec;
  mainBranch?: string;
  /** Merge passing builds into main (default true). */
  merge?: boolean;
  /** git push main after a merge (default false: publishing is the user's call). */
  push?: boolean;
  agentTimeoutMs?: number;
  testTimeoutMs?: number;
  maxUsdPerBuild?: number;
};

const ACTIVE_LOG = 400;
/** Paths a build may never commit: the linked node_modules and the live data (database, worktrees, logs). */
const FORBIDDEN = ['node_modules', 'data'];
const pad = (n: number) => String(n).padStart(4, '0');
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// What the agent may do without asking. In -p mode anything else is denied automatically.
export const AGENT_ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite',
  'Bash(npm test)', 'Bash(npm test:*)', 'Bash(npm run calibrate:*)', 'Bash(node --test:*)', 'Bash(node --check:*)', 'Bash(node tools/shoot.ts:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git mv:*)', 'Bash(git rm:*)',
  'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(grep:*)', 'Bash(rg:*)', 'Bash(sed -n:*)',
];
export const AGENT_DENIED = [
  'Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git reset:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)',
  'Bash(git worktree:*)', 'Bash(rm:*)', 'Bash(curl:*)', 'Bash(npm install:*)', 'Bash(npm i:*)', 'WebFetch', 'WebSearch',
];

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'declined'], description: 'done: built, tested, documented and committed. declined: not built (say why in summary).' },
    summary: { type: 'string', description: '2–4 sentences: what you built and how it shows in the app, or why you declined.' },
    filmLine: { type: 'string', description: 'One sentence a narrator could say about this build in a film about the app improving itself.' },
  },
  required: ['status', 'summary', 'filmLine'],
  additionalProperties: false,
};

const BUILDER_SYSTEM = `You are the builder in Idea Generator 2's self-improvement loop. The app generates ideas for improving itself; its calibrated jury gave the idea below gold, and you now build it into the app's own code, in a git worktree, unattended. Nobody will answer questions: decide, and write your reasoning into the journal.

Rules:
- Read CLAUDE.md first and follow every rule in it. Keep the existing style: vanilla ES modules, TypeScript run directly by Node, no build step.
- Build the smallest version that delivers the idea's core and that a user can see. Prefer a solid small feature over a sprawling one.
- No new npm dependencies. No network calls in tests (use the fakes the tests already use). Never put integer minimum/maximum in a JSON schema.
- Text goes into the DOM as text nodes (dom.js h()), never innerHTML.
- \`npm test\` must pass. Add tests for what you build. Do not weaken or delete existing tests to make them pass.
- Do not touch files outside this worktree. Do not push, merge, switch branches or reset. Commit your work on the current branch.
- If the idea is impossible, unsafe, already exists, or would break the rules above, do not build it: write the journal entry explaining why and finish with status "declined".
- The journal is for a film about an app that improves itself. Write it plainly and honestly, including what went wrong.`;

function buildPrompt(a: { build: Build; idea: Idea | null; goal: string; lineage: { title: string; pitch: string }[]; boardId: number | null; seq: number; jdir: string; branch: string }) {
  const i = a.idea;
  const sum = i ? scoreSum(i) : null;
  return [
    `# Build ${pad(a.seq)}: ${a.build.title}`,
    `You are on branch \`${a.branch}\` in a worktree of the app's repository. Journal folder: \`${a.jdir}/\` (it exists).`,
    `## The idea\n**${a.build.title}.** ${a.build.pitch}`,
    i && sum != null ? `Jury: originality ${i.originality}, feasibility ${i.feasibility}, impact ${i.impact} = ${sum}/15. ${i.reason ?? ''}` : 'Started by hand (no jury verdict yet).',
    a.goal ? `Board goal: ${a.goal}` : '',
    a.lineage.length ? `It grew out of:\n${a.lineage.map((l) => `- ${l.title}: ${l.pitch}`).join('\n')}` : '',
    `## Steps
1. Read CLAUDE.md, README.md and the code the idea touches. Decide the smallest version worth building, or decline.
2. Before you change anything, take a "before" screenshot of where the feature will appear:
   \`node tools/shoot.ts --out ${a.jdir}/01-before.png${a.boardId ? ` --board ${a.boardId}` : ''}\`
   tools/shoot.ts boots this worktree's server against a copy of the live data (autopilot off, no model calls), opens headless Chrome and saves a PNG. Options: \`--board <id>\`, \`--lang en|sv\`, \`--eval "<js>"\` (repeatable, run in order, may return a promise; \`?debug\` is on, so \`window.ideagen\` exposes \`{ graph, state }\`), \`--wait <ms>\` (after load and between evals, default 1500), \`--width\`/\`--height\`. To open an idea panel: \`--eval "window.ideagen.graph.h.select(<ideaId>)"\`. Run \`node tools/shoot.ts --help\` for more.
3. Implement it. Add or update tests. Run \`npm test\` until it passes.
4. Take "after" screenshots that show the feature working: \`${a.jdir}/02-after.png\`, and more (03-…, 04-…) if the feature has steps.
5. Write \`${a.jdir}/README.md\`:
   - \`# ${pad(a.seq)} · <title>\`, then the pitch as a quote
   - **Why the jury picked it**: the verdict above, in a sentence or two
   - **What I built**: what a user sees and does, then how it works (files, mechanism)
   - **How I verified it**: tests added, what you ran, what you looked at in the screenshots
   - **Screenshots**: embed every PNG with a caption, e.g. \`![Before: …](01-before.png)\`
   - **What I left out**: and what the next step would be
   - **For the film**: one or two honest sentences about this build: the moment it worked, or what surprised you
6. If you changed features, update README.md ("What it does") and CLAUDE.md (layout, rules, the test count).
7. \`git add\` everything and commit on this branch: \`Build ${pad(a.seq)}: <what changed>\`. Do not push.

Finish with the structured result.`,
  ].filter(Boolean).join('\n\n');
}

/** One log line per meaningful agent event (stream-json from `claude -p --verbose`). */
export function describeEvent(ev: any, wt: string | string[]): string[] {
  const prefixes = (Array.isArray(wt) ? wt : [wt]).map((w) => w.replace(/\/+$/, '') + '/');
  const rel = (p: unknown) => prefixes.reduce((s, pre) => (s.startsWith(pre) ? s.slice(pre.length) : s), String(p ?? ''));
  const one = (s: unknown, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  if (ev?.type === 'system' && ev.subtype === 'init') return [`▶ Claude Code started · ${ev.model ?? ''}`];
  if (ev?.type === 'assistant') {
    const out: string[] = [];
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push(`💬 ${one(c.text, 400)}`);
      if (c.type !== 'tool_use') continue;
      const x = c.input ?? {};
      if (c.name === 'StructuredOutput') continue;
      if (c.name === 'Bash') out.push(`$ ${one(x.command, 200)}`);
      else if (c.name === 'Edit' || c.name === 'Write' || c.name === 'MultiEdit') out.push(`✏️ ${c.name} ${rel(x.file_path)}`);
      else if (c.name === 'Read') out.push(`📖 ${rel(x.file_path)}`);
      else if (c.name === 'Grep' || c.name === 'Glob') out.push(`🔎 ${one(x.pattern, 120)}`);
      else if (c.name === 'TodoWrite') {
        const doing = (x.todos ?? []).find((t: any) => t.status === 'in_progress');
        if (doing) out.push(`☑ ${one(doing.content ?? doing.activeForm, 160)}`);
      } else out.push(`🔧 ${c.name}`);
    }
    return out;
  }
  if (ev?.type === 'user') {
    const out: string[] = [];
    for (const c of ev.message?.content ?? []) {
      if (c.type === 'tool_result' && c.is_error) {
        const text = Array.isArray(c.content) ? c.content.map((p: any) => p.text ?? '').join(' ') : c.content;
        out.push(`⚠ ${one(text, 200)}`);
      }
    }
    return out;
  }
  if (ev?.type === 'result') return [`■ agent finished · ${ev.num_turns ?? '?'} turns · $${Number(ev.total_cost_usd ?? 0).toFixed(2)}`];
  return [];
}

/** The app's README feature list and what the loop has built, for prompts on self-improvement boards. */
export function selfContext(root: string) {
  let features = '';
  try {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const m = /## What it does\n([\s\S]*?)(\n## |$)/.exec(readme);
    features = (m ? m[1] : readme).trim().slice(0, 6000);
  } catch {
    /* no README: no context */
  }
  const built = journalEntries(root).filter((j) => j.status === 'merged').map((j) => `- ${pad(j.seq)} ${j.title}: ${j.summary ?? ''}`.trim());
  return [
    'You are working on Idea Generator 2 itself: an idea board where language models branch, cross and judge ideas, and an evolution autopilot breeds the best ones. Each idea on this board is a change to this app that a coding agent (Claude Code) will build into its code in one unattended session if the jury gives it gold.',
    features ? `What the app does today (from its README):\n${features}` : '',
    built.length ? `Already built by this self-improvement loop (do not propose these again):\n${built.slice(-40).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

type JournalEntry = { seq: number; title: string; status: string; summary?: string; dir: string };
function journalEntries(root: string): JournalEntry[] {
  const dir = join(root, 'journal');
  if (!existsSync(dir)) return [];
  const out: JournalEntry[] = [];
  for (const name of readdirSync(dir).sort()) {
    const f = join(dir, name, 'build.json');
    if (!/^\d{4}-/.test(name) || !existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      out.push({ seq: Number(name.slice(0, 4)), title: j.title, status: j.status, summary: j.summary, dir: name });
    } catch {
      /* a broken build.json does not break the index */
    }
  }
  return out;
}

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as any).port;
      s.close(() => resolve(port));
    });
  });
}

/** Environment for anything we start in a worktree: never the live server's port or database. */
function worktreeEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, IDEAGEN_NO_AUTOPILOT: '1', IDEAGEN_NO_BUILDER: '1' };
  delete env.PORT;
  delete env.DB_FILE;
  delete env.HOST;
  return { ...env, ...extra };
}

export function createBuilder(deps: Deps) {
  const { repo, root } = deps;
  const mainBranch = deps.mainBranch ?? 'main';
  const agent: AgentSpec = deps.agent ?? {
    cmd: process.env.CLAUDE_BIN || 'claude',
    args: ({ model }) => [
      '-p', '--output-format', 'stream-json', '--verbose', '--model', model,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ...AGENT_ALLOWED,
      '--disallowedTools', ...AGENT_DENIED,
      '--setting-sources', 'project,local', '--strict-mcp-config',
      '--max-budget-usd', String(deps.maxUsdPerBuild ?? 15),
      '--append-system-prompt', BUILDER_SYSTEM,
      '--json-schema', JSON.stringify(RESULT_SCHEMA),
    ],
  };
  let active: { build: Build; lines: string[]; child: ChildProcess | null; cancelled: boolean } | null = null;
  let pumping = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const git = async (cwd: string, ...args: string[]) => {
    const out = await run('git', args, { cwd, timeoutMs: 120_000 });
    if (out.code !== 0) throw new Error(`git ${args.join(' ')}: ${(out.stderr || out.stdout).trim().slice(0, 400)}`);
    return out.stdout.trim();
  };
  const gitOk = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd, timeoutMs: 120_000 })).code === 0;

  function update(id: number, patch: Partial<Build>) {
    const b = repo.updateBuild(id, patch)!;
    if (active?.build.id === id) active.build = b;
    deps.emit({ type: 'build', build: b });
    return b;
  }

  function log(id: number, wtLogFile: string | null, lines: string[]) {
    if (!lines.length) return;
    if (active?.build.id === id) {
      active.lines.push(...lines);
      if (active.lines.length > ACTIVE_LOG) active.lines.splice(0, active.lines.length - ACTIVE_LOG);
    }
    if (wtLogFile) appendFileSync(wtLogFile, lines.map((l) => `[${now()}] ${l}`).join('\n') + '\n');
    deps.emit({ type: 'buildLog', id, lines });
  }

  /**
   * Ignore node_modules and data in every worktree, symlinks included (".gitignore"'s
   * "node_modules/" only matches directories), so not even the agent's own `git add -A` takes them.
   */
  async function excludeForbidden() {
    const common = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const file = join(common, 'info', 'exclude');
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { /* none yet */ }
    const missing = FORBIDDEN.map((f) => `/${f}`).filter((l) => !text.split('\n').includes(l));
    if (!missing.length) return;
    mkdirSync(join(common, 'info'), { recursive: true });
    appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}# idea-generator builder: never commit these from a build\n${missing.join('\n')}\n`);
  }

  function nextSeq() {
    const fromJournal = journalEntries(root).map((j) => j.seq);
    const fromDb = repo.listBuilds(1000).map((b) => b.seq ?? 0);
    return Math.max(0, ...fromJournal, ...fromDb) + 1;
  }

  /** Run the coding agent, stream its events into the log, resolve with its final result event. */
  function runAgent(b: Build, wt: string, prompt: string, model: string, files: { transcript: string; log: string }) {
    return new Promise<{ result: any; timedOut: boolean; exit: number | null; stderr: string }>((resolve, reject) => {
      const wtPaths = [wt, realpathSync(wt)]; // the agent may report either (macOS: /var → /private/var)
      const child = spawn(agent.cmd, agent.args({ model }), { cwd: wt, env: worktreeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      if (active) active.child = child;
      let buf = '', stderr = '', result: any = null, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, deps.agentTimeoutMs ?? 60 * 60_000);
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          appendFileSync(files.transcript, line + '\n');
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) update(b.id, { sessionId: ev.session_id });
          if (ev.type === 'result') result = ev;
          log(b.id, files.log, describeEvent(ev, wtPaths));
        }
      });
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (exit) => { clearTimeout(timer); if (active) active.child = null; resolve({ result, timedOut, exit, stderr }); });
      child.stdin.on('error', () => {});
      child.stdin.end(prompt);
    });
  }

  /** Boot the worktree's server on a free port and wait for / and /api/boards to answer. */
  async function bootCheck(wt: string, dbFile: string) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/index.ts'], { cwd: wt, env: worktreeEnv({ PORT: String(port), HOST: '127.0.0.1', DB_FILE: dbFile }), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    try {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (child.exitCode != null) break;
        try {
          const [a, b] = await Promise.all([fetch(`http://127.0.0.1:${port}/`), fetch(`http://127.0.0.1:${port}/api/boards`)]);
          if (a.ok && b.ok) return { ok: true, output };
        } catch {
          /* not listening yet */
        }
      }
      return { ok: false, output: output.slice(-1500) };
    } finally {
      child.kill('SIGTERM');
    }
  }

  /** Write build.json for one build and regenerate journal/INDEX.md from all of them (in `dir`, a working tree). */
  function writeJournalMeta(dir: string, b: Build, extra: Record<string, unknown> = {}) {
    const jdir = join(dir, b.journalDir!);
    mkdirSync(jdir, { recursive: true });
    const idea = b.ideaId ? repo.getIdea(b.ideaId) : null;
    let before: Record<string, unknown> = {};
    try { before = JSON.parse(readFileSync(join(jdir, 'build.json'), 'utf8')); } catch { /* first write */ }
    writeFileSync(join(jdir, 'build.json'), JSON.stringify({
      ...before,
      seq: b.seq, title: b.title, pitch: b.pitch, status: b.status, trigger: b.trigger, branch: b.branch, commit: b.commit,
      summary: b.summary, error: b.error, costUsd: Math.round(b.costUsd * 100) / 100, sessionId: b.sessionId,
      createdAt: b.createdAt, startedAt: b.startedAt, finishedAt: b.finishedAt,
      jury: idea && scoreSum(idea) != null ? { originality: idea.originality, feasibility: idea.feasibility, impact: idea.impact, reason: idea.reason } : null,
      lineage: b.ideaId ? repo.lineage(b.ideaId).map((l) => ({ kind: l.kind, title: l.title, pitch: l.pitch })) : (before.lineage ?? []),
      ...extra,
    }, null, 2) + '\n');
    const rows = journalEntries(dir);
    const icon: Record<string, string> = { merged: '✅', ready: '🟡', failed: '❌', declined: '🚫', interrupted: '⏸', cancelled: '⏹' };
    writeFileSync(join(dir, 'journal', 'INDEX.md'), [
      '# Build journal',
      '',
      'Every gold idea from the self-improvement board, as Claude Code built it (or did not). Newest last. Each folder has the agent\'s own write-up, screenshots and a build.json with the verdict, lineage, cost and timings.',
      '',
      '| # | Idea | Result | Summary |',
      '|---|------|--------|---------|',
      ...rows.map((r) => `| ${pad(r.seq)} | [${r.title.replace(/\|/g, '/')}](${r.dir}/README.md) | ${icon[r.status] ?? ''} ${r.status} | ${(r.summary ?? '').replace(/\s+/g, ' ').replace(/\|/g, '/').slice(0, 200)} |`),
      '',
    ].join('\n'));
  }

  /** Commit the build's journal folder and the index in the main working tree, touching nothing else. */
  async function commitJournal(b: Build, message: string) {
    const paths = [b.journalDir!, 'journal/INDEX.md'];
    await git(root, 'add', '--', ...paths);
    if (!(await gitOk(root, 'diff', '--cached', '--quiet', '--', ...paths))) {
      await git(root, 'commit', '-q', '-m', message, '--', ...paths);
    }
  }

  function ensureReadme(dir: string, b: Build) {
    if (existsSync(join(dir, b.journalDir!, 'README.md'))) return;
    mkdirSync(join(dir, b.journalDir!), { recursive: true });
    writeFileSync(join(dir, b.journalDir!, 'README.md'), [
      `# ${pad(b.seq!)} · ${b.title}`, '', `> ${b.pitch}`, '', `**Result: ${b.status}.** ${b.error ?? ''}`.trim(), '',
      b.summary ? `${b.summary}\n` : '', '*The agent wrote no journal entry; the builder wrote this one.*', '',
    ].join('\n'));
  }

  /**
   * Settle a build. journal: copy the agent's journal folder into main (unless it
   * arrived by merge), write build.json and the index, commit just those paths.
   */
  async function finish(b: Build, wt: string | null, status: Build['status'], patch: Partial<Build> = {}, o: { journal?: boolean; extra?: Record<string, unknown> } = {}) {
    let done = update(b.id, { ...patch, status, phase: null, finishedAt: now() });
    try {
      if (o.journal !== false && b.journalDir) {
        if (status !== 'merged' && wt && existsSync(join(wt, b.journalDir))) {
          cpSync(join(wt, b.journalDir), join(root, b.journalDir), { recursive: true });
        }
        ensureReadme(root, done);
        writeJournalMeta(root, done, o.extra);
        await commitJournal(done, `Journal: build ${pad(b.seq!)} ${status}`);
      }
    } catch (e: any) {
      done = update(b.id, { error: [done.error, `journal: ${e?.message ?? e}`].filter(Boolean).join(' · ') });
    }
    if (wt) {
      await gitOk(root, 'worktree', 'remove', '--force', wt);
      rmSync(wt, { recursive: true, force: true });
      await gitOk(root, 'worktree', 'prune');
    }
    return done;
  }

  async function runBuild(queued: Build) {
    const seq = nextSeq();
    const slug = slugify(queued.title).slice(0, 40).replace(/-+$/, '');
    const name = `${pad(seq)}-${slug}`;
    const branch = `build/${name}`;
    const jdir = `journal/${name}`;
    const wt = join(root, 'data', 'worktrees', name);
    const files = { transcript: join(root, 'data', 'builds', name, 'transcript.jsonl'), log: join(root, 'data', 'builds', name, 'log.txt') };
    mkdirSync(join(root, 'data', 'builds', name), { recursive: true });
    let b = update(queued.id, { seq, branch, journalDir: jdir, status: 'running', phase: 'preparing', startedAt: now(), error: null });
    active = { build: b, lines: [], child: null, cancelled: false };
    const say = (...lines: string[]) => log(b.id, files.log, lines);
    let created = false;
    try {
      // ---- 1. worktree
      say(`🌱 Build ${pad(seq)}: ${b.title}`, `git worktree on ${branch}`);
      const base = await git(root, 'rev-parse', mainBranch);
      mkdirSync(join(root, 'data', 'worktrees'), { recursive: true });
      await git(root, 'worktree', 'add', '-q', '-b', branch, wt, base);
      created = true;
      await excludeForbidden();
      if (existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(wt, 'node_modules'), 'dir');
      mkdirSync(join(wt, 'data'), { recursive: true });
      repo.snapshot(join(wt, 'data', 'ideas.db'));
      mkdirSync(join(wt, jdir), { recursive: true });

      // ---- 2. the agent
      const idea = b.ideaId ? repo.getIdea(b.ideaId) : null;
      const board = b.boardId ? repo.getBoard(b.boardId) : null;
      const model = board?.config.buildModel || 'opus';
      const lineage = b.ideaId ? repo.lineage(b.ideaId).filter((l) => l.id !== b.ideaId).map((l) => ({ title: l.title, pitch: l.pitch })) : [];
      b = update(b.id, { phase: 'building' });
      say(`🤖 handing it to Claude Code (${model})`);
      if (active.cancelled) return await finish(b, wt, 'cancelled', { error: 'Cancelled by hand' });
      const prompt = buildPrompt({ build: b, idea, goal: board?.goal ?? '', lineage, boardId: b.boardId, seq, jdir, branch });
      const r = await runAgent(b, wt, prompt, model, files);
      if (active.cancelled) return await finish(b, wt, 'cancelled', { error: 'Cancelled by hand' });
      const out = r.result?.structured_output ?? {};
      b = update(b.id, { costUsd: Number(r.result?.total_cost_usd) || 0, summary: String(out.summary ?? r.result?.result ?? '').trim().slice(0, 2000) || null });
      if (r.timedOut) return await finish(b, wt, 'failed', { error: 'The agent timed out' });
      if (!r.result || r.result.is_error) {
        return await finish(b, wt, 'failed', { error: `The agent failed: ${String(r.result?.result ?? r.result?.subtype ?? r.stderr ?? `exit ${r.exit}`).trim().slice(0, 500)}` });
      }
      if (out.status === 'declined') {
        say(`🚫 declined: ${b.summary ?? ''}`);
        return await finish(b, wt, 'declined', {}, { extra: { filmLine: out.filmLine } });
      }

      // ---- 3. verify it ourselves
      b = update(b.id, { phase: 'verifying' });
      if (await git(wt, 'status', '--porcelain')) {
        say('📦 committing what the agent left uncommitted');
        await git(wt, 'add', '-A');
        await git(wt, 'commit', '-q', '-m', `Build ${pad(seq)}: uncommitted changes from the agent`);
      }
      // Build 0001 merged its node_modules symlink into main and took the live server down. Never again.
      const touched = (await git(wt, 'diff', '--name-only', `${base}..HEAD`)).split('\n').filter(Boolean);
      const bad = touched.filter((f) => FORBIDDEN.some((x) => f === x || f.startsWith(x + '/')));
      if (bad.length) return await finish(b, wt, 'failed', { error: `The branch touches files a build must never commit: ${bad.slice(0, 5).join(', ')}` });
      if (Number(await git(wt, 'rev-list', '--count', `${base}..HEAD`)) === 0) return await finish(b, wt, 'failed', { error: 'The agent committed no changes' });
      const head = await git(root, 'rev-parse', mainBranch);
      if (head !== base) {
        say(`🔀 main moved during the build; merging it into ${branch}`);
        if (!(await gitOk(wt, 'merge', '-q', '--no-edit', mainBranch))) {
          await gitOk(wt, 'merge', '--abort');
          return await finish(b, wt, 'failed', { error: 'Conflicts with changes that reached main during the build' });
        }
      }
      say('🧪 npm test (run by the builder, not the agent)');
      const t = await run('npm', ['test'], { cwd: wt, env: worktreeEnv(), timeoutMs: deps.testTimeoutMs ?? 10 * 60_000 });
      const testTail = (t.stdout + t.stderr).trim().split('\n').slice(-12).join('\n');
      b = update(b.id, { tests: testTail });
      if (t.code !== 0) { say('❌ tests failed', ...testTail.split('\n').slice(-6)); return await finish(b, wt, 'failed', { error: t.timedOut ? 'Tests timed out' : 'Tests failed' }); }
      say(`✅ ${testTail.split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join(' · ') || 'tests pass'}`);
      say('🚀 boot check: starting the new server from the worktree');
      const bootDb = join(wt, 'data', 'boot.db');
      repo.snapshot(bootDb);
      const boot = await bootCheck(wt, bootDb);
      if (!boot.ok) { say('❌ the server did not come up', ...boot.output.split('\n').slice(-6)); return await finish(b, wt, 'failed', { error: `Boot check failed: ${boot.output.slice(-300)}` }); }
      if (!existsSync(join(wt, jdir, 'README.md'))) say('⚠ the agent wrote no journal README; the builder writes a stub');
      const extra = { filmLine: out.filmLine, tests: testTail };

      // ---- 4. merge into the live app
      if (deps.merge === false) return await finish(b, wt, 'ready', { error: 'Auto-merge is off: merge the branch by hand' }, { extra });
      if ((await git(root, 'rev-parse', '--abbrev-ref', 'HEAD')) !== mainBranch) {
        return await finish(b, wt, 'ready', { error: `The app's repository is not on ${mainBranch}: merge ${branch} by hand` }, { extra });
      }
      // The journal rides along with the merge: under `npm run dev` the merge restarts
      // the server at once, so nothing that matters may come after it.
      b = update(b.id, { phase: 'merging' });
      ensureReadme(wt, b);
      writeJournalMeta(wt, { ...b, status: 'merged', finishedAt: now() }, extra);
      await git(wt, 'add', '--', jdir, 'journal/INDEX.md');
      if (!(await gitOk(wt, 'diff', '--cached', '--quiet'))) await git(wt, 'commit', '-q', '-m', `Journal: build ${pad(seq)}`);
      say(`🔀 merging ${branch} into ${mainBranch}`);
      if (!(await gitOk(root, 'merge', '-q', '--no-ff', '-m', `Build ${pad(seq)}: ${b.title}\n\n${b.summary ?? ''}`.trim(), branch))) {
        await gitOk(root, 'merge', '--abort');
        return await finish(b, wt, 'ready', { error: `Could not merge into ${mainBranch} (uncommitted changes in the way?): merge ${branch} by hand` }, { extra });
      }
      const commit = await git(root, 'rev-parse', 'HEAD');
      say(`🎉 merged as ${commit.slice(0, 7)}; the app reloads with it`);
      const merged = await finish(b, wt, 'merged', { commit }, { journal: false });
      if (deps.push) {
        const p = await run('git', ['push', '-q', 'origin', mainBranch], { cwd: root, timeoutMs: 120_000 });
        say(p.code === 0 ? `⬆ pushed ${mainBranch}` : `⚠ push failed: ${p.stderr.trim().slice(0, 200)}`);
      }
      return merged;
    } catch (e: any) {
      say(`❌ ${e?.message ?? e}`);
      return await finish(b, created ? wt : null, 'failed', { error: String(e?.message ?? e).slice(0, 800) });
    } finally {
      active = null;
    }
  }

  async function pump() {
    if (pumping || active) return;
    pumping = true;
    try {
      let next: Build | undefined;
      while (!active && (next = repo.buildsWithStatus('queued')[0])) await runBuild(next);
    } finally {
      pumping = false;
    }
  }
  const kick = () => { pump().catch((e) => console.error('[builder]', e)); };

  return {
    /** Queue a build for an idea. The jury's builds respect the board's daily cap; a hand-started one does not. */
    enqueue(ideaId: number, trigger: 'jury' | 'hand'): { build: Build | null; reason?: string } {
      const idea = repo.getIdea(ideaId);
      if (!idea) return { build: null, reason: 'not_found' };
      const board = repo.getBoard(idea.boardId);
      if (!board?.config.selfImprove) return { build: null, reason: 'not_self_improve' };
      const last = repo.latestBuildFor(ideaId);
      if (last && (['queued', 'running', 'merged', 'ready'].includes(last.status) || trigger === 'jury')) return { build: last, reason: 'exists' };
      if (trigger === 'jury' && repo.juryBuildsToday(board.id) >= board.config.buildsPerDay) return { build: null, reason: 'daily_cap' };
      const build = repo.createBuild({ ideaId, boardId: board.id, title: idea.title, pitch: idea.pitch, trigger });
      deps.emit({ type: 'build', build });
      kick();
      return { build };
    },
    cancel(id: number) {
      const b = repo.getBuild(id);
      if (!b) return null;
      if (b.status === 'queued') return update(id, { status: 'cancelled', finishedAt: now() });
      if (active?.build.id === id) {
        active.cancelled = true;
        active.child?.kill('SIGTERM');
      }
      return repo.getBuild(id);
    },
    list: (limit = 100) => repo.listBuilds(limit),
    get: (id: number) => repo.getBuild(id),
    active: () => (active ? { build: active.build, lines: active.lines.slice(-80) } : null),
    /** Saved log of a build (also after it finished). */
    logOf(id: number, max = 400) {
      const b = repo.getBuild(id);
      if (!b?.seq) return [];
      if (active?.build.id === id) return active.lines.slice(-max);
      const f = join(root, 'data', 'builds', `${pad(b.seq)}-${slugify(b.title).slice(0, 40).replace(/-+$/, '')}`, 'log.txt');
      try { return readFileSync(f, 'utf8').trim().split('\n').slice(-max); } catch { return []; }
    },
    /** After a restart: settle builds that were cut off, then carry on with the queue. */
    async recover() {
      for (const b of repo.buildsWithStatus('running')) {
        const merged = b.branch && b.phase === 'merging' && (await gitOk(root, 'merge-base', '--is-ancestor', b.branch, mainBranch));
        const wt = b.seq ? join(root, 'data', 'worktrees', `${pad(b.seq)}-${slugify(b.title).slice(0, 40).replace(/-+$/, '')}`) : null;
        if (merged) await finish(b, wt, 'merged', { commit: await git(root, 'rev-parse', mainBranch) });
        else await finish(b, wt && existsSync(wt) ? wt : null, 'interrupted', { error: 'The server restarted during the build' });
      }
      await gitOk(root, 'worktree', 'prune');
    },
    start() {
      this.recover().catch((e) => console.error('[builder] recover', e)).finally(kick);
      timer ??= setInterval(kick, 30_000);
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      active?.child?.kill('SIGTERM');
    },
    idle: async () => { while (active || pumping || repo.buildsWithStatus('queued').length) await new Promise((r) => setTimeout(r, 50)); },
  };
}

export type Builder = ReturnType<typeof createBuilder>;
