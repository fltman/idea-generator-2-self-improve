import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampScore, fitness, medal, medalFromSum, scoreSum, onMedalEdge, confidenceBand, retrialSum } from '../public/js/score.js';
import {
  breedScore, doubtPenalty, evolutionStats, expandedIds, liftHit, liftRate, liftStats, nextMove, pairKey, pickRecipe, recipeOf, usedPairs,
  assignArm, armOf, armHit, trialStats, trialVerdict, PLACEBO_RATE, TRIAL_MIN,
  diversity, diversitySeries, pressureStats, MONOCULTURE_SHARE, DIVERSITY_MIN,
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

// ---------------------------------------------------------------- placebo trials

test('placebo trials: about one recipe breed in five gets the placebo, same type, base and parent, no change', () => {
  const p = idea(1, 10, { recipeType: 'impact', recipe: 'Name the user.' });
  assert.deepEqual(
    (({ arm, type, change, base }) => ({ arm, type, change, base }))(assignArm([p], {}, () => 0)!),
    { arm: 'placebo', type: 'impact', change: null, base: 1 },
  );
  const r = assignArm([p], {}, () => 0.99)!;
  assert.deepEqual([r.arm, r.change, r.from.id], ['recipe', 'Name the user.', 1]);
  const rng = rngFrom(3);
  let placebos = 0;
  for (let n = 0; n < 4000; n++) if (assignArm([p], {}, rng)!.arm === 'placebo') placebos++;
  assert.ok(Math.abs(placebos / 4000 - PLACEBO_RATE) < 0.03, `placebo share ${placebos / 4000}`);

  // A cross keeps pickRecipe's choice; the placebo replaces it whole.
  const q = idea(2, 12, { recipeType: 'originality', recipe: 'B' });
  const stats = { originality: { tries: 4, hits: 4 }, feasibility: { tries: 0, hits: 0 }, impact: { tries: 4, hits: 0 } };
  const c = assignArm([p, q], stats, () => 0)!;
  assert.deepEqual([c.arm, c.type, c.from.id, c.base], ['placebo', 'originality', 2, 2]);
});

test('placebo trials: no recipe means the no-task arm against the best parent below gold; gold or unjudged parents, no arm', () => {
  const none = assignArm([idea(1, 9), idea(2, 11)], {}, () => 0)!;
  assert.deepEqual([none.arm, none.type, none.change, none.from.id, none.base], ['none', null, null, 2, 2]);
  assert.equal(assignArm([idea(1, 9), idea(2, 13)], {}, () => 0)!.from.id, 1, 'a gold parent cannot be lifted');
  assert.equal(assignArm([idea(1, 14)], {}, () => 0), null);
  assert.equal(assignArm([idea(1, null)], {}, () => 0), null);
});

test('placebo trials: hits per arm and type, only the recipe arm feeds liftStats, and the verdict waits for data', () => {
  const ideas = [
    idea(1, 11, { liftType: 'impact', liftBase: 1 }), // older idea, no arm stored: recipe arm, hit
    idea(2, 10, { liftType: 'impact', liftBase: 1, liftArm: 'recipe' }), // miss
    idea(3, 11, { liftType: 'impact', liftBase: 1, liftArm: 'placebo' }), // placebo hit
    idea(4, 9, { liftType: null, liftBase: 0, liftArm: 'none' }), // no-task hit
    idea(5, null, { liftType: 'impact', liftBase: 1, liftArm: 'placebo' }), // not judged
    idea(6, 12), // not in a trial
  ];
  assert.deepEqual(ideas.map(armOf), ['recipe', 'recipe', 'placebo', 'none', 'placebo', null]);
  assert.deepEqual(ideas.map(armHit), [true, false, true, true, null, null]);
  assert.deepEqual(ideas.map(liftHit), [true, false, null, null, null, null]);
  assert.deepEqual(liftStats(ideas).impact, { tries: 2, hits: 1 });
  const s = trialStats(ideas);
  assert.deepEqual(s.recipe.byType.impact, { tries: 2, hits: 1 });
  assert.deepEqual(s.placebo.total, { tries: 1, hits: 1 });
  assert.deepEqual(s.none.total, { tries: 1, hits: 1 });
  assert.equal(trialVerdict(s).verdict, 'early');

  const arm = (hits: number, tries: number) => ({ total: { hits, tries }, byType: {} });
  const v = (r: any, p: any) => trialVerdict({ recipe: r, placebo: p, none: arm(0, 0) } as any);
  assert.equal(v(arm(6, 10), arm(2, 10)).verdict, 'ahead');
  assert.equal(v(arm(3, 10), arm(3, 10)).verdict, 'even');
  assert.equal(v(arm(1, 10), arm(5, 10)).verdict, 'behind');
  assert.equal(v(arm(9, 10), arm(1, TRIAL_MIN - 1)).verdict, 'early');
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

// ---------------------------------------------------------------- diversity pressure

const kw = (id: number, sum: number | null, keywords: string[], extra: any = {}) => idea(id, sum, { keywords, ...extra });

test('diversity: the share of recent bred ideas carrying the top keyword; seeds and guests do not count', () => {
  const ideas = [
    kw(1, 9, ['camera'], { kind: 'seed' }), kw(2, 9, ['camera'], { kind: 'guest' }),
    ...Array.from({ length: 8 }, (_, n) => kw(10 + n, 10, ['lift recipe', 'jury'])),
    ...Array.from({ length: 4 }, (_, n) => kw(20 + n, 10, [`other ${n}`])),
  ];
  const d = diversity(ideas);
  assert.deepEqual([d.keyword, d.count, d.total], ['jury', 8, 12], 'a tie between keywords goes alphabetically');
  assert.ok(Math.abs(d.share - 8 / 12) < 1e-9);
  assert.equal(d.monoculture, true, `${MONOCULTURE_SHARE * 100}% or more of at least ${DIVERSITY_MIN} ideas`);
  assert.equal(diversity(ideas.slice(0, -1)).monoculture, false, `fewer than ${DIVERSITY_MIN} bred ideas: too few to call it`);
  const mixed = [...ideas, ...Array.from({ length: 6 }, (_, n) => kw(30 + n, 10, [`new ${n}`]))];
  assert.equal(diversity(mixed).monoculture, false, '8 of 18 is below the line');
  assert.equal(diversity(mixed, 6).keyword, 'new 0', 'only the window counts');
});

test('diversity pressure: in a monoculture every breed takes a parent from outside the theme, still by score', () => {
  const inside = Array.from({ length: 14 }, (_, n) => kw(n + 1, 13, ['lift recipe']));
  const outside = [kw(50, 9, ['camera']), kw(51, 11, ['export']), kw(52, 10, ['sound'])];
  const ideas = [...inside, ...outside];
  const outIds = new Set(outside.map((i) => i.id));
  let fromBest = 0;
  for (let s = 0; s < 200; s++) {
    const m = nextMove(ideas, [], { rng: rngFrom(s), mutationRate: 0 })!;
    assert.equal(m.type, 'combine');
    assert.equal(m.escape, 'lift recipe');
    assert.ok(outIds.has(m.a.id) || outIds.has(m.b.id), `seed ${s}: no parent outside`);
    if (m.a.id === 51) fromBest++;
  }
  assert.ok(fromBest > 100, `the tournament still prefers the strongest outsider: ${fromBest}/200`);
  const ex = nextMove(ideas, [], { rng: rngFrom(1), mutationRate: 1 })!;
  assert.deepEqual([ex.type, ex.idea.id, ex.escape], ['expand', 51, 'lift recipe'], 'a mutation expands the best idea outside the theme');
  const off = nextMove(ideas, [], { rng: rngFrom(1), mutationRate: 1, diversity: false })!;
  assert.equal(off.escape, undefined);
  assert.ok(!outIds.has(off.idea.id), 'without pressure the strongest idea wins');
});

test('diversity pressure: no monoculture, or nothing outside it, breeds as before', () => {
  const varied = Array.from({ length: 14 }, (_, n) => kw(n + 1, 10 + (n % 3), [`theme ${n % 5}`]));
  for (let s = 0; s < 20; s++) assert.equal(nextMove(varied, [], { rng: rngFrom(s) })?.escape, undefined);
  const all = Array.from({ length: 14 }, (_, n) => kw(n + 1, 10, ['same']));
  for (let s = 0; s < 20; s++) assert.equal(nextMove(all, [], { rng: rngFrom(s) })?.escape, undefined);
  // the same rng draws as without the feature, so a board without keywords is untouched
  const plain = Array.from({ length: 6 }, (_, n) => idea(n + 1, 9 + n));
  for (let s = 0; s < 20; s++) assert.deepEqual(nextMove(plain, [], { rng: rngFrom(s) }), nextMove(plain, [], { rng: rngFrom(s), diversity: false }));
});

test('diversity gauge: the series over time, when the monoculture began, and what the pressure did', () => {
  const at = (n: number) => `2026-11-08 10:${String(n).padStart(2, '0')}:00`;
  const ideas = [
    ...Array.from({ length: 12 }, (_, n) => kw(n + 1, 10, [`t${n}`], { createdAt: at(n) })),
    ...Array.from({ length: 20 }, (_, n) => kw(20 + n, 10, ['lift recipe'], { createdAt: at(20 + n) })),
    kw(60, 10, ['camera'], { escape: 'lift recipe', createdAt: at(50) }),
    kw(61, 10, ['lift recipe'], { escape: 'lift recipe', createdAt: at(51) }),
    kw(62, null, [], { escape: 'lift recipe', createdAt: at(52) }),
  ];
  const series = diversitySeries(ideas);
  assert.equal(series.length, 34 - DIVERSITY_MIN + 1, 'one point per tagged bred idea from the 12th on');
  assert.ok(series[0].share < 0.1 && series.at(-1)!.share > MONOCULTURE_SHARE);
  const first = series.find((p) => p.monoculture)!;
  const p = pressureStats(ideas);
  assert.deepEqual(p.since, { id: first.id, at: first.at, keyword: 'lift recipe' }, 'the start of the current run above the line');
  assert.deepEqual([p.escapes, p.judged, p.left, p.last.id], [3, 2, 1, 62], 'one of two judged escapes really left the theme');
  assert.equal(pressureStats(ideas.slice(0, 14)).since, null, 'no monoculture, no start');
});
