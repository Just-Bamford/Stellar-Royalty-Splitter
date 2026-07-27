/**
 * Background job: Auto-trigger distributions on payment schedule (#599).
 *
 * Checks every minute for schedules whose next_run_at has passed,
 * triggers the distribution flow, and advances next_run_at.
 */

import logger from "../logger.js";
import { getDueSchedules, markScheduleRun, logScheduledDistribution } from "../database/payment-schedules.js";
import { addAuditLog } from "../database/audit.js";
import { parsePositiveInt } from "../utils.js";

const SCHEDULE_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.SCHEDULE_CHECK_INTERVAL_MS,
  60_000 // 1 minute
);

/**
 * Process due schedules. For each due schedule, log a triggered event and
 * advance the next run time. Actual on-chain distribution is initiated by
 * the operator via the distribute endpoint; the scheduler creates a
 * pending trigger record that operators/webhooks can consume.
 *
 * @param {Date} [now] - Injectable for testing
 * @returns {object} Summary
 */
export async function processDueSchedules(now = new Date()) {
  const due = getDueSchedules(now);

  if (due.length === 0) {
    return { processed: 0, triggered: 0, failed: 0 };
  }

  logger.info("Processing due payment schedules", { count: due.length });

  let triggered = 0;
  let failed = 0;

  for (const schedule of due) {
    try {
      logger.info("Triggering scheduled distribution", {
        scheduleId: schedule.id,
        contractId: schedule.contractId,
        name: schedule.name,
        schedule_type: schedule.schedule_type,
      });

      // Log the triggered event
      const logId = logScheduledDistribution(
        schedule.id,
        schedule.contractId,
        "triggered"
      );

      // Advance the schedule to its next run time
      markScheduleRun(schedule.id, now);

      addAuditLog(schedule.contractId, "scheduled_distribution_triggered", "schedule-job", {
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        logId,
        triggeredAt: now.toISOString(),
      });

      triggered++;
    } catch (err) {
      failed++;
      logger.error("Failed to process payment schedule", {
        scheduleId: schedule.id,
        contractId: schedule.contractId,
        error: err.message,
      });

      try {
        logScheduledDistribution(schedule.id, schedule.contractId, "failed", err.message);
      } catch (_) {
        // best effort
      }
    }
  }

  const result = { processed: due.length, triggered, failed };
  logger.info("Payment schedule job completed", result);
  return result;
}

/**
 * Start the payment schedule background checker.
 * Returns a stop function.
 */
export function startPaymentScheduleJob() {
  logger.info("Starting payment schedule job", { intervalMs: SCHEDULE_CHECK_INTERVAL_MS });

  const interval = setInterval(async () => {
    try {
      await processDueSchedules();
    } catch (err) {
      logger.error("Payment schedule job error", { error: err.message });
    }
  }, SCHEDULE_CHECK_INTERVAL_MS);

  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Payment schedule job stopped");
    },
  };
}
