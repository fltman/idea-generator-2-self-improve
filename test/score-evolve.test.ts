import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScore, fitness, medal, medalFromSum, scoreSum, onMedalEdge, confidenceBand, retrialSum } from '../public/js/score.js';
import {
  breedScore, doubtPenalty, evolutionStats, expandedIds, liftHit, liftRate, liftStats, nextMove, pairKey, pickRecipe, recipeOf, usedPairs,
} from '../public/js/evolve.js';

const idea = (id: number, sum: number | null, extra: any = {}) => {
  const base: any = { id, kind: 'expand', generation: 1, medalOverride: null, ...extra };
  if (sum != null) {
    // spread the sum over three 1–5 scores
    const o = Math.min(5, sum - 2), f = Math.min(5, sum - o - 1), i = sum - o - f;
    Object.assign(base, { originality: o, feasibility: f, impact: i });
  }
  return base;
};

// Deterministic PRNG (mulberry32) so statistical tests are stable.
const rngFrom = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test('medal thresholds on the 3–15 sum', () => {
  assert.equal(medalFromSum(null), null);
  assert.deepEqual([3, 8, 9, 10, 11, 12, 13, 15].map(medalFromSum), [0, 0, 1, 1, 2, 2, 3, 3]);
});

test('scores are clamped to whole numbers 1–5', () => {
  assert.deepEqual([0, 1, 2.6, 5, 9, 'x', null].map(clampScore), [1, 1, 3, 5, 5, 1, 1]);
});

test('the helper builds the sum it was asked for', () => {
  for (let s = 3; s <= 15; s++) assert.equal(scoreSum(idea(1, s)), s);
});

test('a hand-set medal beats the judge, for display and for breeding', () => {
  const i = idea(1, 6, { medalOverride: 3 });
  assert.equal(medal(i), 3);
  assert.equal(fitness(i), 14);
  assert.equal(medal(idea(2, null)), null);
  assert.equal(fitness(idea(2, null)), null);
});

test('pairs already combined, and parent–child pairs, are not bred again', () => {
  const ideas = [idea(1, 9), idea(2, 9), idea(3, 12, { kind: 'combine' })];
  const edges = [{ from: 1, to: 3 }, { from: 2, to: 3 }];
  const used = usedPairs(ideas, edges);
  assert.ok(used.has(pairKey(1, 2)), 'parents of a combination');
  assert.ok(used.has(pairKey(1, 3)), 'parent and child');
  for (let s = 0; s < 200; s++) {
    const m = nextMove(ideas, edges, { rng: rngFrom(s), mutationRate: 0 });
    if (m?.type === 'combine') {
      assert.ok(!used.has(pairKey(m.a.id, m.b.id)), `bred a used pair ${m.a.id}-${m.b.id}`);
    }
  }
});

test('never combines an idea with itself and skips busy ideas and in-flight pairs', () => {
  const ideas = [idea(1, 10), idea(2, 11), idea(3, 12), idea(4, 13)];
  for (let s = 0; s < 300; s++) {
    const m = nextMove(ideas, [], {
      rng: rngFrom(s), mutationRate: 0, busy: new Set([4]), inFlight: new Set([pairKey(2, 3)]),
    });
    assert.equal(m?.type, 'combine');
    assert.notEqual(m.a.id, m.b.id);
    assert.ok(m.a.id !== 4 && m.b.id !== 4, 'used a busy idea');
    assert.notEqual(pairKey(m.a.id, m.b.id), pairKey(2, 3));
  }
});

test('selection favours fitter parents', () => {
  const ideas = Array.from({ length: 10 }, (_, n) => idea(n + 1, 4 + n)); // sums 4..13
  const count = new Map<number, number>();
  const rng = rngFrom(42);
  for (let n = 0; n < 4000; n++) {
    const m = nextMove(ideas, [], { rng, mutationRate: 0 });
    for (const p of [m.a, m.b]) count.set(p.id, (count.get(p.id) ?? 0) + 1);
  }
  const best = count.get(10) ?? 0;
  const worst = count.get(1) ?? 0;
  assert.ok(best > worst * 5, `best ${best} vs worst ${worst}`);
});

test('a small population is grown by expanding its best unexpanded idea', () => {
  const ideas = [idea(1, 5, { kind: 'seed' }), idea(2, 9, { kind: 'seed' })];
  const m = nextMove(ideas, [], { rng: rngFrom(1) });
  assert.equal(m?.type, 'expand');
  assert.equal(m.idea.id, 2);
  const ideas2 = [...ideas, idea(3, 7), idea(4, 7), idea(5, 7)];
  const edges = [3, 4, 5].map((to) => ({ from: 2, to }));
  assert.deepEqual([...expandedIds(ideas2, edges)], [2]);
});

