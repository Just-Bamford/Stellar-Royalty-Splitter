/**
 * Transaction tracking and distribution payout functions.
 * Handles recording, updating, and querying transactions and their related payouts.
 */

import { db, countWrite } from "./core.js";
import { assertValidContractId } from "../contract-id.js";

export function recordTransaction(contractId, type, initiatorAddress, data) {
  assertValidContractId(contractId);
  const { requestedAmount, tokenId } = data;

  const stmt = db.prepare(`
    INSERT INTO transactions 
    (contractId, type, initiatorAddress, requestedAmount, tokenId, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const result = stmt.run(contractId, type, initiatorAddress, requestedAmount, tokenId);
  countWrite();
  return result.lastInsertRowid;
}

export function updateTransactionHash(transactionId, txHash) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET txHash = ? 
    WHERE id = ?
  `);

  stmt.run(txHash, transactionId);
  countWrite();
}

export function updateTransactionStatus(txHash, status, blockTime = null, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET status = ?, blockTime = ?, errorMessage = ? 
    WHERE txHash = ?
  `);

  stmt.run(status, blockTime, errorMessage, txHash);
  countWrite();
}

export function addDistributionPayout(
  transactionId,
  contractId,
  collaboratorAddress,
  amountReceived
) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    INSERT INTO distribution_payouts 
    (transactionId, contractId, collaboratorAddress, amountReceived)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(transactionId, contractId, collaboratorAddress, amountReceived);
  countWrite();
}

export function getTransactionCount(contractId) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`SELECT COUNT(*) as total FROM transactions WHERE contractId = ?`);
  return stmt.get(contractId).total;
}

export function getTransactionHistory(contractId, limit = 50, offset = 0) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      (SELECT COUNT(*) FROM distribution_payouts dp WHERE dp.transactionId = t.id) as payoutCount
    FROM transactions t INDEXED BY idx_transactions_contractId_timestamp_desc
    WHERE t.contractId = ?
    ORDER BY t.timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

export function getTransactionById(transactionId) {
  const stmt = db.prepare(`
    SELECT
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage
    FROM transactions t
    WHERE t.id = ?
  `);

  return stmt.get(transactionId) ?? null;
}

export function getTransactionDetails(txHash) {
  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage
    FROM transactions t
    WHERE t.txHash = ?
  `);

  const transaction = stmt.get(txHash);

  if (!transaction) {
    return null;
  }

  const payoutsStmt = db.prepare(`
    SELECT collaboratorAddress, amountReceived
    FROM distribution_payouts
    WHERE transactionId = ?
  `);

  const payouts = payoutsStmt.all(transaction.id);

  return {
    ...transaction,
    payouts,
  };
}
