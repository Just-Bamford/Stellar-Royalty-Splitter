/**
 * Benchmarking service (#952).
 *
 * Provides percentile calculations, cohort grouping, and performance ranking
 * for collaborators across contracts.
 *
 * Cache: 1-hour TTL (TTL.analytics) via the shared in-memory + Redis-backed
 * cache layer in cache.js, matching the analytics resource type.
 */
import { db } from "../database/core.js";
import { cacheGet, cacheSet, cacheKey, TTL } from "../cache.js";
import logger from "../logger.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the percentile rank (0–100) of `value` within a sorted ascending
 * array of numbers.  Uses the "percentage of values strictly below" formula
 * so the result is intuitive:  rank 75 means "you earn more than 75% of peers".
 *
 * @param {number[]} sorted - Values sorted ascending.
 * @param {number}   value  - The subject value.
 * @returns {number} Percentile rank rounded to one decimal place.
 */
function percentileRank(sorted, value) {
  if (sorted.length === 0) return null;
  const below = sorted.filter((v) => v < value).length;
  return Math.round((below / sorted.length) * 1000) / 10;
}

/**
 * Compute the p-th percentile value of a sorted ascending array.
 * Uses the nearest-rank method.
 *
 * @param {number[]} sorted - Values sorted ascending.
 * @param {number}   p      - Percentile (0–100).
 * @returns {number}
 */
