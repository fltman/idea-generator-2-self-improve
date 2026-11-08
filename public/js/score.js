// Scoring shared by the server, the browser and the tests. Pure, no DOM.
//
// The judge scores three criteria 1–5. The medal comes from the sum (3–15)
// in code, never from the model, so the thresholds stay put when the prompt
// changes. Gold must be rare: an uncalibrated LLM jury gave 3/3 to the bare
// word "fire", which makes "gold" meaningless.

export const CRITERIA = ['originality', 'feasibility', 'impact'];

// Medal index: 0 none, 1 bronze, 2 silver, 3 gold.
export const MEDAL_MIN_SUM = { 1: 9, 2: 11, 3: 13 };

export function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 1;
  return Math.min(5, Math.max(1, v));
}

export function isJudged(idea) {
  return CRITERIA.every((c) => Number.isInteger(idea?.[c]));
}

export function scoreSum(idea) {
  if (!isJudged(idea)) return null;
  return idea.originality + idea.feasibility + idea.impact;
}

export function medalFromSum(sum) {
  if (sum == null) return null;
  if (sum >= MEDAL_MIN_SUM[3]) return 3;
  if (sum >= MEDAL_MIN_SUM[2]) return 2;
  if (sum >= MEDAL_MIN_SUM[1]) return 1;
  return 0;
}

/** Medal shown for an idea: a hand-set medal wins over the judge. null = not judged yet. */
export function medal(idea) {
  if (Number.isInteger(idea?.medalOverride)) return idea.medalOverride;
  return medalFromSum(scoreSum(idea));
}

// A hand-set medal counts as a typical sum for that medal when breeding.
const OVERRIDE_FITNESS = [6, 10, 12, 14];

/** What evolution selects on. null = not part of the population yet. */
export function fitness(idea) {
  if (Number.isInteger(idea?.medalOverride)) return OVERRIDE_FITNESS[idea.medalOverride];
  return scoreSum(idea);
}

// ---------------------------------------------------------------- second opinion
//
// A verdict whose sum sits exactly on a medal threshold (9, 11, 13) is one
// point from a different medal, so it is the verdict most worth doubting. A
// second judge, on another model and blind to the first verdict, re-scores it
// (idea.retrial). The two sums form a confidence band; the medal still comes
// from the first jury, and the gap only lowers the breeding score (evolve.js).

const EDGES = Object.values(MEDAL_MIN_SUM);

/** Judged by the jury (not hand-medalled) with a sum exactly on a medal threshold. */
export function onMedalEdge(idea) {
  if (Number.isInteger(idea?.medalOverride)) return false;
  return EDGES.includes(scoreSum(idea));
}

/** The second judge's sum, or null if there is none (or it is malformed). */
export function retrialSum(idea) {
  const r = idea?.retrial;
  if (!r || !CRITERIA.every((c) => Number.isInteger(r[c]))) return null;
  return r.originality + r.feasibility + r.impact;
}

/**
 * The confidence band between the two judges: low and high sum, their medals,
 * and the gap. null until both have scored.
 */
export function confidenceBand(idea) {
  const a = scoreSum(idea);
  const b = retrialSum(idea);
  if (a == null || b == null) return null;
  const low = Math.min(a, b), high = Math.max(a, b);
  return { first: a, second: b, low, high, gap: high - low, medals: [medalFromSum(low), medalFromSum(high)], agree: medalFromSum(a) === medalFromSum(b) };
}

/**
 * Whether a jury gold may be built (self-improvement boards). A gold sum of
 * exactly 13 is one point from silver, so it waits for the blind second judge:
 *   'build'     clear gold (14–15): build at once
 *   'waiting'   gold on the edge, no second opinion yet
 *   'agreed'    the second judge also gave gold: build
 *   'contested' the second judge gave less: wait for a human
 * null when the idea is not a jury gold (a hand-set medal is the human's call).
 */
export function goldGate(idea) {
  if (Number.isInteger(idea?.medalOverride)) return null;
  if (medalFromSum(scoreSum(idea)) !== 3) return null;
  if (!onMedalEdge(idea)) return 'build';
  const r = retrialSum(idea);
  if (r == null) return 'waiting';
  return medalFromSum(r) === 3 ? 'agreed' : 'contested';
}
