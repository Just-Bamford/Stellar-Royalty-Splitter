/**
 * Secondary royalties (resale royalties) functions.
 * Handles recording resale transactions, tracking royalty distributions, and statistics.
 */

import { db, countWrite } from "./core.js";
import { addAuditLog } from "./audit.js";
import { recordTransaction } from "./transactions.js";
import logger from "../logger.js";
import { assertValidContractId } from "../contract-id.js";

// ---------------------------------------------------------------------------
// Largest-remainder rounding algorithm (#427)
// ---------------------------------------------------------------------------

/**
 * Distribute `totalAmount` (integer) across `collaborators` (array of
 * { address, shareNumerator, shareDenominator }) using the largest-remainder
 * method so that:
 *   - Every collaborator receives at least floor(totalAmount * share)
 *   - The remainder (dust) is awarded, one unit at a time, to the collaborators
 *     with the largest fractional parts, in descending order.
 *   - SUM of all allocations === totalAmount (no funds are lost or duplicated)
 *
 * Each entry in the returned array is:
 *   { address, amount, dustReceived }
 *
 * @param {bigint}  totalAmount   - Integer amount to distribute (lamports / stroops)
 * @param {Array<{ address: string, basisPoints: number }>} collaborators
 *   Each collaborator's share is expressed as `basisPoints / 10000`.
 *   basisPoints values must sum to ≤ 10000.
 * @returns {Array<{ address: string, amount: bigint, dustReceived: bigint }>}
 */
export function applyLargestRemainder(totalAmount, collaborators) {
  if (collaborators.length === 0) return [];

  const SCALE = 10_000n;
  const total = BigInt(totalAmount);

  // 1. Compute the exact (scaled) share for each collaborator.
  //    exactScaled = total * basisPoints  (we divide by SCALE after flooring)
  const entries = collaborators.map((c) => {
    const bp = BigInt(c.basisPoints);
    const exactScaled = total * bp; // keep as numerator; denominator is SCALE
    const floor = exactScaled / SCALE;
    // fractional remainder = exactScaled - floor * SCALE  (range: [0, SCALE-1])
    const frac = exactScaled - floor * SCALE;
    return { address: c.address, floor, frac };
  });

  // 2. Sum the floors — the difference to totalAmount is the dust to award.
  const floorSum = entries.reduce((acc, e) => acc + e.floor, 0n);
  let dust = total - floorSum; // >= 0, typically small

  // 3. Sort by fractional part descending (stable: ties broken by original order).
  const sorted = entries
    .map((e, idx) => ({ ...e, idx }))
    .sort((a, b) => (a.frac > b.frac ? -1 : a.frac < b.frac ? 1 : a.idx - b.idx));

  // 4. Award one unit of dust to each top-fractional collaborator.
  const dustMap = new Map();
  for (let i = 0; i < sorted.length && dust > 0n; i++, dust--) {
    dustMap.set(sorted[i].address, 1n);
  }

  // 5. Build final result in original order.
  return entries.map((e) => {
    const dustReceived = dustMap.get(e.address) ?? 0n;
    return {
      address: e.address,
      amount: e.floor + dustReceived,
      dustReceived,
    };
  });
}

/**
 * Record a secondary (resale) transaction for an NFT.
 * Returns the secondary sale record ID.
 */
export function recordSecondarySale(
  contractId,
  nftId,
  previousOwner,
  newOwner,
  salePrice,
  saleToken,
  royaltyAmount,
  royaltyRate,
  transactionHash = null
) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    INSERT INTO secondary_sales 
    (contractId, nftId, previousOwner, newOwner, salePrice, saleToken, royaltyAmount, royaltyRate, transactionHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    contractId,
    nftId,
    previousOwner,
    newOwner,
    salePrice.toString(),
    saleToken,
    royaltyAmount.toString(),
    royaltyRate,
    transactionHash
  );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get all secondary sales for a contract with optional filtering.
 * Pass undistributedOnly=true to return only rows where distributed = 0.
 * Supports optional date range filtering with startDate and endDate.
 */
