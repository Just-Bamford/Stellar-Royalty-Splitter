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
 *
 * Before deleting pending records, we perform a final Horizon status check
 * to ensure we don't silently delete transactions that were confirmed but
 * missed during the polling window.
 */

import {
  deleteOldFinalityRecords,
  getPendingFinalityRecordsOlderThan,
  markFinalityConfirmed,
  markFinalityFailed,
} from "../database/transaction-finality.js";
import { addAuditLog } from "../database/index.js";
import { getHorizonTransactionOnce } from "../stellar.js";
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
 * Before deleting pending records, we perform a final Horizon status check
 * to ensure we don't silently delete transactions that were confirmed but
 * missed during the polling window.
 *
 * @param {Date}   [now]           Override "now" for deterministic tests.
 * @param {number} [retentionDays] Override retention window for tests.
 * @returns {{ deleted: number, cutoff: string, checked: number, updated: number }}
 */
export async function executeFinalityCleanup(
  now = new Date(),
  retentionDays = FINALITY_RETENTION_DAYS
) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  // Perform final Horizon check on pending records older than cutoff
  const pendingRecords = getPendingFinalityRecordsOlderThan(cutoff);
  let checked = 0;
  let updated = 0;

  for (const record of pendingRecords) {
    if (!record.tx_hash) {
      // No txHash stored, skip Horizon check
      continue;
    }

    checked++;
    try {
      const horizonResult = await getHorizonTransactionOnce(record.tx_hash);
      if (horizonResult) {
        // Transaction found on Horizon, update status before cleanup
        if (horizonResult.status === "confirmed") {
          markFinalityConfirmed(record.transaction_id, {
            feePaid: null,
            firstConfirmationAt: horizonResult.createdAt,
          });
          logger.info("Finality cleanup: updated pending record to confirmed", {
            event: "finality_cleanup_pending_confirmed",
            transactionId: record.transaction_id,
            txHash: record.tx_hash.substring(0, 8),
          });
          // Audit log entry
          try {
            addAuditLog(
              "__global__",
              "finality_cleanup_pending_confirmed",
              null,
              {
                transactionId: record.transaction_id,
                txHash: record.tx_hash,
                confirmedAt: horizonResult.createdAt,
              }
            );
          } catch (_) {
            /* non-fatal */
          }
          updated++;
        } else if (horizonResult.status === "failed") {
          markFinalityFailed(record.transaction_id, "Transaction failed on Horizon");
          logger.info("Finality cleanup: updated pending record to failed", {
            event: "finality_cleanup_pending_failed",
            transactionId: record.transaction_id,
            txHash: record.tx_hash.substring(0, 8),
          });
          // Audit log entry
          try {
            addAuditLog(
              "__global__",
              "finality_cleanup_pending_failed",
              null,
              {
                transactionId: record.transaction_id,
                txHash: record.tx_hash,
              }
            );
          } catch (_) {
            /* non-fatal */
          }
          updated++;
        }
      }
    } catch (error) {
      logger.warn("Finality cleanup: Horizon check failed", {
        event: "finality_cleanup_horizon_check_failed",
        transactionId: record.transaction_id,
        txHash: record.tx_hash.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deleted = deleteOldFinalityRecords(cutoff);

  if (deleted > 0 || checked > 0) {
    logger.info("Finality cleanup: completed", {
      event: "finality_cleanup_completed",
      deleted,
      checked,
      updated,
      cutoff: cutoff.toISOString(),
      retentionDays,
    });
  } else {
    logger.debug("Finality cleanup: no records to delete", {
      event: "finality_cleanup_noop",
      cutoff: cutoff.toISOString(),
    });
  }

  return { deleted, cutoff: cutoff.toISOString(), checked, updated };
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

  _cleanupTimer = setInterval(async () => {
    try {
      await executeFinalityCleanup();
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
