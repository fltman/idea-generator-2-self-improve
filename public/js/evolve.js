// Evolution autopilot: decides the next move. Pure, no DOM, no network.
//
// Not random merging: parents are picked by tournament selection on the
// judge's score, so strong ideas get more children. Now and then it "mutates"
// instead, expanding a strong idea that has not been expanded yet, which
// brings new material into the pool.

import { fitness, medal, CRITERIA, confidenceBand, scoreSum, isJudged } from './score.js';

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

/**
 * Did this bred idea's recipe lift the medal? null: no recipe task (placebo
 * and no-task children too), not judged yet, or the recipe check ruled that
 * the child ignored its recipe (then the recipe was never tried, so it is
 * neither a hit nor a miss). Unchecked children (older ideas, a failed check)
 * still count, as they did before the check existed. With a blind duel
 * (build 0009) the duel decides: a hit is the child beating its parent on the
 * recipe's criterion. Without one, a hit is the medal rising above liftBase.
 */
export function liftHit(idea) {
  if (armOf(idea) !== 'recipe' || !LIFT_TYPES.includes(idea?.liftType)) return null;
  if (idea.liftApplied === false) return null;
  if (armHit(idea) == null) return null; // not judged yet
  const d = duelHit(idea);
  return d ?? armHit(idea);
}

// ---------------------------------------------------------------- blind duel
//
// A medal is a coarse ruler: a recipe can sharpen a child without crossing a
// threshold, and a child can cross one by noise. After the verdict, the judge
// model reads child and parent side by side as "A" and "B" in random order
// (no recipe, scores or lineage) and names a winner per criterion
// (idea.duel: 'child' | 'parent' | 'tie' each). For a recipe child with a
// duel, the hit is the child winning the recipe's own criterion; a tie is a
// miss. Children without a duel keep the medal rule.

export const DUEL_SIDES = ['child', 'parent', 'tie'];

/** Did the child win its recipe's criterion in the blind duel? null: no duel, or not a recipe child. */
export function duelHit(idea) {
  if (armOf(idea) !== 'recipe' || !LIFT_TYPES.includes(idea?.liftType)) return null;
  const w = idea.duel?.[idea.liftType];
  return DUEL_SIDES.includes(w) ? w === 'child' : null;
}

/**
 * Judged recipe children that have a duel: how many won the recipe's
 * criterion in the duel, how many rose a medal, and per criterion how often
 * the child, the parent or neither won.
 */
export function duelStats(ideas) {
  const out = { n: 0, duelHits: 0, medalHits: 0, byCriterion: Object.fromEntries(LIFT_TYPES.map((c) => [c, { child: 0, parent: 0, tie: 0 }])) };
  for (const i of ideas) {
    const d = duelHit(i);
    const m = armHit(i);
    if (d == null || m == null) continue;
    out.n++;
    if (d) out.duelHits++;
    if (m) out.medalHits++;
    for (const c of LIFT_TYPES) if (DUEL_SIDES.includes(i.duel[c])) out.byCriterion[c][i.duel[c]]++;
  }
  return out;
}

// ---------------------------------------------------------------- recipe check
//
// A child handed a recipe may simply not carry it out. After the jury's
// verdict, the judge model reads parent, recipe and child (no scores) and
// rules 'applied' or 'ignored' (idea.liftApplied true/false). Only applied
// and unchecked recipe children feed liftStats(); the overview splits the
// recipe arm's hit rate by that status, so you can see whether ignoring the
// recipe was what kept the hit rate down.

export const APPLIED_STATUSES = ['applied', 'ignored', 'unchecked'];

/** 'applied', 'ignored' or 'unchecked' for a recipe-arm child; null for anything else. */
export function appliedStatus(idea) {
  if (armOf(idea) !== 'recipe') return null;
  return idea.liftApplied === true ? 'applied' : idea.liftApplied === false ? 'ignored' : 'unchecked';
}

