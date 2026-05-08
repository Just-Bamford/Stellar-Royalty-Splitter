/**
 * Analytics query functions.
 * Provides aggregated insights on transactions, distributions, and collaborator performance.
 */

import { db } from "./core.js";

/**
 * Get analytics data for a contract within a date range.
 * Returns summary stats, trends, top earners, and per-collaborator statistics.
 */
export function getAnalyticsData(contractId, startDate, endDate) {
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
      ORDER BY totalEarned DESC`
    )
    .all(contractId, startDate, endDate);

  return { summary, trends, topEarners, collaboratorStats };
}