test('nothing to do on an empty board', () => {
  assert.equal(nextMove([], []), null);
  assert.equal(nextMove([idea(1, null)], []), null);
});

test('evolution stats leave seeds out and compare first and latest windows', () => {
  const ideas = [
    idea(1, 3, { kind: 'seed', generation: 0 }),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 2, 8)),
    ...Array.from({ length: 8 }, (_, n) => idea(n + 10, 12, { generation: 5 })),
  ];
  const s = evolutionStats(ideas);
  assert.equal(s.count, 16);
  assert.equal(s.first, 8);
  assert.equal(s.latest, 12);
  assert.equal(s.best, 12);
  assert.equal(s.generation, 5);
  assert.equal(evolutionStats(ideas.slice(0, 5)).latest, null, 'no "latest" until there is more than one window');
});

// ---------------------------------------------------------------- lift recipes

test('lift recipes: a hit is a medal above the parent\'s medal at breeding time', () => {
  const ideas = [
    idea(1, 11, { liftType: 'feasibility', liftBase: 1 }), // bronze → silver: hit
    idea(2, 10, { liftType: 'feasibility', liftBase: 1 }), // still bronze: miss
    idea(3, null, { liftType: 'feasibility', liftBase: 1 }), // not judged: not counted
    idea(4, 9, { liftType: 'impact', liftBase: 0 }), // none → bronze: hit
    idea(5, 6, { liftType: 'impact', liftBase: 0, medalOverride: 2 }), // a hand-set medal counts
    idea(6, 12, { liftType: 'charm', liftBase: 0 }), // unknown type: ignored
    idea(7, 12), // no task
  ];
  assert.deepEqual(ideas.map(liftHit), [true, false, null, true, true, null, null]);
  assert.deepEqual(liftStats(ideas), {
    originality: { tries: 0, hits: 0 }, feasibility: { tries: 2, hits: 1 }, impact: { tries: 2, hits: 2 },
  });
});

test('lift rate is smoothed: 0.5 with no data, never 0 or 1', () => {
  const s = { originality: { tries: 0, hits: 0 }, feasibility: { tries: 4, hits: 0 }, impact: { tries: 4, hits: 4 } };
  assert.equal(liftRate(s, 'originality'), 0.5);
  assert.ok(liftRate(s, 'feasibility') > 0 && liftRate(s, 'feasibility') < 0.5);
  assert.ok(liftRate(s, 'impact') > 0.5 && liftRate(s, 'impact') < 1);
  assert.equal(liftRate({}, 'impact'), 0.5);
});

test('only a judged, non-gold idea with a whole recipe hands one on', () => {
  assert.equal(recipeOf(idea(1, 10)), null, 'no recipe');
  assert.equal(recipeOf(idea(1, null, { recipeType: 'impact', recipe: 'x' })), null, 'not judged');
  assert.equal(recipeOf(idea(1, 13, { recipeType: 'impact', recipe: 'x' })), null, 'gold has no next medal');
  assert.equal(recipeOf(idea(1, 10, { recipeType: 'impact', recipe: '' })), null, 'empty change');
  const r = recipeOf(idea(1, 10, { recipeType: 'impact', recipe: 'Name the user.' }));
  assert.deepEqual({ type: r.type, change: r.change, base: r.base, from: r.from.id }, { type: 'impact', change: 'Name the user.', base: 1, from: 1 });
});

test('a cross takes the recipe whose type has lifted more often', () => {
  const a = idea(1, 10, { recipeType: 'originality', recipe: 'A' });
  const b = idea(2, 10, { recipeType: 'impact', recipe: 'B' });
  const none = { originality: { tries: 0, hits: 0 }, feasibility: { tries: 0, hits: 0 }, impact: { tries: 0, hits: 0 } };
  assert.equal(pickRecipe(a, b, none).from.id, 1, 'a tie keeps the first parent');
  assert.equal(pickRecipe(a, b, { ...none, impact: { tries: 3, hits: 3 } }).from.id, 2);
  assert.equal(pickRecipe(idea(3, 10), b, none).from.id, 2, 'only one parent has a recipe');
  assert.equal(pickRecipe(idea(3, 10), idea(4, 10), none), null);
});

