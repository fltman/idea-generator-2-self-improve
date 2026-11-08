// Pause banner (build 0014): when the autopilot stops at a cap, say which cap,
// its value, when it lifts by itself, and price a one-click raise in medals.
// Pure, no DOM, no network: shared by the browser and the tests.

/** The autopilot states that are a tripped cap (backoff and errors are not caps). */
export const PAUSE_CAPS = ['board_budget', 'global_budget', 'hourly'];

/** A priced resume buys this many medals' worth of spend at the board's measured cost per medal. */
export const RESUME_MEDALS = 3;

/** Without cost data, raise a dollar cap by this share of itself (at least FALLBACK_MIN_USD). */
export const FALLBACK_SHARE = 0.25;
export const FALLBACK_MIN_USD = 0.5;

/** Hourly cap: raise steps per hour by FALLBACK_SHARE, at least this many steps. */
export const HOURLY_MIN_STEPS = 5;

/** Up to the next cent: the board config keeps two decimals, and rounding down could buy less than promised. */
const cents = (x) => Math.ceil(x * 100 - 1e-9) / 100;

/**
 * The banner's model, or null when the autopilot is not paused at a cap.
 *   status      the autopilot status ({ state, until, spentToday, stepsLastHour })
 *   rate        the board's config.rate ({ usdPerDay, stepsPerHour })
 *   globalCap   the app's maxUsdPerDay; globalSpent today's spend across boards (may be null)
 *   usdPerMedal flightStats(…).total.usdPerMedal (null when there is no cost data)
 *   medals      how many medals that figure rests on
 * Returns { cap, value, spent, until, raise: { by, to, usd }, forecast }.
 * For a dollar cap `by` and `usd` are the same dollars, RESUME_MEDALS times
 * the cost per medal; `forecast` is { medals, usdPerMedal, basis }, the medals
 * the room above today's spend buys at that cost. Without cost data the raise
 * is a plain +25% (at least $0.50) and `forecast` is null. For the hourly cap
 * `by` is steps and `usd` and `forecast` are null: a step cap is not priced
 * (the recorder knows dollars per medal, not steps per medal).
 */
export function pauseBanner({ status, rate, globalCap = null, globalSpent = null, usdPerMedal = null, medals = 0 }) {
  const state = status?.state;
  if (!PAUSE_CAPS.includes(state)) return null;
  const until = status.until ?? null;

  if (state === 'hourly') {
    const value = rate?.stepsPerHour ?? 0;
    const by = Math.max(HOURLY_MIN_STEPS, Math.ceil(value * FALLBACK_SHARE));
    return { cap: 'hourly', value, spent: status.stepsLastHour ?? null, until, raise: { by, to: value + by, usd: null }, forecast: null };
  }

  const priced = Number.isFinite(usdPerMedal) && usdPerMedal > 0;
  const value = state === 'global_budget' ? (globalCap ?? 0) : (rate?.usdPerDay ?? 0);
  const spent = state === 'global_budget' ? globalSpent : (status.spentToday ?? null);
  const by = priced ? cents(usdPerMedal * RESUME_MEDALS) : cents(Math.max(FALLBACK_MIN_USD, value * FALLBACK_SHARE));
  // Spend can overshoot a cap (the check runs before a step, not during it).
  // The new cap must end above today's spend, or the click would resume nothing.
  const base = Math.max(spent ?? value, value);
  const to = cents(base + by);
  const usd = cents(to - value);
  return {
    cap: state, value, spent, until,
    raise: { by: usd, to, usd },
    // What the raise buys is the room above today's spend.
    forecast: priced ? { medals: (to - base) / usdPerMedal, usdPerMedal, basis: medals } : null,
  };
}
