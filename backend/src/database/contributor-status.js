/**
 * Contributor suspension / deactivation helpers (#593).
 *
 * Status values:
 *   active       — normal operation; eligible for payouts
 *   suspended    — temporarily paused; payments blocked; data preserved
 *   deactivated  — permanently removed from payouts; data preserved
 */
import { db, countWrite } from "./core.js";

/**
 * Return the status record for a contributor, or null if none exists
 * (implying "active").
 */
export function getContributorStatus(contractId, address) {
  return (
    db
      .prepare(
        `SELECT id, contractId, address, status, reason,
                suspendedAt, deactivatedAt, updatedBy, createdAt, updatedAt
         FROM contributor_status
         WHERE contractId = ? AND address = ?`
      )
      .get(contractId, address) ?? null
  );
}

/**
 * List all contributors for a contract that have a non-active status,
 * or all statuses when includeActive=true.
 */
export function listContributorStatuses(contractId, { includeActive = false } = {}) {
  let query = `SELECT id, contractId, address, status, reason,
                      suspendedAt, deactivatedAt, updatedBy, createdAt, updatedAt
               FROM contributor_status
               WHERE contractId = ?`;
  const params = [contractId];
  if (!includeActive) {
    query += ` AND status != 'active'`;
  }
  query += ` ORDER BY updatedAt DESC`;
  return db.prepare(query).all(...params);
}

/**
 * Upsert a contributor's status.
 * @param {string} contractId
 * @param {string} address
 * @param {'active'|'suspended'|'deactivated'} status
 * @param {object} opts
 * @param {string|null} opts.reason   - human-readable reason
 * @param {string|null} opts.updatedBy - wallet address of operator who made the change
 */
export function setContributorStatus(contractId, address, status, { reason = null, updatedBy = null } = {}) {
  const now = new Date().toISOString();
  const suspendedAt = status === "suspended" ? now : null;
  const deactivatedAt = status === "deactivated" ? now : null;

  db.prepare(
    `INSERT INTO contributor_status
       (contractId, address, status, reason, suspendedAt, deactivatedAt, updatedBy, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(contractId, address) DO UPDATE SET
       status       = excluded.status,
       reason       = excluded.reason,
       suspendedAt  = CASE WHEN excluded.status = 'suspended'    THEN excluded.suspendedAt    ELSE suspendedAt    END,
       deactivatedAt= CASE WHEN excluded.status = 'deactivated'  THEN excluded.deactivatedAt  ELSE deactivatedAt  END,
       updatedBy    = excluded.updatedBy,
       updatedAt    = excluded.updatedAt`
  ).run(contractId, address, status, reason, suspendedAt, deactivatedAt, updatedBy, now);

  countWrite();
  return getContributorStatus(contractId, address);
}

/**
 * Check whether a given address is currently blocked from receiving payouts
 * (i.e. suspended or deactivated).
 */
export function isContributorBlocked(contractId, address) {
  const row = db
    .prepare(
      `SELECT status FROM contributor_status WHERE contractId = ? AND address = ?`
    )
    .get(contractId, address);
  return row ? row.status !== "active" : false;
}
