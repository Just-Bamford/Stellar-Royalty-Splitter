/**
 * Distribution scheduler — polls for due schedules and fires the batch processor.
 *
 * Design mirrors the existing retry-failed-distributions job:
 *   - setInterval with .unref() so it never blocks process exit
 *   - Returns { stop(), interval } so index.js can clean up on SIGTERM/SIGINT
 *   - All state is fully DB-persisted; restarts pick up exactly where they left off
 *   - Injectable `now` param on every function for deterministic unit testing
 *
 * Schedule timing:
 *   weekly   – fires on a specific dayOfWeek (0=Sun … 6=Sat)
 *   biweekly – same as weekly but nextRunAt advances by 14 days instead of 7
 *   monthly  – fires on a specific dayOfMonth (1–28); always advances by ~1 month
 *
 * nextRunAt is computed once on schedule creation (via computeNextRunAt) and
 * again after every successful or failed run (markScheduleRun stores it).
 * The scheduler simply queries WHERE enabled=1 AND nextRunAt <= now.
 */

import { getDueSchedules, markScheduleRun } from "../database/schedules.js";
import { executeBatch } from "./batch-processor.js";
import logger from "../logger.js";
import { parsePositiveInt } from "../utils.js";

/** How often the scheduler polls for due schedules (default: 60 s). */
const SCHEDULE_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.SCHEDULE_CHECK_INTERVAL_MS,
  60_000
);

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Compute the first future run time for a newly created schedule.
 *
 * For weekly/biweekly schedules the next occurrence of `dayOfWeek` at
 * `hourOfDay:minuteOfHour` UTC is returned.
 *
 * For monthly schedules the next occurrence of `dayOfMonth` at
 * `hourOfDay:minuteOfHour` UTC is returned (capped at day 28 so it is safe
 * across all calendar months).
 *
 * @param {object} schedule
 * @param {string} schedule.frequency      - 'weekly' | 'biweekly' | 'monthly'
 * @param {number|null} schedule.dayOfWeek  - 0–6, for weekly/biweekly
 * @param {number|null} schedule.dayOfMonth - 1–28, for monthly
 * @param {number} schedule.hourOfDay       - 0–23
 * @param {number} schedule.minuteOfHour    - 0–59
 * @param {Date} [now]
 * @returns {string} ISO 8601 datetime string
 */
export function computeNextRunAt(schedule, now = new Date()) {
  const { frequency, dayOfWeek, dayOfMonth, hourOfDay, minuteOfHour } = schedule;

  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCHours(hourOfDay, minuteOfHour, 0, 0);

  if (frequency === "weekly" || frequency === "biweekly") {
    const targetDay = dayOfWeek ?? 0;
    const currentDay = candidate.getUTCDay();
    let daysUntil = (targetDay - currentDay + 7) % 7;

    // If today is the target day but the time has already passed, schedule
    // for next week instead of the same day
    if (daysUntil === 0 && candidate <= now) {
      daysUntil = 7;
    }

    candidate.setUTCDate(candidate.getUTCDate() + daysUntil);
    return candidate.toISOString();
  }

  if (frequency === "monthly") {
    const targetDay = dayOfMonth ?? 1;

    // Try this month first
    candidate.setUTCDate(targetDay);

    if (candidate <= now) {
      // Advance to the same day next month
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCDate(targetDay);
    }

    return candidate.toISOString();
  }

  throw new Error(`Unknown schedule frequency: ${frequency}`);
}

/**
 * Compute the next run time AFTER the most recent run.
 * Called by the scheduler after every execution.
 *
 * @param {object} schedule  - the schedule row from the DB
 * @param {Date} [lastRunAt]
 * @returns {string} ISO 8601 datetime string
 */
