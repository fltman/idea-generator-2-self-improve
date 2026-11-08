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
    const hit = liftHit(i); // recipe arm only: a placebo's luck must not steer breeding
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

/** Did this bred idea's recipe lift the medal? null: no recipe task (placebo and no-task children too), or not judged yet. */
export function liftHit(idea) {
  if (armOf(idea) !== 'recipe' || !LIFT_TYPES.includes(idea?.liftType)) return null;
  return armHit(idea);
}

// ---------------------------------------------------------------- placebo trials
//
// Do recipes beat chance? Borrowed from clinical trials: some breeds that
// would have been handed a recipe are randomly handed a placebo instead, a
// vague "improve it", and remember which recipe type was withheld. Breeds
// from parents below gold that have no recipe at all are a third, no-task arm.
// Every arm counts a hit the same way: the child's medal above liftBase.
// Only the recipe arm feeds liftStats(), so placebos never steer breeding.

/** Share of recipe breeds that get the placebo instead. */
export const PLACEBO_RATE = 0.2;
export const ARMS = ['recipe', 'placebo', 'none'];

/** Which arm a bred idea belongs to. Ideas from before the trials that carry a recipe type were recipe breeds. */
export function armOf(idea) {
  if (ARMS.includes(idea?.liftArm)) return idea.liftArm;
  return idea?.liftType ? 'recipe' : null;
}

/** Did the medal rise above the parent's, whatever the arm? null: in no arm, or not judged yet. */
export function armHit(idea) {
  if (!armOf(idea) || !Number.isInteger(idea?.liftBase)) return null;
  const m = medal(idea);
  return m == null ? null : m > idea.liftBase;
}

/**
 * The arm and task for a new breed from these parents (one for expand, two
 * for a cross). With a recipe: the recipe, or with chance PLACEBO_RATE the
 * placebo (same type, base and parent, no change). Without one: the no-task
 * arm, measured against the best parent below gold. null when no parent can
 * be lifted (all gold or unjudged).
 * @returns {{arm, type, change, from, base} | null}
 */
export function assignArm(parents, stats, rng = Math.random) {
  const r = parents.length === 2 ? pickRecipe(parents[0], parents[1], stats) : recipeOf(parents[0]);
  if (r) return rng() < PLACEBO_RATE ? { ...r, arm: 'placebo', change: null } : { ...r, arm: 'recipe' };
  const liftable = parents.filter((p) => medal(p) != null && medal(p) < 3);
  if (!liftable.length) return null;
  const from = liftable.reduce((a, b) => (medal(b) > medal(a) ? b : a));
  return { arm: 'none', type: null, change: null, from, base: medal(from) };
}

/** Per arm: hits and tries per recipe type (recipe, placebo) and in total (all three). */
export function trialStats(ideas) {
  const cell = () => ({ tries: 0, hits: 0 });
  const out = Object.fromEntries(ARMS.map((a) => [a, { total: cell(), byType: Object.fromEntries(LIFT_TYPES.map((t) => [t, cell()])) }]));
  for (const i of ideas) {
    const hit = armHit(i);
    if (hit == null) continue;
    const arm = out[armOf(i)];
    for (const c of [arm.total, arm.byType[i.liftType]]) {
      if (!c) continue;
      c.tries++;
      if (hit) c.hits++;
    }
  }
  return out;
}

/** Fewer judged children than this in either arm, and the comparison says "too early". */
export const TRIAL_MIN = 10;

/**
 * Recipe arm against placebo arm, in total: the difference in raw hit rate,
 * or why there is none yet. Not a significance test; a plain reading.
 * @returns {{verdict:'early'|'ahead'|'even'|'behind', diff:number|null}}
 */
