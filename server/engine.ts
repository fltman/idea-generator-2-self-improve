// The engine: every operation on boards and ideas, used by both the HTTP routes
// and the autopilot. New ideas are judged in the background (a small queue),
// so announced guests get judged even on boards nobody has open. Every change
// is published on a per-board bus that the browser follows over SSE.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Repo, Idea, Board, Scrap } from './db.ts';
import { makeLLM } from './llm.ts';
import { asUrl, fetchPage as realFetchPage } from './extract.ts';
import { fetchPapers as realFetchPapers, researchLeads, xLeads } from './leads.ts';
import { slugify, writeBrief, writeProject } from './project.ts';
import { RepoError, scanRepo, scanText, shortPath } from './reposcan.ts';
import { ProviderError, type AppSettings, type ChatFn, type Role } from './providers.ts';
import { fitness, isJudged, medal, scoreSum, onMedalEdge, goldGate } from '../public/js/score.js';
import { nextMove, assignArm, liftStats, armOf, controlDue, drawStyle, sporeDue, sporeRested, pickSpore, sporeTarget, scrapDue, drawScrap } from '../public/js/evolve.js';

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
/** What the flight recorder writes about a model call: the step (a Role, or liftcheck/duel/plain/synthesis), its idea and model. */
type CallMeta = { role: string; ideaId?: number | null; model?: string };
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
  /** Blind duel: the coin that decides whether the child is shown as A or B (tests fix it). */
  duelRng?: () => number;
  /** Idea styles: the lot that picks each breed's style. Its own rng, so the arm and duel draws stay as they were (tests fix it). */
  styleRng?: () => number;
  /** Spores: the draw that breaks ties between equally fitting target boards (tests fix it). */
  sporeRng?: () => number;
  /** Clock for the spore gap (tests move it). */
  now?: () => number;
  /** Scrap heap: the lot that picks which wilted idea is drawn (tests fix it). */
  scrapRng?: () => number;
  /** Codebase boards: the folder gold logs go to unless a board names its own file (default data/gold). */
  goldRoot?: string;
};

