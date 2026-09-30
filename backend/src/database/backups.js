/**
 * Database functions for contract backup tracking.
 *
 * Each row in contract_backups represents one weekly snapshot attempt.
 * The snapshot payload itself lives in IPFS; we store only the CID + metadata.
 */

import { db, countWrite } from "./core.js";

// ── ISO week helpers ──────────────────────────────────────────────────────────

/**
 * Return { weekNumber, yearNumber } for a given Date using ISO-8601 week numbering.
 * Week 1 = the week containing the first Thursday of the year.
 *
 * @param {Date} [date]
 * @returns {{ weekNumber: number, yearNumber: number }}
 */
export function getIsoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Set to Thursday in the current week (ISO weeks start Mon, anchor on Thu)
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNumber = Math.ceil(((d - yearStart) / 86_400_000 + 1) / 7);
  return { weekNumber, yearNumber: d.getUTCFullYear() };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

/**
 * Create a new backup record in 'pending' state.
 *
 * @param {object} params
 * @param {string} params.contractId
 * @param {number} params.weekNumber
 * @param {number} params.yearNumber
 * @param {boolean} [params.isRecoveryDrill]
 * @returns {number} new backup ID
 */
export function createBackupRecord({ contractId, weekNumber, yearNumber, isRecoveryDrill = false }) {
  const result = db
    .prepare(
      `INSERT INTO contract_backups
         (contractId, weekNumber, yearNumber, status, isRecoveryDrill)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(contractId, weekNumber, yearNumber, isRecoveryDrill ? 1 : 0);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Mark a backup record as uploading.
 *
 * @param {number} backupId
 */
export function markBackupUploading(backupId) {
  db.prepare(`UPDATE contract_backups SET status = 'uploading' WHERE id = ?`).run(backupId);
  countWrite();
}

/**
 * Mark a backup as completed with IPFS CID and payload metrics.
 *
 * @param {number} backupId
 * @param {object} result
 */
export function markBackupCompleted(backupId, {
  ipfsCid,
  ipfsGatewayUrl,
  sizeBytes,
  transactionCount,
  collaboratorCount,
  secondarySaleCount,
  auditLogCount,
}) {
  db.prepare(`
    UPDATE contract_backups
    SET status = 'completed',
        ipfsCid = ?,
        ipfsGatewayUrl = ?,
        sizeBytes = ?,
        transactionCount = ?,
        collaboratorCount = ?,
        secondarySaleCount = ?,
        auditLogCount = ?,
        completedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    ipfsCid,
    ipfsGatewayUrl ?? null,
    sizeBytes,
    transactionCount,
    collaboratorCount,
    secondarySaleCount,
    auditLogCount,
    backupId,
  );
  countWrite();
}

/**
 * Mark a backup as failed with an error message.
 *
 * @param {number} backupId
 * @param {string} errorMessage
 */
export function markBackupFailed(backupId, errorMessage) {
  db.prepare(`
    UPDATE contract_backups
    SET status = 'failed', errorMessage = ?, completedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(errorMessage, backupId);
  countWrite();
}

/**
 * Record the result of a recovery drill on an existing backup record.
 *
 * @param {number} backupId
 * @param {boolean} succeeded
 * @param {number} durationMs
 */
export function recordDrillResult(backupId, succeeded, durationMs) {
  db.prepare(`
    UPDATE contract_backups
    SET drillSucceeded = ?, drillDurationMs = ?
    WHERE id = ?
  `).run(succeeded ? 1 : 0, durationMs, backupId);
  countWrite();
}

// ── Queries ───────────────────────────────────────────────────────────────────

/**
 * Get a single backup record by ID.
 *
 * @param {number} backupId
 * @returns {object|null}
 */
export function getBackupById(backupId) {
  return db.prepare(`SELECT * FROM contract_backups WHERE id = ?`).get(backupId) ?? null;
}

/**
 * List backups for a contract, newest first.
 *
 * @param {string} contractId
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function listBackups(contractId, limit = 52, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM contract_backups
       WHERE contractId = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`,
    )
    .all(contractId, limit, offset);
}

/**
 * Count backups for a contract.
 *
 * @param {string} contractId
 * @returns {number}
 */
export function countBackups(contractId) {
  return db
    .prepare(`SELECT COUNT(*) as total FROM contract_backups WHERE contractId = ?`)
    .get(contractId).total;
}

/**
 * Get the most recent completed backup for a contract.
 *
 * @param {string} contractId
 * @returns {object|null}
 */
export function getLatestBackup(contractId) {
  return (
    db
      .prepare(
        `SELECT * FROM contract_backups
         WHERE contractId = ? AND status = 'completed'
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(contractId) ?? null
  );
}

/**
 * Check whether a backup already exists for a given contract + ISO week.
 * Used to prevent duplicate weekly snapshots.
 *
 * @param {string} contractId
 * @param {number} weekNumber
 * @param {number} yearNumber
 * @returns {boolean}
 */
export function backupExistsForWeek(contractId, weekNumber, yearNumber) {
  const row = db
    .prepare(
      `SELECT id FROM contract_backups
       WHERE contractId = ? AND weekNumber = ? AND yearNumber = ?
         AND status IN ('pending', 'uploading', 'completed')
       LIMIT 1`,
    )
    .get(contractId, weekNumber, yearNumber);
  return row != null;
}

/**
 * Return all contracts that have at least one completed backup, along with
 * the date of their last successful backup.  Used by the backup scheduler to
 * decide which contracts are overdue.
 *
 * @returns {Array<{ contractId: string, lastBackupAt: string }>}
 */
export function getContractsWithBackups() {
  return db
    .prepare(
      `SELECT contractId, MAX(completedAt) as lastBackupAt
       FROM contract_backups
       WHERE status = 'completed'
       GROUP BY contractId`,
    )
    .all();
}

/**
 * Delete backups older than 52 weeks for a contract, keeping only the most
 * recent 52 completed snapshots.  Returns the number of rows deleted.
 *
 * @param {string} contractId
 * @returns {number}
 */
export function pruneOldBackups(contractId) {
  const result = db
    .prepare(
      `DELETE FROM contract_backups
       WHERE contractId = ?
         AND status = 'completed'
         AND id NOT IN (
           SELECT id FROM contract_backups
           WHERE contractId = ? AND status = 'completed'
           ORDER BY createdAt DESC
           LIMIT 52
         )`,
    )
    .run(contractId, contractId);
  if (result.changes > 0) countWrite();
  return result.changes;
}
