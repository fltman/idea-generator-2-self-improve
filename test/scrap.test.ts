// Scrap heap (build 0012): wilted ideas crossed with their own jury reason as the task.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';
import {
  wilted, keywordDistance, scrapDue, drawScrap, scrapStats, armOf, liftStats, trialStats,
  WILT_CHILDREN, SCRAP_EVERY, SCRAP_FLOOR, SCRAP_TARGET,
} from '../public/js/evolve.js';

// sum 9 = bronze, 11 = silver, 13 = gold; null = unjudged
const idea = (id: number, sum: number | null, extra: object = {}) => ({
  id, kind: 'combine', medalOverride: null, keywords: [], reason: 'too vague',
  ...(sum == null ? { originality: null, feasibility: null, impact: null } : { originality: sum - 8, feasibility: 4, impact: 4 }),
  ...extra,
});
const kidsOf = (parent: number, first: number, sums: number[]) => ({
  ideas: sums.map((s, k) => idea(first + k, s)),
  edges: sums.map((_, k) => ({ from: parent, to: first + k })),
});

test('wilted: WILT_CHILDREN judged children and none above its own medal', () => {
  const p = idea(1, 11, { kind: 'seed' }); // silver
  const five = kidsOf(1, 10, [11, 9, 9, 7, 11]);
  assert.deepEqual(wilted([p, ...five.ideas], five.edges).map((i) => i.id), [1]);
  const four = kidsOf(1, 10, [11, 9, 9, 7]);
  assert.deepEqual(wilted([p, ...four.ideas, idea(20, null)], [...four.edges, { from: 1, to: 20 }]).map((i) => i.id), [], 'an unjudged child does not count');
  const riser = kidsOf(1, 10, [11, 9, 9, 7, 13]);
  assert.deepEqual(wilted([p, ...riser.ideas], riser.edges), [], 'one child above it, and it lives');
  assert.equal(WILT_CHILDREN, 5);
  // Gold, guests and ideas with no reason never wilt.
  for (const x of [idea(1, 13), idea(1, 11, { kind: 'guest' }), idea(1, 11, { reason: null })]) {
    assert.deepEqual(wilted([x, ...five.ideas], five.edges), []);
  }
});

test('keywordDistance: one minus the mean share of living ideas carrying each keyword', () => {
  const living = [idea(2, 9, { keywords: ['a', 'b'] }), idea(3, 9, { keywords: ['a'] }), idea(4, 9, { keywords: ['c'] }), idea(5, 9, { keywords: [] })];
  assert.equal(keywordDistance({ id: 1, keywords: ['a'] }, living), 0.5);
  assert.equal(keywordDistance({ id: 1, keywords: ['z'] }, living), 1);
  assert.equal(keywordDistance({ id: 1, keywords: ['a', 'z'] }, living), 0.75);
  assert.equal(keywordDistance({ id: 1, keywords: [] }, living), null);
  assert.equal(keywordDistance({ id: 2, keywords: ['a'] }, [living[0]]), 1, 'itself is not part of the pool');
});

test('scrapDue: every SCRAP_EVERY bred ideas after the last scrap child', () => {
  const bred = Array.from({ length: SCRAP_EVERY }, (_, k) => idea(k + 1, 9));
  assert.equal(scrapDue(bred.slice(1)), false);
  assert.equal(scrapDue(bred), true);
  assert.equal(scrapDue([...bred.slice(1), idea(50, 9, { kind: 'seed' })]), false, 'seeds do not count');
  assert.equal(scrapDue([...bred, idea(50, 9, { scrap: { from: 1, distance: 0.5 } })]), false, 'counts again from the last scrap child');
});

test('drawScrap: weighted by keyword distance, never the same wilted idea twice, partner the fittest living idea', () => {
  // Two wilted silvers: 1 shares its keyword with the whole pool, 2 shares nothing.
  const w1 = idea(1, 11, { kind: 'seed', keywords: ['common'] });
  const w2 = idea(2, 11, { kind: 'seed', keywords: ['rare'] });
  const a = kidsOf(1, 10, [11, 9, 9, 9, 9].map(() => 9));
  const b = kidsOf(2, 20, [9, 9, 9, 9, 9]);
  for (const k of [...a.ideas, ...b.ideas]) k.keywords = ['common'];
  const best = idea(40, 12, { kind: 'seed', keywords: ['common'] });
  const ideas = [w1, w2, ...a.ideas, ...b.ideas, best];
  const edges = [...a.edges, ...b.edges];
  // Weights: w1 SCRAP_FLOOR (distance 0), w2 1. A low draw picks w1, anything above its share picks w2.
  assert.equal(drawScrap(ideas, edges, () => 0).wilt.id, 1);
  const far = drawScrap(ideas, edges, () => SCRAP_FLOOR / (1 + SCRAP_FLOOR) + 0.01);
  assert.equal(far.wilt.id, 2);
  assert.equal(far.distance, 1);
  assert.equal(far.partner.id, 40, 'the fittest living idea');
  // w2 has been drawn: only w1 is left.
  const drawn = [...ideas, idea(60, 9, { scrap: { from: 2, distance: 1 } })];
  assert.equal(drawScrap(drawn, [...edges, { from: 2, to: 60 }, { from: 40, to: 60 }], () => 0.99).wilt.id, 1);
  assert.equal(drawScrap([best], []), null, 'nothing wilted, nothing drawn');
});

