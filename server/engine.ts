// The engine: every operation on boards and ideas, used by both the HTTP routes
// and the autopilot. New ideas are judged in the background (a small queue),
// so announced guests get judged even on boards nobody has open. Every change
// is published on a per-board bus that the browser follows over SSE.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Repo, Idea, Board } from './db.ts';
import { makeLLM } from './llm.ts';
import { asUrl, fetchPage as realFetchPage } from './extract.ts';
import { fetchPapers as realFetchPapers, researchLeads, xLeads } from './leads.ts';
import { writeBrief, writeProject } from './project.ts';
import { ProviderError, type AppSettings, type ChatFn, type Role } from './providers.ts';
import { fitness, isJudged, medal, scoreSum, onMedalEdge, goldGate } from '../public/js/score.js';
import { nextMove, assignArm, liftStats, armOf, controlDue } from '../public/js/evolve.js';

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type BoardEvent = { type: string; [k: string]: unknown };
export function createBus() {
  const subs = new Map<number, Set<(e: BoardEvent) => void>>();
  return {
    on(boardId: number, fn: (e: BoardEvent) => void) {
      if (!subs.has(boardId)) subs.set(boardId, new Set());
      subs.get(boardId)!.add(fn);
      return () => subs.get(boardId)?.delete(fn);
    },
    emit(boardId: number, e: BoardEvent) {
      for (const fn of subs.get(boardId) ?? []) {
        try {
          fn(e);
        } catch {
          /* a dead subscriber must not break the others */
        }
      }
    },
    /** To every open board (the builder's progress is news wherever you are). */
    emitAll(e: BoardEvent) {
      for (const id of subs.keys()) this.emit(id, e);
    },
  };
}

/** Arc of n children pointing away from where the parent came from. */
export function arcPositions(parent: Idea, grandparent: Idea | null, n: number) {
  const dir = grandparent ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x) : Math.random() * Math.PI * 2;
  const spread = grandparent ? (Math.PI * 2) / 3 : Math.PI * 2;
  return Array.from({ length: n }, (_, i) => {
    const a = grandparent ? dir - spread / 2 + (spread * (i + 0.5)) / n : dir + (spread * i) / n;
    return { x: parent.x + Math.cos(a) * 190, y: parent.y + Math.sin(a) * 190 };
  });
}

/** Where a newcomer (guest, lead) lands: just right of what is already on the board. */
function besideBoard(ideas: Idea[]) {
  if (!ideas.length) return { x: 0, y: 0 };
  const maxX = Math.max(...ideas.map((i) => i.x));
  const meanY = ideas.reduce((s, i) => s + i.y, 0) / ideas.length;
  return { x: maxX + 240, y: meanY + (Math.random() - 0.5) * 160 };
}

type Deps = {
  repo: Repo;
  chat: ChatFn;
  settings: () => AppSettings;
  fetchPage?: typeof realFetchPage;
  fetchPapers?: typeof realFetchPapers;
  reveal?: (path: string) => void;
  gitInit?: boolean;
  /** Self-improvement boards: called when an idea gets gold, from the jury or by hand (the builder queues it). */
  onGold?: (idea: Idea, by: 'jury' | 'hand') => void;
  /** Self-improvement boards: what the app is and does today, added to every prompt. */
  selfContext?: () => string;
  /** Placebo trials: the lot that sends a recipe breed to the placebo arm (tests fix it). */
  trialRng?: () => number;
};

