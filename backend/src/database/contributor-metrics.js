/**
 * Contributor performance metrics — closes #600.
 *
 * Calculates and caches per-contributor metrics:
 *
 *   success_rate    — confirmed payouts / total distribution attempts (%)
 *   avg_payout_time — average hours between distribution initiation and block confirmation
 *   reliability_score — composite 0–100 score derived from success_rate and
 *                       payout consistency over time
 *
 * Metrics are recomputed on demand and cached in contributor_metrics.
 * The cache is invalidated whenever a new distribution payout lands for the wallet.
 */

import { db, countWrite } from "./core.js";

// ─── Query helpers ────────────────────────────────────────────────────────────

/**
 * Raw statistics needed to compute all metrics for a wallet.
 *
 * @param {string} walletAddress
 * @returns {object}
 */
function fetchRawStats(walletAddress) {
  // Total distribution attempts where this wallet was a payout recipient
  const attempts = db.prepare(`
    SELECT
      COUNT(DISTINCT t.id)                                            AS totalAttempts,
      COUNT(DISTINCT CASE WHEN t.status = 'confirmed' THEN t.id END) AS confirmedPayouts,
      COUNT(DISTINCT CASE WHEN t.status = 'failed'    THEN t.id END) AS failedPayouts,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0)               AS totalEarned,
      MIN(COALESCE(t.blockTime, t.timestamp))                         AS firstPayoutAt,
      MAX(COALESCE(t.blockTime, t.timestamp))                         AS lastPayoutAt
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.type = 'distribute'
  `).get(walletAddress);

  // Average time (hours) from transaction creation to block confirmation
  const avgConfirmTime = db.prepare(`
    SELECT AVG(
      (julianday(COALESCE(t.blockTime, t.timestamp)) - julianday(t.timestamp)) * 24
    ) AS avgHours
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.status = 'confirmed'
      AND t.blockTime IS NOT NULL
      AND t.type = 'distribute'
  `).get(walletAddress);

  // Monthly payout counts over the last 12 months (for consistency scoring)
  const monthlyActivity = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(t.blockTime, t.timestamp)) AS month,
      COUNT(*) AS payouts
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.status = 'confirmed'
      AND COALESCE(t.blockTime, t.timestamp) >= datetime('now', '-12 months')
    GROUP BY month
    ORDER BY month ASC
  `).all(walletAddress);

  // Trend: last 6 months rolling (for charts)
  const trend = db.prepare(`
    SELECT
      strftime('%Y-%m', COALESCE(t.blockTime, t.timestamp)) AS period,
      COUNT(*) AS payoutCount,
      COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS totalAmount
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE dp.collaboratorAddress = ?
      AND t.status = 'confirmed'
      AND COALESCE(t.blockTime, t.timestamp) >= datetime('now', '-6 months')
    GROUP BY period
    ORDER BY period ASC
  `).all(walletAddress);

  return { attempts, avgConfirmTime, monthlyActivity, trend };
}

/**
 * Compute a reliability score (0–100).
 *
 * Formula:
 *   base       = success_rate (0–100)
 *   consistency = % of last 12 months with at least 1 confirmed payout
 *               (bonus/penalty: +10 if 12/12 months active, −10 if < 3 months)
 *   score      = clamp(0.7 * base + 0.3 * consistency * 100, 0, 100)
 *
 * @param {number} successRate   - 0–100
 * @param {object[]} monthlyActivity - rows with { month, payouts }
 * @returns {number} 0–100
 */
function computeReliabilityScore(successRate, monthlyActivity) {
  const activeMonths = monthlyActivity.filter((m) => m.payouts > 0).length;
  const consistencyPct = (activeMonths / 12) * 100;
  const raw = 0.7 * successRate + 0.3 * consistencyPct;
  return Math.round(Math.min(100, Math.max(0, raw)));
}

// ─── Cached metrics table ─────────────────────────────────────────────────────

/**
 * Retrieve cached metrics for a wallet.
 *
 * @param {string} walletAddress
 * @returns {object|null}
 */
export function getCachedMetrics(walletAddress) {
  return db.prepare(`
    SELECT walletAddress, successRate, avgPayoutTime, reliabilityScore,
           totalPayouts, totalEarned, firstPayoutAt, lastPayoutAt,
           trendJson, computedAt
    FROM contributor_metrics
    WHERE walletAddress = ?
  `).get(walletAddress) ?? null;
}

/**
 * Recompute and upsert metrics for a wallet.
 *
 * @param {string} walletAddress
 * @returns {object} The freshly computed metrics record
 */
export function recomputeMetrics(walletAddress) {
  const { attempts, avgConfirmTime, monthlyActivity, trend } = fetchRawStats(walletAddress);

  const totalAttempts = attempts?.totalAttempts ?? 0;
  const confirmedPayouts = attempts?.confirmedPayouts ?? 0;

  const successRate = totalAttempts > 0
    ? Math.round((confirmedPayouts / totalAttempts) * 100 * 10) / 10
    : 0;

  const avgPayoutTimeHours = avgConfirmTime?.avgHours != null
    ? Math.round(avgConfirmTime.avgHours * 100) / 100
    : null;

  const reliabilityScore = computeReliabilityScore(successRate, monthlyActivity);

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO contributor_metrics
      (walletAddress, successRate, avgPayoutTime, reliabilityScore,
       totalPayouts, totalEarned, firstPayoutAt, lastPayoutAt,
       trendJson, computedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(walletAddress) DO UPDATE SET
      successRate      = excluded.successRate,
      avgPayoutTime    = excluded.avgPayoutTime,
      reliabilityScore = excluded.reliabilityScore,
      totalPayouts     = excluded.totalPayouts,
      totalEarned      = excluded.totalEarned,
      firstPayoutAt    = excluded.firstPayoutAt,
      lastPayoutAt     = excluded.lastPayoutAt,
      trendJson        = excluded.trendJson,
      computedAt       = excluded.computedAt
  `).run(
    walletAddress,
    successRate,
    avgPayoutTimeHours,
    reliabilityScore,
    confirmedPayouts,
    attempts?.totalEarned ?? 0,
    attempts?.firstPayoutAt ?? null,
    attempts?.lastPayoutAt ?? null,
    JSON.stringify(trend),
    now
  );

  countWrite();

  return {
    walletAddress,
    successRate,
    avgPayoutTime: avgPayoutTimeHours,
    reliabilityScore,
    totalPayouts: confirmedPayouts,
    totalEarned: attempts?.totalEarned ?? 0,
    firstPayoutAt: attempts?.firstPayoutAt ?? null,
    lastPayoutAt: attempts?.lastPayoutAt ?? null,
    trend,
    computedAt: now,
  };
}

