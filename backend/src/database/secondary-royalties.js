/**
 * Secondary royalties (resale royalties) functions.
 * Handles recording resale transactions, tracking royalty distributions, and statistics.
 */

import { db, countWrite } from "./core.js";

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
  let query = `
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
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (nftId) {
    query += ` AND nftId = ?`;
    params.push(nftId);
  }

  if (undistributedOnly) {
    query += ` AND distributed = 0`;
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Count secondary sales for a contract (ignores LIMIT/OFFSET).
 * Supports optional date range filtering with startDate and endDate.
 */
export function countSecondarySales(contractId, nftId = null, startDate = null, endDate = null) {
  let query = `SELECT COUNT(*) as total FROM secondary_sales WHERE contractId = ?`;
  const params = [contractId];

  if (nftId) {
    query += ` AND nftId = ?`;
    params.push(nftId);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  return db.prepare(query).get(...params).total;
}

/**
 * Mark an array of secondary sale IDs as distributed.
 */
export function markSalesDistributed(ids) {
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE secondary_sales SET distributed = 1 WHERE id IN (${placeholders})`).run(
    ...ids
  );
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
 * Get royalty statistics for a contract.
 * Always returns consistent types — numeric fields use toFixed(7) strings,
 * counts are integers, and null is never returned for aggregates.
 */
export function getRoyaltyStatistics(contractId) {
  const totalSalesStmt = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(CAST(royaltyAmount as REAL)), 0) as totalRoyalties,
      COALESCE(SUM(CAST(salePrice as REAL)), 0) as totalVolume
    FROM secondary_sales
    WHERE contractId = ?
  `);
  const totalSales = totalSalesStmt.get(contractId);

  const pendingPoolStmt = db.prepare(`
    SELECT COALESCE(SUM(CAST(royaltyAmount as REAL)), 0) as pendingPool
    FROM secondary_sales
    WHERE contractId = ?
      AND timestamp > COALESCE(
        (SELECT MAX(timestamp) FROM secondary_royalty_distributions WHERE contractId = ?),
        '1970-01-01'
      )
  `);
  const pendingPool = pendingPoolStmt.get(contractId, contractId);

  const lastDistributionStmt = db.prepare(`
    SELECT srd.timestamp, srd.totalRoyaltiesDistributed, srd.numberOfSales, t.txHash
    FROM secondary_royalty_distributions srd
    LEFT JOIN transactions t ON srd.transactionId = t.id
    WHERE srd.contractId = ?
    ORDER BY srd.timestamp DESC
    LIMIT 1
  `);
  const lastDistribution = lastDistributionStmt.get(contractId);

  return {
    totalSecondarySales: totalSales.count,
    totalRoyaltiesGenerated: totalSales.totalRoyalties.toFixed(7),
    totalVolume: totalSales.totalVolume.toFixed(7),
    pendingRoyaltyPool: pendingPool.pendingPool.toFixed(7),
    lastDistribution: lastDistribution || null,
  };
}
