/**
 * Loan liquidation DB functions (#665).
 * Processes loan_liquidated contract events and records them in loan_liquidations.
 */

import { db, countWrite } from "./core.js";

/**
 * Record a loan liquidation event from the contract.
 * @param {string} contractId
 * @param {string} loanId
 * @param {string} borrower
 * @param {string} liquidator
 * @param {string} repayAmount  - serialised i128 string
 * @param {string} collateralSeized - serialised i128 string
 * @param {string|null} txHash
 * @returns {number} inserted row id
 */
export function recordLoanLiquidation(
  contractId,
  loanId,
  borrower,
  liquidator,
  repayAmount,
  collateralSeized,
  txHash = null
) {
  const stmt = db.prepare(`
    INSERT INTO loan_liquidations
      (contractId, loanId, borrower, liquidator, repayAmount, collateralSeized, txHash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'liquidated')
  `);
  const result = stmt.run(
    contractId,
    loanId,
    borrower,
    liquidator,
    String(repayAmount),
    String(collateralSeized),
    txHash
  );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Retrieve a single liquidation record by its row id.
 * @param {number} id
 * @returns {object|null}
 */
export function getLoanLiquidation(id) {
  return db.prepare(`SELECT * FROM loan_liquidations WHERE id = ?`).get(id) ?? null;
}

/**
 * List liquidations for a contract, newest first.
 * @param {string} contractId
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function getLoanLiquidations(contractId, limit = 50, offset = 0) {
  return db
    .prepare(
      `SELECT * FROM loan_liquidations WHERE contractId = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}