export function getSecondarySales(
  contractId,
  limit = 50,
  offset = 0,
  nftId = null,
  undistributedOnly = false,
  startDate = null,
  endDate = null
) {
  assertValidContractId(contractId);
  const conditions = ["contractId = ?"];
  const params = [contractId];

  if (nftId) {
    conditions.push("nftId = ?");
    params.push(nftId);
  }

  if (undistributedOnly) {
    conditions.push("distributed = 0");
  }

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("timestamp <= ?");
    params.push(endDate);
  }

  const query = `
    SELECT
      id,
      nftId,
      previousOwner,
      newOwner,
      salePrice,
      saleToken,
      royaltyAmount,
      royaltyRate,
      distributed,
      timestamp,
      transactionHash
    FROM secondary_sales
    WHERE ${conditions.join(" AND ")}
    ORDER BY timestamp DESC LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Count secondary sales for a contract (ignores LIMIT/OFFSET).
 * Supports optional date range filtering with startDate and endDate.
 */
export function countSecondarySales(contractId, nftId = null, startDate = null, endDate = null) {
  assertValidContractId(contractId);
  const conditions = ["contractId = ?"];
  const params = [contractId];

  if (nftId) {
    conditions.push("nftId = ?");
    params.push(nftId);
  }

  if (startDate) {
    conditions.push("timestamp >= ?");
    params.push(startDate);
  }

  if (endDate) {
    conditions.push("timestamp <= ?");
    params.push(endDate);
  }

  const query = `SELECT COUNT(*) as total FROM secondary_sales WHERE ${conditions.join(" AND ")}`;
  return db.prepare(query).get(...params).total;
}

/**
 * Mark an array of secondary sale IDs as distributed.
 */
export function markSalesDistributed(ids) {
  db.prepare(`
    UPDATE secondary_sales
    SET distributed = 1
    WHERE id IN (SELECT value FROM json_each(?))
  `).run(JSON.stringify(ids));
  countWrite();
}

/**
 * Record a secondary royalty distribution transaction.
 * `dustAllocated` is the total number of remainder units (lamports) that were
 * distributed via the largest-remainder algorithm in this distribution round.
 * It is stored for analytics / audit purposes.
 */
export function recordSecondaryRoyaltyDistribution(
  transactionId,
  contractId,
  totalRoyaltiesDistributed,
  numberOfSales,
  dustAllocated = 0
) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    INSERT INTO secondary_royalty_distributions
    (transactionId, contractId, totalRoyaltiesDistributed, numberOfSales, dustAllocated)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    transactionId,
    contractId,
    totalRoyaltiesDistributed.toString(),
    numberOfSales,
    dustAllocated.toString()
  );
  countWrite();
  return result;
}

/**
 * Get secondary royalty distribution history for a contract.
 */
export function getSecondaryRoyaltyDistributions(contractId, limit = 50, offset = 0) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    SELECT 
      srd.id,
      srd.transactionId,
      srd.totalRoyaltiesDistributed,
      srd.numberOfSales,
      srd.dustAllocated,
      srd.timestamp,
      t.txHash,
      t.status,
      t.initiatorAddress
    FROM secondary_royalty_distributions srd
    LEFT JOIN transactions t ON srd.transactionId = t.id
    WHERE srd.contractId = ?
    ORDER BY srd.timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

/**
 * Atomically record a secondary distribution: insert the transaction row,
 * mark all pending sales as distributed, insert the distribution record, and
 * write the audit log entries — all inside a single SQLite transaction (#471).
 *
 * If any step throws, the entire transaction is rolled back, preventing
 * orphaned pending-sale rows when the Stellar XDR is already built.
 *
 * @param {object} params
 * @param {string}  params.contractId
 * @param {string}  params.walletAddress
 * @param {bigint}  params.totalRoyalties
 * @param {number}  params.numberOfSales
 * @param {number[]} params.pendingSaleIds
 * @param {bigint}  params.totalDustAllocated
 * @param {object|null} params.dustAuditData  — null when no dust was allocated
 * @returns {number} transactionId
 */
export const commitSecondaryDistributionAtomic = db.transaction(
  ({
    contractId,
    walletAddress,
    totalRoyalties,
    numberOfSales,
    pendingSaleIds,
    totalDustAllocated,
    dustAuditData,
  }) => {
    const transactionId = recordTransaction(
      contractId,
      "secondary_distribute",
      walletAddress,
      { totalRoyalties: totalRoyalties.toString(), numberOfSales }
    );

    markSalesDistributed(pendingSaleIds);

    recordSecondaryRoyaltyDistribution(
      transactionId,
      contractId,
      totalRoyalties.toString(),
      numberOfSales,
      totalDustAllocated
    );

    if (dustAuditData) {
      addAuditLog(
        contractId,
        "secondary_distribution_dust_allocated",
        walletAddress,
        dustAuditData
      );
    }

    addAuditLog(contractId, "secondary_distribution_initiated", walletAddress, {
      transactionId,
      numberOfSales,
      totalRoyalties: totalRoyalties.toString(),
      dustAllocated: totalDustAllocated.toString(),
    });

    return transactionId;
  }
);

// #462: 60-second in-process cache for royalty statistics per contractId.
const _statsCache = new Map();
const STATS_CACHE_TTL_MS = 60_000;

export function _invalidateStatsCache(contractId) {
  if (contractId) {
    assertValidContractId(contractId);
    _statsCache.delete(contractId);
  } else {
    _statsCache.clear();
  }
}

// Single CTE query combining totals, pending pool, and last distribution (#462).
// Prepare lazily so route-only tests can initialize the schema before use.
let _statsStmt;

function getStatsStatement() {
  if (!_statsStmt) {
    _statsStmt = db.prepare(`
      WITH
        last_dist_ts AS (
          SELECT COALESCE(MAX(timestamp), '1970-01-01') AS ts
          FROM secondary_royalty_distributions
          WHERE contractId = ?
        ),
        totals AS (
          SELECT
            COUNT(*) AS count,
            COALESCE(SUM(CAST(royaltyAmount AS REAL)), 0) AS totalRoyalties,
            COALESCE(SUM(CAST(salePrice AS REAL)), 0) AS totalVolume
          FROM secondary_sales
          WHERE contractId = ?
        ),
        pending AS (
          SELECT COALESCE(SUM(CAST(royaltyAmount AS REAL)), 0) AS pendingPool
          FROM secondary_sales, last_dist_ts
          WHERE secondary_sales.contractId = ?
            AND secondary_sales.timestamp > last_dist_ts.ts
        ),
        last_dist AS (
          SELECT srd.timestamp, srd.totalRoyaltiesDistributed, srd.numberOfSales, t.txHash
          FROM secondary_royalty_distributions srd
          LEFT JOIN transactions t ON srd.transactionId = t.id
          WHERE srd.contractId = ?
          ORDER BY srd.timestamp DESC
          LIMIT 1
        )
      SELECT
        totals.count          AS totalSales,
        totals.totalRoyalties AS totalRoyalties,
        totals.totalVolume    AS totalVolume,
        pending.pendingPool   AS pendingPool,
        last_dist.timestamp                  AS lastDistTimestamp,
        last_dist.totalRoyaltiesDistributed  AS lastDistTotal,
        last_dist.numberOfSales              AS lastDistSales,
        last_dist.txHash                     AS lastDistTxHash
      FROM totals
      CROSS JOIN pending
      LEFT JOIN last_dist ON 1=1
    `);
  }

  return _statsStmt;
}

/**
 * Get royalty statistics for a contract.
 * Combines totals, pending pool, and last distribution in a single SQL query.
 * Results are cached for 60 seconds to reduce query pressure (#462).
 * Always returns consistent types — numeric fields use toFixed(7) strings,
 * counts are integers, and null is never returned for aggregates.
 */
export function getRoyaltyStatistics(contractId) {
  assertValidContractId(contractId);
  const cached = _statsCache.get(contractId);
  if (cached && Date.now() - cached.ts < STATS_CACHE_TTL_MS) {
    return cached.data;
  }

  const row = getStatsStatement().get(contractId, contractId, contractId, contractId);

  const lastDistribution =
    row.lastDistTimestamp != null
      ? {
          timestamp: row.lastDistTimestamp,
          totalRoyaltiesDistributed: row.lastDistTotal,
          numberOfSales: row.lastDistSales,
          txHash: row.lastDistTxHash,
        }
      : null;

  const data = {
    totalSecondarySales: row.totalSales,
    totalRoyaltiesGenerated: row.totalRoyalties.toFixed(7),
    totalVolume: row.totalVolume.toFixed(7),
    pendingRoyaltyPool: row.pendingPool.toFixed(7),
    lastDistribution,
  };

  _statsCache.set(contractId, { ts: Date.now(), data });
  return data;
}

// ---------------------------------------------------------------------------
// Retry Queue for Failed Secondary Royalty Distributions
// ---------------------------------------------------------------------------

/**
 * Calculate next retry time using exponential backoff.
 * Formula: baseDelay * (2 ^ retryCount) with jitter
 * Max delay capped at 1 hour.
 */
function calculateNextRetryAt(retryCount) {
  const baseDelayMs = 1000; // 1 second
  const maxDelayMs = 3600000; // 1 hour
  const exponentialDelay = baseDelayMs * Math.pow(2, retryCount);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter: +/- 20% random variation
  const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
  const nextRetryDelay = cappedDelay + jitter;
  return new Date(Date.now() + nextRetryDelay);
}

/**
 * Add a failed distribution to the retry queue.
 */
export function addToRetryQueue(params) {
  const {
    contractId,
    walletAddress,
    tokenId,
    collaborators,
    totalRoyalties,
    numberOfSales,
    pendingSaleIds,
    totalDustAllocated,
    dustAuditData,
    errorMessage,
  } = params;
  assertValidContractId(contractId);

  const stmt = db.prepare(`
    INSERT INTO secondary_royalty_retry_queue
    (contractId, walletAddress, tokenId, collaborators, totalRoyalties, numberOfSales,
     pendingSaleIds, totalDustAllocated, dustAuditData, errorMessage, retryCount, nextRetryAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `);

  const nextRetryAt = calculateNextRetryAt(0);

  stmt.run(
    contractId,
    walletAddress,
    tokenId,
    collaborators ? JSON.stringify(collaborators) : null,
    totalRoyalties.toString(),
    numberOfSales,
    JSON.stringify(pendingSaleIds),
    totalDustAllocated.toString(),
    dustAuditData ? JSON.stringify(dustAuditData) : null,
    errorMessage,
    nextRetryAt.toISOString()
  );
  countWrite();

  logger.info("Added failed distribution to retry queue", {
    contractId,
    tokenId,
    retryCount: 0,
    nextRetryAt: nextRetryAt.toISOString(),
  });
}

/**
 * Get items from retry queue that are ready for retry.
 */
export function getReadyRetryItems(limit = 10) {
  const stmt = db.prepare(`
    SELECT
      id,
      contractId,
      walletAddress,
      tokenId,
      collaborators,
      totalRoyalties,
      numberOfSales,
      pendingSaleIds,
      totalDustAllocated,
      dustAuditData,
      errorMessage,
      retryCount
    FROM secondary_royalty_retry_queue
    WHERE nextRetryAt <= datetime('now')
    ORDER BY nextRetryAt ASC
    LIMIT ?
  `);

  const items = stmt.all(limit);
  return items.map((item) => ({
    ...item,
    collaborators: item.collaborators ? JSON.parse(item.collaborators) : null,
    pendingSaleIds: JSON.parse(item.pendingSaleIds),
    dustAuditData: item.dustAuditData ? JSON.parse(item.dustAuditData) : null,
  }));
}

/**
 * Update retry item with new error and increment retry count.
 */
export function updateRetryItem(id, errorMessage) {
  const item = db.prepare("SELECT retryCount FROM secondary_royalty_retry_queue WHERE id = ?").get(id);
  if (!item) return false;

  const newRetryCount = item.retryCount + 1;
  const nextRetryAt = calculateNextRetryAt(newRetryCount);

  const stmt = db.prepare(`
    UPDATE secondary_royalty_retry_queue
    SET errorMessage = ?,
        retryCount = ?,
        nextRetryAt = ?,
        lastAttemptAt = datetime('now')
    WHERE id = ?
  `);

  stmt.run(errorMessage, newRetryCount, nextRetryAt.toISOString(), id);
  countWrite();

  logger.info("Updated retry item", {
    id,
    retryCount: newRetryCount,
    nextRetryAt: nextRetryAt.toISOString(),
  });

  return true;
}

/**
 * Remove item from retry queue after successful retry.
 */
export function removeFromRetryQueue(id) {
  const stmt = db.prepare("DELETE FROM secondary_royalty_retry_queue WHERE id = ?");
  stmt.run(id);
  countWrite();

  logger.info("Removed item from retry queue after success", { id });
}

/**
 * Move item from retry queue to dead-letter queue after max retries.
 */
export function moveToDeadLetterQueue(id, failureReason) {
  const item = db.prepare(`
    SELECT contractId, walletAddress, tokenId, collaborators, totalRoyalties,
           numberOfSales, pendingSaleIds, totalDustAllocated, dustAuditData,
           errorMessage, retryCount
    FROM secondary_royalty_retry_queue
    WHERE id = ?
  `).get(id);

  if (!item) return false;

  const stmt = db.prepare(`
    INSERT INTO secondary_royalty_dlq
    (contractId, walletAddress, tokenId, collaborators, totalRoyalties, numberOfSales,
     pendingSaleIds, totalDustAllocated, dustAuditData, errorMessage, failureReason, retryCount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    item.contractId,
    item.walletAddress,
    item.tokenId,
    item.collaborators,
    item.totalRoyalties,
    item.numberOfSales,
    item.pendingSaleIds,
    item.totalDustAllocated,
    item.dustAuditData,
    item.errorMessage,
    failureReason,
    item.retryCount
  );
  countWrite();

  // Remove from retry queue
  db.prepare("DELETE FROM secondary_royalty_retry_queue WHERE id = ?").run(id);
  countWrite();

  logger.error("Moved failed distribution to dead-letter queue", {
    contractId: item.contractId,
    tokenId: item.tokenId,
    retryCount: item.retryCount,
    failureReason,
  });

  return true;
}