function percentileValue(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

/**
 * Round a number to two decimal places.
 */
function r2(n) {
  return Math.round((n ?? 0) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

/**
 * Fetch per-collaborator aggregated stats across all contracts (or one) for a
 * given date window.  Returns one row per collaborator address.
 *
 * Metrics per collaborator:
 *   - totalEarned       – sum of amountReceived across all confirmed payouts
 *   - payoutCount       – number of confirmed payouts
 *   - avgPayout         – average confirmed payout amount
 *   - activeMonths      – distinct YYYY-MM buckets that had at least one payout
 *   - payoutsPerMonth   – payoutCount / activeMonths (activity level)
 *
 * @param {string|null} contractId  - If provided, scope to a single contract.
 * @param {string}      startIso    - ISO datetime string for range start.
 * @param {string}      endIso      - ISO datetime string for range end.
 * @returns {Array<object>}
 */
function fetchCollaboratorStats(contractId, startIso, endIso) {
  const conditions = ["t.status = 'confirmed'", "t.timestamp BETWEEN ? AND ?"];
  const params = [startIso, endIso];

  if (contractId) {
    conditions.push("t.contractId = ?");
    params.push(contractId);
  }

  const where = conditions.join(" AND ");

  return db
    .prepare(
      `SELECT
        dp.collaboratorAddress                                  AS address,
        CAST(SUM(CAST(dp.amountReceived AS REAL)) AS REAL)     AS totalEarned,
        COUNT(*)                                                AS payoutCount,
        CAST(AVG(CAST(dp.amountReceived AS REAL)) AS REAL)     AS avgPayout,
        COUNT(DISTINCT strftime('%Y-%m', t.timestamp))         AS activeMonths
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE ${where}
      GROUP BY dp.collaboratorAddress`
    )
    .all(...params)
    .map((row) => ({
      address: row.address,
      totalEarned: r2(row.totalEarned),
      payoutCount: row.payoutCount,
      avgPayout: r2(row.avgPayout),
      activeMonths: row.activeMonths,
      payoutsPerMonth: row.activeMonths > 0 ? r2(row.payoutCount / row.activeMonths) : 0,
    }));
}

// ---------------------------------------------------------------------------
// Exported service functions
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/analytics/benchmarking/collaborator-percentile
 *
 * Returns the percentile rank of a single collaborator across four metrics
 * (totalEarned, payoutCount, avgPayout, payoutsPerMonth) relative to all
 * collaborators active within the requested time window.
 *
 * Also returns benchmark distribution statistics (p25/p50/p75/p90) for each
 * metric so callers can build charts without a second request.
 *
 * @param {string}      address     - Stellar G… address.
 * @param {string|null} contractId  - Optional scope.
 * @param {Date}        startDate
 * @param {Date}        endDate
 */
export function getCollaboratorPercentile(address, contractId, startDate, endDate) {
  const ck = cacheKey(
    "benchmarking:percentile",
    address,
    contractId ?? "all",
    startDate.toISOString(),
    endDate.toISOString()
  );

  const cached = cacheGet(ck);
  if (cached !== undefined) return cached;

  const allStats = fetchCollaboratorStats(contractId, startDate.toISOString(), endDate.toISOString());

  if (allStats.length === 0) {
    const result = { address, peerCount: 0, percentiles: null, benchmarks: null };
    cacheSet(ck, result, TTL.analytics);
    return result;
  }

  const subject = allStats.find((s) => s.address === address);

  // Build sorted arrays for each metric (ascending)
  const metrics = ["totalEarned", "payoutCount", "avgPayout", "payoutsPerMonth"];
  const sorted = {};
  for (const m of metrics) {
    sorted[m] = allStats.map((s) => s[m]).sort((a, b) => a - b);
  }

  // Percentile ranks for the subject (null if not found)
  const percentiles = subject
    ? Object.fromEntries(metrics.map((m) => [m, percentileRank(sorted[m], subject[m])]))
    : null;

  // Benchmark distribution for all peers
  const benchmarks = Object.fromEntries(
    metrics.map((m) => [
      m,
      {
        p25: r2(percentileValue(sorted[m], 25)),
        p50: r2(percentileValue(sorted[m], 50)),
        p75: r2(percentileValue(sorted[m], 75)),
        p90: r2(percentileValue(sorted[m], 90)),
        mean: r2(sorted[m].reduce((a, b) => a + b, 0) / sorted[m].length),
      },
    ])
  );

  // Human-readable insight strings
  const insights = [];
  if (subject && percentiles) {
    const pct = percentiles.totalEarned;
    if (pct >= 75) {
      insights.push(`Your earnings rank in the top ${r2(100 - pct)}% of collaborators`);
    } else if (pct >= 50) {
      insights.push(`Your earnings are above the median collaborator`);
    } else {
      insights.push(`Your earnings rank in the bottom ${r2(pct + 1)}% of collaborators`);
    }

    const ratio = benchmarks.totalEarned.p50 > 0
      ? r2(subject.totalEarned / benchmarks.totalEarned.p50)
      : null;
    if (ratio !== null) {
      insights.push(`You earn ${ratio}x the median collaborator`);
    }
  }

  const result = {
    address,
    found: subject !== null && subject !== undefined,
    peerCount: allStats.length,
    subject: subject ?? null,
    percentiles,
    benchmarks,
    insights,
  };

  cacheSet(ck, result, TTL.analytics);
  return result;
}

/**
 * GET /api/v1/analytics/benchmarking/cohort-comparison
 *
 * Compares a collaborator against a peer cohort.  Cohort can be defined by:
 *   - joinYear   (e.g. 2024 → collaborators who first appeared in 2024)
 *   - tier       (e.g. "vip")
 *   - both
 *
 * When no cohort filters are provided the cohort defaults to "all
 * collaborators" (same as the percentile endpoint but grouped differently).
 *
 * @param {string}      address
 * @param {string|null} contractId
 * @param {Date}        startDate
 * @param {Date}        endDate
 * @param {{ joinYear?: number, tier?: string }} cohortFilters
 */
export function getCohortComparison(address, contractId, startDate, endDate, cohortFilters = {}) {
  const { joinYear, tier } = cohortFilters;

  const ck = cacheKey(
    "benchmarking:cohort",
    address,
    contractId ?? "all",
    startDate.toISOString(),
    endDate.toISOString(),
    joinYear ?? "any",
    tier ?? "any"
  );

  const cached = cacheGet(ck);
  if (cached !== undefined) return cached;

  // Fetch all stats for the period
  const allStats = fetchCollaboratorStats(contractId, startDate.toISOString(), endDate.toISOString());

  // Enrich with join-year and tier metadata for each collaborator.
  // We only do the DB lookup for the subject to keep this fast; the cohort
  // grouping is done by first-payout date within the allStats query window.
  // For cohort assignment of every peer, compute their first-seen year from
  // a lightweight batch query.
  const firstSeenRows = db
    .prepare(
      `SELECT dp.collaboratorAddress AS address, MIN(t.timestamp) AS firstSeen
       FROM distribution_payouts dp
       JOIN transactions t ON dp.transactionId = t.id
       WHERE t.status = 'confirmed'
       GROUP BY dp.collaboratorAddress`
    )
    .all();

  const firstSeenMap = new Map(firstSeenRows.map((r) => [r.address, r.firstSeen]));

  // Tier batch query (optional table)
  const tierMap = new Map();
  try {
    const tierRows = db
      .prepare(`SELECT collaboratorAddress, tier FROM contributor_tiers`)
      .all();
    for (const r of tierRows) tierMap.set(r.collaboratorAddress, r.tier);
  } catch (_e) {
    // Table doesn't exist; all tiers default to "regular"
  }

  const enriched = allStats.map((s) => {
    const fs = firstSeenMap.get(s.address);
    return {
      ...s,
      joinYear: fs ? new Date(fs).getFullYear() : null,
      tier: tierMap.get(s.address) ?? "regular",
    };
  });

  // Apply cohort filters
  let cohort = enriched;
  const appliedFilters = {};

  if (joinYear !== undefined && joinYear !== null) {
    cohort = cohort.filter((s) => s.joinYear === Number(joinYear));
    appliedFilters.joinYear = Number(joinYear);
  }
  if (tier !== undefined && tier !== null) {
    cohort = cohort.filter((s) => s.tier === tier);
    appliedFilters.tier = tier;
  }

  const subject = enriched.find((s) => s.address === address) ?? null;

  const metrics = ["totalEarned", "payoutCount", "avgPayout", "payoutsPerMonth"];

  // Cohort averages and medians
  const cohortStats = {};
  for (const m of metrics) {
    const vals = cohort.map((s) => s[m]).sort((a, b) => a - b);
    cohortStats[m] = {
      mean: vals.length > 0 ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : 0,
      median: vals.length > 0 ? r2(percentileValue(vals, 50)) : 0,
      count: vals.length,
    };
  }

  // Comparison ratios for the subject vs cohort median
  const comparisons = {};
  if (subject) {
    for (const m of metrics) {
      const median = cohortStats[m].median;
      comparisons[m] = {
        subjectValue: subject[m],
        cohortMedian: median,
        ratio: median > 0 ? r2(subject[m] / median) : null,
        percentileInCohort: percentileRank(
          cohort.map((s) => s[m]).sort((a, b) => a - b),
          subject[m]
        ),
      };
    }
  }

  // Insight strings
  const insights = [];
  if (subject && comparisons.totalEarned) {
    const ratio = comparisons.totalEarned.ratio;
    const cohortLabel = [
      joinYear ? `who joined in ${joinYear}` : null,
      tier ? `with tier "${tier}"` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    const peerLabel = cohortLabel
      ? `collaborators ${cohortLabel}`
      : "all collaborators";

    if (ratio !== null) {
      insights.push(
        `Compared to ${peerLabel}: you earn ${ratio}x the median (${cohortStats.totalEarned.median} XLM)`
      );
    }
    if (comparisons.payoutsPerMonth.ratio !== null) {
      insights.push(
        `Your activity level (${subject.payoutsPerMonth} payouts/mo) is ${comparisons.payoutsPerMonth.ratio}x the cohort median`
      );
    }
  }

  const result = {
    address,
    found: subject !== null,
    cohortSize: cohort.length,
    cohortFilters: appliedFilters,
    subject: subject ?? null,
    cohortStats,
    comparisons: subject ? comparisons : null,
    insights,
  };

  cacheSet(ck, result, TTL.analytics);
  return result;
}

/**
 * GET /api/v1/analytics/benchmarking/performance-ranking
 *
 * Returns top-N and bottom-N collaborators by a chosen metric.
 * Supports scoping to a contract and a date range.
 *
 * @param {string|null} contractId
 * @param {Date}        startDate
 * @param {Date}        endDate
 * @param {string}      metric       - "totalEarned" | "payoutCount" | "avgPayout" | "payoutsPerMonth"
 * @param {number}      n            - Number of top/bottom entries (1–50, default 10)
 */
export function getPerformanceRanking(contractId, startDate, endDate, metric, n) {
  const VALID_METRICS = ["totalEarned", "payoutCount", "avgPayout", "payoutsPerMonth"];
  const safeMetric = VALID_METRICS.includes(metric) ? metric : "totalEarned";
  const safeN = Math.min(Math.max(parseInt(n, 10) || 10, 1), 50);

  const ck = cacheKey(
    "benchmarking:ranking",
    contractId ?? "all",
    startDate.toISOString(),
    endDate.toISOString(),
    safeMetric,
    safeN
  );

  const cached = cacheGet(ck);
  if (cached !== undefined) return cached;

  const allStats = fetchCollaboratorStats(contractId, startDate.toISOString(), endDate.toISOString());

  if (allStats.length === 0) {
    const result = {
      metric: safeMetric,
      totalCollaborators: 0,
      top: [],
      bottom: [],
    };
    cacheSet(ck, result, TTL.analytics);
    return result;
  }

  // Sort descending by metric to assign ranks
  const ranked = [...allStats].sort((a, b) => b[safeMetric] - a[safeMetric]);

  const withRank = ranked.map((s, i) => ({ ...s, rank: i + 1 }));

  const top = withRank.slice(0, safeN);
  // Bottom = last safeN entries reversed so rank 1 = worst
  const bottom = withRank
    .slice(-safeN)
    .reverse()
    .map((s, i) => ({ ...s, bottomRank: i + 1 }));

  // Aggregate distribution stats
  const vals = allStats.map((s) => s[safeMetric]).sort((a, b) => a - b);
  const distribution = {
    min: r2(vals[0]),
    p25: r2(percentileValue(vals, 25)),
    p50: r2(percentileValue(vals, 50)),
    p75: r2(percentileValue(vals, 75)),
    p90: r2(percentileValue(vals, 90)),
    max: r2(vals[vals.length - 1]),
    mean: r2(vals.reduce((a, b) => a + b, 0) / vals.length),
  };

  const result = {
    metric: safeMetric,
    n: safeN,
    totalCollaborators: allStats.length,
    distribution,
    top,
    bottom,
  };

  logger.info("Benchmarking performance ranking computed", {
    contractId: contractId ?? "global",
    metric: safeMetric,
    totalCollaborators: allStats.length,
  });

  cacheSet(ck, result, TTL.analytics);
  return result;
}
