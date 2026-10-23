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
import { createSnapshot, ensureSnapshotTable, pruneSnapshots } from "../database/contract-snapshots.js";
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
 * Basis-point share configuration is only held on-chain (`get_all_shares`);
 * the backend does not persist it — the collaborators route caches it in
 * memory and the initialize audit log records requested, unconfirmed shares
 * without addresses. `shares` is therefore stored as `null` with
 * `sharesSource: "unavailable"` and cannot be used for configuration recovery
 * until an on-chain read is added to this job. Cumulative payout totals are
 * recorded in `balances`.
 *
 * @param {string} contractId
 * @returns {{ collaborators: string, collaboratorsSource: string, shares: string, sharesSource: string, balances: string, transactionCount: number, lastTransactionId: number|null }}
 */
export function computeContractState(contractId) {
  // Get unique collaborator addresses from distribution_payouts first
  const collaboratorRows = db
    .prepare(
      `SELECT DISTINCT collaboratorAddress
       FROM distribution_payouts
       WHERE contractId = ?`
    )
    .all(contractId);
  let collaborators = collaboratorRows.map((r) => r.collaboratorAddress);
  let collaboratorsSource = "distribution_payouts";

  // Fallback: if no distributions, try to get collaborators from audit_log (initialize events)
  if (collaborators.length === 0) {
    const auditRows = db
      .prepare(
        `SELECT details
         FROM audit_log
         WHERE contractId = ? AND action = 'initialize'
         ORDER BY timestamp DESC
         LIMIT 1`
      )
      .all(contractId);

    if (auditRows.length > 0) {
      try {
        const details = JSON.parse(auditRows[0].details);
        if (details.collaborators && Array.isArray(details.collaborators)) {
          collaborators = details.collaborators.map((c) => c.address).filter(Boolean);
          collaboratorsSource = "audit_log";
        }
      } catch (err) {
        // Malformed audit log details - continue with empty collaborators
        logger.warn(`Failed to parse audit_log details for contract ${contractId}`, {
          contractId,
          error: err.message,
        });
      }
    }
  }

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

  // Build balances map from cumulative payouts
  const balanceRows = db
    .prepare(
      `SELECT collaboratorAddress, SUM(CAST(amountReceived AS REAL)) AS totalReceived
       FROM distribution_payouts
       WHERE contractId = ?
       GROUP BY collaboratorAddress`
    )
    .all(contractId);

  const balances = {};

  for (const row of balanceRows) {
    balances[row.collaboratorAddress] = Math.round(row.totalReceived * 100) / 100;
  }

  return {
    collaborators: JSON.stringify(collaborators),
    collaboratorsSource,
    shares: JSON.stringify(null),
    sharesSource: "unavailable",
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
      const pruned = pruneSnapshots(contractId, SNAPSHOT_RETENTION_COUNT);
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