export function trialVerdict(stats) {
  const r = stats.recipe.total, p = stats.placebo.total;
  if (r.tries < TRIAL_MIN || p.tries < TRIAL_MIN) return { verdict: 'early', diff: null };
  const diff = r.hits / r.tries - p.hits / p.tries;
  return { verdict: diff > 0.1 ? 'ahead' : diff < -0.1 ? 'behind' : 'even', diff };
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

// ---------------------------------------------------------------- diversity pressure
//
// Tournament selection keeps crossing the strongest ideas, and the strongest
// ideas tend to share one lineage and one theme, so a board can drift into a
// monoculture. The jury tags every idea with 2–4 keywords from a shared
// vocabulary; the share of recent bred ideas that carry the most common one
// measures how concentrated the board is. Above MONOCULTURE_SHARE the
// autopilot takes at least one parent from outside that theme (or expands an
// idea outside it). Within that pool the tournament still ranks by breedScore.

/** How many recent bred ideas the gauge looks at. */
export const DIVERSITY_WINDOW = 24;
/** Fewer keyworded bred ideas than this, and no monoculture is declared. */
export const DIVERSITY_MIN = 12;
/** Share of the window carrying one keyword at which the pressure kicks in. */
export const MONOCULTURE_SHARE = 0.6;

/** Bred ideas the jury has tagged, oldest first (seeds and guests excluded, as in evolutionStats). */
function tagged(ideas) {
  return ideas.filter((i) => i.kind !== 'seed' && i.kind !== 'guest' && i.keywords?.length).sort((a, b) => a.id - b.id);
}

/** The keyword carried by most of these ideas (alphabetical on a tie) and its share. */
function concentration(list) {
  const counts = new Map();
  for (const i of list) for (const k of new Set(i.keywords)) counts.set(k, (counts.get(k) ?? 0) + 1);
  let keyword = null, count = 0;
  for (const [k, n] of counts) if (n > count || (n === count && k < keyword)) [keyword, count] = [k, n];
  return { keyword, count, total: list.length, share: list.length ? count / list.length : 0 };
}

/**
 * How concentrated the board is now: the dominant keyword among the last
 * `window` bred ideas, its share, and whether that is a monoculture.
 * @returns {{keyword:string|null, count:number, total:number, share:number, monoculture:boolean}}
 */
export function diversity(ideas, window = DIVERSITY_WINDOW) {
  const recent = tagged(ideas).slice(-window);
  const c = concentration(recent);
  return { ...c, monoculture: recent.length >= DIVERSITY_MIN && c.share >= MONOCULTURE_SHARE };
}

/** The gauge over time: after each bred idea (from the DIVERSITY_MIN-th on), the dominant keyword's share of the window ending there. */
export function diversitySeries(ideas, window = DIVERSITY_WINDOW) {
  const list = tagged(ideas);
  const out = [];
  for (let n = DIVERSITY_MIN; n <= list.length; n++) {
    const c = concentration(list.slice(Math.max(0, n - window), n));
    out.push({ id: list[n - 1].id, at: list[n - 1].createdAt ?? null, keyword: c.keyword, share: c.share, monoculture: c.share >= MONOCULTURE_SHARE });
  }
  return out;
}

/**
 * When the current monoculture began (the first point of the latest run above
 * the line, null if the board is not in one now), and what the pressure has
 * done since: breeds the autopilot made outside the theme (idea.escape), and
 * of those judged, how many really left it (the jury did not tag them with it).
 */
export function pressureStats(ideas, window = DIVERSITY_WINDOW) {
  const series = diversitySeries(ideas, window);
  let start = null;
  for (let n = series.length - 1; n >= 0 && series[n].monoculture; n--) start = series[n];
  const escapes = ideas.filter((i) => i.escape);
  const judged = escapes.filter((i) => i.keywords?.length);
  return {
    since: start ? { id: start.id, at: start.at, keyword: start.keyword } : null,
    escapes: escapes.length,
    judged: judged.length,
    left: judged.filter((i) => !i.keywords.includes(i.escape)).length,
    last: escapes.length ? escapes.reduce((a, b) => (b.id > a.id ? b : a)) : null,
  };
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
 *                       mutationRate, k (tournament size), diversity (false: no diversity pressure)
 * @returns {{type:'combine', a, b, escape?} | {type:'expand', idea, escape?} | null}
 *          escape: the dominant keyword, when the move takes a parent from outside a monoculture.
 */
export function nextMove(ideas, edges, opts = {}) {
  const { rng = Math.random, busy = new Set(), inFlight = new Set(), mutationRate = 0.2, k = 3 } = opts;
  const pool = population(ideas).filter((i) => !busy.has(i.id));
  const expanded = expandedIds(ideas, edges);
  const used = usedPairs(ideas, edges);
  const stats = liftStats(ideas);

  // Diversity pressure: in a monoculture, one parent comes from outside the theme.
  const div = opts.diversity === false ? null : diversity(ideas);
  const theme = div?.monoculture ? div.keyword : null;
  const outside = theme ? pool.filter((i) => !i.keywords?.includes(theme)) : [];
  const isOut = new Set(outside.map((i) => i.id));
  const mark = (m) => (theme && [m.idea, m.a, m.b].some((p) => p && isOut.has(p.id)) ? { ...m, escape: theme } : m);

  const bestUnexpanded = (from) =>
    [...from].sort((a, b) => fitness(b) - fitness(a)).find((i) => !expanded.has(i.id));
  const bestToExpand = () => (outside.length && bestUnexpanded(outside)) || bestUnexpanded(pool);

  if (pool.length < 3 || rng() < mutationRate) {
    const idea = bestToExpand();
    if (idea) return mark({ type: 'expand', idea });
  }

  if (pool.length >= 2) {
    const first = outside.length ? outside : pool;
    for (let attempt = 0; attempt < 40; attempt++) {
      const a = tournament(first, k, rng, stats);
      const rest = pool.filter((i) => i.id !== a.id);
      const b = tournament(rest, k, rng, stats);
      const key = pairKey(a.id, b.id);
      if (used.has(key) || inFlight.has(key)) continue;
      return mark({ type: 'combine', a, b });
    }
  }

  const idea = bestToExpand();
  return idea ? mark({ type: 'expand', idea }) : null;
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
