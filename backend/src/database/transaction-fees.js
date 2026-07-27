/**
 * Transaction fee tracking database helpers — closes #606.
 *
 * Stores the Soroban resource fee (minResourceFee) captured at simulation
 * time so contributors can see exactly what was deducted from each distribution.
 */

import { db, countWrite } from "./core.js";

/**
 * Record the simulated fee for a transaction.
 *
 * @param {number} transactionId  FK → transactions.id
 * @param {string} contractId     Stellar contract address
 * @param {number|string} feeStroops  Soroban minResourceFee in stroops
 * @returns {{ id: number, transactionId: number, contractId: string, feeStroops: string, recordedAt: string }}
 */
export function recordTransactionFee(transactionId, contractId, feeStroops) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO transaction_fees (transactionId, contractId, feeStroops, recordedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(transactionId)
    DO UPDATE SET feeStroops = excluded.feeStroops,
                  recordedAt = excluded.recordedAt
  `);
  stmt.run(transactionId, contractId, String(feeStroops), now);
  countWrite();

  return {
    transactionId,
    contractId,
    feeStroops: String(feeStroops),
    recordedAt: now,
  };
}

/**
 * Return the fee record for a transaction, or null if not recorded.
 *
 * @param {number} transactionId
 * @returns {{ transactionId: number, contractId: string, feeStroops: string, recordedAt: string } | null}
 */
export function getTransactionFee(transactionId) {
  return (
    db
      .prepare(
        `SELECT transactionId, contractId, feeStroops, recordedAt
         FROM transaction_fees
         WHERE transactionId = ?`
      )
      .get(transactionId) ?? null
  );
}

/**
 * Return fee records for all transactions belonging to a contract,
 * ordered by most recent first, with optional pagination.
 *
 * @param {string} contractId
 * @param {number} limit
 * @param {number} offset
 * @returns {Array<{ transactionId: number, feeStroops: string, recordedAt: string }>}
 */
export function getFeesByContract(contractId, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT transactionId, feeStroops, recordedAt
       FROM transaction_fees
       WHERE contractId = ?
       ORDER BY recordedAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}