/** Recipe-arm children that have been judged: hits and tries per applied status. */
export function appliedStats(ideas) {
  const out = Object.fromEntries(APPLIED_STATUSES.map((s) => [s, { tries: 0, hits: 0 }]));
  for (const i of ideas) {
    const status = appliedStatus(i);
    const hit = status && armHit(i);
    if (status == null || hit == null) continue;
    out[status].tries++;
    if (hit) out[status].hits++;
  }
  return out;
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
export const ARMS = ['recipe', 'placebo', 'none', 'control'];

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

// ---------------------------------------------------------------- control siblings and net lift
//
// A raw hit rate flatters nothing and blames nothing: a bronze parent's child
// may land on silver by luck, or fall back by regression to the mean, with or
// without a recipe. So every CONTROL_EVERY-th recipe cross the autopilot makes
// gets a control sibling: the same two parents crossed again with no task at
// all (arm 'control', liftType the withheld type, same liftBase). The net
// lift of a recipe type is the mean medal gain of its recipe children minus
// the mean gain of its control siblings. Placebos still never steer breeding.

/** Every this many recipe crosses on a board, the autopilot breeds one control sibling. */
export const CONTROL_EVERY = 4;

/** Is a control sibling due after this many recipe-arm crosses? (Counted after the newest one was made.) */
export const controlDue = (recipeCrosses) => recipeCrosses > 0 && recipeCrosses % CONTROL_EVERY === 0;

/** Medal steps gained over the parent's medal at breeding time (negative: it fell). null: in no arm, or not judged. */
export function medalGain(idea) {
  if (!armOf(idea) || !Number.isInteger(idea?.liftBase)) return null;
  const m = medal(idea);
  return m == null ? null : m - idea.liftBase;
}

/**
 * Per recipe type: n and mean gain in the recipe arm, n and mean gain in the
 * control arm, and the net lift (recipe mean minus control mean), null until
 * both arms have at least one judged child of that type.
 * @returns {Record<string, {n:number, gain:number|null, controlN:number, controlGain:number|null, net:number|null}>}
 */
export function netLiftStats(ideas) {
  const sums = Object.fromEntries(LIFT_TYPES.map((t) => [t, { recipe: [0, 0], control: [0, 0] }]));
  for (const i of ideas) {
    const arm = armOf(i);
    if ((arm !== 'recipe' && arm !== 'control') || !sums[i.liftType]) continue;
    const g = medalGain(i);
    if (g == null) continue;
    sums[i.liftType][arm][0]++;
    sums[i.liftType][arm][1] += g;
  }
  const mean = ([n, s]) => (n ? s / n : null);
  return Object.fromEntries(LIFT_TYPES.map((t) => {
    const r = sums[t].recipe, c = sums[t].control;
    const gain = mean(r), controlGain = mean(c);
    return [t, { n: r[0], gain, controlN: c[0], controlGain, net: gain == null || controlGain == null ? null : gain - controlGain }];
  }));
}

/**
 * The selection nudge from a type's net lift, strictly within ±0.5 like the
 * hit-rate nudge it replaces, and shrunk toward 0 while the smaller arm is
 * small (one control sibling counts for a third of its face value). null: no
 * net lift yet, so the caller falls back to the hit rate.
 */
export function netNudge(net, type) {
  const s = net?.[type];
  if (!s || s.net == null) return null;
  const k = Math.min(s.n, s.controlN);
  return (k / (k + 2)) * (s.net / (2 * (Math.abs(s.net) + 1)));
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
 * Once control siblings exist for the type (net: netLiftStats), the net lift
 * over control decides instead of the raw hit rate (netNudge, also within ±0.5).
 * A disagreeing second judge then takes off half the gap (doubtPenalty).
 */
export function breedScore(idea, stats, net = null) {
  const r = recipeOf(idea);
  const nudge = r ? netNudge(net, r.type) ?? liftRate(stats, r.type) - 0.5 : 0;
  return fitness(idea) + nudge - doubtPenalty(idea);
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

function tournament(pool, k, rng, stats, net) {
  let best = null;
  for (let i = 0; i < k; i++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (!best || breedScore(c, stats, net) > breedScore(best, stats, net)) best = c;
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
  const net = netLiftStats(ideas);

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
      const a = tournament(first, k, rng, stats, net);
      const rest = pool.filter((i) => i.id !== a.id);
      const b = tournament(rest, k, rng, stats, net);
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

// ---------------------------------------------------------------- idea styles
//
// Which framing earns medals? Every breed (expand or cross) draws one of four
// writing styles by lot, the prompt demands it, and the child remembers it.
// The draw is independent of the trial arm and of the parents, so the medal
// rate per style is a clean comparison. Styles are measured, never used to
// steer breeding.

export const STYLES = ['scenario', 'mechanism', 'analogy', 'metric'];
/** Fewer judged children than this in a style, and its row says "too early". */
export const STYLE_MIN = 10;

/** One style by lot (uniform). */
export function drawStyle(rng = Math.random) {
  return STYLES[Math.min(STYLES.length - 1, Math.floor(rng() * STYLES.length))];
}

/**
 * Per style: judged children, how many earned a medal (bronze or better) and
 * how many gold, and whether there are too few to read yet. Unknown styles and
 * unjudged ideas are skipped.
 * @returns {Record<string, {n:number, medals:number, golds:number, rate:number|null, early:boolean}>}
 */
export function styleStats(ideas) {
  const out = Object.fromEntries(STYLES.map((s) => [s, { n: 0, medals: 0, golds: 0, rate: null, early: true }]));
  for (const i of ideas) {
    const c = out[i?.style];
    const m = medal(i);
    if (!c || m == null) continue;
    c.n++;
    if (m >= 1) c.medals++;
    if (m >= 3) c.golds++;
  }
  for (const c of Object.values(out)) {
    c.rate = c.n ? c.medals / c.n : null;
    c.early = c.n < STYLE_MIN;
  }
  return out;
}

// ---------------------------------------------------------------- wording gap
//
// Blinded peer review (build 0011): the judge model rewrites an idea in plain
// wording and the ordinary jury prompt scores the rewrite, blind. The gap is
// the jury's sum minus the plain sum. A gap above PLAIN_GAP (the judge's
// run-to-run spread is about 1) means the wording, not the substance, carried
// the score: the idea is "style-carried". Measured, never used to steer.

/** A gap above this many points marks an idea style-carried. */
export const PLAIN_GAP = 1;
/** The overview lists at most this many keywords. */
export const WORDING_TOP = 8;

/** The jury's sum minus the plain rewrite's sum. null: no rescore, or the idea is not judged. */
export function plainGap(idea) {
  const p = idea?.plain;
  const s = scoreSum(idea);
  if (s == null || !p || !CRITERIA.every((c) => Number.isInteger(p[c]))) return null;
  return s - (p.originality + p.feasibility + p.impact);
}

/** Did the wording carry the score (gap above PLAIN_GAP)? null: no rescore. */
export function styleCarried(idea) {
  const g = plainGap(idea);
  return g == null ? null : g > PLAIN_GAP;
}

/**
 * Rescored ideas in total and per first keyword: n, how many are
 * style-carried with the rate, and the mean gap. Keywords sorted by n (ties
 * alphabetical), at most WORDING_TOP; ideas with no keyword count in the total only.
 * @returns {{n:number, carried:number, rate:number|null, meanGap:number|null, keywords:{keyword:string, n:number, carried:number, rate:number, meanGap:number}[]}}
 */
export function wordingStats(ideas) {
  const row = () => ({ n: 0, carried: 0, gapSum: 0 });
  const total = row();
  const by = new Map();
  for (const i of ideas) {
    const g = plainGap(i);
    if (g == null) continue;
    const rows = [total];
    const kw = i.keywords?.[0];
    if (kw) {
      if (!by.has(kw)) by.set(kw, row());
      rows.push(by.get(kw));
    }
    for (const r of rows) {
      r.n++;
      r.gapSum += g;
      if (g > PLAIN_GAP) r.carried++;
    }
  }
  const fin = (r) => ({ n: r.n, carried: r.carried, rate: r.n ? r.carried / r.n : null, meanGap: r.n ? r.gapSum / r.n : null });
  const keywords = [...by.entries()]
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, WORDING_TOP)
    .map(([keyword, r]) => ({ keyword, ...fin(r) }));
  return { ...fin(total), keywords };
}

// ---------------------------------------------------------------- spores
// Ideas that spread between boards on their own, like spores: now and then the
// autopilot sends a board's strongest unsent idea (silver or better) to the
// spore board it fits best, judged by the keywords the two share. There it is
// a guest, judged against that board's own goal; if it earns a medal it has
// taken root, and it cross-breeds with the locals like any guest.

/** Bred ideas on a board between two spores. */
export const SPORE_EVERY = 10;
/** The lowest medal a spore may carry (2 = silver). */
export const SPORE_MIN_MEDAL = 2;

/** Is the board due to release a spore? `lastSporeAt`: id of the newest home idea when the last spore left (0: never). */
export function sporeDue(ideas, lastSporeAt = 0) {
  return ideas.filter((i) => i.id > lastSporeAt && (i.kind === 'expand' || i.kind === 'combine')).length >= SPORE_EVERY;
}

/** The board's strongest idea that may leave: its own (not a guest), silver or better, not sent before. */
export function pickSpore(ideas, sent = new Set()) {
  let best = null;
  for (const i of ideas) {
    if (i.kind === 'guest' || sent.has(i.id) || medal(i) < SPORE_MIN_MEDAL) continue;
    if (!best || fitness(i) > fitness(best) || (fitness(i) === fitness(best) && i.id < best.id)) best = i;
  }
  return best;
}

/**
 * Where a spore lands: the candidate board sharing most of the spore's
 * keywords with its own top keywords. A random draw under 1 breaks ties, so
 * with no overlap anywhere it drifts to a random board (spores travel blind).
 * @param {{keywords?: string[]}} idea
 * @param {{id: number, keywords: string[]}[]} boards  candidates (other spore boards that do not have it yet)
 * @returns {{boardId: number, shared: string[]} | null}
 */
export function sporeTarget(idea, boards, rng = Math.random) {
  const mine = new Set((idea.keywords ?? []).map((k) => k.toLowerCase()));
  let best = null;
  for (const b of boards) {
    const shared = b.keywords.filter((k) => mine.has(k.toLowerCase()));
    const score = shared.length + rng() * 0.99;
    if (!best || score > best.score) best = { boardId: b.id, shared, score };
  }
  return best && { boardId: best.boardId, shared: best.shared };
}

/** Has a spore taken root where it landed? Judged there and earned a medal (bronze or better). */
export function sporeRooted(guest) {
  return isJudged(guest) || guest.medalOverride != null ? medal(guest) >= 1 : null;
}

/**
 * What spores did for a board: those it sent (`out`: guests on other boards
 * whose origin is here) and those it took in (its own spore guests, with how
 * many children each has bred here).
 */
export function sporeStats(out, ideas, edges = []) {
  const count = (list) => ({
    n: list.length,
    judged: list.filter((g) => sporeRooted(g) !== null).length,
    rooted: list.filter((g) => sporeRooted(g) === true).length,
  });
  const arrived = ideas.filter((i) => i.spore);
  const kids = (id) => edges.filter((e) => e.from === id).length;
  return {
    sent: count(out),
    arrived: { ...count(arrived), children: arrived.reduce((s, g) => s + kids(g.id), 0) },
  };
}

// ---------------------------------------------------------------- scrap heap
// Build 0012. A wilted idea has bred WILT_CHILDREN or more judged children and
// none rose above its own medal: selection keeps picking it, and it keeps
// failing to pass anything on. Every SCRAP_EVERY bred ideas (or when the
// autopilot has nothing else to do) a board with the scrap heap on draws one
// wilted idea by lot, weighted by how unlike the living pool its keywords are,
// and crosses it with the fittest living idea. The task is the jury's own
// reason for the wilted idea's score. The child remembers where it came from
// (idea.scrap) and the overview compares the medal rate of scrap children with
// normal breeds. Measured and shown; selection treats scrap children like any other.

/** Judged children an idea must have bred, none above its medal, to count as wilted. */
export const WILT_CHILDREN = 5;
/** Bred ideas on a board between two scrap draws. */
export const SCRAP_EVERY = 8;
/** Lowest draw weight, so a wilted idea close to the pool can still come up. */
export const SCRAP_FLOOR = 0.1;
/** The gap (scrap medal rate minus normal medal rate) the scrap heap aims for, in percentage points. */
export const SCRAP_TARGET = 10;
/** Fewer judged scrap children than this, and the gap reads "too early". */
export const SCRAP_MIN = 10;

const isBred = (i) => i.kind === 'expand' || i.kind === 'combine';

/** Wilted ideas: own (not guests), judged below gold with a jury reason, WILT_CHILDREN+ judged children, none above its medal. */
export function wilted(ideas, edges) {
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const kids = new Map();
  for (const e of edges) {
    const c = byId.get(e.to);
    if (!c || medal(c) == null) continue;
    if (!kids.has(e.from)) kids.set(e.from, []);
    kids.get(e.from).push(c);
  }
  return ideas.filter((i) => {
    const m = medal(i);
    const ks = kids.get(i.id) ?? [];
    return i.kind !== 'guest' && isJudged(i) && !!i.reason && m < 3 && ks.length >= WILT_CHILDREN && ks.every((c) => medal(c) <= m);
  });
}

/**
 * How unlike the living pool an idea's keywords are, 0–1: one minus the mean
 * share of living ideas that carry each of its keywords. null: no keywords.
 */
export function keywordDistance(idea, living) {
  const kws = [...new Set(idea?.keywords ?? [])];
  if (!kws.length) return null;
  const others = living.filter((i) => i.id !== idea.id);
  if (!others.length) return 1;
  const share = (k) => others.filter((i) => i.keywords?.includes(k)).length / others.length;
  return 1 - kws.reduce((s, k) => s + share(k), 0) / kws.length;
}

/** Is the board due for a scrap draw? SCRAP_EVERY bred ideas newer than its last scrap child. */
export function scrapDue(ideas) {
  const last = ideas.reduce((m, i) => (i.scrap ? Math.max(m, i.id) : m), 0);
  return ideas.filter((i) => i.id > last && isBred(i) && !i.scrap).length >= SCRAP_EVERY;
}

/**
 * The scrap draw: one wilted idea not drawn before, by lot weighted by its
 * keyword distance from the living pool (at least SCRAP_FLOOR), and as its
 * partner the fittest living idea it has not been crossed with (on a tie the
 * one sharing fewest keywords, then the older).
 * @returns {{wilt, partner, distance:number|null} | null}
 */
export function drawScrap(ideas, edges, rng = Math.random) {
  const wilt = wilted(ideas, edges);
  const wiltIds = new Set(wilt.map((i) => i.id));
  const drawn = new Set(ideas.filter((i) => i.scrap).map((i) => i.scrap.from));
  const living = population(ideas).filter((i) => !wiltIds.has(i.id));
  const used = usedPairs(ideas, edges);
  const cands = wilt
    .filter((w) => !drawn.has(w.id) && living.some((p) => !used.has(pairKey(w.id, p.id))))
    .map((w) => {
      const distance = keywordDistance(w, living);
      return { w, distance, weight: Math.max(SCRAP_FLOOR, distance ?? 0) };
    });
  if (!cands.length) return null;
  let r = rng() * cands.reduce((s, c) => s + c.weight, 0);
  let pick = cands[cands.length - 1];
  for (const c of cands) {
    r -= c.weight;
    if (r < 0) {
      pick = c;
      break;
    }
  }
  const overlap = (p) => (p.keywords ?? []).filter((k) => pick.w.keywords?.includes(k)).length;
  const partner = living
    .filter((p) => !used.has(pairKey(pick.w.id, p.id)))
    .sort((a, b) => fitness(b) - fitness(a) || overlap(a) - overlap(b) || a.id - b.id)[0];
  return { wilt: pick.w, partner, distance: pick.distance };
}

/**
 * Scrap children versus normal breeds (expand and cross children that are not
 * scrap): judged n, medals (bronze or better: the survivors) and rate; the gap
 * in percentage points; the mean draw distance; and the survivors, best first.
 */
export function scrapStats(ideas) {
  const judged = ideas.filter((i) => isBred(i) && medal(i) != null);
  const cell = (list) => {
    const medals = list.filter((i) => medal(i) >= 1).length;
    return { n: list.length, medals, rate: list.length ? medals / list.length : null };
  };
  const scrap = cell(judged.filter((i) => i.scrap));
  const normal = cell(judged.filter((i) => !i.scrap));
  const dists = ideas.filter((i) => i.scrap && typeof i.scrap.distance === 'number').map((i) => i.scrap.distance);
  const gap = scrap.rate == null || normal.rate == null ? null : Math.round((scrap.rate - normal.rate) * 100);
  return {
    drawn: ideas.filter((i) => i.scrap).length,
    scrap,
    normal,
    gap,
    early: scrap.n < SCRAP_MIN,
    onTarget: gap != null && gap >= SCRAP_TARGET,
    distance: dists.length ? dists.reduce((s, d) => s + d, 0) / dists.length : null,
    survivors: judged.filter((i) => i.scrap && medal(i) >= 1).sort((a, b) => fitness(b) - fitness(a) || b.id - a.id),
  };
}

// ---------------------------------------------------------------- flight recorder (build 0013)

/**
 * Seconds and dollars per medal, per role. `recorder` is the server's
 * callStats() (roles: role, n, failed, lost, usd, seconds); the medals are the
 * board's ideas with bronze or better (jury or hand). Each role's total is
 * divided by all the board's medals, not by the medals that role helped make:
 * every step of the loop pays for the medals together. null per medal when the
 * board has none yet. Measured, never used: nothing in selection reads it.
 */
export function flightStats(recorder, ideas) {
  const medals = ideas.filter((i) => (medal(i) ?? 0) >= 1).length;
  const per = (x) => (medals ? x / medals : null);
  const rows = (recorder?.roles ?? []).map((r) => ({ ...r, usdPerMedal: per(r.usd), secPerMedal: per(r.seconds) }));
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const total = {
    role: 'total', n: sum('n'), failed: sum('failed'), lost: sum('lost'),
    usd: sum('usd'), seconds: sum('seconds'), usdPerMedal: per(sum('usd')), secPerMedal: per(sum('seconds')),
  };
  return { medals, rows, total, restarts: recorder?.restarts ?? 0, lost: recorder?.lost ?? 0, lastRestart: recorder?.lastRestart ?? null };
}
