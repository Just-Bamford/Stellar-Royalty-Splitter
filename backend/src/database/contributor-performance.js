/**
 * Contributor performance metrics database functions (#600).
 *
 * Metrics computed:
 *   - success_rate:       confirmed payouts / total payouts attempted (0-100)
 *   - avg_payout_time_hours: average hours between tx creation and confirmation
 *   - reliability_score:  composite score 0-100 combining success_rate and activity
 *   - total_payouts:      number of confirmed payouts in period
 *   - total_earned:       sum of amounts in confirmed payouts in period
 */

import { db, countWrite } from "./core.js";

/**
 * Compute and upsert performance metrics for a contributor within a period.
 * Called after each distribution run to keep metrics fresh.
 *
 * @param {string} walletAddress
 * @param {string} contractId
 * @param {string} periodStart - ISO string
 * @param {string} periodEnd   - ISO string
 * @returns {object|null} Upserted performance record
 */
export function computeAndSavePerformance(walletAddress, contractId, periodStart, periodEnd) {
  // Count confirmed payouts for this contributor
  const confirmedRow = db.prepare(`
    SELECT
      COUNT(*) AS total_payouts,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS total_earned
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.contractId = ?
      AND t.status = 'confirmed'
      AND t.timestamp BETWEEN ? AND ?
  `).get(walletAddress, contractId, periodStart, periodEnd);

  // Count failed/pending (attempted but not confirmed) — via transactions touching this contract
  const attemptedRow = db.prepare(`
    SELECT COUNT(DISTINCT t.id) AS attempted
    FROM transactions t
    JOIN distribution_payouts dp ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.contractId = ?
      AND t.timestamp BETWEEN ? AND ?
  `).get(walletAddress, contractId, periodStart, periodEnd);

  const totalPayouts = confirmedRow?.total_payouts ?? 0;
  const totalEarned = confirmedRow?.total_earned ?? 0;
  const attempted = attemptedRow?.attempted ?? 0;

  const successRate = attempted > 0 ? Math.round((totalPayouts / attempted) * 100 * 100) / 100 : 100;

  // Average payout time: hours between transaction timestamp and blockTime (confirmation)
  const avgPayoutTimeRow = db.prepare(`
    SELECT AVG(
      CAST((julianday(t.blockTime) - julianday(t.timestamp)) * 24 AS REAL)
    ) AS avg_hours
    FROM transactions t
    JOIN distribution_payouts dp ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.contractId = ?
      AND t.status = 'confirmed'
      AND t.blockTime IS NOT NULL
      AND t.timestamp BETWEEN ? AND ?
  `).get(walletAddress, contractId, periodStart, periodEnd);

  const avgPayoutTimeHours = avgPayoutTimeRow?.avg_hours ?? null;

  // Reliability score: weighted composite
  // 70% success_rate + 30% activity factor (log scale, capped at 100)
  const activityFactor = Math.min(Math.log10(totalPayouts + 1) * 33, 30);
  const reliabilityScore = Math.round((successRate * 0.7 + activityFactor) * 100) / 100;

  // Upsert
  const existing = db.prepare(`
    SELECT id FROM contributor_performance
    WHERE walletAddress = ? AND contractId = ? AND period_start = ?
  `).get(walletAddress, contractId, periodStart);

  if (existing) {
    db.prepare(`
      UPDATE contributor_performance SET
        success_rate = ?,
        avg_payout_time_hours = ?,
        reliability_score = ?,
        total_payouts = ?,
        total_earned = ?,
        period_end = ?,
        computed_at = CURRENT_TIMESTAMP
      WHERE walletAddress = ? AND contractId = ? AND period_start = ?
    `).run(
      successRate, avgPayoutTimeHours, reliabilityScore,
      totalPayouts, totalEarned, periodEnd,
      walletAddress, contractId, periodStart
    );
  } else {
    db.prepare(`
      INSERT INTO contributor_performance
        (walletAddress, contractId, success_rate, avg_payout_time_hours, reliability_score,
         total_payouts, total_earned, period_start, period_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      walletAddress, contractId, successRate, avgPayoutTimeHours, reliabilityScore,
      totalPayouts, totalEarned, periodStart, periodEnd
    );
  }
  countWrite();

  return getContributorPerformance(walletAddress, contractId, periodStart);
}

/**
 * Get the stored performance record for a contributor in a period.
 */
export function getContributorPerformance(walletAddress, contractId, periodStart) {
  return db.prepare(`
    SELECT * FROM contributor_performance
    WHERE walletAddress = ? AND contractId = ? AND period_start = ?
  `).get(walletAddress, contractId, periodStart) ?? null;
}

/**
 * Get the latest performance record for a contributor across all contracts.
 */
export function getContributorProfile(walletAddress) {
  return db.prepare(`
    SELECT * FROM contributor_performance
    WHERE walletAddress = ?
    ORDER BY period_start DESC
    LIMIT 12
  `).all(walletAddress);
}

/**
 * Get performance metrics for all contributors in a contract, latest period.
 * Used for ranking and tier decisions.
 */
export function getContractPerformanceLeaderboard(contractId, limit = 50) {
  return db.prepare(`
    SELECT cp.*
    FROM contributor_performance cp
    INNER JOIN (
      SELECT walletAddress, MAX(period_start) AS max_period
      FROM contributor_performance
      WHERE contractId = ?
      GROUP BY walletAddress
    ) latest ON cp.walletAddress = latest.walletAddress AND cp.period_start = latest.max_period
    WHERE cp.contractId = ?
    ORDER BY cp.reliability_score DESC
    LIMIT ?
  `).all(contractId, contractId, limit);
}

/**
 * Compute live (on-the-fly) metrics for a contributor without persisting them.
 * Used by the profile page for real-time display.
 */
export function computeLiveMetrics(walletAddress, contractId, periodStart, periodEnd) {
  const confirmedRow = db.prepare(`
    SELECT
      COUNT(*) AS total_payouts,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS total_earned,
      COALESCE(AVG(CAST(dp.amountReceived AS REAL)), 0) AS avg_payout
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.contractId = ?
      AND t.status = 'confirmed'
      AND t.timestamp BETWEEN ? AND ?
  `).get(walletAddress, contractId, periodStart, periodEnd);

  const trends = db.prepare(`
    SELECT
      DATE(t.timestamp) AS date,
      COUNT(*) AS payouts,
      SUM(CAST(dp.amountReceived AS REAL)) AS earned
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.contractId = ?
      AND t.status = 'confirmed'
      AND t.timestamp BETWEEN ? AND ?
    GROUP BY DATE(t.timestamp)
    ORDER BY date ASC
  `).all(walletAddress, contractId, periodStart, periodEnd);

  const totalPayouts = confirmedRow?.total_payouts ?? 0;
  const totalEarned = confirmedRow?.total_earned ?? 0;
  const attempted = totalPayouts; // simplified for live calc
  const successRate = 100;
  const activityFactor = Math.min(Math.log10(totalPayouts + 1) * 33, 30);
  const reliabilityScore = Math.round((successRate * 0.7 + activityFactor) * 100) / 100;

  return {
    walletAddress,
    contractId,
    period: { start: periodStart, end: periodEnd },
    metrics: {
      success_rate: successRate,
      reliability_score: reliabilityScore,
      total_payouts: totalPayouts,
      total_earned: Math.round(totalEarned * 100) / 100,
      avg_payout: Math.round((confirmedRow?.avg_payout ?? 0) * 100) / 100,
    },
    trends: trends.map((t) => ({
      date: t.date,
      payouts: t.payouts,
      earned: Math.round(t.earned * 100) / 100,
    })),
  };
}