export function computeNextRunAfter(schedule, lastRunAt = new Date()) {
  const { frequency, dayOfWeek, dayOfMonth, hourOfDay, minuteOfHour } = schedule;

  const base = new Date(lastRunAt);
  base.setUTCHours(hourOfDay, minuteOfHour, 0, 0);

  if (frequency === "weekly") {
    base.setUTCDate(base.getUTCDate() + 7);
    // Ensure we land on the correct dayOfWeek (handles DST edge cases)
    const targetDay = dayOfWeek ?? 0;
    const diff = (targetDay - base.getUTCDay() + 7) % 7;
    if (diff !== 0) base.setUTCDate(base.getUTCDate() + diff);
    return base.toISOString();
  }

  if (frequency === "biweekly") {
    base.setUTCDate(base.getUTCDate() + 14);
    const targetDay = dayOfWeek ?? 0;
    const diff = (targetDay - base.getUTCDay() + 7) % 7;
    if (diff !== 0) base.setUTCDate(base.getUTCDate() + diff);
    return base.toISOString();
  }

  if (frequency === "monthly") {
    const targetDay = dayOfMonth ?? 1;
    base.setUTCMonth(base.getUTCMonth() + 1);
    base.setUTCDate(targetDay);
    return base.toISOString();
  }

  throw new Error(`Unknown schedule frequency: ${frequency}`);
}

// ── Core scheduler job ────────────────────────────────────────────────────────

/**
 * Run one tick of the scheduler: find all due schedules and execute them.
 *
 * @param {Date} [now]
 * @returns {Promise<{ processed: number, succeeded: number, failed: number }>}
 */
export async function runSchedulerTick(now = new Date()) {
  const dueSchedules = getDueSchedules(now);

  if (dueSchedules.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info("Found due distribution schedules", {
    event: "scheduler_tick",
    count: dueSchedules.length,
  });

  let succeeded = 0;
  let failed = 0;

  for (const schedule of dueSchedules) {
    try {
      await runSchedule(schedule, now);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error("Schedule execution failed", {
        event: "schedule_execution_error",
        scheduleId: schedule.id,
        contractId: schedule.contractId,
        error: err?.message ?? String(err),
      });
    }
  }

  return { processed: dueSchedules.length, succeeded, failed };
}

/**
 * Execute a single due schedule via the batch processor.
 *
 * Even though each schedule currently maps to one distribution item (one
 * contract + wallet + token), the batch abstraction is kept so future
 * multi-contract schedules can be added without changing this layer.
 *
 * @param {object} schedule  - row from distribution_schedules
 * @param {Date} [now]
 */
export async function runSchedule(schedule, now = new Date()) {
  logger.info("Executing scheduled distribution", {
    event: "schedule_execution_start",
    scheduleId: schedule.id,
    contractId: schedule.contractId,
    frequency: schedule.frequency,
  });

  const items = [
    {
      contractId: schedule.contractId,
      walletAddress: schedule.walletAddress,
      tokenId: schedule.tokenId,
    },
  ];

  let lastRunStatus = "failed";

  try {
    const result = await executeBatch(items, schedule.id);
    lastRunStatus = result.failureCount === 0 ? "success" : "partial";

    logger.info("Scheduled distribution executed", {
      event: "schedule_execution_complete",
      scheduleId: schedule.id,
      batchId: result.batchId,
      successCount: result.successCount,
      failureCount: result.failureCount,
      lastRunStatus,
    });
  } catch (err) {
    lastRunStatus = "failed";
    logger.error("Scheduled distribution batch failed", {
      event: "schedule_execution_batch_error",
      scheduleId: schedule.id,
      error: err?.message ?? String(err),
    });
    // Re-throw so runSchedulerTick can count it
    throw err;
  } finally {
    // Always advance nextRunAt so the schedule doesn't fire again immediately
    const nextRunAt = computeNextRunAfter(schedule, now);
    markScheduleRun(schedule.id, nextRunAt, lastRunStatus);

    logger.info("Schedule advanced to next run", {
      event: "schedule_advanced",
      scheduleId: schedule.id,
      nextRunAt,
      lastRunStatus,
    });
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Start the distribution scheduler. Returns a stop function that clears the
 * interval — to be called from the graceful shutdown handler in index.js.
 *
 * @returns {{ stop: () => void, interval: NodeJS.Timeout }}
 */
export function startDistributionScheduler() {
  logger.info("Starting distribution scheduler", {
    intervalMs: SCHEDULE_CHECK_INTERVAL_MS,
  });

  const interval = setInterval(async () => {
    try {
      const result = await runSchedulerTick();
      if (result.processed > 0) {
        logger.info("Scheduler tick completed", result);
      }
    } catch (err) {
      logger.error("Distribution scheduler tick error", { error: err?.message });
    }
  }, SCHEDULE_CHECK_INTERVAL_MS);

  // Don't block process exit on this timer
  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Distribution scheduler stopped");
    },
    interval,
  };
}
