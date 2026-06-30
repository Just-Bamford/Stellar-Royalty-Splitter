/**
 * Analytics query functions.
 * Provides aggregated insights on transactions, distributions, and collaborator performance.
 *
 * #503: All figures are computed with set-based JOIN/GROUP BY queries rather than
 * iterating transactions and issuing a per-row lookup (the old N+1 pattern). The
 * number of database round-trips is therefore constant — it does not grow with the
 * number of transactions or collaborators. Results are memoised for 60s so repeated
 * dashboard polls reuse the same aggregate instead of re-scanning the tables.
 */

import { db } from "./core.js";
import { assertValidContractId } from "../contract-id.js";

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const analyticsCache = new Map();

/** Clear the analytics cache. Exposed for tests and cache invalidation. */
export function _clearAnalyticsCache() {
  analyticsCache.clear();
}

/**
 * Get analytics data for a contract within a date range.
 * Returns summary stats, trends, top earners, and per-collaborator statistics.
 *
 * @param {string} contractId
 * @param {string} startDate ISO timestamp (inclusive)
 * @param {string} endDate   ISO timestamp (inclusive)
 * @param {number} [collaboratorLimit=10] cap on rows returned in collaboratorStats
 */
export function getAnalyticsData(contractId, startDate, endDate, collaboratorLimit = 10) {
  assertValidContractId(contractId);
  const cacheKey = `${contractId}|${startDate}|${endDate}|${collaboratorLimit}`;
  const cached = analyticsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const summary = db
    .prepare(
      `SELECT
        COUNT(DISTINCT t.id) as totalTransactions,
        COALESCE(SUM(CAST(dp.amountReceived as REAL)), 0) as totalDistributed,
        COALESCE(AVG(CAST(dp.amountReceived as REAL)), 0) as averagePayout
      FROM transactions t
      LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.type != 'initialize'
        AND t.timestamp BETWEEN ? AND ?`
    )
    .get(contractId, startDate, endDate);

  const trends = db
    .prepare(
      `SELECT
        DATE(t.timestamp) as date,
        SUM(CAST(dp.amountReceived as REAL)) as amount,
        COUNT(*) as count
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY DATE(t.timestamp)
      ORDER BY date ASC`
    )
    .all(contractId, startDate, endDate);

  const topEarners = db
    .prepare(
      `SELECT
        dp.collaboratorAddress as address,
        SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
        COUNT(*) as payouts
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY totalEarned DESC
      LIMIT 10`
    )
    .all(contractId, startDate, endDate);

  const collaboratorStats = db
    .prepare(
      `SELECT
        dp.collaboratorAddress as address,
        SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
        COUNT(*) as payoutCount
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY totalEarned DESC
      LIMIT ?`
    )
    .all(contractId, startDate, endDate, collaboratorLimit);

  const data = { summary, trends, topEarners, collaboratorStats };
  analyticsCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}
