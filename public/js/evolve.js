// Evolution autopilot: decides the next move. Pure, no DOM, no network.
//
// Not random merging: parents are picked by tournament selection on the
// judge's score, so strong ideas get more children. Now and then it "mutates"
// instead, expanding a strong idea that has not been expanded yet, which
// brings new material into the pool.

import { fitness, medal, CRITERIA, confidenceBand } from './score.js';

export const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Ideas that can breed: judged or hand-medalled. */
export function population(ideas) {
  return ideas.filter((i) => fitness(i) != null);
}

/** Pairs that must not be bred again: already combined, or parent and child. */
export function usedPairs(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const parentsOf = new Map();
  const used = new Set();
  for (const e of edges) {
    used.add(pairKey(e.from, e.to));
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, []);
    parentsOf.get(e.to).push(e.from);
  }
  for (const [child, parents] of parentsOf) {
    if (kindOf.get(child) === 'combine' && parents.length === 2) used.add(pairKey(parents[0], parents[1]));
  }
  return used;
}

/** Ideas that already have expand-children. */
export function expandedIds(ideas, edges) {
  const kindOf = new Map(ideas.map((i) => [i.id, i.kind]));
  const out = new Set();
  for (const e of edges) if (kindOf.get(e.to) === 'expand') out.add(e.from);
  return out;
}

// ---------------------------------------------------------------- lift recipes
//
// The jury writes, for every idea, one "lift recipe": the single change that
// would earn it the next medal, typed by the criterion it raises
// (originality, feasibility or impact). A child bred from that idea gets the
// recipe as its task and remembers which type it was handed (liftType) and
// its parent's medal at the time (liftBase). Once the child is judged, the
// recipe either lifted the medal or it did not, and that is counted here.

export const LIFT_TYPES = CRITERIA;

/** Per recipe type: how many judged children were bred with it, and how many beat their parent's medal. */
export function liftStats(ideas) {
  const out = Object.fromEntries(LIFT_TYPES.map((t) => [t, { tries: 0, hits: 0 }]));
  for (const i of ideas) {
    const hit = liftHit(i);
    if (hit == null) continue;
    out[i.liftType].tries++;
    if (hit) out[i.liftType].hits++;
  }
  return out;
}

/** Smoothed hit rate (Laplace): 0.5 with no data, never exactly 0 or 1. */
export function liftRate(stats, type) {
  const s = stats?.[type];
  return s ? (s.hits + 1) / (s.tries + 2) : 0.5;
}

/** Did this bred idea's recipe lift the medal? null: no recipe task, or not judged yet. */
export function liftHit(idea) {
  if (!LIFT_TYPES.includes(idea?.liftType) || !Number.isInteger(idea?.liftBase)) return null;
  const m = medal(idea);
  return m == null ? null : m > idea.liftBase;
}

/** The recipe an idea can hand on: it needs one, and gold has no next medal to reach. */
export function recipeOf(idea) {
  if (!LIFT_TYPES.includes(idea?.recipeType) || !idea?.recipe) return null;
  const base = medal(idea);
  if (base == null || base >= 3) return null;
  return { type: idea.recipeType, change: idea.recipe, from: idea, base };
}

/** For a cross: of the two parents' recipes, the one whose type has the better hit rate (a on a tie). */
export function pickRecipe(a, b, stats) {
  const ra = recipeOf(a);
  const rb = recipeOf(b);
  if (!ra || !rb) return ra ?? rb;
  return liftRate(stats, rb.type) > liftRate(stats, ra.type) ? rb : ra;
}

/**
 * What the tournament compares: fitness plus a nudge from the hit rate of the
 * idea's own recipe type. The nudge stays within ±0.5, so it never beats a
 * full point of jury score; it decides between ideas the jury scored the same.
 * A disagreeing second judge then takes off half the gap (doubtPenalty).
 */
export function breedScore(idea, stats) {
  const r = recipeOf(idea);
  return fitness(idea) + (r ? liftRate(stats, r.type) - 0.5 : 0) - doubtPenalty(idea);
}

/**
 * When a blind second judge disagreed with the jury, the idea breeds as if it
 * were worth half the gap less: a jury 13 against a second opinion of 11
 * breeds like a 12. Either direction counts, since disagreement is
 * uncertainty, not a verdict. A hand-set medal is a person's call: no penalty.
 */
export function doubtPenalty(idea) {
  if (Number.isInteger(idea?.medalOverride)) return 0;
  const band = confidenceBand(idea);
  return band ? band.gap / 2 : 0;
}

function tournament(pool, k, rng, stats) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!best || breedScore(c, stats) > breedScore(best, stats)) best = c;
  }
  return best;
}

/**
 * @param {Array} ideas  ideas on the board (with id, kind, scores)
 * @param {Array} edges  {from, to}
 * @param {object} opts  rng, busy (Set of ids being worked on), inFlight (Set of pair keys),
 *                       mutationRate, k (tournament size)
 * @returns {{type:'combine', a, b} | {type:'expand', idea} | null}
 */
export function nextMove(ideas, edges, opts = {}) {
  const { rng = Math.random, busy = new Set(), inFlight = new Set(), mutationRate = 0.2, k = 3 } = opts;
  const pool = population(ideas).filter((i) => !busy.has(i.id));
  const expanded = expandedIds(ideas, edges);
  const used = usedPairs(ideas, edges);
  const stats = liftStats(ideas);

  const bestUnexpanded = () =>
    [...pool].sort((a, b) => fitness(b) - fitness(a)).find((i) => !expanded.has(i.id));

  if (pool.length < 3 || rng() < mutationRate) {
    const idea = bestUnexpanded();
    if (idea) return { type: 'expand', idea };
  }

  if (pool.length >= 2) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = tournament(pool, k, rng, stats);
      const rest = pool.filter((i) => i.id !== a.id);
      const b = tournament(rest, k, rng, stats);
      const key = pairKey(a.id, b.id);
      if (used.has(key) || inFlight.has(key)) continue;
      return { type: 'combine', a, b };
    }
  }

  const idea = bestUnexpanded();
  return idea ? { type: 'expand', idea } : null;
}

/**
 * Has quality moved? Mean fitness of the first and the latest `window` bred
 * ideas (seeds and guests excluded: a bare topic scores low by design and
 * would flatter the climb, and guests were bred on another board), plus the best so far.
 */
export function evolutionStats(ideas, window = 8) {
  const bred = ideas
    .filter((i) => i.kind !== 'seed' && i.kind !== 'guest' && fitness(i) != null)
    .sort((a, b) => a.id - b.id);
  const mean = (xs) => (xs.length ? xs.reduce((s, i) => s + fitness(i), 0) / xs.length : null);
  const generation = ideas.reduce((g, i) => Math.max(g, i.generation || 0), 0);
  return {
    count: bred.length,
    generation,
    first: mean(bred.slice(0, window)),
    latest: bred.length > window ? mean(bred.slice(-window)) : null,
    best: bred.length ? Math.max(...bred.map(fitness)) : null,
  };
}
