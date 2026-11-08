// SQLite through Node's built-in node:sqlite. No ORM, no dependencies.
//
// Every board is self-contained: its goal, its own creation flow (prompts),
// its jury guidance, its researchers, its autopilot pace. Templates only seed
// a new board's flow; editing a board never changes another board.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  expand TEXT NOT NULL,
  combine TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  origin_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('seed', 'expand', 'combine', 'guest')),
  source_url TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  originality INTEGER,
  feasibility INTEGER,
  impact INTEGER,
  reason TEXT,
  judged_at TEXT,
  medal_override INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  project_path TEXT,
  origin_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  origin_board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL,
  recipe_type TEXT,
  recipe TEXT,
  lift_type TEXT,
  lift_from INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  lift_base INTEGER,
  lift_arm TEXT,
  escape_kw TEXT,
  retrial TEXT,
  lift_applied INTEGER,
  lift_check TEXT,
  duel TEXT,
  style TEXT,
  plain TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ideas_board ON ideas(board_id);
CREATE UNIQUE INDEX IF NOT EXISTS ideas_guest_once ON ideas(board_id, origin_idea_id) WHERE origin_idea_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS edges (
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('x', 'research')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  url TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS leads_board ON leads(board_id);
-- Keywords come from the judge, in one canonical form, so trends can be counted across boards.
CREATE TABLE IF NOT EXISTS idea_keywords (
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  PRIMARY KEY (idea_id, keyword)
);
CREATE INDEX IF NOT EXISTS idea_keywords_kw ON idea_keywords(keyword);
-- Saved cross-board syntheses for the report window (latest one is shown).
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  days INTEGER NOT NULL,
  lang TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Spend ledger per board and local calendar day; the rate limiter reads it.
-- board_id 0 = spend that belongs to no board.
CREATE TABLE IF NOT EXISTS spend (
  board_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, day)
);
-- Self-improvement: gold ideas that Claude Code builds into this app's own code.
-- seq is the journal number (journal/0001-slug/), stable even if the DB is reset.
CREATE TABLE IF NOT EXISTS builds (
  id INTEGER PRIMARY KEY,
  idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  board_id INTEGER,
  seq INTEGER,
  title TEXT NOT NULL,
  pitch TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT,
  trigger TEXT NOT NULL DEFAULT 'jury',
  branch TEXT,
  commit_sha TEXT,
  journal_dir TEXT,
  summary TEXT,
  error TEXT,
  tests TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS builds_idea ON builds(idea_id);
`;

// Templates for a board's creation flow. The prompts are in English; the
// output language is decided per request (same language as the seed).
export const DEFAULT_TEMPLATES = [
  {
    name: 'Uppfinnaren · Inventor',
    system:
      'You are a brilliant, practical inventor. You think in mechanisms: what exactly happens, for whom, and why it works. You avoid buzzwords.',
    expand:
      'Generate 3 new ideas that grow out of the concept. Make them clearly different from each other: one close variation that sharpens it, one that borrows a mechanism from a completely different field, and one bold leap.',
    combine:
      'Fuse the two ideas into ONE new concept that neither could be alone. Name the specific mechanism that connects them; do not just list both.',
  },
  {
    name: 'Affärsstrategen · Business',
    system:
      'You are a sharp business strategist who has built and sold companies. You care about who pays, why now, and what makes it hard to copy.',
    expand:
      'Generate 3 ideas for products, services or business models that grow out of the concept. Each must say who the customer is and how money is made, and they must differ from each other.',
    combine:
      "Merge the two ideas into ONE business concept where each part strengthens the other's business model. State who pays and why.",
  },
  {
    name: 'Omställaren · Sustainability',
    system:
      'You are a systems thinker working on sustainability and local communities. You favour solutions that cut resource use and that ordinary people and municipalities can start with today.',
    expand:
      'Generate 3 ideas that grow out of the concept and make it more sustainable socially, ecologically or economically. Make them differ in scale: household, organisation, and region.',
    combine:
      'Combine the two ideas into ONE solution where the sustainability gain of one multiplies the other. Be concrete about what changes.',
  },
  {
    name: 'Självförbättraren · Self-improver',
    system:
      'You are a product engineer and the lead developer of Idea Generator 2, the very app you are running inside. You improve it as an idea generator: better ideas, sharper judging, smarter evolution, clearer insight for the people watching. You think in concrete changes to its code that a coding agent can build and verify in one session.',
    expand:
      'Generate 3 improvements to the app that grow out of this one. Make them differ: one that sharpens it into the smallest buildable change, one that borrows a mechanism from another field (evolutionary biology, editing, games, science), and one bolder change to how the app generates or judges ideas. Each must name what changes in the app and how a user would see it.',
    combine:
      'Fuse the two improvements into ONE change to the app where each part makes the other work better. Name the concrete mechanism and what the user sees; it must still be buildable in one session.',
  },
  {
    name: 'Galningen · Wild card',
    system:
      'You are a playful, fearless provocateur. You turn assumptions upside down and find the idea nobody dares say out loud, but every idea must still be explainable in two sentences and possible to actually try.',
    expand:
      'Generate 3 surprising, unconventional ideas that grow out of the concept. Each must break at least one obvious assumption.',
    combine:
      'Crash the two ideas together into ONE unexpected concept. The stranger the connection the better, as long as it can actually be done.',
  },
];

export type Flow = { system: string; expand: string; combine: string };
const MODEL_ROLES = ['distill', 'expand', 'combine', 'judge', 'summary', 'research', 'x', 'brief', 'retrial'] as const;

export type BoardConfig = {
  flowName: string;
  flow: Flow;
  judgeGuidance: string;
  researchers: { x: { enabled: boolean; focus: string }; research: { enabled: boolean; focus: string } };
  /** Fallback language for generated text ('sv' | 'en'); ideas otherwise follow their seed's language. */
  lang: 'sv' | 'en';
  /** manual: people drive. auto: the server evolves the board on its own, within the limits below. */
  mode: 'manual' | 'auto';
  /** Seconds between autopilot steps (pace). */
  autopilotSeconds: number;
  rate: { stepsPerHour: number; usdPerDay: number };
  autoProjectOnGold: boolean;
  /** Wording gap (build 0011): after each verdict the judge model rewrites the idea in plain wording and the jury prompt rescores the rewrite, blind. Measured, never used. */
  wordingGap: boolean;
  /**
   * Self-improvement: ideas on this board are changes to this app. Prompts get
   * the app's current feature list, and gold ideas go to the Claude Code
   * builder (server/builder.ts) instead of becoming project folders.
   */
  selfImprove: boolean;
  /** Most builds the jury may start per local day on this board (hand-started builds are not counted). */
  buildsPerDay: number;
  /** Claude Code model for the builder: an alias (opus, sonnet) or a full ID. */
  buildModel: string;
  /** Per-role model overrides ("provider:model"); empty = the app-wide setting. */
  models: Partial<Record<(typeof MODEL_ROLES)[number], string>>;
  /**
   * Codebase board: ideas are improvements to the code in this folder. `context`
   * (the scan and the analysis) goes into every prompt and the jury; gold ideas
   * are appended to `goldFile`. null on ordinary boards.
   */
  repo: RepoConfig | null;
};
export type RepoConfig = { path: string; name: string; summary: string; stack: string; focus: string[]; context: string; goldFile: string; testCommand: string | null };

/** A codebase board's settings from untrusted input; null unless it has an absolute path. */
export function cleanRepoConfig(raw: any, base: RepoConfig | null): RepoConfig | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') return base;
  const s = (v: unknown, max: number, fb = '') => (typeof v === 'string' ? v.trim().slice(0, max) : fb);
  const path = s(raw.path, 1000, base?.path ?? '');
  if (!path.startsWith('/')) return base;
  const goldFile = s(raw.goldFile, 1000, base?.goldFile ?? '');
  return {
    path,
    name: s(raw.name, 120, base?.name ?? '') || path.split('/').pop() || 'code',
    summary: s(raw.summary, 1000, base?.summary ?? ''),
    stack: s(raw.stack, 300, base?.stack ?? ''),
    focus: Array.isArray(raw.focus) ? raw.focus.map((f: unknown) => s(f, 200)).filter(Boolean).slice(0, 8) : base?.focus ?? [],
    context: s(raw.context, 16_000, base?.context ?? ''),
    goldFile: goldFile.startsWith('/') ? goldFile : base?.goldFile ?? '',
    testCommand: typeof raw.testCommand === 'string' ? s(raw.testCommand, 200) || null : base?.testCommand ?? null,
  };
}

export function defaultConfig(template = DEFAULT_TEMPLATES[0]): BoardConfig {
  return {
    flowName: template.name,
    flow: { system: template.system, expand: template.expand, combine: template.combine },
    judgeGuidance: '',
    researchers: { x: { enabled: true, focus: '' }, research: { enabled: true, focus: '' } },
    lang: 'sv',
    mode: 'manual',
    autopilotSeconds: 10,
    rate: { stepsPerHour: 60, usdPerDay: 1 },
    autoProjectOnGold: true,
    wordingGap: false,
    selfImprove: false,
    buildsPerDay: 4,
    buildModel: 'opus',
    models: {},
    repo: null,
  };
}

/** Merge an untrusted partial config onto a valid one, keeping only well-typed values. */
export function mergeConfig(base: BoardConfig, raw: any): BoardConfig {
  const s = (v: unknown, max: number, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
  const nonEmpty = (v: unknown, max: number, fallback: string) => s(v, max, fallback) || fallback;
  const b = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const r = raw && typeof raw === 'object' ? raw : {};
  const rx = r.researchers?.x ?? {};
  const rr = r.researchers?.research ?? {};
  const secs = Number(r.autopilotSeconds);
  const sph = Number(r.rate?.stepsPerHour);
  const usd = Number(r.rate?.usdPerDay);
  const models: BoardConfig['models'] = { ...base.models };
  for (const role of MODEL_ROLES) {
    if (typeof r.models?.[role] === 'string') {
      const v = r.models[role].trim().slice(0, 200);
      if (v) models[role] = v;
      else delete models[role];
    }
  }
  return {
    flowName: nonEmpty(r.flowName, 80, base.flowName),
    flow: {
      system: nonEmpty(r.flow?.system, 4000, base.flow.system),
      expand: nonEmpty(r.flow?.expand, 4000, base.flow.expand),
      combine: nonEmpty(r.flow?.combine, 4000, base.flow.combine),
    },
    judgeGuidance: s(r.judgeGuidance, 4000, base.judgeGuidance),
    researchers: {
      x: { enabled: b(rx.enabled, base.researchers.x.enabled), focus: s(rx.focus, 300, base.researchers.x.focus) },
      research: {
        enabled: b(rr.enabled, base.researchers.research.enabled),
        focus: s(rr.focus, 300, base.researchers.research.focus),
      },
    },
    lang: r.lang === 'en' || r.lang === 'sv' ? r.lang : base.lang,
    mode: r.mode === 'auto' || r.mode === 'manual' ? r.mode : base.mode,
    autopilotSeconds: Number.isFinite(secs) ? Math.min(3600, Math.max(3, Math.round(secs))) : base.autopilotSeconds,
    rate: {
      stepsPerHour: Number.isFinite(sph) ? Math.min(3600, Math.max(1, Math.round(sph))) : base.rate.stepsPerHour,
      usdPerDay: Number.isFinite(usd) ? Math.min(1000, Math.max(0, Math.round(usd * 100) / 100)) : base.rate.usdPerDay,
    },
    autoProjectOnGold: b(r.autoProjectOnGold, base.autoProjectOnGold),
    wordingGap: b(r.wordingGap, base.wordingGap),
    selfImprove: b(r.selfImprove, base.selfImprove),
    buildsPerDay: Number.isFinite(Number(r.buildsPerDay)) && r.buildsPerDay !== null && r.buildsPerDay !== ''
      ? Math.min(50, Math.max(0, Math.round(Number(r.buildsPerDay)))) : base.buildsPerDay,
    buildModel: /^[a-z0-9.\-\[\]]{2,60}$/i.test(String(r.buildModel ?? '').trim()) ? String(r.buildModel).trim() : base.buildModel,
    models,
    repo: 'repo' in r ? cleanRepoConfig(r.repo, base.repo ?? null) : base.repo ?? null,
  };
}

export type Idea = {
  id: number;
  boardId: number;
  title: string;
  pitch: string;
  kind: 'seed' | 'expand' | 'combine' | 'guest';
  sourceUrl: string | null;
  x: number;
  y: number;
  originality: number | null;
  feasibility: number | null;
  impact: number | null;
  reason: string | null;
  judgedAt: string | null;
  medalOverride: number | null;
  generation: number;
  projectPath: string | null;
  originIdeaId: number | null;
  originBoardId: number | null;
  originBoardTitle: string | null;
  keywords: string[];
  /** The jury's lift recipe for this idea: the criterion it raises, and the change. */
  recipeType: string | null;
  recipe: string | null;
  /** Bred under a parent's lift recipe: its type, the parent, and the parent's medal (0–3) at the time. */
  liftType: string | null;
  liftFrom: number | null;
  liftBase: number | null;
  /** Placebo trials: 'recipe', 'placebo' (a vague "improve it" instead of the recipe; liftType is the withheld type), 'none' (the parent had no recipe; liftType null) or 'control' (the autopilot's no-task sibling of a recipe cross; liftType the withheld type). null: older idea, or not bred toward a medal. */
  liftArm: string | null;
  /** Diversity pressure: the dominant keyword of the monoculture the autopilot bred this idea outside of. null: an ordinary breed. */
  escape: string | null;
  /** A blind second judge's scores (verdicts on a medal edge), on another model. Cleared when the jury re-judges. */
  retrial: Retrial | null;
  /** Recipe check (build 0008): did this recipe child really carry out its parent's recipe? With the checker's one-sentence reason. null: not checked (no recipe task, an older idea, or the check failed). */
  liftApplied: boolean | null;
  liftCheck: string | null;
  /** Blind duel (build 0009): per criterion, did the child or its parent win, read blind in random order? null: no duel (not a recipe child, an older idea, or the duel failed). */
  duel: Duel | null;
  /** Idea style (build 0010): the framing the breed was told to write in (STYLES in evolve.js). null: a seed, guest or older idea. */
  style: string | null;
  /** Wording gap (build 0011): the judge model's plain rewrite of this idea and the jury prompt's blind scores for it. The gap is the jury's sum minus the plain sum (plainGap() in evolve.js). null: not rescored. */
  plain: Plain | null;
  createdAt: string;
};
export type Plain = { title: string; pitch: string; originality: number; feasibility: number; impact: number; reason: string; model: string; at: string };
export type DuelWinner = 'child' | 'parent' | 'tie';
export type Duel = { originality: DuelWinner; feasibility: DuelWinner; impact: DuelWinner; reason: string; childFirst: boolean; model: string; at: string };
export type Retrial = { originality: number; feasibility: number; impact: number; reason: string; model: string; at: string };

export type Board = {
  id: number; title: string; goal: string; config: BoardConfig; createdAt: string; updatedAt: string;
  /** Spin-off boards: the idea this board grew from, and where that idea lives. */
  originIdeaId: number | null; originIdeaTitle: string | null; originBoardId: number | null; originBoardTitle: string | null;
  summary: BoardSummary | null;
};
export type BoardSummary = {
  headline: string;
  themes: { name: string; insight: string; ideas: string[] }[];
  strongest: { title: string; why: string }[];
  gaps: string[];
  nextSteps: string[];
  ideaCount: number;
  lang: string;
  createdAt: string;
};
export type BuildStatus = 'queued' | 'running' | 'merged' | 'ready' | 'failed' | 'declined' | 'interrupted' | 'cancelled';
export type Build = {
  id: number; ideaId: number | null; boardId: number | null; seq: number | null; title: string; pitch: string;
  status: BuildStatus; phase: string | null; trigger: 'jury' | 'hand'; branch: string | null; commit: string | null;
  journalDir: string | null; summary: string | null; error: string | null; tests: string | null; costUsd: number;
  sessionId: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
};
const buildFromRow = (r: any): Build => ({
  id: r.id, ideaId: r.idea_id, boardId: r.board_id, seq: r.seq, title: r.title, pitch: r.pitch, status: r.status, phase: r.phase,
  trigger: r.trigger, branch: r.branch, commit: r.commit_sha, journalDir: r.journal_dir, summary: r.summary, error: r.error,
  tests: r.tests, costUsd: r.cost_usd, sessionId: r.session_id, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
});
const BUILD_COLS: Record<string, string> = {
  seq: 'seq', status: 'status', phase: 'phase', branch: 'branch', commit: 'commit_sha', journalDir: 'journal_dir', summary: 'summary',
  error: 'error', tests: 'tests', costUsd: 'cost_usd', sessionId: 'session_id', startedAt: 'started_at', finishedAt: 'finished_at',
};

export type Template = { id: number; name: string; system: string; expand: string; combine: string; sort: number };
export type Lead = {
  id: number; boardId: number; source: 'x' | 'research'; title: string; summary: string; hook: string;
  url: string | null; meta: Record<string, unknown>; ideaId: number | null; fetchedAt: string;
};

const IDEA_SELECT = `SELECT i.*, ob.title AS origin_board_title,
  (SELECT group_concat(keyword, '|') FROM (SELECT keyword FROM idea_keywords k WHERE k.idea_id = i.id ORDER BY keyword)) AS keywords
  FROM ideas i LEFT JOIN boards ob ON ob.id = i.origin_board_id`;

const ideaFromRow = (r: any): Idea => ({
  id: r.id,
  boardId: r.board_id,
  title: r.title,
  pitch: r.pitch,
  kind: r.kind,
  sourceUrl: r.source_url,
  x: r.x,
  y: r.y,
  originality: r.originality,
  feasibility: r.feasibility,
  impact: r.impact,
  reason: r.reason,
  judgedAt: r.judged_at,
  medalOverride: r.medal_override,
  generation: r.generation,
  projectPath: r.project_path,
  originIdeaId: r.origin_idea_id,
  originBoardId: r.origin_board_id,
  originBoardTitle: r.origin_board_title ?? null,
  keywords: r.keywords ? String(r.keywords).split('|') : [],
  recipeType: r.recipe_type ?? null,
  recipe: r.recipe ?? null,
  liftType: r.lift_type ?? null,
  liftFrom: r.lift_from ?? null,
  liftBase: r.lift_base ?? null,
  liftArm: r.lift_arm ?? null,
  escape: r.escape_kw ?? null,
  retrial: r.retrial ? parseJson(r.retrial) : null,
  liftApplied: r.lift_applied == null ? null : !!r.lift_applied,
  liftCheck: r.lift_check ?? null,
  duel: r.duel ? parseJson(r.duel) : null,
  style: r.style ?? null,
  plain: r.plain ? parseJson(r.plain) : null,
  createdAt: r.created_at,
});

const parseJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};

const BOARD_SELECT = `SELECT b.*, oi.title AS origin_idea_title, oi.board_id AS origin_board_id, ob.title AS origin_board_title
  FROM boards b LEFT JOIN ideas oi ON oi.id = b.origin_idea_id LEFT JOIN boards ob ON ob.id = oi.board_id`;

const boardFromRow = (r: any): Board => ({
  id: r.id,
  title: r.title,
  goal: r.goal,
  config: mergeConfig(defaultConfig(), parseJson(r.config)),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  originIdeaId: r.origin_idea_id ?? null,
  originIdeaTitle: r.origin_idea_title ?? null,
  originBoardId: r.origin_board_id ?? null,
  originBoardTitle: r.origin_board_title ?? null,
  summary: r.summary ? parseJson(r.summary) : null,
});

const leadFromRow = (r: any): Lead => ({
  id: r.id,
  boardId: r.board_id,
  source: r.source,
  title: r.title,
  summary: r.summary,
  hook: r.hook,
  url: r.url,
  meta: parseJson(r.meta),
  ideaId: r.idea_id,
  fetchedAt: r.fetched_at,
});

export function openDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Databases from before lift recipes: add the columns (SQLite has no ADD COLUMN IF NOT EXISTS).
  const ideaCols = new Set((db.prepare('PRAGMA table_info(ideas)').all() as any[]).map((c) => c.name));
  for (const [name, type] of [['recipe_type', 'TEXT'], ['recipe', 'TEXT'], ['lift_type', 'TEXT'], ['lift_from', 'INTEGER'], ['lift_base', 'INTEGER'], ['retrial', 'TEXT'], ['lift_arm', 'TEXT'], ['escape_kw', 'TEXT'], ['lift_applied', 'INTEGER'], ['lift_check', 'TEXT'], ['duel', 'TEXT'], ['style', 'TEXT'], ['plain', 'TEXT']]) {
    if (!ideaCols.has(name)) db.exec(`ALTER TABLE ideas ADD COLUMN ${name} ${type}`);
  }

  if ((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as any).n === 0) {
    const ins = db.prepare('INSERT INTO templates (name, system, expand, combine, sort) VALUES (?, ?, ?, ?, ?)');
    DEFAULT_TEMPLATES.forEach((t, i) => ins.run(t.name, t.system, t.expand, t.combine, i));
  } else {
    // Databases from before the self-improvement loop get its template too.
    const self = DEFAULT_TEMPLATES.find((t) => t.name.startsWith('Självförbättraren'))!;
    if (!db.prepare('SELECT 1 FROM templates WHERE name = ?').get(self.name)) {
      db.prepare('INSERT INTO templates (name, system, expand, combine, sort) VALUES (?, ?, ?, ?, ?)').run(self.name, self.system, self.expand, self.combine, 99);
    }
  }

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };

  const repo = {
    close: () => db.close(),

    // ---- boards
    listBoards() {
      return db
        .prepare(
          `SELECT * FROM (${BOARD_SELECT}) b2 ORDER BY b2.updated_at DESC, b2.id DESC`,
        )
        .all()
        .map((r: any) => ({
          ...boardFromRow(r),
          ideaCount: (db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE board_id = ?').get(r.id) as any).n,
        }));
    },
    getBoard(id: number): Board | null {
      const r = db.prepare(`${BOARD_SELECT} WHERE b.id = ?`).get(id);
      return r ? boardFromRow(r) : null;
    },
    createBoard(b: { title: string; goal?: string; templateId?: number | null; config?: unknown; originIdeaId?: number | null }): Board {
      const template = repo.getTemplate(b.templateId ?? null);
      const config = mergeConfig(defaultConfig(template), b.config);
      const { lastInsertRowid } = db
        .prepare('INSERT INTO boards (title, goal, config, origin_idea_id) VALUES (?, ?, ?, ?)')
        .run(b.title, b.goal ?? '', JSON.stringify(config), b.originIdeaId ?? null);
      return repo.getBoard(Number(lastInsertRowid))!;
    },
    updateBoard(id: number, patch: { title?: string; goal?: string; config?: unknown }) {
      const cur = repo.getBoard(id);
      if (!cur) return null;
      const config = patch.config === undefined ? cur.config : mergeConfig(cur.config, patch.config);
      db.prepare(`UPDATE boards SET title = ?, goal = ?, config = ?, updated_at = datetime('now') WHERE id = ?`).run(
        patch.title ?? cur.title,
        patch.goal ?? cur.goal,
        JSON.stringify(config),
        id,
      );
      return repo.getBoard(id);
    },
    setSummary(id: number, summary: BoardSummary) {
      db.prepare('UPDATE boards SET summary = ? WHERE id = ?').run(JSON.stringify(summary), id);
      return repo.getBoard(id);
    },
    touchBoard(id: number) {
      db.prepare(`UPDATE boards SET updated_at = datetime('now') WHERE id = ?`).run(id);
    },
    /** Boards spun off from ideas on this board: idea id → [{boardId, title}]. */
    spinoffs(boardId: number) {
      return db
        .prepare('SELECT b.id AS board_id, b.title, b.origin_idea_id FROM boards b JOIN ideas i ON i.id = b.origin_idea_id WHERE i.board_id = ? ORDER BY b.id')
        .all(boardId)
        .map((r: any) => ({ ideaId: r.origin_idea_id, boardId: r.board_id, title: r.title }));
    },
    deleteBoard(id: number) {
      return db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0;
    },

    // ---- ideas
    listIdeas(boardId: number): Idea[] {
      return db.prepare(`${IDEA_SELECT} WHERE i.board_id = ? ORDER BY i.id`).all(boardId).map(ideaFromRow);
    },
    getIdea(id: number): Idea | null {
      const r = db.prepare(`${IDEA_SELECT} WHERE i.id = ?`).get(id);
      return r ? ideaFromRow(r) : null;
    },
    /** Insert an idea and the edges from its parents in one transaction. */
    insertIdea(
      i: {
        boardId: number; title: string; pitch: string; kind: Idea['kind']; sourceUrl?: string | null;
        x: number; y: number; generation: number; originIdeaId?: number | null; originBoardId?: number | null;
        lift?: { type: string | null; from: number; base: number; arm?: string } | null;
        escape?: string | null;
        style?: string | null;
      },
      parentIds: number[] = [],
    ): Idea {
      return tx(() => {
        const { lastInsertRowid } = db
          .prepare(
            `INSERT INTO ideas (board_id, title, pitch, kind, source_url, x, y, generation, origin_idea_id, origin_board_id, lift_type, lift_from, lift_base, lift_arm, escape_kw, style)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            i.boardId, i.title, i.pitch, i.kind, i.sourceUrl ?? null, i.x, i.y, i.generation, i.originIdeaId ?? null, i.originBoardId ?? null,
            i.lift?.type ?? null, i.lift?.from ?? null, i.lift?.base ?? null, i.lift?.arm ?? null, i.escape ?? null, i.style ?? null,
          );
        const id = Number(lastInsertRowid);
        const edge = db.prepare('INSERT OR IGNORE INTO edges (board_id, from_id, to_id) VALUES (?, ?, ?)');
        for (const p of parentIds) edge.run(i.boardId, p, id);
        repo.touchBoard(i.boardId);
        return repo.getIdea(id)!;
      });
    },
    /** Is this original already a guest on that board? */
    hasGuest(boardId: number, originIdeaId: number) {
      return !!db.prepare('SELECT 1 FROM ideas WHERE board_id = ? AND (origin_idea_id = ? OR id = ?)').get(boardId, originIdeaId, originIdeaId);
    },
    saveJudgement(id: number, j: { originality: number; feasibility: number; impact: number; reason: string; liftType?: string | null; lift?: string | null }) {
      db.prepare(
        // A new verdict makes the old second opinion meaningless: it was about other scores.
        `UPDATE ideas SET originality = ?, feasibility = ?, impact = ?, reason = ?, recipe_type = ?, recipe = ?, retrial = NULL, judged_at = datetime('now') WHERE id = ?`,
      ).run(j.originality, j.feasibility, j.impact, j.reason, j.liftType ?? null, j.lift ?? null, id);
      return repo.getIdea(id);
    },
    /** The recipe check's ruling: did this child carry out its parent's recipe? */
    saveLiftCheck(id: number, c: { applied: boolean; reason: string }) {
      db.prepare('UPDATE ideas SET lift_applied = ?, lift_check = ? WHERE id = ?').run(c.applied ? 1 : 0, c.reason, id);
      return repo.getIdea(id);
    },
    /** The blind duel's per-criterion winners between this child and its parent. */
    saveDuel(id: number, d: Duel) {
      db.prepare('UPDATE ideas SET duel = ? WHERE id = ?').run(JSON.stringify(d), id);
      return repo.getIdea(id);
    },
    /** Wording gap: the plain rewrite and its blind rescore. Kept on a re-judge: the text it rewrote has not changed. */
    savePlain(id: number, p: Plain) {
      db.prepare('UPDATE ideas SET plain = ? WHERE id = ?').run(JSON.stringify(p), id);
      return repo.getIdea(id);
    },
    saveRetrial(id: number, r: Retrial) {
      db.prepare('UPDATE ideas SET retrial = ? WHERE id = ?').run(JSON.stringify(r), id);
      return repo.getIdea(id);
    },
    setKeywords(id: number, keywords: string[]) {
      tx(() => {
        db.prepare('DELETE FROM idea_keywords WHERE idea_id = ?').run(id);
        const ins = db.prepare('INSERT OR IGNORE INTO idea_keywords (idea_id, keyword) VALUES (?, ?)');
        for (const k of keywords) ins.run(id, k);
      });
      return repo.getIdea(id);
    },
    /** The keywords in use, most common first, so the judge can reuse them. */
    keywordVocabulary(limit = 80): string[] {
      return db
        .prepare('SELECT keyword, COUNT(*) AS n FROM idea_keywords GROUP BY keyword ORDER BY n DESC, keyword LIMIT ?')
        .all(limit)
        .map((r: any) => r.keyword);
    },
    /**
     * Keyword trends across all boards. Per keyword: how many ideas, on how many
     * boards, mean jury sum, ideas in the last `days` vs the `days` before, and
     * a per-day count series for the last `days`.
     */
    dashboard(days = 30, limit = 40) {
      const since = `-${days} days`;
      const before = `-${days * 2} days`;
      const rows = db
        .prepare(
          `SELECT k.keyword,
             COUNT(*) AS count,
             COUNT(DISTINCT i.board_id) AS boards,
             AVG(i.originality + i.feasibility + i.impact) AS mean_sum,
             SUM(i.created_at >= datetime('now', ?)) AS recent,
             SUM(i.created_at < datetime('now', ?) AND i.created_at >= datetime('now', ?)) AS previous
           FROM idea_keywords k JOIN ideas i ON i.id = k.idea_id
           GROUP BY k.keyword
           ORDER BY recent DESC, count DESC, k.keyword
           LIMIT ?`,
        )
        .all(since, since, before, limit) as any[];
      const seriesRows = db
        .prepare(
          `SELECT k.keyword, substr(i.created_at, 1, 10) AS day, COUNT(*) AS n
           FROM idea_keywords k JOIN ideas i ON i.id = k.idea_id
           WHERE i.created_at >= datetime('now', ?)
           GROUP BY k.keyword, day`,
        )
        .all(since) as any[];
      const dayList: string[] = [];
      for (let d = days - 1; d >= 0; d--) dayList.push(new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10));
      const series = new Map<string, number[]>();
      for (const r of seriesRows) {
        if (!series.has(r.keyword)) series.set(r.keyword, dayList.map(() => 0));
        const at = dayList.indexOf(r.day);
        if (at >= 0) series.get(r.keyword)![at] = r.n;
      }
      const boards = db
        .prepare(
          `SELECT b.id, b.title, k.keyword, COUNT(*) AS n
           FROM boards b JOIN ideas i ON i.board_id = b.id JOIN idea_keywords k ON k.idea_id = i.id
           GROUP BY b.id, k.keyword ORDER BY b.id, n DESC, k.keyword`,
        )
        .all() as any[];
      const perBoard = new Map<number, { id: number; title: string; keywords: { keyword: string; count: number }[] }>();
      for (const r of boards) {
        if (!perBoard.has(r.id)) perBoard.set(r.id, { id: r.id, title: r.title, keywords: [] });
        const pb = perBoard.get(r.id)!;
        if (pb.keywords.length < 6) pb.keywords.push({ keyword: r.keyword, count: r.n });
      }
      const totals = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM ideas) AS ideas, (SELECT COUNT(*) FROM boards) AS boards,
                  (SELECT COUNT(DISTINCT keyword) FROM idea_keywords) AS keywords,
                  (SELECT COUNT(*) FROM ideas WHERE created_at >= datetime('now', ?)) AS recent`,
        )
        .get(since) as any;
      return {
        days: dayList,
        totals,
        keywords: rows.map((r) => ({
          keyword: r.keyword,
          count: r.count,
          boards: r.boards,
          meanSum: r.mean_sum == null ? null : Math.round(r.mean_sum * 10) / 10,
          recent: r.recent,
          previous: r.previous,
          series: series.get(r.keyword) ?? dayList.map(() => 0),
        })),
        boards: [...perBoard.values()],
      };
    },
    ideasWithKeyword(keyword: string, limit = 100) {
      return db
        .prepare(
          `SELECT i.*, b.title AS board_title FROM idea_keywords k JOIN ideas i ON i.id = k.idea_id JOIN boards b ON b.id = i.board_id
           WHERE k.keyword = ? ORDER BY i.id DESC LIMIT ?`,
        )
        .all(keyword, limit)
        .map((r: any) => ({ ...ideaFromRow(r), boardTitle: r.board_title }));
    },
    setMedalOverride(id: number, medal: number | null) {
      db.prepare('UPDATE ideas SET medal_override = ? WHERE id = ?').run(medal, id);
      return repo.getIdea(id);
    },
    setProjectPath(id: number, path: string) {
      db.prepare('UPDATE ideas SET project_path = ? WHERE id = ?').run(path, id);
      return repo.getIdea(id);
    },
    savePositions(boardId: number, positions: { id: number; x: number; y: number }[]) {
      tx(() => {
        const up = db.prepare('UPDATE ideas SET x = ?, y = ? WHERE id = ? AND board_id = ?');
        for (const p of positions) up.run(p.x, p.y, p.id, boardId);
      });
    },
    deleteIdea(id: number) {
      return db.prepare('DELETE FROM ideas WHERE id = ?').run(id).changes > 0;
    },

    // ---- edges and lineage
    listEdges(boardId: number) {
      return db
        .prepare('SELECT from_id, to_id FROM edges WHERE board_id = ? ORDER BY rowid')
        .all(boardId)
        .map((r: any) => ({ from: r.from_id, to: r.to_id }));
    },
    parentsOf(id: number): Idea[] {
      return db
        .prepare(`${IDEA_SELECT} JOIN edges e ON i.id = e.from_id WHERE e.to_id = ? ORDER BY i.id`)
        .all(id)
        .map(ideaFromRow);
    },
    /** Ancestors, nearest first. A guest continues into its original's ancestry on the other board. */
    lineage(id: number, max = 12): Idea[] {
      const out: Idea[] = [];
      const seen = new Set([id]);
      const queue = [id];
      while (queue.length && out.length < max) {
        const cur = repo.getIdea(queue.shift()!);
        if (!cur) continue;
        const next = [...repo.parentsOf(cur.id)];
        if (cur.originIdeaId) {
          const origin = repo.getIdea(cur.originIdeaId);
          if (origin) next.push(origin);
        }
        for (const p of next) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          out.push(p);
          queue.push(p.id);
        }
      }
      return out.slice(0, max);
    },

    // ---- leads
    listLeads(boardId: number): Lead[] {
      return db.prepare('SELECT * FROM leads WHERE board_id = ? ORDER BY source, id').all(boardId).map(leadFromRow);
    },
    getLead(id: number): Lead | null {
      const r = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
      return r ? leadFromRow(r) : null;
    },
    /** A refresh replaces the unused leads of that source; used ones stay as history. */
    replaceLeads(boardId: number, source: Lead['source'], drafts: { title: string; summary: string; hook: string; url: string; meta: object }[]) {
      tx(() => {
        db.prepare('DELETE FROM leads WHERE board_id = ? AND source = ? AND idea_id IS NULL').run(boardId, source);
        const ins = db.prepare('INSERT INTO leads (board_id, source, title, summary, hook, url, meta) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const d of drafts) ins.run(boardId, source, d.title, d.summary, d.hook, d.url, JSON.stringify(d.meta ?? {}));
      });
      return repo.listLeads(boardId).filter((l) => l.source === source);
    },
    markLeadUsed(id: number, ideaId: number) {
      db.prepare('UPDATE leads SET idea_id = ? WHERE id = ?').run(ideaId, id);
      return repo.getLead(id);
    },
    deleteLead(id: number) {
      return db.prepare('DELETE FROM leads WHERE id = ?').run(id).changes > 0;
    },

    // ---- templates
    listTemplates(): Template[] {
      return db.prepare('SELECT * FROM templates ORDER BY sort, id').all() as Template[];
    },
    getTemplate(id: number | null): Template {
      const r = id == null ? null : db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
      return (r ?? db.prepare('SELECT * FROM templates ORDER BY sort, id LIMIT 1').get()) as Template;
    },
    createTemplate(t: Omit<Template, 'id' | 'sort'>): Template {
      const sort = ((db.prepare('SELECT MAX(sort) AS s FROM templates').get() as any).s ?? 0) + 1;
      const { lastInsertRowid } = db
        .prepare('INSERT INTO templates (name, system, expand, combine, sort) VALUES (?, ?, ?, ?, ?)')
        .run(t.name, t.system, t.expand, t.combine, sort);
      return repo.getTemplate(Number(lastInsertRowid));
    },
    updateTemplate(id: number, t: Omit<Template, 'id' | 'sort'>) {
      db.prepare('UPDATE templates SET name = ?, system = ?, expand = ?, combine = ? WHERE id = ?').run(t.name, t.system, t.expand, t.combine, id);
      return repo.getTemplate(id);
    },
    deleteTemplate(id: number) {
      if ((db.prepare('SELECT COUNT(*) AS n FROM templates').get() as any).n <= 1) return false;
      return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
    },

    // ---- report: insights, ideas and projects across all boards
    /**
     * Everything the report window shows for the last `days` days: totals,
     * every Claude Code project, and per board its goal, summary, best ideas.
     */
    report(days = 30) {
      const since = `-${days} days`;
      const boards = repo.listBoards();
      const ideas = (db.prepare(`${IDEA_SELECT} ORDER BY i.id`).all() as any[]).map(ideaFromRow);
      const recentIds = new Set(
        (db.prepare(`SELECT id FROM ideas WHERE created_at >= datetime('now', ?)`).all(since) as any[]).map((r) => r.id),
      );
      const sum = (i: Idea) => (i.originality == null ? null : i.originality + i.feasibility! + i.impact!);
      const medalOf = (i: Idea) => {
        if (i.medalOverride != null) return i.medalOverride;
        const s = sum(i);
        return s == null ? null : s >= 13 ? 3 : s >= 11 ? 2 : s >= 9 ? 1 : 0;
      };
      const rank = (x: Idea, y: Idea) => (sum(y) ?? -1) - (sum(x) ?? -1) || y.id - x.id;
      const brief = (i: Idea) => ({ id: i.id, boardId: i.boardId, title: i.title, pitch: i.pitch, sum: sum(i), medal: medalOf(i), reason: i.reason, kind: i.kind });
      const title = new Map(boards.map((b) => [b.id, b.title]));
      const projects = ideas
        .filter((i) => i.projectPath)
        .map((i) => ({ ...brief(i), boardTitle: title.get(i.boardId) ?? '', path: i.projectPath! }));
      const medals = { gold: 0, silver: 0, bronze: 0 };
      for (const i of ideas) {
        const m = medalOf(i);
        if (m === 3) medals.gold++;
        else if (m === 2) medals.silver++;
        else if (m === 1) medals.bronze++;
      }
      const spent: any = db.prepare(`SELECT SUM(usd) AS usd FROM spend WHERE day >= ?`).get(localDay(new Date(Date.now() - (days - 1) * 86_400_000)));
      const latest: any = db.prepare('SELECT * FROM reports ORDER BY id DESC LIMIT 1').get();
      return {
        days,
        totals: {
          boards: boards.length,
          ideas: ideas.length,
          newIdeas: recentIds.size,
          judged: ideas.filter((i) => i.judgedAt).length,
          medals,
          projects: projects.length,
          spentUsd: Math.round((spent?.usd ?? 0) * 10000) / 10000,
        },
        projects,
        boards: boards.map((b) => {
          const own = ideas.filter((i) => i.boardId === b.id);
          return {
            id: b.id, title: b.title, goal: b.goal, mode: b.config.mode,
            ideaCount: own.length, newIdeas: own.filter((i) => recentIds.has(i.id)).length,
            best: own.filter((i) => sum(i) != null || i.medalOverride != null).sort(rank).slice(0, 3).map(brief),
            summary: b.summary ? { ...b.summary, stale: b.summary.ideaCount !== own.length } : null,
            projects: projects.filter((p) => p.boardId === b.id),
          };
        }),
        synthesis: latest ? { ...parseJson(latest.content), days: latest.days, lang: latest.lang, createdAt: latest.created_at } : null,
      };
    },
    saveSynthesis(days: number, lang: string, content: object) {
      db.prepare('INSERT INTO reports (days, lang, content) VALUES (?, ?, ?)').run(days, lang, JSON.stringify(content));
    },

    // ---- builds (self-improvement)
    createBuild(b: { ideaId: number; boardId: number; title: string; pitch: string; trigger: 'jury' | 'hand' }): Build {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO builds (idea_id, board_id, title, pitch, trigger) VALUES (?, ?, ?, ?, ?)')
        .run(b.ideaId, b.boardId, b.title, b.pitch, b.trigger);
      return repo.getBuild(Number(lastInsertRowid))!;
    },
    getBuild(id: number): Build | null {
      const r = db.prepare('SELECT * FROM builds WHERE id = ?').get(id);
      return r ? buildFromRow(r) : null;
    },
    updateBuild(id: number, patch: Partial<Build>): Build | null {
      const keys = Object.keys(patch).filter((k) => k in BUILD_COLS);
      if (keys.length) {
        db.prepare(`UPDATE builds SET ${keys.map((k) => `${BUILD_COLS[k]} = ?`).join(', ')} WHERE id = ?`)
          .run(...keys.map((k) => (patch as any)[k] ?? null), id);
      }
      return repo.getBuild(id);
    },
    listBuilds(limit = 100): Build[] {
      return db.prepare('SELECT * FROM builds ORDER BY id DESC LIMIT ?').all(limit).map(buildFromRow);
    },
    buildsWithStatus(...statuses: string[]): Build[] {
      return db.prepare(`SELECT * FROM builds WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`).all(...statuses).map(buildFromRow);
    },
    latestBuildFor(ideaId: number): Build | null {
      const r = db.prepare('SELECT * FROM builds WHERE idea_id = ? ORDER BY id DESC LIMIT 1').get(ideaId);
      return r ? buildFromRow(r) : null;
    },
    /** Builds the jury started on a board today (local day): the daily cap counts these. */
    juryBuildsToday(boardId: number, day = localDay()): number {
      const rows = db.prepare("SELECT created_at FROM builds WHERE board_id = ? AND trigger = 'jury'").all(boardId) as any[];
      return rows.filter((r) => localDay(new Date(r.created_at.replace(' ', 'T') + 'Z')) === day).length;
    },
    /** A consistent copy of the whole database (for screenshots and boot checks in a build's worktree). */
    snapshot(path: string) {
      db.prepare('VACUUM INTO ?').run(path);
    },

    // ---- spend ledger (per board, per local day)
    addSpend(boardId: number, usd: number, day = localDay()) {
      db.prepare(
        `INSERT INTO spend (board_id, day, usd, calls) VALUES (?, ?, ?, 1)
         ON CONFLICT(board_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`,
      ).run(boardId, day, usd > 0 ? usd : 0);
    },
    spentOn(boardId: number | null, day = localDay()): number {
      const r: any =
        boardId == null
          ? db.prepare('SELECT SUM(usd) AS usd FROM spend WHERE day = ?').get(day)
          : db.prepare('SELECT usd FROM spend WHERE board_id = ? AND day = ?').get(boardId, day);
      return r?.usd ?? 0;
    },
    spentTotal(): { usd: number; calls: number } {
      const r: any = db.prepare('SELECT SUM(usd) AS usd, SUM(calls) AS calls FROM spend').get();
      return { usd: r?.usd ?? 0, calls: r?.calls ?? 0 };
    },
  };
  return repo;
}

export type Repo = ReturnType<typeof openDb>;

/** YYYY-MM-DD in local time: budgets reset at local midnight. */
export function localDay(d = new Date()) {
  return d.toLocaleDateString('sv-SE');
}