export function createEngine(deps: Deps) {
  const { repo } = deps;
  const fetchPage = deps.fetchPage ?? realFetchPage;
  const fetchPapers = deps.fetchPapers ?? realFetchPapers;
  const reveal = deps.reveal ?? ((p: string) => execFile('open', [p], () => {}));
  const llm = makeLLM(deps.chat);
  const trialRng = deps.trialRng ?? Math.random;
  const duelRng = deps.duelRng ?? Math.random;
  const styleRng = deps.styleRng ?? Math.random;
  const sporeRng = deps.sporeRng ?? Math.random;
  const now = deps.now ?? Date.now;
  const scrapRng = deps.scrapRng ?? Math.random;
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
  // On a codebase board the ideas are improvements to someone's code, so every prompt (and the jury) gets the scan.
  const repoCtx = (board: Board) => {
    const r = board.config.repo;
    if (!r) return '';
    return [
      `This board improves the codebase "${r.name}" (${r.path}).`,
      r.summary && `What it is: ${r.summary}`,
      r.stack && `Stack: ${r.stack}`,
      r.focus.length ? `The owner wants ideas in these directions: ${r.focus.join('; ')}.` : '',
      r.context,
    ].filter(Boolean).join('\n');
  };
  const extraCtx = (board: Board) => [selfCtx(board), repoCtx(board)].filter(Boolean).join('\n\n');
  // The board's language wins over the source ideas' on self-improvement boards: one
  // Swedish slip would otherwise breed a Swedish lineage, and the code and journal follow the board.
  const ctxOf = (board: Board) => ({ goal: board.goal, fixedLang: board.config.selfImprove || board.config.repo ? board.config.lang : undefined });
  const flowFor = (board: Board) => {
    const ctx = extraCtx(board);
    return ctx ? { ...board.config.flow, system: `${board.config.flow.system}\n\n${ctx}` } : board.config.flow;
  };
  const guidanceFor = (board: Board) => [board.config.judgeGuidance, extraCtx(board)].filter((x) => x.trim()).join('\n\n');

  /** A guest copy of an idea on another board, beside what is already there. */
  function landGuest(boardId: number, idea: Idea, originIdeaId: number, originBoardId: number | null, spore: boolean) {
    const at = besideBoard(repo.listIdeas(boardId));
    return repo.insertIdea({
      boardId, title: idea.title, pitch: idea.pitch, kind: 'guest', sourceUrl: idea.sourceUrl,
      x: at.x, y: at.y, generation: 0, originIdeaId, originBoardId, spore,
    });
  }

  /**
   * Spores: after an autopilot step on a spore board, every SPORE_EVERY bred
   * ideas it sends its strongest unsent idea (silver or better) to the other
   * spore board whose keywords it shares most. There it is a guest, judged
   * against that board's goal. Returns the guest, or null when nothing went.
   */
  async function maybeSpore(boardId: number) {
    const board = repo.getBoard(boardId);
    if (!board?.config.spores) return null;
    const out = repo.sporesFrom(boardId);
    const ideas = repo.listIdeas(boardId);
    if (!sporeDue(ideas, out.reduce((m, g) => Math.max(m, g.id), 0))) return null;
    if (!sporeRested(out.at(-1)?.createdAt ?? null, now())) return null;
    // Never send an idea twice, nor one that is built or being built: it would only
    // propose the same change again on the board it lands on.
    const BUILT = new Set(['queued', 'running', 'ready', 'merged']);
    const keep = new Set(out.map((g) => g.originIdeaId));
    for (const i of ideas) if (BUILT.has(repo.latestBuildFor(i.id)?.status ?? '')) keep.add(i.id);
    const spore = pickSpore(ideas, keep);
    if (!spore) return null;
    const candidates = repo.listBoards()
      .filter((b) => b.id !== boardId && b.config.spores && !repo.hasGuest(b.id, spore.id))
      .map((b) => ({ id: b.id, keywords: repo.boardKeywords(b.id) }));
    const target = sporeTarget(spore, candidates, sporeRng);
    if (!target) return null;
    const guest = landGuest(target.boardId, spore, spore.id, boardId, true);
    emitIdeas(target.boardId, [guest]);
    bus.emit(boardId, { type: 'spore', ideaId: spore.id, toBoardId: target.boardId, guestId: guest.id, shared: target.shared });
    bus.emit(target.boardId, { type: 'spore', ideaId: guest.id, fromBoardId: boardId, shared: target.shared });
    queueJudge([guest.id]);
    return { guest, shared: target.shared };
  }

  /**
   * Codebase boards: append a gold idea to the board's gold file (Markdown), once
   * per idea. A failure is logged, never thrown: the verdict stands either way.
   */
  function logGold(board: Board, idea: Idea, by: 'jury' | 'hand') {
    const r = board.config.repo;
    if (!r?.goldFile) return null;
    try {
      const marker = `<!-- idea:${idea.id} -->`;
      const exists = existsSync(r.goldFile);
      if (exists && readFileSync(r.goldFile, 'utf8').includes(marker)) return null;
      mkdirSync(dirname(r.goldFile), { recursive: true });
      const head = exists ? '' : `# Gold ideas for ${r.name}\n\nFrom the Idea Generator board "${board.title}". Each idea is an improvement to ${r.path}.\n`;
      const scores = isJudged(idea) ? ` · ${idea.originality}/${idea.feasibility}/${idea.impact} (${scoreSum(idea)}/15)` : '';
      const lineage = repo.lineage(idea.id).filter((l) => l.id !== idea.id).map((l) => `  - ${l.title}`).join('\n');
      appendFileSync(r.goldFile, [
        head,
        `\n## ${idea.title}\n${marker}\n`,
        `${idea.pitch}\n`,
        `*${new Date().toISOString().slice(0, 16).replace('T', ' ')} · gold ${by === 'hand' ? 'by hand' : 'from the jury'}${scores}*\n`,
        idea.reason ? `> Jury: ${idea.reason}\n` : '',
        lineage ? `Grew out of:\n${lineage}\n` : '',
      ].join('\n'));
      bus.emit(board.id, { type: 'goldLogged', ideaId: idea.id, file: r.goldFile });
      return r.goldFile;
    } catch (e: any) {
      console.log(`[gold] ${r.goldFile}: ${e?.message ?? e}`);
      return null;
    }
  }
  const titles = (boardId: number) => repo.listIdeas(boardId).map((i) => i.title);
  const emitIdeas = (boardId: number, ideas: Idea[]) => ideas.length && bus.emit(boardId, { type: 'ideas', ideas });

  /**
   * Every LLM call: spend lands on the board's ledger; failures become 502s that keep the provider's code.
   * Flight recorder (build 0013): the call is written to the `calls` table before it starts (role, idea,
   * model) and closed after it with its dollars and milliseconds, or as failed. A row the server never got
   * to close was cut off by a crash; the next boot marks it lost (repo.recordBoot) and recover() redoes it.
   */
  async function call<T extends { costUsd: number }>(boardId: number, meta: CallMeta, fn: () => Promise<T>): Promise<T> {
    const id = repo.openCall({ boardId, ...meta });
    const t0 = performance.now();
    try {
      const out = await fn();
      repo.closeCall(id, 'ok', out.costUsd, performance.now() - t0);
      repo.addSpend(boardId, out.costUsd);
      return out;
    } catch (e: any) {
      repo.closeCall(id, 'failed', 0, performance.now() - t0);
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
    const { brief } = await call(board.id, { role: 'brief', ideaId: idea.id, model: modelFor(board, 'brief') }, () => writeBrief({ chat: deps.chat, model: modelFor(board, 'brief'), idea, goal: board.goal, lineage, lang }));
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
      const { judgement } = await call(board.id, { role: 'judge', ideaId: idea.id, model: modelFor(board, 'judge') }, () =>
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
      } else if (board.config.repo && medal(out.idea) === 3) {
        // A codebase board logs its gold to a file for the owner (and, later, a builder).
        logGold(board, out.idea, 'jury');
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
      // A recipe child: did it really carry out the recipe? Only an applied recipe's hit counts.
      out.idea = (await checkLift(board, out.idea)) ?? out.idea;
      // ...and did it beat its parent, read blind side by side? The duel decides the recipe's hit.
      out.idea = (await duelLift(board, out.idea)) ?? out.idea;
      // Would the jury score it the same in plain words? Measured only; never touches the medal.
      if (board.config.wordingGap && !out.idea.plain) out.idea = (await plainRescore(board, out.idea).catch(() => null)) ?? out.idea;
      // A verdict one point from another medal gets a blind second opinion, in the background.
      if (autoRetrial(board, out.idea)) queueRetrial(out.idea.id);
      return out;
    } finally {
      setJudging(board.id, [idea.id], false);
    }
  }

  // ---------------------------------------------------------------- recipe check

  /**
   * After a recipe-arm child is judged, the judge model is shown the parent,
   * the recipe and the child (no scores, no medals) and rules whether the
   * child applied the recipe. Once per child: the text does not change on a
   * re-judge. Skipped when the parent's recipe is gone or has changed type
   * since the breed (it is no longer the recipe the child was handed). A
   * failed check leaves the child unchecked; it never fails the verdict.
   */
  async function checkLift(board: Board, idea: Idea): Promise<Idea | null> {
    if (armOf(idea) !== 'recipe' || idea.liftApplied != null || !idea.liftFrom) return null;
    const parent = repo.getIdea(idea.liftFrom);
    if (!parent?.recipe || parent.recipeType !== idea.liftType) return null;
    try {
      const r = await call(board.id, { role: 'liftcheck', ideaId: idea.id, model: modelFor(board, 'judge') }, () =>
        llm.checkLift({ model: modelFor(board, 'judge'), parent, recipe: { type: parent.recipeType!, change: parent.recipe! }, child: idea, lang: board.config.lang }),
      );
      if (r.applied == null) return null;
      const saved = repo.saveLiftCheck(idea.id, { applied: r.applied, reason: r.reason })!;
      emitIdeas(board.id, [saved]);
      return saved;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- blind duel

  /**
   * After a recipe-arm child is judged, the judge model reads child and parent
   * side by side as "A" and "B", in an order decided by a coin, with no
   * recipe, scores, medals or lineage, and picks a winner per criterion. The
   * winner on the recipe's own criterion decides the recipe's hit
   * (liftHit()); the medal and the scores stay what the jury gave. Once per
   * child (the texts do not change on a re-judge). A failed or incomplete
   * duel leaves the child without one; it never fails the verdict.
   */
  async function duelLift(board: Board, idea: Idea): Promise<Idea | null> {
    if (armOf(idea) !== 'recipe' || idea.duel || !idea.liftFrom) return null;
    const parent = repo.getIdea(idea.liftFrom);
    if (!parent) return null;
    const childFirst = duelRng() < 0.5;
    const model = modelFor(board, 'judge');
    try {
      const r = await call(board.id, { role: 'duel', ideaId: idea.id, model }, () =>
        llm.duel({ model, a: childFirst ? idea : parent, b: childFirst ? parent : idea, lang: board.config.lang }),
      );
      const side = (v: 'A' | 'B' | 'tie' | null) =>
        v === 'tie' ? 'tie' : v === 'A' ? (childFirst ? 'child' : 'parent') : v === 'B' ? (childFirst ? 'parent' : 'child') : null;
      const [o, f, i] = [side(r.originality), side(r.feasibility), side(r.impact)];
      if (!o || !f || !i) return null;
      const saved = repo.saveDuel(idea.id, { originality: o, feasibility: f, impact: i, reason: r.reason, childFirst, model, at: new Date().toISOString() })!;
      emitIdeas(board.id, [saved]);
      return saved;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- wording gap

  /**
   * Wording gap (build 0011), like blinded peer review: the judge model
   * rewrites the idea in plain wording (seeing only its text), then the
   * ordinary jury prompt scores the rewrite, blind (no first verdict). The
   * gap between the jury's sum and the plain sum is computed where it is
   * shown (plainGap() in evolve.js); above PLAIN_GAP the idea is
   * "style-carried". Nothing in selection, the medal or the builder reads
   * it. Returns null when the rewrite came back empty; throws on a failed
   * call (judge() swallows that, the hand endpoint reports it).
   */
  async function plainRescore(board: Board, idea: Idea): Promise<Idea | null> {
    const model = modelFor(board, 'judge');
    const { rewrite } = await call(board.id, { role: 'plain', ideaId: idea.id, model }, () => llm.plainRewrite({ model, idea, lang: board.config.lang }));
    if (!rewrite) return null;
    const { judgement: j } = await call(board.id, { role: 'plain', ideaId: idea.id, model }, () =>
      llm.judge({
        model, board: ctxOf(board), idea: rewrite, lang: board.config.lang,
        guidance: guidanceFor(board), vocabulary: repo.keywordVocabulary(),
      }),
    );
    // Only the scores and the reason are kept: the rewrite's keywords and recipe must not touch the idea.
    const saved = repo.savePlain(idea.id, {
      ...rewrite, originality: j.originality, feasibility: j.feasibility, impact: j.impact, reason: j.reason, model, at: new Date().toISOString(),
    })!;
    emitIdeas(board.id, [saved]);
    return saved;
  }

  /** POST /api/ideas/:id/plain: the wording-gap rescore by hand, on any board. Redoes an old one. */
  async function plain(ideaId: number) {
    const idea = mustIdea(ideaId);
    if (!isJudged(idea)) throw new AppError(400, 'not_judged', 'The jury has not judged this idea yet');
    const board = mustBoard(idea.boardId);
    const saved = await plainRescore(board, idea);
    if (!saved) throw new AppError(502, 'llm_failed', 'The plain rewrite came back empty');
    return { idea: saved };
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
      const { judgement: j } = await call(board.id, { role: 'retrial', ideaId: idea.id, model }, () =>
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
      // Someone else (an autopilot step) is already judging it: one jury call per idea, not two.
      if (judging.has(id)) continue;
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

  /**
   * Flight recorder (build 0013): after a restart, redo what the crash cut off.
   * `lost` is what repo.recordBoot() returned. A lost jury call is queued again
   * if its idea still exists, is unjudged and has no hand-set medal; a lost
   * second opinion is retried if the verdict is still on the edge and has none.
   * Everything else (breeds, summaries, scouts) is left alone: the autopilot's
   * next step or a click does it again, and redoing a breed would add ideas.
   * Returns the idea ids it queued.
   */
  function recover(lost: { boardId: number; ideaId: number | null; role: string }[]) {
    const judged: number[] = [];
    const retried: number[] = [];
    for (const c of lost) {
      if (c.ideaId == null) continue;
      const idea = repo.getIdea(c.ideaId);
      const board = idea && repo.getBoard(idea.boardId);
      if (!idea || !board) continue;
      if (c.role === 'judge' && !isJudged(idea) && idea.medalOverride == null && !judged.includes(idea.id)) judged.push(idea.id);
      if (c.role === 'retrial' && isJudged(idea) && !idea.retrial && autoRetrial(board, idea) && !retried.includes(idea.id)) retried.push(idea.id);
    }
    if (judged.length) queueJudge(judged);
    for (const id of retried) queueRetrial(id);
    return { judged, retried };
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
    const style = drawStyle(styleRng); // one style per breed, by lot, independent of the arm
    const { ideas } = await call(board.id, { role: 'expand', ideaId: parent.id, model: modelFor(board, 'expand') }, () =>
      llm.expand({ model: modelFor(board, 'expand'), flow: flowFor(board), board: ctxOf(board), idea: parent, existingTitles: titles(board.id), lang: board.config.lang, task, style }),
    );
    const spots = arcPositions(parent, repo.parentsOf(parent.id)[0] ?? null, ideas.length);
    const lift = task ? { type: task.type, from: parent.id, base: task.base, arm: task.arm } : null;
    const created = ideas.map((i, n) =>
      repo.insertIdea({ boardId: board.id, ...i, kind: 'expand', x: spots[n].x, y: spots[n].y, generation: parent.generation + 1, lift, escape, style }, [parent.id]),
    );
    const edges = created.map((c) => ({ from: parent.id, to: c.id }));
    emitIdeas(board.id, created);
    bus.emit(board.id, { type: 'edges', edges });
    return { ideas: created, edges };
  }

  /**
   * `forced`: a task chosen by the caller instead of assignArm's (the autopilot's control sibling, the scrap draw).
   * `scrap`: the scrap draw's record, stored on the child.
   */
  async function doCombine(
    boardId: number, aId: number, bId: number, escape: string | null = null,
    forced: ReturnType<typeof assignArm> = null, scrap: Scrap | null = null,
  ) {
    const board = mustBoard(boardId);
    if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId === bId) throw new AppError(400, 'bad_pair', 'Pick two different ideas');
    const a = mustIdea(aId);
    const c = mustIdea(bId);
    if (a.boardId !== board.id || c.boardId !== board.id) throw new AppError(400, 'bad_pair', 'Ideas belong to another board');
    // Of the two parents' recipes, the type that has lifted medals more often on this board (or, by lot, the placebo).
    const task = forced ?? assignArm([a, c], liftStats(repo.listIdeas(board.id)), trialRng);
    const style = drawStyle(styleRng);
    const { idea } = await call(board.id, { role: 'combine', ideaId: a.id, model: modelFor(board, 'combine') }, () =>
      llm.combine({ model: modelFor(board, 'combine'), flow: flowFor(board), board: ctxOf(board), a, b: c, existingTitles: titles(board.id), lang: board.config.lang, task, style }),
    );
    const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy) || 1; // midpoint, nudged off the line
    const created = repo.insertIdea(
      {
        boardId: board.id, ...idea, kind: 'combine',
        x: (a.x + c.x) / 2 + (-dy / len) * 70, y: (a.y + c.y) / 2 + (dx / len) * 70,
        generation: Math.max(a.generation, c.generation) + 1,
        // A scrap child is in no trial arm: its task is a jury reason, not a recipe, so it must not touch the trials.
        lift: task && task.arm !== 'scrap' ? { type: task.type, from: task.from.id, base: task.base, arm: task.arm } : null,
        escape,
        style,
        scrap,
      },
      [a.id, c.id],
    );
    const edges = [{ from: a.id, to: created.id }, { from: c.id, to: created.id }];
    emitIdeas(board.id, [created]);
    bus.emit(board.id, { type: 'edges', edges });
    return { idea: created, edges };
  }

  const api = {
    bus,
    judging,
    idle,
    queueJudge,
    recover,
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
        const { idea } = await call(board.id, { role: 'distill', model: modelFor(board, 'distill') }, () =>
          llm.distill({ model: modelFor(board, 'distill'), flow, board: ctxOf(board), text: [page.title, page.text].filter(Boolean).join('\n\n'), url, lang }),
        );
        ({ title, pitch } = idea);
        sourceUrl = url;
      } else if (text.length > 120) { // longer than a title: distill it, never cut it off
        const { idea } = await call(board.id, { role: 'distill', model: modelFor(board, 'distill') }, () => llm.distill({ model: modelFor(board, 'distill'), flow, board: ctxOf(board), text, lang }));
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
    /** The wording-gap rescore by hand (any judged idea, any board). */
    plain,
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
      const owner = repo.getBoard(idea.boardId);
      if (m === 3 && owner?.config.repo) logGold(owner, idea, 'hand');
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
        const guest = landGuest(boardId, idea, originIdeaId, originBoardId, false);
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

    /**
     * Codebase boards, step 1: scan a folder (read-only) and ask the model what
     * the code is and which directions ideas could take. Nothing is stored.
     */
    async analyzeRepo(b: { path?: unknown; lang?: unknown }) {
      const lang = b.lang === 'en' ? 'en' : 'sv';
      let scan;
      try {
        scan = scanRepo(b.path);
      } catch (e: any) {
        if (e instanceof RepoError) throw new AppError(400, e.code, e.message);
        throw e;
      }
      if (!scan.files) throw new AppError(400, 'empty_repo', `No files to read in ${scan.path}`);
      const model = deps.settings().models.summary;
      let out;
      // Not on a board yet (and, as before, not on the spend ledger), but the flight recorder logs it under board 0.
      const callId = repo.openCall({ boardId: 0, role: 'analyze', model });
      const t0 = performance.now();
      try {
        out = await llm.analyzeRepo({ model, scan: scanText(scan), lang });
        repo.closeCall(callId, 'ok', out.costUsd, performance.now() - t0);
      } catch (e: any) {
        repo.closeCall(callId, 'failed', 0, performance.now() - t0);
        throw new AppError(502, e instanceof ProviderError ? e.code : 'llm_failed', e?.message ?? String(e));
      }
      return {
        scan: { path: scan.path, short: shortPath(scan.path), name: scan.name, files: scan.files, languages: scan.languages, testCommand: scan.testCommand, docs: scan.docs.map((d) => d.file) },
        analysis: { summary: out.summary, stack: out.stack, focuses: out.focuses },
        costUsd: out.costUsd,
      };
    },

    /**
     * Codebase boards, step 2: create the board from the analysis and the
     * directions the person picked. The folder is scanned again here, so the
     * context in the prompts comes from the files, not from the browser.
     */
    async createRepoBoard(b: any) {
      const lang: 'sv' | 'en' = b.lang === 'en' ? 'en' : 'sv';
      let scan;
      try {
        scan = scanRepo(b.path);
      } catch (e: any) {
        if (e instanceof RepoError) throw new AppError(400, e.code, e.message);
        throw e;
      }
      const cut = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
      const focuses = (Array.isArray(b.focuses) ? b.focuses : [])
        .map((f: any) => ({ label: cut(f?.label, 60), seed: cut(f?.seed, 120) }))
        .filter((f: { label: string }) => f.label)
        .slice(0, 8);
      const extra = cut(b.extra, 300);
      const focus = [...focuses.map((f: { label: string }) => f.label), ...(extra ? [extra] : [])];
      if (!focus.length) throw new AppError(400, 'no_focus', 'Pick at least one direction, or write your own');
      const summary = cut(b.summary, 800);
      const stack = cut(b.stack, 300);
      const title = cut(b.title, 120) || scan.name;
      const goldRoot = deps.goldRoot ?? join(process.cwd(), 'data', 'gold');
      const goal = `Improve the codebase "${scan.name}" in these directions: ${focus.join('; ')}. Every idea is a concrete change to this code that a coding agent could build and test.`.slice(0, 600);
      const board = repo.createBoard({ title, goal, templateId: null, config: { lang } });
      const goldFile = join(goldRoot, `board-${board.id}-${slugify(scan.name)}.md`);
      const config = {
        flowName: 'Kodbas · Codebase',
        flow: {
          system: `You are a senior engineer and product thinker improving the codebase "${scan.name}". You think in concrete changes to its code: what to add, change or remove, where in the code, and how a user or developer would notice.`,
          expand: 'Generate 3 improvements to the codebase that grow out of this one. Make them differ: one that sharpens it into the smallest shippable change, one that borrows a mechanism from another field or product, and one bolder change. Each must name what changes in the code and how someone would see or measure it.',
          combine: 'Fuse the two improvements into ONE change to the codebase where each part makes the other work better. Name the concrete mechanism, where in the code it lives, and what a user or developer sees.',
        },
        judgeGuidance: [
          `Each idea is a proposed change to the codebase "${scan.name}".`,
          `FEASIBILITY: could a coding agent build and test it in this codebase in about an hour, without new paid services or accounts? 5 = a contained change to a few files with an obvious test. 3 = touches several parts but is clear. 1–2 = vague, needs new infrastructure or a human to finish it.`,
          `IMPACT: how much it moves the codebase in the directions its owner chose (${focus.join('; ')}). Cosmetic tweaks score at most 2.`,
          'ORIGINALITY is judged against what the code already does (see the scan below). A feature it already has scores 1.',
          'An idea that does not say where in the code it lands, or how to verify it, scores at most 3 on feasibility.',
        ].join('\n'),
        researchers: { x: { enabled: false, focus: '' }, research: { enabled: false, focus: '' } },
        autoProjectOnGold: false,
        mode: b.autopilot === false ? 'manual' : 'auto',
        autopilotSeconds: 45,
        rate: { stepsPerHour: 40, usdPerDay: Number.isFinite(Number(b.usdPerDay)) ? Number(b.usdPerDay) : 2 },
        repo: { path: scan.path, name: scan.name, summary, stack, focus, context: scanText(scan), goldFile, testCommand: scan.testCommand },
      };
      repo.updateBoard(board.id, { config });
      // One starter idea per picked direction, in a ring; the jury judges them in the background.
      const seeds = focuses.map((f: { seed: string }) => f.seed).filter(Boolean);
      if (extra) seeds.push(extra);
      await Promise.all(seeds.map((text: string, i: number) => {
        const a = (i / seeds.length) * Math.PI * 2;
        return api.seed(board.id, { text, x: Math.round(Math.cos(a) * 260), y: Math.round(Math.sin(a) * 260) });
      }));
      return { board: repo.getBoard(board.id) };
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
      const { summary } = await call(board.id, { role: 'summary', model: modelFor(board, 'summary') }, () => llm.summarize({ model: modelFor(board, 'summary'), board, ideas, lang }));
      const saved = repo.setSummary(board.id, { ...summary, ideaCount: ideas.length, lang, createdAt: new Date().toISOString() })!;
      bus.emit(board.id, { type: 'board', board: saved });
      return { board: saved };
    },

    /** The report's conclusions across every board, saved so the window opens instantly. */
    async synthesize(days: number, lang: 'sv' | 'en') {
      const report = repo.report(days);
      const boards = report.boards.filter((b) => b.ideaCount);
      if (!boards.length) throw new AppError(400, 'too_few', 'There are no ideas to report on yet');
      const { synthesis } = await call(0, { role: 'synthesis', model: deps.settings().models.summary }, () =>
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
        r = await call(board.id, { role: 'x', model: modelFor(board, 'x') }, () => xLeads({ chat: deps.chat, model: modelFor(board, 'x'), goal: topic, lang }));
      } else {
        let papers;
        try {
          papers = await fetchPapers(focus || board.goal);
        } catch (e: any) {
          throw new AppError(502, 'research_failed', e?.message ?? String(e));
        }
        r = await call(board.id, { role: 'research', model: modelFor(board, 'research') }, () => researchLeads({ chat: deps.chat, model: modelFor(board, 'research'), goal: topic, lang, papers }));
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
    /** One autopilot step, then (on a spore board, when due) a spore. A failed spore never fails the step. */
    async autoStep(boardId: number) {
      const r = await api.breedStep(boardId);
      // The scrap heap: after a breed when due, or whenever the autopilot had nothing else to do.
      if (r.did === 'expand' || r.did === 'combine' || r.reason === 'nothing_to_do') {
        await api.maybeScrap(boardId, r.reason === 'nothing_to_do').catch((e) => console.log(`[scrap] board ${boardId}: ${e?.message ?? e}`));
      }
      if (r.did !== 'idle') await maybeSpore(boardId).catch((e) => console.log(`[spore] board ${boardId}: ${e?.message ?? e}`));
      return r;
    },

    maybeSpore,

    /**
     * Scrap heap (build 0012): on a board with it on, every SCRAP_EVERY bred
     * ideas (or at once when `idle`) draw one wilted idea (drawScrap() in
     * evolve.js) and cross it with the fittest living idea through the
     * ordinary cross prompt, the jury's reason for the wilted idea as the
     * task. The child stores `scrap` and is judged here. null: nothing drawn.
     */
    async maybeScrap(boardId: number, idle = false) {
      const board = mustBoard(boardId);
      if (!board.config.scrapHeap) return null;
      const ideas = repo.listIdeas(boardId);
      if (!idle && !scrapDue(ideas)) return null;
      const draw = drawScrap(ideas, repo.listEdges(boardId), scrapRng);
      if (!draw?.partner) return null;
      const { wilt, partner, distance } = draw;
      const task = { arm: 'scrap', type: null, change: wilt.reason, from: wilt, base: medal(wilt) };
      const scrap = { from: wilt.id, distance: distance == null ? null : Math.round(distance * 100) / 100, at: new Date().toISOString() };
      const r = await doCombine(boardId, wilt.id, partner.id, null, task, scrap);
      bus.emit(boardId, { type: 'scrap', ideaId: r.idea.id, from: wilt.id, partner: partner.id, distance: scrap.distance });
      await judge(r.idea.id);
      return { idea: repo.getIdea(r.idea.id)!, wilt, partner, distance: scrap.distance };
    },

    async breedStep(boardId: number): Promise<{ did: 'idle' | 'judge' | 'expand' | 'combine'; reason?: string; ids?: number[] }> {
      mustBoard(boardId);
      const ideas = repo.listIdeas(boardId);
      if (!ideas.length) return { did: 'idle', reason: 'empty' };
      const judgeAll = async (ids: number[]) => {
        const results = await Promise.allSettled(ids.map((id) => judge(id)));
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
      };
      const unjudged = ideas.filter((i) => !isJudged(i) && i.medalOverride == null && !judging.has(i.id) && !queue.includes(i.id)).slice(0, 3);
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
  return api;
}

export type Engine = ReturnType<typeof createEngine>;
