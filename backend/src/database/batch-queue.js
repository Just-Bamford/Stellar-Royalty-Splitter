/**
 * Batch queue management for secondary royalty distribution.
 * Handles queueing, tracking, retries, and metrics for batched distributions.
 * Issue: Multiple secondary royalty distributions create separate transactions,
 * causing network spam and accumulated gas costs. Solution: Batch distributions
 * into time-windowed groups (5-minute batches) processed in single transactions.
 */

import { db, countWrite } from "./core.js";

/**
 * Record a batch entry in the queue.
 * Returns the batch entry ID.
 */
export function queueBatchEntry(
  contractId,
  batchId,
  token,
  totalAmount,
  status = 0 // 0: pending, 1: processing, 2: completed, 3: failed
) {
  const stmt = db.prepare(`
    INSERT INTO batch_queue 
    (contractId, batchId, token, totalAmount, status, createdAt)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const result = stmt.run(contractId, batchId, token, totalAmount.toString(), status);
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get all pending batches for a contract.
 */
export function getPendingBatches(contractId) {
  const stmt = db.prepare(`
    SELECT 
      id,
      contractId,
      batchId,
      token,
      totalAmount,
      status,
      retryCount,
      createdAt,
      processedAt
    FROM batch_queue
    WHERE contractId = ? AND status = 0
    ORDER BY createdAt ASC
  `);

  return stmt.all(contractId);
}

/**
 * Get batch history for a contract with pagination.
 */
export function getBatchHistory(
  contractId,
  limit = 50,
  offset = 0,
  status = null
) {
  let query = `
    SELECT 
      id,
      contractId,
      batchId,
      token,
      totalAmount,
      status,
      retryCount,
      createdAt,
      processedAt
    FROM batch_queue
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (status !== null) {
    query += ` AND status = ?`;
    params.push(status);
  }

  query += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Update batch status and retry count.
 */
export function updateBatchStatus(batchEntryId, status, retryCount = null, processedAt = null) {
  let query = `UPDATE batch_queue SET status = ?`;
  const params = [status];

  if (retryCount !== null) {
    query += `, retryCount = ?`;
    params.push(retryCount);
  }

  if (processedAt !== null) {
    query += `, processedAt = ?`;
    params.push(processedAt);
  }

  query += ` WHERE id = ?`;
  params.push(batchEntryId);

  const stmt = db.prepare(query);
  stmt.run(...params);
  countWrite();
}

/**
 * Get batch metrics for a contract (total batches, distributions, gas savings).
 */
export function getBatchMetrics(contractId) {
  const stmt = db.prepare(`
    SELECT 
      COUNT(*) as totalBatches,
      SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) as completedBatches,
      SUM(CASE WHEN status = 3 THEN 1 ELSE 0 END) as failedBatches,
      COALESCE(SUM(CASE WHEN status = 2 THEN totalAmount ELSE 0 END), 0) as totalDistributed,
      AVG(CASE WHEN status = 2 THEN totalAmount ELSE NULL END) as averageBatchSize,
      MAX(processedAt) as lastBatchTimestamp
    FROM batch_queue
    WHERE contractId = ?
  `);

  const result = stmt.get(contractId);
  return {
    totalBatches: result.totalBatches || 0,
    completedBatches: result.completedBatches || 0,
    failedBatches: result.failedBatches || 0,
    totalDistributed: BigInt(result.totalDistributed || 0),
    averageBatchSize: result.averageBatchSize ? BigInt(Math.floor(result.averageBatchSize)) : 0n,
    lastBatchTimestamp: result.lastBatchTimestamp || null,
    // Estimate gas savings: ~5000 stroops per batch vs individual transactions
    estimatedGasSaved: BigInt((result.totalBatches || 0) * 5000),
  };
}

/**
 * Get retry statistics for failed batches.
 */
export function getRetryStats(contractId) {
  const stmt = db.prepare(`
    SELECT 
      retryCount,
      COUNT(*) as count
    FROM batch_queue
    WHERE contractId = ? AND status IN (2, 3)
    GROUP BY retryCount
    ORDER BY retryCount ASC
  `);

  return stmt.all(contractId);
}

/**
 * Clean up old completed batches (older than specified days).
 */
export function cleanupOldBatches(contractId, olderThanDays = 30) {
  const stmt = db.prepare(`
    DELETE FROM batch_queue
    WHERE contractId = ? 
    AND status = 2 
    AND processedAt IS NOT NULL 
    AND processedAt < datetime('now', '-' || ? || ' days')
  `);

  const result = stmt.run(contractId, olderThanDays);
  countWrite();
  return result.changes;
}

/**
 * Commit an atomic batch distribution (all entries grouped by batchId).
 * Records the distribution with timestamp and participants.
 */
export function commitBatchDistribution(
  contractId,
  batchId,
  totalAmount,
  collaborators, // array of { address, payout }
  transactionId = null
) {
  const stmt = db.prepare(`
    INSERT INTO secondary_royalty_distributions 
    (contractId, batchId, totalAmount, collaborators, transactionId, processedAt)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const result = stmt.run(
    contractId,
    batchId,
    totalAmount.toString(),
    JSON.stringify(collaborators),
    transactionId
  );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get batch distribution history with collaborator details.
 */
export function getBatchDistributions(
  contractId,
  limit = 50,
  offset = 0,
  batchId = null
) {
  let query = `
    SELECT 
      id,
      contractId,
      batchId,
      totalAmount,
      collaborators,
      transactionId,
      processedAt
    FROM secondary_royalty_distributions
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (batchId !== null) {
    query += ` AND batchId = ?`;
    params.push(batchId);
  }

  query += ` ORDER BY processedAt DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get efficiency metrics for batch processing.
 * Compares batched vs non-batched distribution costs.
 */
export function getBatchEfficiencyMetrics(contractId) {
  // Estimate: 1 base transaction + 1 per recipient transfer
  // Batching: 1 transaction for entire batch regardless of number
  // Estimate: 5000 stroops per recipient transfer saved

  const metrics = getBatchMetrics(contractId);
  
  // Get average recipients count from collaborator data (assume 5 for estimation)
  const avgRecipientsPerBatch = 5;
  
  // Gas savings: (avgRecipients - 1) * 5000 stroops per batch
  const estimatedSavingsPerBatch = BigInt((avgRecipientsPerBatch - 1) * 5000);
  const totalGasSavings = metrics.completedBatches > 0 
    ? estimatedSavingsPerBatch * BigInt(metrics.completedBatches)
    : 0n;

  return {
    totalBatches: metrics.totalBatches,
    completedBatches: metrics.completedBatches,
    failedBatches: metrics.failedBatches,
    totalDistributed: metrics.totalDistributed,
    averageBatchSize: metrics.averageBatchSize,
    lastBatchTimestamp: metrics.lastBatchTimestamp,
    estimatedGasSaved: totalGasSavings,
    transactionsGrouped: metrics.totalBatches > 0 ? metrics.totalBatches : 0,
    efficiency: {
      avgRecipientsPerBatch,
      estimatedSavingsPerBatch: estimatedSavingsPerBatch.toString(),
      totalSavingsEstimate: totalGasSavings.toString(),
    },
  };
}