export function createEngine(deps: Deps) {
  const { repo } = deps;
  const fetchPage = deps.fetchPage ?? realFetchPage;
  const fetchPapers = deps.fetchPapers ?? realFetchPapers;
  const reveal = deps.reveal ?? ((p: string) => execFile('open', [p], () => {}));
  const llm = makeLLM(deps.chat);
  const trialRng = deps.trialRng ?? Math.random;
  const bus = createBus();
  const judging = new Set<number>();

  const mustBoard = (id: number) => {
    const b = repo.getBoard(id);
    if (!b) throw new AppError(404, 'not_found', 'Board not found');
    return b;
  };
  const mustIdea = (id: number) => {
    const i = repo.getIdea(id);
    if (!i) throw new AppError(404, 'not_found', 'Idea not found');
    return i;
  };
  const modelFor = (board: Board, role: Role) => board.config.models[role] || deps.settings().models[role];
  // On a self-improvement board the ideas are changes to this app, so every
  // prompt (and the jury) gets to know the app as it is right now.
  const selfCtx = (board: Board) => (board.config.selfImprove && deps.selfContext ? deps.selfContext() : '');
  // The board's language wins over the source ideas' on self-improvement boards: one
  // Swedish slip would otherwise breed a Swedish lineage, and the code and journal follow the board.
  const ctxOf = (board: Board) => ({ goal: board.goal, fixedLang: board.config.selfImprove ? board.config.lang : undefined });
  const flowFor = (board: Board) => {
    const ctx = selfCtx(board);
    return ctx ? { ...board.config.flow, system: `${board.config.flow.system}\n\n${ctx}` } : board.config.flow;
  };
  const guidanceFor = (board: Board) => [board.config.judgeGuidance, selfCtx(board)].filter((x) => x.trim()).join('\n\n');
  const titles = (boardId: number) => repo.listIdeas(boardId).map((i) => i.title);
  const emitIdeas = (boardId: number, ideas: Idea[]) => ideas.length && bus.emit(boardId, { type: 'ideas', ideas });

  /** Every LLM call: spend lands on the board's ledger; failures become 502s that keep the provider's code. */
  async function call<T extends { costUsd: number }>(boardId: number, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      repo.addSpend(boardId, out.costUsd);
      return out;
    } catch (e: any) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, e instanceof ProviderError ? e.code : 'llm_failed', e?.message ?? String(e));
    }
  }

  // ---------------------------------------------------------------- judging

  function setJudging(boardId: number, ids: number[], on: boolean) {
    for (const id of ids) on ? judging.add(id) : judging.delete(id);
    bus.emit(boardId, { type: 'judging', ids, on });
  }

  async function createProject(idea: Idea) {
    if (idea.projectPath && existsSync(idea.projectPath)) return { idea, path: idea.projectPath, existed: true };
    const board = mustBoard(idea.boardId);
    const lineage = repo.lineage(idea.id);
    const lang = board.config.lang;
    const { brief } = await call(board.id, () => writeBrief({ chat: deps.chat, model: modelFor(board, 'brief'), idea, goal: board.goal, lineage, lang }));
    let path: string;
    try {
      path = await writeProject({ root: deps.settings().projectsRoot, brief, idea, goal: board.goal, lineage, lang, gitInit: deps.gitInit });
    } catch (e: any) {
      throw new AppError(500, 'project_failed', e?.message ?? String(e));
    }
    const saved = repo.setProjectPath(idea.id, path)!;
    emitIdeas(board.id, [saved]);
    return { idea: saved, path, existed: false };
  }

  async function judge(ideaId: number) {
    const idea = mustIdea(ideaId);
    const board = mustBoard(idea.boardId);
    setJudging(board.id, [idea.id], true);
    try {
      const { judgement } = await call(board.id, () =>
        llm.judge({
          model: modelFor(board, 'judge'), board: ctxOf(board), idea, lang: board.config.lang,
          guidance: guidanceFor(board), vocabulary: repo.keywordVocabulary(),
        }),
      );
      repo.saveJudgement(idea.id, judgement);
      const out: { idea: Idea; project?: string; projectError?: string } = { idea: repo.setKeywords(idea.id, judgement.keywords)! };
      // Gold on a self-improvement board goes to the builder, which builds it into this app.
      if (board.config.selfImprove && medal(out.idea) === 3) {
        // A gold on the edge (exactly 13) waits for the blind second judge; retrial() builds it if both agree.
        if (!autoRetrial(board, out.idea)) deps.onGold?.(out.idea, 'jury');
      } else if (board.config.autoProjectOnGold && medal(out.idea) === 3 && !out.idea.projectPath) {
        // The judge itself turns gold into a Claude Code project, if the board allows it.
        try {
          const p = await createProject(out.idea);
          out.idea = p.idea;
          out.project = p.path;
          bus.emit(board.id, { type: 'project', ideaId: idea.id, path: p.path, byJudge: true });
        } catch (e: any) {
          out.projectError = e?.message ?? String(e);
        }
      }
      emitIdeas(board.id, [out.idea]);
      // A verdict one point from another medal gets a blind second opinion, in the background.
      if (autoRetrial(board, out.idea)) queueRetrial(out.idea.id);
      return out;
    } finally {
      setJudging(board.id, [idea.id], false);
    }
  }

  // ---------------------------------------------------------------- second opinion

  /**
   * On self-improvement boards (where a verdict decides what gets built), a
   * jury score exactly on a medal threshold is re-scored by a second judge on
   * another model. It runs the same judge prompt and never sees the first
   * verdict, so it is blind. If both roles use the same model it is skipped:
   * the point is a second view, not the same view twice.
   */
  const autoRetrial = (board: Board, idea: Idea) =>
    board.config.selfImprove && onMedalEdge(idea) && modelFor(board, 'retrial') !== modelFor(board, 'judge');

  const retrying = new Set<number>();
  const retrials = new Set<Promise<unknown>>();
  function queueRetrial(id: number) {
    if (retrying.has(id)) return;
    const p = retrial(id)
      .catch((e: any) => {
        const boardId = repo.getIdea(id)?.boardId;
        if (boardId) bus.emit(boardId, { type: 'error', code: e?.code ?? 'retrial_failed', message: e?.message ?? String(e), ideaId: id });
      })
      .finally(() => retrials.delete(p));
    retrials.add(p);
  }

  async function retrial(ideaId: number) {
    const idea = mustIdea(ideaId);
    if (!isJudged(idea)) throw new AppError(400, 'not_judged', 'The jury has not judged this idea yet');
    if (retrying.has(idea.id)) throw new AppError(409, 'busy', 'A second opinion is already on its way');
    const board = mustBoard(idea.boardId);
    const model = modelFor(board, 'retrial');
    const verdict = (i: Idea | null | undefined) => (i ? [i.judgedAt, i.originality, i.feasibility, i.impact, i.reason].join('|') : '');
    const judgedAt = verdict(idea);
    retrying.add(idea.id);
    bus.emit(board.id, { type: 'retrying', ids: [idea.id], on: true });
    try {
      const { judgement: j } = await call(board.id, () =>
        llm.judge({
          model, board: ctxOf(board), idea, lang: board.config.lang,
          guidance: guidanceFor(board), vocabulary: repo.keywordVocabulary(),
        }),
      );
      // The jury re-judged meanwhile: this opinion is about scores that no longer exist.
      if (verdict(repo.getIdea(idea.id)) !== judgedAt) return { idea: repo.getIdea(idea.id)!, stale: true };
      const saved = repo.saveRetrial(idea.id, {
        originality: j.originality, feasibility: j.feasibility, impact: j.impact, reason: j.reason, model, at: new Date().toISOString(),
      })!;
      emitIdeas(board.id, [saved]);
      // A held gold: both judges say gold, so it is built; otherwise it is contested and waits for a human.
      if (board.config.selfImprove) {
        const gate = goldGate(saved);
        if (gate === 'agreed') deps.onGold?.(saved, 'jury');
        else if (gate === 'contested') bus.emit(board.id, { type: 'contested', ideaId: saved.id, title: saved.title, first: scoreSum(saved), second: j.originality + j.feasibility + j.impact });
      }
      return { idea: saved };
    } finally {
      retrying.delete(idea.id);
      bus.emit(board.id, { type: 'retrying', ids: [idea.id], on: false });
    }
  }

  // Background queue: at most three judgements at once.
  const queue: number[] = [];
  let active = 0;
  let idleWaiters: (() => void)[] = [];
  function pump() {
    while (active < 3 && queue.length) {
      const id = queue.shift()!;
      active++;
      judge(id)
        .catch((e: any) => {
          const boardId = repo.getIdea(id)?.boardId;
          if (boardId) bus.emit(boardId, { type: 'error', code: e?.code ?? 'judge_failed', message: e?.message ?? String(e), ideaId: id });
        })
        .finally(() => {
          active--;
          pump();
          if (!active && !queue.length) {
            idleWaiters.forEach((f) => f());
            idleWaiters = [];
          }
        });
    }
  }
  function queueJudge(ids: number[]) {
    for (const id of ids) if (!judging.has(id) && !queue.includes(id)) queue.push(id);
    pump();
  }
  /** Resolves when no judgement or second opinion is queued or running (tests, shutdown). */
  const idle = async (): Promise<void> => {
    while (active || queue.length || retrials.size) {
      if (active || queue.length) await new Promise<void>((r) => idleWaiters.push(r));
      else await Promise.all([...retrials]);
    }
  };

  // ---------------------------------------------------------------- creating ideas

  async function doExpand(parentId: number, escape: string | null = null) {
    const parent = mustIdea(parentId);
    const board = mustBoard(parent.boardId);
    // The parent's lift recipe becomes the children's task (or, by lot, the placebo), and they remember it so the hit can be counted.
    const task = assignArm([parent], liftStats(repo.listIdeas(board.id)), trialRng);
    const { ideas } = await call(board.id, () =>
      llm.expand({ model: modelFor(board, 'expand'), flow: flowFor(board), board: ctxOf(board), idea: parent, existingTitles: titles(board.id), lang: board.config.lang, task }),
    );
    const spots = arcPositions(parent, repo.parentsOf(parent.id)[0] ?? null, ideas.length);
    const lift = task ? { type: task.type, from: parent.id, base: task.base, arm: task.arm } : null;
    const created = ideas.map((i, n) =>
      repo.insertIdea({ boardId: board.id, ...i, kind: 'expand', x: spots[n].x, y: spots[n].y, generation: parent.generation + 1, lift, escape }, [parent.id]),
    );
    const edges = created.map((c) => ({ from: parent.id, to: c.id }));
    emitIdeas(board.id, created);
    bus.emit(board.id, { type: 'edges', edges });
    return { ideas: created, edges };
  }

  /** `forced`: a task chosen by the caller instead of assignArm's (the autopilot's control sibling). */
  async function doCombine(boardId: number, aId: number, bId: number, escape: string | null = null, forced: ReturnType<typeof assignArm> = null) {
    const board = mustBoard(boardId);
    if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId === bId) throw new AppError(400, 'bad_pair', 'Pick two different ideas');
    const a = mustIdea(aId);
    const c = mustIdea(bId);
    if (a.boardId !== board.id || c.boardId !== board.id) throw new AppError(400, 'bad_pair', 'Ideas belong to another board');
    // Of the two parents' recipes, the type that has lifted medals more often on this board (or, by lot, the placebo).
    const task = forced ?? assignArm([a, c], liftStats(repo.listIdeas(board.id)), trialRng);
    const { idea } = await call(board.id, () =>
      llm.combine({ model: modelFor(board, 'combine'), flow: flowFor(board), board: ctxOf(board), a, b: c, existingTitles: titles(board.id), lang: board.config.lang, task }),
    );
    const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy) || 1; // midpoint, nudged off the line
    const created = repo.insertIdea(
      {
        boardId: board.id, ...idea, kind: 'combine',
        x: (a.x + c.x) / 2 + (-dy / len) * 70, y: (a.y + c.y) / 2 + (dx / len) * 70,
        generation: Math.max(a.generation, c.generation) + 1,
        lift: task ? { type: task.type, from: task.from.id, base: task.base, arm: task.arm } : null,
        escape,
      },
      [a.id, c.id],
    );
    const edges = [{ from: a.id, to: created.id }, { from: c.id, to: created.id }];
    emitIdeas(board.id, [created]);
    bus.emit(board.id, { type: 'edges', edges });
    return { idea: created, edges };
  }

  return {
    bus,
    judging,
    idle,
    queueJudge,
    modelFor,

    async seed(boardId: number, b: { text: string; x?: number; y?: number }) {
      const board = mustBoard(boardId);
      const text = String(b.text ?? '').trim().slice(0, 20_000);
      if (!text) throw new AppError(400, 'empty', 'Write an idea or paste a link');
      const lang = board.config.lang;
      const flow = flowFor(board);
      const url = asUrl(text);
      let title = text.slice(0, 120);
      let pitch = '';
      let sourceUrl: string | null = null;
      if (url) {
        let page;
        try {
          page = await fetchPage(url);
        } catch (e: any) {
          throw new AppError(422, 'url_unreadable', `${url}: ${e?.message ?? e}`);
        }
        if (page.text.length < 80) throw new AppError(422, 'url_no_text', `${url}: too little readable text`);
        const { idea } = await call(board.id, () =>
          llm.distill({ model: modelFor(board, 'distill'), flow, board: ctxOf(board), text: [page.title, page.text].filter(Boolean).join('\n\n'), url, lang }),
        );
        ({ title, pitch } = idea);
        sourceUrl = url;
      } else if (text.length > 120) { // longer than a title: distill it, never cut it off
        const { idea } = await call(board.id, () => llm.distill({ model: modelFor(board, 'distill'), flow, board: ctxOf(board), text, lang }));
        ({ title, pitch } = idea);
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const idea = repo.insertIdea({ boardId: board.id, title, pitch, kind: 'seed', sourceUrl, x: num(b.x), y: num(b.y), generation: 0 });
      emitIdeas(board.id, [idea]);
      queueJudge([idea.id]);
      return { idea };
    },

    async expand(ideaId: number) {
      const out = await doExpand(ideaId);
      queueJudge(out.ideas.map((i) => i.id));
      return out;
    },

    async combine(boardId: number, aId: number, bId: number) {
      const out = await doCombine(boardId, aId, bId);
      queueJudge([out.idea.id]);
      return out;
    },

    judge,
    retrying,
    /** A second opinion by hand (any judged idea, any board): awaited, unlike the automatic one. */
    retrial,
    createProject: (ideaId: number) => createProject(mustIdea(ideaId)),

    reveal(ideaId: number) {
      const idea = mustIdea(ideaId);
      if (!idea.projectPath || !existsSync(idea.projectPath)) throw new AppError(404, 'no_project', 'The project folder is gone');
      reveal(idea.projectPath);
      return { ok: true };
    },

    setMedal(ideaId: number, m: unknown) {
      mustIdea(ideaId);
      if (m !== null && !(Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 3)) {
        throw new AppError(400, 'bad_request', 'medalOverride is 0–3 or null');
      }
      const idea = repo.setMedalOverride(ideaId, m as number | null)!;
      emitIdeas(idea.boardId, [idea]);
      // A person handing out gold on a self-improvement board is a request to build it.
      if (m === 3 && repo.getBoard(idea.boardId)?.config.selfImprove) deps.onGold?.(idea, 'hand');
      return { idea };
    },

    deleteIdea(ideaId: number) {
      const idea = repo.getIdea(ideaId);
      const ok = repo.deleteIdea(ideaId);
      if (idea) bus.emit(idea.boardId, { type: 'removed', ids: [ideaId] });
      return { ok };
    },

    /** Announce an idea to other boards: each gets a guest copy that can cross-breed there. */
    announce(ideaId: number, boardIds: unknown) {
      const idea = mustIdea(ideaId);
      const isGuest = idea.kind === 'guest' && idea.originIdeaId;
      const originIdeaId = isGuest ? idea.originIdeaId! : idea.id;
      const originBoardId = isGuest ? idea.originBoardId : idea.boardId;
      const wanted: number[] =
        boardIds === 'all' ? repo.listBoards().map((x) => x.id) : (Array.isArray(boardIds) ? boardIds : []).filter(Number.isInteger);
      const guests: { boardId: number; idea: Idea }[] = [];
      const skipped: number[] = [];
      for (const boardId of [...new Set(wanted)]) {
        if (boardId === idea.boardId) continue;
        if (!repo.getBoard(boardId) || repo.hasGuest(boardId, originIdeaId)) {
          skipped.push(boardId);
          continue;
        }
        const at = besideBoard(repo.listIdeas(boardId));
        const guest = repo.insertIdea({
          boardId, title: idea.title, pitch: idea.pitch, kind: 'guest', sourceUrl: idea.sourceUrl,
          x: at.x, y: at.y, generation: 0, originIdeaId, originBoardId,
        });
        guests.push({ boardId, idea: guest });
        emitIdeas(boardId, [guest]);
      }
      // Judged against each target board's own goal, not the one it came from.
      queueJudge(guests.map((g) => g.idea.id));
      return { guests, skipped };
    },

    /** Spin an idea off into its own board, to refine it in its own context. */
    spinoff(ideaId: number) {
      const idea = mustIdea(ideaId);
      const parent = mustBoard(idea.boardId);
      const goal = (idea.pitch ? `${idea.title}: ${idea.pitch}` : idea.title).slice(0, 600);
      const board = repo.createBoard({ title: idea.title.slice(0, 120), goal, config: { ...parent.config, mode: 'manual' }, originIdeaId: idea.id });
      const root = repo.insertIdea({
        boardId: board.id, title: idea.title, pitch: idea.pitch, kind: 'seed', sourceUrl: idea.sourceUrl,
        x: 0, y: 0, generation: 0, originIdeaId: idea.id, originBoardId: idea.boardId,
      });
      bus.emit(parent.id, { type: 'spinoff', ideaId: idea.id, boardId: board.id, title: board.title });
      queueJudge([root.id]);
      return { board: repo.getBoard(board.id), idea: root };
    },

    updateBoard(boardId: number, patch: { title?: string; goal?: string; config?: unknown }) {
      mustBoard(boardId);
      const board = repo.updateBoard(boardId, patch)!;
      bus.emit(boardId, { type: 'board', board });
      return { board };
    },

    async summarize(boardId: number) {
      const board = mustBoard(boardId);
      const ideas = repo
        .listIdeas(board.id)
        .sort((x, y) => (fitness(y) ?? -1) - (fitness(x) ?? -1))
        .map((i) => ({ title: i.title, pitch: i.pitch, kind: i.kind, sum: scoreSum(i), reason: i.reason }));
      if (ideas.length < 2) throw new AppError(400, 'too_few', 'A summary needs at least two ideas');
      const lang = board.config.lang;
      const { summary } = await call(board.id, () => llm.summarize({ model: modelFor(board, 'summary'), board, ideas, lang }));
      const saved = repo.setSummary(board.id, { ...summary, ideaCount: ideas.length, lang, createdAt: new Date().toISOString() })!;
      bus.emit(board.id, { type: 'board', board: saved });
      return { board: saved };
    },

    /** The report's conclusions across every board, saved so the window opens instantly. */
    async synthesize(days: number, lang: 'sv' | 'en') {
      const report = repo.report(days);
      const boards = report.boards.filter((b) => b.ideaCount);
      if (!boards.length) throw new AppError(400, 'too_few', 'There are no ideas to report on yet');
      const { synthesis } = await call(0, () =>
        llm.synthesize({
          model: deps.settings().models.summary, lang, days,
          boards: boards.map((b) => ({
            title: b.title, goal: b.goal, summary: b.summary?.headline ?? '',
            best: b.best.map((i) => ({ title: i.title, pitch: i.pitch, sum: i.sum })),
            projects: b.projects.map((p) => p.title),
          })),
        }),
      );
      repo.saveSynthesis(days, lang, synthesis);
      return repo.report(days);
    },

    // ---- leads: each board's own researchers
    async refreshLeads(boardId: number, source: 'x' | 'research') {
      const board = mustBoard(boardId);
      const lang = board.config.lang;
      const focus = board.config.researchers[source].focus;
      const topic = [board.goal, focus].filter(Boolean).join(' — ');
      let r: { leads: any[]; dropped?: number };
      if (source === 'x') {
        r = await call(board.id, () => xLeads({ chat: deps.chat, model: modelFor(board, 'x'), goal: topic, lang }));
      } else {
        let papers;
        try {
          papers = await fetchPapers(focus || board.goal);
        } catch (e: any) {
          throw new AppError(502, 'research_failed', e?.message ?? String(e));
        }
        r = await call(board.id, () => researchLeads({ chat: deps.chat, model: modelFor(board, 'research'), goal: topic, lang, papers }));
      }
      // Nothing verified: keep the old leads rather than wiping the panel.
      const leads = r.leads.length ? repo.replaceLeads(board.id, source, r.leads) : repo.listLeads(board.id).filter((l) => l.source === source);
      bus.emit(board.id, { type: 'leads', source, leads });
      return { leads, dropped: r.dropped ?? 0, empty: !r.leads.length };
    },

    seedLead(leadId: number, at: { x?: number; y?: number }) {
      const lead = repo.getLead(leadId);
      if (!lead) throw new AppError(404, 'not_found', 'Lead not found');
      const pos = Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x!, y: at.y! } : besideBoard(repo.listIdeas(lead.boardId));
      const idea = repo.insertIdea({
        boardId: lead.boardId, title: lead.title, pitch: [lead.summary, lead.hook].filter(Boolean).join(' ').slice(0, 600),
        kind: 'seed', sourceUrl: lead.url, x: pos.x, y: pos.y, generation: 0,
      });
      const used = repo.markLeadUsed(lead.id, idea.id)!;
      emitIdeas(lead.boardId, [idea]);
      bus.emit(lead.boardId, { type: 'leads', source: lead.source, leads: repo.listLeads(lead.boardId).filter((l) => l.source === lead.source) });
      queueJudge([idea.id]);
      return { idea, lead: used };
    },

    /**
     * One autopilot step: judge what is unjudged, otherwise breed (combine by
     * tournament selection) or mutate (expand a strong idea). Awaits its own
     * judgements so the next step sees the scores. In a keyword monoculture
     * (diversity() in evolve.js) one parent comes from outside it, and the
     * children store the escaped keyword in `escape`.
     */
    async autoStep(boardId: number): Promise<{ did: 'idle' | 'judge' | 'expand' | 'combine'; reason?: string; ids?: number[] }> {
      mustBoard(boardId);
      const ideas = repo.listIdeas(boardId);
      if (!ideas.length) return { did: 'idle', reason: 'empty' };
      const judgeAll = async (ids: number[]) => {
        const results = await Promise.allSettled(ids.map((id) => judge(id)));
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
      };
      const unjudged = ideas.filter((i) => !isJudged(i) && i.medalOverride == null && !judging.has(i.id)).slice(0, 3);
      if (unjudged.length) {
        await judgeAll(unjudged.map((i) => i.id));
        return { did: 'judge', ids: unjudged.map((i) => i.id) };
      }
      const move = nextMove(ideas, repo.listEdges(boardId), { busy: judging });
      if (!move) return { did: 'idle', reason: 'nothing_to_do' };
      if (move.type === 'expand') {
        const r = await doExpand(move.idea.id, move.escape ?? null);
        await judgeAll(r.ideas.map((i) => i.id));
        return { did: 'expand', ids: r.ideas.map((i) => i.id) };
      }
      const r = await doCombine(boardId, move.a.id, move.b.id, move.escape ?? null);
      const ids = [r.idea.id];
      // Every CONTROL_EVERY-th recipe cross gets a control sibling: the same parents, no task,
      // the withheld recipe type and the same base, so netLiftStats() can subtract chance.
      const recipeCrosses = repo.listIdeas(boardId).filter((i) => i.kind === 'combine' && armOf(i) === 'recipe').length;
      if (armOf(r.idea) === 'recipe' && controlDue(recipeCrosses)) {
        const from = mustIdea(r.idea.liftFrom!);
        const control = { arm: 'control', type: r.idea.liftType, change: null, from, base: r.idea.liftBase! };
        const sib = await doCombine(boardId, move.a.id, move.b.id, move.escape ?? null, control);
        ids.push(sib.idea.id);
      }
      await judgeAll(ids);
      return { did: 'combine', ids };
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