/**
 * Get metrics for a wallet, recomputing if cache is older than `maxAgeMs`.
 *
 * @param {string} walletAddress
 * @param {number} [maxAgeMs=300_000] - 5 minutes default
 * @returns {object}
 */
export function getOrComputeMetrics(walletAddress, maxAgeMs = 300_000) {
  const cached = getCachedMetrics(walletAddress);

  if (cached) {
    const ageMs = Date.now() - new Date(cached.computedAt).getTime();
    if (ageMs < maxAgeMs) {
      return {
        ...cached,
        trend: cached.trendJson ? JSON.parse(cached.trendJson) : [],
      };
    }
  }

  return recomputeMetrics(walletAddress);
}

/**
 * Bulk recompute metrics for all active contributors on a contract.
 * Returns the number of wallets updated.
 *
 * @param {string} contractId
 * @returns {number}
 */
export function recomputeContractMetrics(contractId) {
  const wallets = db.prepare(`
    SELECT DISTINCT dp.collaboratorAddress
    FROM distribution_payouts dp
    JOIN transactions t ON dp.transactionId = t.id
    WHERE t.contractId = ? AND t.type = 'distribute'
  `).all(contractId).map((r) => r.collaboratorAddress);

  for (const wallet of wallets) {
    recomputeMetrics(wallet);
  }

  return wallets.length;
}

/**
 * Get ranked leaderboard metrics for all contributors on a contract.
 *
 * @param {string} contractId
 * @param {{ sortBy?: string, limit?: number, offset?: number }} opts
 * @returns {object[]}
 */
export function getContractLeaderboard(contractId, { sortBy = "reliabilityScore", limit = 50, offset = 0 } = {}) {
  const allowedSort = ["reliabilityScore", "successRate", "totalPayouts", "totalEarned", "avgPayoutTime"];
  const col = allowedSort.includes(sortBy) ? sortBy : "reliabilityScore";

  return db.prepare(`
    SELECT cm.walletAddress, cm.successRate, cm.avgPayoutTime, cm.reliabilityScore,
           cm.totalPayouts, cm.totalEarned, cm.firstPayoutAt, cm.lastPayoutAt, cm.computedAt
    FROM contributor_metrics cm
    WHERE cm.walletAddress IN (
      SELECT DISTINCT dp.collaboratorAddress
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ?
    )
    ORDER BY cm.${col} DESC
    LIMIT ? OFFSET ?
  `).all(contractId, limit, offset);
}
