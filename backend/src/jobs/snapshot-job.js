/**
 * Daily contract snapshot job — closes #613.
 *
 * Creates periodic snapshots of contract state for recovery and auditing.
 * Runs on a configurable schedule (default: daily at 00:00 UTC).
 *
 * This job collects current state from on-chain data and stored transactions,
 * then creates a snapshot record in the database.
 */

import db from "../database/index.js";
import { createSnapshot, ensureSnapshotTable } from "../database/contract-snapshots.js";
import logger from "../logger.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const SNAPSHOT_INTERVAL_MS = Number(process.env.SNAPSHOT_INTERVAL_MS) || 24 * 60 * 60 * 1000; // 24h default
const SNAPSHOT_RETENTION_COUNT = Number(process.env.SNAPSHOT_RETENTION_COUNT) || 90; // keep 90 most recent

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Get the list of contract IDs that have transaction activity.
 * @returns {string[]}
 */
function getActiveContractIds() {
  const rows = db
    .prepare(
      `SELECT DISTINCT contractId FROM transactions
       UNION
       SELECT DISTINCT contractId FROM distribution_payouts`
    )
    .all();
  return rows.map((r) => r.contractId);
}

/**
 * Compute a summary of contract state from stored data.
 *
 * @param {string} contractId
 * @returns {{ collaborators: string[], shares: object, balances: object, transactionCount: number, lastTransactionId: number|null }}
 */
function computeContractState(contractId) {
  // Get unique collaborator addresses
  const collaboratorRows = db
    .prepare(
      `SELECT DISTINCT collaboratorAddress
       FROM distribution_payouts
       WHERE contractId = ?`
    )
    .all(contractId);
  const collaborators = collaboratorRows.map((r) => r.collaboratorAddress);

  // Get transaction count
  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM transactions WHERE contractId = ?`)
    .get(contractId);
  const transactionCount = countRow.cnt;

  // Get most recent transaction ID
  const lastTx = db
    .prepare(`SELECT id FROM transactions WHERE contractId = ? ORDER BY timestamp DESC LIMIT 1`)
    .get(contractId);
  const lastTransactionId = lastTx?.id ?? null;

  // Build shares map from contributor_status or distribution_payouts
  const shareRows = db
    .prepare(
      `SELECT collaboratorAddress, SUM(CAST(amountReceived AS REAL)) AS totalReceived
       FROM distribution_payouts
       WHERE contractId = ?
       GROUP BY collaboratorAddress`
    )
    .all(contractId);

  const shares = {};
  const balances = {};

  for (const row of shareRows) {
    const amount = Math.round(row.totalReceived * 100) / 100;
    shares[row.collaboratorAddress] = amount;
    balances[row.collaboratorAddress] = amount;
  }

  return {
    collaborators: JSON.stringify(collaborators),
    shares: JSON.stringify(shares),
    balances: JSON.stringify(balances),
    transactionCount,
    lastTransactionId,
  };
}

// ─── Job Execution ─────────────────────────────────────────────────────────────

/**
 * Execute a snapshot run for all active contracts.
 * This is called by the scheduler and can also be invoked manually.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.forceLabel]  Override label for manual runs
 * @returns {{ snapshotsCreated: number, contractsProcessed: number, errors: string[] }}
 */
export async function executeSnapshotRun({ forceLabel } = {}) {
  ensureSnapshotTable();

  const contractIds = getActiveContractIds();
  const errors = [];
  let snapshotsCreated = 0;

  logger.info(`Snapshot job starting: ${contractIds.length} contract(s) to process`, {
    event: "snapshot_job_started",
    contractCount: contractIds.length,
  });

  for (const contractId of contractIds) {
    try {
      const state = computeContractState(contractId);
      const label = forceLabel ?? `daily-snapshot-${new Date().toISOString().slice(0, 10)}`;

      createSnapshot({
        contractId,
        label,
        ...state,
        createdBy: "system",
      });

      snapshotsCreated++;

      // Prune old snapshots beyond retention
      const pruned = await import("../database/contract-snapshots.js").then((mod) =>
        mod.pruneSnapshots(contractId, SNAPSHOT_RETENTION_COUNT)
      );
      if (pruned > 0) {
        logger.debug(`Pruned ${pruned} old snapshots for contract ${contractId}`);
      }
    } catch (err) {
      logger.error(`Snapshot job failed for contract ${contractId}`, {
        event: "snapshot_job_contract_error",
        contractId,
        error: err.message,
      });
      errors.push(`Contract ${contractId}: ${err.message}`);
    }
  }

  logger.info(`Snapshot job completed`, {
    event: "snapshot_job_completed",
    contractsProcessed: contractIds.length,
    snapshotsCreated,
    errors: errors.length,
  });

  return { snapshotsCreated, contractsProcessed: contractIds.length, errors };
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

let _snapshotTimer = null;

/**
 * Start the periodic snapshot scheduler.
 *
 * @param {number} [intervalMs]  Override interval in milliseconds
 */
export function startSnapshotScheduler(intervalMs = SNAPSHOT_INTERVAL_MS) {
  if (_snapshotTimer) {
    logger.warn("Snapshot scheduler already running, stopping first");
    stopSnapshotScheduler();
  }

  logger.info(`Starting snapshot scheduler (interval: ${intervalMs}ms)`, {
    event: "snapshot_scheduler_started",
    intervalMs,
  });

  _snapshotTimer = setInterval(() => {
    executeSnapshotRun().catch((err) => {
      logger.error("Unhandled error in scheduled snapshot run", {
        event: "snapshot_scheduler_error",
        error: err.message,
      });
    });
  }, intervalMs);

  // Don't let the timer keep the process alive
  if (_snapshotTimer && _snapshotTimer.unref) {
    _snapshotTimer.unref();
  }
}

/**
 * Stop the periodic snapshot scheduler.
 */
export function stopSnapshotScheduler() {
  if (_snapshotTimer) {
    clearInterval(_snapshotTimer);
    _snapshotTimer = null;
    logger.info("Snapshot scheduler stopped", { event: "snapshot_scheduler_stopped" });
  }
}

/**
 * Get scheduler status.
 * @returns {{ running: boolean, intervalMs: number }}
 */
export function getSchedulerStatus() {
  return {
    running: _snapshotTimer !== null,
    intervalMs: SNAPSHOT_INTERVAL_MS,
  };
}