test('the hit-rate nudge breaks ties in selection but never beats a point of jury score', () => {
  const stats = { originality: { tries: 0, hits: 0 }, feasibility: { tries: 20, hits: 0 }, impact: { tries: 20, hits: 20 } };
  const good = idea(1, 10, { recipeType: 'impact', recipe: 'x' });
  const bad = idea(2, 10, { recipeType: 'feasibility', recipe: 'x' });
  const better = idea(3, 11, { recipeType: 'feasibility', recipe: 'x' });
  assert.ok(breedScore(good, stats) > breedScore(bad, stats));
  assert.ok(breedScore(better, stats) > breedScore(good, stats));

  // Two equal ideas: the one whose recipe type keeps working is picked as a parent more often.
  const ideas = [
    idea(1, 10, { recipeType: 'impact', recipe: 'x' }),
    idea(2, 10, { recipeType: 'feasibility', recipe: 'x' }),
    idea(3, 10),
    ...Array.from({ length: 6 }, (_, n) => idea(10 + n, 11, { liftType: 'impact', liftBase: 1 })), // hits
    ...Array.from({ length: 6 }, (_, n) => idea(20 + n, 10, { liftType: 'feasibility', liftBase: 1 })), // misses
  ];
  const count = new Map<number, number>();
  const rng = rngFrom(7);
  for (let n = 0; n < 3000; n++) {
    const m = nextMove(ideas, [], { rng, mutationRate: 0 });
    if (m?.type === 'combine') for (const p of [m.a, m.b]) count.set(p.id, (count.get(p.id) ?? 0) + 1);
  }
  assert.ok((count.get(1) ?? 0) > (count.get(2) ?? 0) * 1.2, `impact ${count.get(1)} vs feasibility ${count.get(2)}`);
});

// ---------------------------------------------------------------- second opinion

const second = (o: number, f: number, i: number) => ({ retrial: { originality: o, feasibility: f, impact: i, reason: '', model: 'm', at: '' } });

test('second opinion: only a jury sum exactly on a medal threshold is on the edge', () => {
  assert.deepEqual([8, 9, 10, 11, 12, 13, 14].map((s) => onMedalEdge(idea(1, s))), [false, true, false, true, false, true, false]);
  assert.equal(onMedalEdge(idea(1, null)), false, 'not judged');
  assert.equal(onMedalEdge(idea(1, 11, { medalOverride: 2 })), false, 'a hand-set medal is not doubted');
});

test('second opinion: the band spans both sums and says whether the medals agree', () => {
  assert.equal(confidenceBand(idea(1, 13)), null, 'no second opinion yet');
  assert.equal(retrialSum(idea(1, 13, { retrial: { originality: 4, feasibility: 'x', impact: 4 } })), null, 'malformed');
  assert.deepEqual(confidenceBand(idea(1, 13, second(4, 3, 4))), { first: 13, second: 11, low: 11, high: 13, gap: 2, medals: [2, 3], agree: false });
  assert.equal(confidenceBand(idea(1, 11, second(4, 4, 4)))!.agree, true, '11 and 12 are both silver');
  assert.equal(confidenceBand(idea(1, 11, second(4, 3, 4)))!.gap, 0);
});

test('second opinion: disagreement lowers the breeding score by half the gap, either way; agreement costs nothing', () => {
  assert.equal(breedScore(idea(1, 13, second(3, 4, 4)), {}), 12);
  assert.equal(breedScore(idea(1, 9, second(4, 4, 4)), {}), 7.5, 'a higher second opinion is doubt too');
  assert.equal(breedScore(idea(1, 11, second(3, 4, 4)), {}), 11);
  assert.equal(doubtPenalty(idea(1, 13, { ...second(1, 4, 4), medalOverride: 3 })), 0, 'a person decided');
  // An undisputed 12 now outbreeds a 13 the second judge put at 9.
  assert.ok(breedScore(idea(1, 12), {}) > breedScore(idea(2, 13, second(1, 4, 4)), {}));
  // The medal itself stays the jury's.
  assert.equal(medal(idea(2, 13, second(1, 4, 4))), 3);
});

test('gold gate: a jury gold on the edge waits for the second judge; only agreement builds', async () => {
  const { goldGate } = await import('../public/js/score.js');
  assert.equal(goldGate(idea(1, 12)), null, 'silver is not gold');
  assert.equal(goldGate(idea(1, null)), null, 'not judged');
  assert.equal(goldGate(idea(1, 14)), 'build', 'clear gold builds at once');
  assert.equal(goldGate(idea(1, 13)), 'waiting', 'on the edge: wait for the second judge');
  assert.equal(goldGate(idea(1, 13, second(5, 4, 4))), 'agreed');
  assert.equal(goldGate(idea(1, 13, second(5, 5, 5))), 'agreed', 'a higher second opinion is still gold');
  assert.equal(goldGate(idea(1, 13, second(4, 4, 4))), 'contested');
  assert.equal(goldGate(idea(1, 13, { ...second(1, 1, 1), medalOverride: 3 })), null, 'a hand-set gold is the human\'s call');
  assert.equal(goldGate(idea(1, 13, { retrial: { originality: 4, feasibility: 'x', impact: 4 } })), 'waiting', 'a malformed opinion is no opinion');
});
