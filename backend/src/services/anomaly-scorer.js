/**
 * Pure anomaly-scoring engine for fraud detection (#1042).
 *
 * Converts a transaction plus its context into a 0-100 risk score by summing
 * independent risk factors. Free of I/O so it is fully deterministic, fast, and
 * unit-testable in isolation.
 *
 * Risk factors (configurable via thresholds):
 *   - Amount > 3x historical average      -> +30
 *   - Access from a new location          -> +20
 *   - Multiple failed attempts (>= 2)     -> +25
 *   - Activity outside usual hours        -> +15
 */

export const POINTS = {
  LARGE_AMOUNT: 30,
  NEW_LOCATION: 20,
  MULTIPLE_FAILED: 25,
  OFF_HOURS: 15,
};

export const DEFAULT_THRESHOLDS = {
  amountMultiplier: 3,
  failedAttempts: 2,
  verification: 50,
  block: 80,
};

/**
 * Score a single transaction.
 *
 * @param {object} params
 * @param {number} params.amount               - Transaction amount.
 * @param {number} params.historicalAverage    - Baseline daily/total average.
 * @param {boolean} [params.isNewLocation]     - True if location unseen for the user.
 * @param {number} [params.failedAttempts]     - Failed auth attempts in the window.
 * @param {number} [params.hour]               - Hour-of-day (0-23) of activity.
 * @param {{start:number,end:number}} [params.usualHours] - Usual active hour window.
 * @param {object} [params.thresholds]
 * @returns {{ score: number, factors: Array<{name:string, points:number, detail:object}> }}
 */
export function scoreTransaction(params) {
  const {
    amount,
    historicalAverage,
    isNewLocation,
    failedAttempts,
    hour,
    usualHours,
    thresholds = DEFAULT_THRESHOLDS,
  } = params;

  const factors = [];

  if (
    historicalAverage > 0 &&
    Number.isFinite(amount) &&
    amount > thresholds.amountMultiplier * historicalAverage
  ) {
    factors.push({
      name: "large_amount",
      points: POINTS.LARGE_AMOUNT,
      detail: { amount, historicalAverage, multiplier: thresholds.amountMultiplier },
    });
  }

  if (isNewLocation) {
    factors.push({ name: "new_location", points: POINTS.NEW_LOCATION, detail: {} });
  }

  if (failedAttempts >= thresholds.failedAttempts) {
    factors.push({
      name: "multiple_failed_attempts",
      points: POINTS.MULTIPLE_FAILED,
      detail: { failedAttempts },
    });
  }

  if (usualHours && hour != null) {
    const h = Number(hour);
    if (Number.isFinite(h) && (h < usualHours.start || h > usualHours.end)) {
      factors.push({
        name: "off_hours",
        points: POINTS.OFF_HOURS,
        detail: { hour: h, usualHours },
      });
    }
  }

  const score = Math.max(0, Math.min(100, factors.reduce((sum, f) => sum + f.points, 0)));
  return { score, factors };
}

/**
 * Map a score to an action level.
 *   score > 80  -> "block"
 *   score > 50  -> "require_verification"
 *   otherwise   -> "allow"
 */
export function deriveAlertLevel(score, thresholds = DEFAULT_THRESHOLDS) {
  if (score > thresholds.block) return "block";
  if (score > thresholds.verification) return "require_verification";
  return "allow";
}

export default {
  scoreTransaction,
  deriveAlertLevel,
  POINTS,
  DEFAULT_THRESHOLDS,
};
