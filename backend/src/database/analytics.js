/*
 * Analytics query functions.
 * Provides aggregated insights on transactions, distributions, and collaborator performance.
 */

import { db } from "./core.js";

/**
 * A/B testing experiment analytics.
 * Provides per-variant metric aggregation and statistical significance.
 */

function normalCdf(z) {
  // Abramowitz & Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

function twoProportionPValue(control, variant) {
  const n1 = control.users;
  const n2 = variant.users;
  if (n1 === 0 || n2 === 0) return 1;
  const p1 = control.conversions / n1;
  const p2 = variant.conversions / n2;
  const pooled = (control.conversions + variant.conversions) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return 1;
  const z = (p2 - p1) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

/**
 * Record a metric event for a user's assigned variant.
 */
export function trackExperimentMetric(experimentId, variant, userId, metric, value = 1) {
  db.prepare(
    `INSERT INTO experiment_metrics (experimentId, variant, userId, metric, value, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(experimentId, variant, userId, metric, value, Date.now());
}

/**
 * Aggregate metrics per variant and compute statistical significance
 * against the control variant.
 */
export function getExperimentResults(experimentId) {
  const rows = db
    .prepare(
      `SELECT variant, metric, COUNT(DISTINCT userId) as users, SUM(value) as total
       FROM experiment_metrics
       WHERE experimentId = ?
       GROUP BY variant, metric`
    )
    .all(experimentId);

  const variants = {};
  for (const row of rows) {
    if (!variants[row.variant]) variants[row.variant] = { users: 0, metrics: {} };
    variants[row.variant].metrics[row.metric] = row.total;
    variants[row.variant].users = Math.max(variants[row.variant].users, row.users);
  }

  const control = variants.control || { users: 0, metrics: {} };
  const results = Object.entries(variants).map(([variant, data]) => {
    const conversions = data.metrics.conversion || 0;
    const controlConversions = control.metrics.conversion || 0;
    const pValue =
      variant === "control"
        ? 1
        : twoProportionPValue(
            { users: control.users, conversions: controlConversions },
            { users: data.users, conversions }
          );
    return {
      variant,
      users: data.users,
      metrics: data.metrics,
      conversionRate: data.users ? conversions / data.users : 0,
      pValue,
      significant: pValue < 0.05,
    };
  });

  const winner = results
    .filter((r) => r.variant !== "control" && r.significant)
    .sort((a, b) => b.conversionRate - a.conversionRate)[0];

  return { experimentId, results, winner: winner ? winner.variant : null };
}

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
        AND t​imestamp BETWEEN ? AND ?`
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
      WHERE t​contractId = ? AND t.status = 'confirmed'
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
      WHERE t​contractId = ? AND t.status = 'confirmed'
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
      GROUP BY t​contractId
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
      ORDER BY t​contractId ASC`
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
        AND t​status = 'confirmed'
        AND COALESCE(t.blockTime, t.timestamp) BETWEEN ? AND ?
        ${contractFilter}
      ORDER BY payoutDate DESC`
    )
    .all(...params);
}