/**
 * Get dead-letter queue items for a contract.
 */
export function getDeadLetterItems(contractId, limit = 50, offset = 0) {
  assertValidContractId(contractId);
  const stmt = db.prepare(`
    SELECT
      id,
      contractId,
      walletAddress,
      tokenId,
      totalRoyalties,
      numberOfSales,
      errorMessage,
      failureReason,
      retryCount,
      createdAt,
      failedAt
    FROM secondary_royalty_dlq
    WHERE contractId = ?
    ORDER BY createdAt DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

/**
 * Get retry queue statistics.
 */
export function getRetryQueueStats() {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as totalItems,
      AVG(retryCount) as avgRetryCount,
      MAX(retryCount) as maxRetryCount,
      COUNT(CASE WHEN nextRetryAt <= datetime('now') THEN 1 END) as readyForRetry
    FROM secondary_royalty_retry_queue
  `);

  return stmt.get();
}

/**
 * Get dead-letter queue statistics.
 */
export function getDeadLetterQueueStats() {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as totalItems,
      AVG(retryCount) as avgRetryCount,
      MAX(retryCount) as maxRetryCount,
      COUNT(CASE WHEN createdAt >= datetime('now', '-7 days') THEN 1 END) as last7Days
    FROM secondary_royalty_dlq
  `);

  return stmt.get();
}
