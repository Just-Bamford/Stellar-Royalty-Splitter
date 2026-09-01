/**
 * Finality record cleanup job — closes #finality.
 *
 * The transaction_finality table grows continuously as new transactions are
 * submitted.  This job periodically deletes records whose submission_at is
 * older than FINALITY_RETENTION_DAYS (default 7 days) to prevent unbounded
 * table growth.
 *
 * Only settled records (confirmed, failed, timeout) are safe to delete; a
 * record with status = 'pending' that is more than 7 days old almost
 * certainly represents a stuck or forgotten transaction, so we delete those
 * too rather than leaving them in the table forever.
 */

import { deleteOldFinalityRecords } from "../database/transaction-finality.js";
import logger from "../logger.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const FINALITY_RETENTION_DAYS =
  Number(process.env.FINALITY_RETENTION_DAYS) || 7;

const CLEANUP_INTERVAL_MS =
  Number(process.env.FINALITY_CLEANUP_INTERVAL_MS) || 24 * 60 * 60 * 1000; // daily

// ─── Job execution ────────────────────────────────────────────────────────────

/**
 * Delete finality records older than the retention window.
 *
 * @param {Date}   [now]           Override "now" for deterministic tests.
 * @param {number} [retentionDays] Override retention window for tests.
 * @returns {{ deleted: number, cutoff: string }}
 */
export function executeFinalityCleanup(
  now = new Date(),
  retentionDays = FINALITY_RETENTION_DAYS
) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const deleted = deleteOldFinalityRecords(cutoff);

  if (deleted > 0) {
    logger.info("Finality cleanup: deleted old records", {
      event: "finality_cleanup_completed",
      deleted,
      cutoff: cutoff.toISOString(),
      retentionDays,
    });
  } else {
    logger.debug("Finality cleanup: no records to delete", {
      event: "finality_cleanup_noop",
      cutoff: cutoff.toISOString(),
    });
  }

  return { deleted, cutoff: cutoff.toISOString() };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

let _cleanupTimer = null;

/**
 * Start the periodic finality cleanup scheduler.
 *
 * @param {number} [intervalMs] Override interval for tests.
 * @returns {{ stop: () => void }}
 */
export function startFinalityCleanupScheduler(intervalMs = CLEANUP_INTERVAL_MS) {
  if (_cleanupTimer) {
    stopFinalityCleanupScheduler();
  }

  logger.info("Finality cleanup scheduler started", {
    event: "finality_cleanup_scheduler_started",
    intervalMs,
    retentionDays: FINALITY_RETENTION_DAYS,
  });

  _cleanupTimer = setInterval(() => {
    try {
      executeFinalityCleanup();
    } catch (err) {
      logger.error("Finality cleanup scheduler error", {
        event: "finality_cleanup_scheduler_error",
        error: err?.message ?? String(err),
      });
    }
  }, intervalMs);

  // Don't prevent clean process exit
  if (_cleanupTimer && _cleanupTimer.unref) {
    _cleanupTimer.unref();
  }

  return { stop: stopFinalityCleanupScheduler };
}

/**
 * Stop the periodic finality cleanup scheduler.
 */
export function stopFinalityCleanupScheduler() {
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
    logger.info("Finality cleanup scheduler stopped", {
      event: "finality_cleanup_scheduler_stopped",
    });
  }
}