test('scrapStats: survivors, medal rates, the gap in points and the mean distance', () => {
  const ideas = [
    idea(1, 9, { scrap: { from: 9, distance: 0.8 } }), idea(2, 7, { scrap: { from: 8, distance: 0.4 } }), idea(3, null, { scrap: { from: 7, distance: null } }),
    idea(4, 9), idea(5, 7), idea(6, 7), idea(7, 7), idea(8, 13, { kind: 'seed' }),
  ];
  const s = scrapStats(ideas);
  assert.deepEqual(s.scrap, { n: 2, medals: 1, rate: 0.5 });
  assert.deepEqual(s.normal, { n: 4, medals: 1, rate: 0.25 }, 'seeds are not breeds');
  assert.equal(s.gap, 25);
  assert.equal(s.onTarget, s.gap >= SCRAP_TARGET);
  assert.equal(s.early, true);
  assert.equal(s.drawn, 3);
  assert.ok(Math.abs(s.distance - 0.6) < 1e-9);
  assert.deepEqual(s.survivors.map((i: any) => i.id), [1]);
  assert.equal(scrapStats([idea(4, 9)]).gap, null, 'no scrap children, no gap');
});

/** A board with one wilted silver ("Gammal") whose five children are bronze, and a gold-free living pool. */
function setup(config: object) {
  const repo = openDb(':memory:');
  const prompts: string[] = [];
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    if (r.schemaName === 'combine' || r.schemaName === 'pitch') prompts.push(r.user);
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'ok', originality: 3, feasibility: 3, impact: 3, keywords: ['ny'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false, scrapRng: () => 0 });
  const board = repo.createBoard({ title: 'Skrot', config });
  const old = repo.insertIdea({ boardId: board.id, title: 'Gammal', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  const verdict = (id: number, reason: string, sums: [number, number, number], kw: string) => {
    repo.saveJudgement(id, { reason, originality: sums[0], feasibility: sums[1], impact: sums[2], keywords: [kw] } as any);
    repo.setKeywords(id, [kw]);
  };
  verdict(old.id, 'Nobody can tell what it measures.', [4, 4, 3], 'gammal');
  const best = repo.insertIdea({ boardId: board.id, title: 'Bäst', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });
  verdict(best.id, 'r', [4, 4, 4], 'ny');
  for (let k = 0; k < 5; k++) {
    const c = repo.insertIdea({ boardId: board.id, title: `Barn ${k}`, pitch: '', kind: 'expand', x: 0, y: 0, generation: 1 }, [old.id]);
    verdict(c.id, 'r', [3, 3, 3], 'ny');
  }
  return { repo, engine, board, old, best, prompts };
}

test('engine: the scrap draw crosses the wilted idea with the fittest living one, its jury reason as the task, and judges the child', async () => {
  const { repo, engine, board, old, best, prompts } = setup({ scrapHeap: true });
  assert.equal(await engine.maybeScrap(board.id), null, 'not due yet: only five bred ideas');
  const r = await engine.maybeScrap(board.id, true);
  assert.ok(r);
  assert.equal(r.wilt.id, old.id);
  assert.equal(r.partner.id, best.id);
  assert.equal(r.distance, 1, '"gammal" is carried by no living idea');
  const child = repo.getIdea(r.idea.id)!;
  assert.deepEqual({ from: child.scrap!.from, distance: child.scrap!.distance }, { from: old.id, distance: 1 });
  assert.ok(child.judgedAt, 'judged in the same step');
  assert.equal(child.liftArm, null);
  assert.equal(armOf(child), null, 'in no trial arm');
  assert.deepEqual(repo.parentsOf(child.id).map((p) => p.id).sort(), [old.id, best.id].sort());
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /Nobody can tell what it measures\./);
  assert.match(prompt, /overcome what this verdict says held it back/);
  // Trials do not see the scrap child.
  const all = repo.listIdeas(board.id);
  assert.equal(trialStats(all).recipe.total.tries + trialStats(all).none.total.tries, 0);
  assert.deepEqual(liftStats(all), liftStats(all.filter((i) => !i.scrap)));
  // Drawn once: nothing else is wilted now.
  assert.equal(await engine.maybeScrap(board.id, true), null);
});

test('engine: the autopilot draws from the scrap heap once SCRAP_EVERY ideas are bred, and never with it off', async () => {
  for (const on of [true, false]) {
    const { repo, engine, board } = setup({ scrapHeap: on });
    for (let i = 0; i < 10 && !repo.listIdeas(board.id).some((x) => x.scrap); i++) await engine.autoStep(board.id);
    assert.equal(repo.listIdeas(board.id).some((x) => x.scrap), on);
  }
});
