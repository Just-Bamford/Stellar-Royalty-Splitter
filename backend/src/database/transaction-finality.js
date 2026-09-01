/**
 * Database operations for the transaction_finality table.
 *
 * Each row tracks one transaction's journey from submission through to a
 * final on-chain status (confirmed / failed / timeout). The finality service
 * reads and writes these rows; the REST endpoint and WebSocket broadcast
 * layer read them to give contributors real-time visibility.
 */

import { db, countWrite } from "./core.js";

// ─── Write helpers ────────────────────────────────────────────────────────────

/**
 * Create an initial finality record immediately after a transaction XDR is
 * built and returned to the frontend. The record starts in "pending" state
 * and will be updated by the polling service.
 *
 * @param {number} transactionId  - PK from the `transactions` table
 * @param {string|null} [txHash]  - Horizon transaction hash (may be unknown at record time)
 * @returns {number} insertedId
 */
export function createFinalityRecord(transactionId, txHash = null) {
  const stmt = db.prepare(`
    INSERT INTO transaction_finality
      (transaction_id, tx_hash, status, submission_at)
    VALUES (?, ?, 'pending', CURRENT_TIMESTAMP)
  `);
  const result = stmt.run(transactionId, txHash ?? null);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Attach a Horizon tx hash to an existing finality record.
 * Called after the frontend submits the signed transaction and the hash is
 * passed back to the backend.
 *
 * @param {number} transactionId
 * @param {string} txHash
 */
export function setFinalityTxHash(transactionId, txHash) {
  db.prepare(`
    UPDATE transaction_finality
    SET tx_hash = ?
    WHERE transaction_id = ?
  `).run(txHash, transactionId);
  countWrite();
}

/**
 * Record a single poll attempt and update next_poll_at.
 *
 * @param {number} transactionId
 * @param {Date}   nextPollAt
 */
export function incrementPollAttempt(transactionId, nextPollAt) {
  db.prepare(`
    UPDATE transaction_finality
    SET poll_attempts = poll_attempts + 1,
        next_poll_at  = ?
    WHERE transaction_id = ?
  `).run(nextPollAt ? nextPollAt.toISOString() : null, transactionId);
  countWrite();
}

/**
 * Mark a finality record as confirmed.
 *
 * @param {number}      transactionId
 * @param {object}      opts
 * @param {string}      opts.feePaid              - Fee in stroops (from Horizon)
 * @param {string|null} opts.firstConfirmationAt  - ISO timestamp
 */
export function markFinalityConfirmed(transactionId, { feePaid = null, firstConfirmationAt = null } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE transaction_finality
    SET status               = 'confirmed',
        confirmations        = 1,
        fee_paid             = ?,
        first_confirmation_at = COALESCE(first_confirmation_at, ?),
        final_status         = 'confirmed',
        final_status_at      = ?,
        next_poll_at         = NULL
    WHERE transaction_id = ?
  `).run(feePaid ?? null, firstConfirmationAt ?? now, now, transactionId);
  countWrite();
}

/**
 * Mark a finality record as failed (e.g. Horizon returned unsuccessful=true).
 *
 * @param {number} transactionId
 * @param {string} [errorMessage]
 */
export function markFinalityFailed(transactionId, errorMessage = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE transaction_finality
    SET status          = 'failed',
        final_status    = 'failed',
        final_status_at = ?,
        error_message   = ?,
        next_poll_at    = NULL
    WHERE transaction_id = ?
  `).run(now, errorMessage ?? null, transactionId);
  countWrite();
}

/**
 * Mark a finality record as timed out (10-minute polling window expired).
 *
 * @param {number} transactionId
 */
export function markFinalityTimeout(transactionId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE transaction_finality
    SET status          = 'timeout',
        final_status    = 'timeout',
        final_status_at = ?,
        error_message   = 'Finality polling window (10 min) expired without confirmation',
        next_poll_at    = NULL
    WHERE transaction_id = ?
  `).run(now, transactionId);
  countWrite();
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch a finality record by its parent transaction ID.
 *
 * @param {number} transactionId
 * @returns {object|null}
 */
export function getFinalityByTransactionId(transactionId) {
  return db.prepare(`
    SELECT * FROM transaction_finality WHERE transaction_id = ?
  `).get(transactionId) ?? null;
}

/**
 * Fetch a finality record by Horizon tx hash.
 *
 * @param {string} txHash
 * @returns {object|null}
 */
export function getFinalityByTxHash(txHash) {
  return db.prepare(`
    SELECT * FROM transaction_finality WHERE tx_hash = ?
  `).get(txHash) ?? null;
}

/**
 * Return all pending finality records whose next_poll_at is in the past
 * (or NULL — meaning they have never been attempted).
 *
 * @param {Date} [now]
 * @returns {object[]}
 */
export function getPendingFinalityRecords(now = new Date()) {
  return db.prepare(`
    SELECT * FROM transaction_finality
    WHERE status = 'pending'
      AND (next_poll_at IS NULL OR next_poll_at <= ?)
    ORDER BY submission_at ASC
  `).all(now.toISOString());
}

/**
 * Delete finality records whose submission_at is older than the given cutoff.
 * Used by the cleanup job to prevent unbounded table growth.
 *
 * @param {Date} cutoff
 * @returns {number} number of rows deleted
 */
export function deleteOldFinalityRecords(cutoff) {
  const result = db.prepare(`
    DELETE FROM transaction_finality
    WHERE submission_at < ?
  `).run(cutoff.toISOString());
  if (result.changes > 0) countWrite();
  return result.changes;
}
