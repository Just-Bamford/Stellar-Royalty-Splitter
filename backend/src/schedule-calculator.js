/**
 * Schedule next-run calculator — closes #599.
 *
 * Pure functions for computing the next UTC trigger datetime for each
 * schedule type. All output is in ISO 8601 format.
 *
 * Schedule types:
 *   monthly  - day-of-month (1–28), at hourOfDay UTC
 *   biweekly - every 14 days from anchorDate, at hourOfDay UTC
 *   weekly   - day-of-week (0=Sun…6=Sat), at hourOfDay UTC
 *   custom   - every intervalDays from anchorDate, at hourOfDay UTC
 */

/**
 * Advance a Date to the next occurrence of a given UTC hour on the same day
 * or a future day, never in the past.
 *
 * @param {Date}   base        - Reference date
 * @param {number} hourOfDay   - Target UTC hour (0–23)
 * @returns {Date}
 */
function atHour(date, hourOfDay) {
  const d = new Date(date);
  d.setUTCHours(hourOfDay, 0, 0, 0);
  return d;
}

/**
 * Add `days` calendar days to `date`.
 */
function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Compute next run time for a monthly schedule.
 *
 * @param {Date}   now
 * @param {number} dayOfMonth  - 1–28
 * @param {number} hourOfDay   - 0–23 UTC
 * @returns {string} ISO datetime
 */
export function nextMonthly(now, dayOfMonth, hourOfDay) {
  // Clamp to 28 so we never overshoot February
  const dom = Math.min(Math.max(dayOfMonth, 1), 28);

  let candidate = new Date(now);
  candidate.setUTCDate(dom);
  candidate = atHour(candidate, hourOfDay);

  if (candidate <= now) {
    // Move to next month
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    candidate.setUTCDate(dom);
    candidate = atHour(candidate, hourOfDay);
  }

  return candidate.toISOString();
}

/**
 * Compute next run time for a weekly schedule.
 *
 * @param {Date}   now
 * @param {number} dayOfWeek  - 0=Sunday … 6=Saturday
 * @param {number} hourOfDay  - 0–23 UTC
 * @returns {string} ISO datetime
 */
export function nextWeekly(now, dayOfWeek, hourOfDay) {
  const dow = ((dayOfWeek % 7) + 7) % 7;
  const currentDow = now.getUTCDay();
  let daysUntil = (dow - currentDow + 7) % 7;

  let candidate = addDays(now, daysUntil);
  candidate = atHour(candidate, hourOfDay);

  if (candidate <= now) {
    candidate = addDays(candidate, 7);
    candidate = atHour(candidate, hourOfDay);
  }

  return candidate.toISOString();
}

/**
 * Compute next run time for an interval-based schedule (biweekly / custom).
 *
 * @param {Date}   now
 * @param {Date}   anchorDate   - Epoch date; intervals are calculated from this
 * @param {number} intervalDays - Cadence in days (14 for biweekly)
 * @param {number} hourOfDay    - 0–23 UTC
 * @returns {string} ISO datetime
 */
export function nextInterval(now, anchorDate, intervalDays, hourOfDay) {
  const anchor = new Date(anchorDate);
  anchor.setUTCHours(0, 0, 0, 0);

  const msPerDay = 86_400_000;
  const elapsed = Math.floor((now - anchor) / msPerDay);
  const cyclesPassed = Math.floor(elapsed / intervalDays);

  // Next cycle start = anchor + (cyclesPassed + 1) * intervalDays
  let candidate = addDays(anchor, (cyclesPassed + 1) * intervalDays);
  candidate = atHour(candidate, hourOfDay);

  if (candidate <= now) {
    candidate = addDays(anchor, (cyclesPassed + 2) * intervalDays);
    candidate = atHour(candidate, hourOfDay);
  }

  return candidate.toISOString();
}

/**
 * Compute the next run for any schedule type.
 *
 * @param {object} schedule - A payment_schedule row (parsed)
 * @param {Date}   [now]    - Reference time (defaults to current time)
 * @returns {string} ISO datetime of next run
 */
export function computeNextRun(schedule, now = new Date()) {
  const hour = schedule.hourOfDay ?? 0;

  switch (schedule.type) {
    case "monthly":
      return nextMonthly(now, schedule.dayOfMonth, hour);

    case "weekly":
      return nextWeekly(now, schedule.dayOfWeek, hour);

    case "biweekly": {
      const anchor = schedule.anchorDate
        ? new Date(schedule.anchorDate)
        : now;
      return nextInterval(now, anchor, 14, hour);
    }

    case "custom": {
      const anchor = schedule.anchorDate
        ? new Date(schedule.anchorDate)
        : now;
      const interval = schedule.intervalDays ?? 1;
      return nextInterval(now, anchor, interval, hour);
    }

    default:
      throw new Error(`Unknown schedule type: "${schedule.type}"`);
  }
}
