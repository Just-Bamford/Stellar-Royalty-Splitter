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

/**
 * Daily earnings history for a contributor wallet across one or more contracts.
 */
export function getContributorEarningsHistory(walletAddress, startDate, endDate, contractIds = null) {
  const params = [walletAddress, startDate, endDate];
  let contractFilter = "";

  if (Array.isArray(contractIds) && contractIds.length > 0) {
    const placeholders = contractIds.map(() => "?").join(", ");
    contractFilter = ` AND t.contractId IN (${placeholders})`;
    params.push(...contractIds);
  }

  const daily = db
    .prepare(
      `SELECT
        DATE(COALESCE(t.blockTime, t.timestamp)) as date,
        t.contractId as contractId,
        SUM(CAST(dp.amountReceived as REAL)) as amount
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
        AND t.type != 'initialize'
        AND COALESCE(t.blockTime, t.timestamp) BETWEEN ? AND ?
        ${contractFilter}
      GROUP BY DATE(COALESCE(t.blockTime, t.timestamp)), t.contractId
      ORDER BY date ASC`
    )
    .all(...params);

  return daily.map((row) => ({
    date: row.date,
    contractId: row.contractId,
    amount: Math.round((row.amount ?? 0) * 100) / 100,
  }));
}

/**
 * Contract lifecycle events for a contributor (added contracts, failed distributions).
 */
export function getContributorEarningsEvents(walletAddress) {
  const added = db
    .prepare(
      `SELECT DISTINCT
        t.contractId as contractId,
        MIN(COALESCE(t.blockTime, t.timestamp)) as date
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
      GROUP BY t.contractId
      ORDER BY date ASC`
    )
    .all(walletAddress)
    .map((row) => ({
      type: "contract_added",
      contractId: row.contractId,
      date: row.date,
      label: "New contract",
    }));

  const failures = db
    .prepare(
      `SELECT
        t.contractId as contractId,
        COALESCE(t.blockTime, t.timestamp) as date,
        t.errorMessage as message
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'failed'
        AND t.type = 'distribute'
      ORDER BY date ASC`
    )
    .all(walletAddress)
    .map((row) => ({
      type: "distribution_failure",
      contractId: row.contractId,
      date: row.date,
      label: row.message ? "Distribution failed" : "Distribution failed",
    }));

  return [...added, ...failures].sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/**
 * Contracts a contributor has earned from.
 */
export function getContributorContracts(walletAddress) {
  return db
    .prepare(
      `SELECT DISTINCT t.contractId as contractId
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
      ORDER BY t.contractId ASC`
    )
    .all(walletAddress)
    .map((row) => row.contractId);
}

/**
 * Get detailed payout records for export.
 */
export function getContributorPayoutRecords(walletAddress, startDate, endDate, contractIds = null) {
  const params = [walletAddress, startDate, endDate];
  let contractFilter = "";

  if (Array.isArray(contractIds) && contractIds.length > 0) {
    const placeholders = contractIds.map(() => "?").join(", ");
    contractFilter = ` AND t.contractId IN (${placeholders})`;
    params.push(...contractIds);
  }

  return db
    .prepare(
      `SELECT
        COALESCE(t.blockTime, t.timestamp) as payoutDate,
        COALESCE(t.txHash, CAST(t.id AS TEXT)) as transactionId,
        t.type as royaltyType,
        dp.amountReceived as amount,
        t.contractId as contractId
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
        AND COALESCE(t.blockTime, t.timestamp) BETWEEN ? AND ?
        ${contractFilter}
      ORDER BY payoutDate DESC`
    )
    .all(...params);
}

