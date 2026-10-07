/**
 * Collaborator performance benchmarking routes (#952).
 *
 * All three endpoints are read-only and scoped under /api/v1/analytics/benchmarking.
 * They are cached for 1 hour (TTL.analytics) inside the service layer.
 *
 * Endpoints:
 *   GET /api/v1/analytics/benchmarking/collaborator-percentile
 *   GET /api/v1/analytics/benchmarking/cohort-comparison
 *   GET /api/v1/analytics/benchmarking/performance-ranking
 */
import { Router } from "express";
import { sendError } from "../../error-response.js";
import {
  getCollaboratorPercentile,
  getCohortComparison,
  getPerformanceRanking,
} from "../../services/benchmarking.js";
import logger from "../../logger.js";

export const benchmarkingRouter = Router();

// Stellar address regex — shared validation helper
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * Parse and validate a shared date range from query params.
 * Defaults: start = 90 days ago, end = now.
 * Returns { startDate, endDate } or writes a 400 and returns null.
 */
function parseDateRange(query, res) {
  const { start, end } = query;
  const startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const endDate = end ? new Date(end) : new Date();

  if (start && isNaN(startDate.getTime())) {
    sendError(res, 400, "invalid_query_parameter", "Invalid start date. Use YYYY-MM-DD.");
    return null;
  }
  if (end && isNaN(endDate.getTime())) {
    sendError(res, 400, "invalid_query_parameter", "Invalid end date. Use YYYY-MM-DD.");
    return null;
  }
  if (start && end && startDate > endDate) {
    sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");
    return null;
  }

  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/benchmarking/collaborator-percentile
// ---------------------------------------------------------------------------
/**
 * What percentage of collaborators earn more / less than the queried address?
 *
 * Required query params:
 *   address    Stellar G... address of the collaborator to look up.
 *
 * Optional query params:
 *   contractId  Scope to a single contract (default: all contracts).
 *   start       YYYY-MM-DD  (default: 90 days ago)
 *   end         YYYY-MM-DD  (default: today)
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       address,
 *       found,           // false when the address has no payouts in the window
 *       peerCount,
 *       subject,         // the collaborator's own stats (null when not found)
 *       percentiles: {   // 0–100 — what % of peers the subject outperforms
 *         totalEarned, payoutCount, avgPayout, payoutsPerMonth
 *       },
 *       benchmarks: {    // distribution stats for all peers
 *         totalEarned: { p25, p50, p75, p90, mean }, ...
 *       },
 *       insights         // human-readable strings
 *     }
 *   }
 */
benchmarkingRouter.get("/collaborator-percentile", (req, res) => {
  const { address, contractId } = req.query;

  if (!address || !STELLAR_ADDRESS_RE.test(address)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      "Valid Stellar address is required (address=G...)"
    );
  }

  const range = parseDateRange(req.query, res);
  if (!range) return;

  try {
    const data = getCollaboratorPercentile(
      address,
      contractId ?? null,
      range.startDate,
      range.endDate
    );

    res.set("Cache-Control", "max-age=3600");
    return res.json({ success: true, data });
  } catch (error) {
    logger.error("Benchmarking collaborator-percentile error", { error: error.message, address });
    return sendError(res, 500, "benchmarking_fetch_failed", "Failed to compute percentile data");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/benchmarking/cohort-comparison
// ---------------------------------------------------------------------------
/**
 * How does a collaborator compare against a peer cohort (by join date / tier)?
 *
 * Required query params:
 *   address    Stellar G... address.
 *
 * Optional query params:
 *   contractId  Scope to a single contract.
 *   start       YYYY-MM-DD  (default: 90 days ago)
 *   end         YYYY-MM-DD  (default: today)
 *   joinYear    Filter cohort to collaborators whose first payout was in this year
 *               (e.g. 2024).
 *   tier        Filter cohort to a specific tier ("vip" | "regular" | "trial").
 *               Requires the contributor_tiers table to be populated (#589).
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       address,
 *       found,
 *       cohortSize,
 *       cohortFilters,          // the filters that were actually applied
 *       subject,                // this collaborator's stats
 *       cohortStats: {
 *         totalEarned: { mean, median, count }, ...
 *       },
 *       comparisons: {
 *         totalEarned: {
 *           subjectValue, cohortMedian, ratio, percentileInCohort
 *         }, ...
 *       },
 *       insights
 *     }
 *   }
 */
benchmarkingRouter.get("/cohort-comparison", (req, res) => {
  const { address, contractId, joinYear, tier } = req.query;

  if (!address || !STELLAR_ADDRESS_RE.test(address)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      "Valid Stellar address is required (address=G...)"
    );
  }

  if (joinYear !== undefined) {
    const y = parseInt(joinYear, 10);
    if (isNaN(y) || y < 2000 || y > 2100) {
      return sendError(
        res,
        400,
        "invalid_query_parameter",
        "joinYear must be a valid 4-digit year (e.g. 2024)"
      );
    }
  }

  const VALID_TIERS = ["vip", "regular", "trial"];
  if (tier !== undefined && !VALID_TIERS.includes(tier)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      `tier must be one of: ${VALID_TIERS.join(", ")}`
    );
  }

  const range = parseDateRange(req.query, res);
  if (!range) return;

  try {
    const data = getCohortComparison(
      address,
      contractId ?? null,
      range.startDate,
      range.endDate,
      {
        joinYear: joinYear !== undefined ? parseInt(joinYear, 10) : undefined,
        tier: tier ?? undefined,
      }
    );

    res.set("Cache-Control", "max-age=3600");
    return res.json({ success: true, data });
  } catch (error) {
    logger.error("Benchmarking cohort-comparison error", { error: error.message, address });
    return sendError(res, 500, "benchmarking_fetch_failed", "Failed to compute cohort comparison");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/analytics/benchmarking/performance-ranking
// ---------------------------------------------------------------------------
/**
 * Top-N and bottom-N performers by a chosen metric.
 *
 * Optional query params:
 *   contractId  Scope to a single contract (default: global).
 *   start       YYYY-MM-DD  (default: 90 days ago)
 *   end         YYYY-MM-DD  (default: today)
 *   metric      "totalEarned" | "payoutCount" | "avgPayout" | "payoutsPerMonth"
 *               (default: totalEarned)
 *   n           Number of entries in top / bottom lists, 1–50 (default: 10)
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       metric,
 *       n,
 *       totalCollaborators,
 *       distribution: { min, p25, p50, p75, p90, max, mean },
 *       top: [{ address, totalEarned, payoutCount, avgPayout,
 *               payoutsPerMonth, activeMonths, rank }, ...],
 *       bottom: [{ ..., bottomRank }, ...]
 *     }
 *   }
 */
benchmarkingRouter.get("/performance-ranking", (req, res) => {
  const { contractId, metric = "totalEarned", n = "10" } = req.query;

  const VALID_METRICS = ["totalEarned", "payoutCount", "avgPayout", "payoutsPerMonth"];
  if (!VALID_METRICS.includes(metric)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      `metric must be one of: ${VALID_METRICS.join(", ")}`
    );
  }

  const parsedN = parseInt(n, 10);
  if (isNaN(parsedN) || parsedN < 1 || parsedN > 50) {
    return sendError(res, 400, "invalid_query_parameter", "n must be an integer between 1 and 50");
  }

  const range = parseDateRange(req.query, res);
  if (!range) return;

  try {
    const data = getPerformanceRanking(
      contractId ?? null,
      range.startDate,
      range.endDate,
      metric,
      parsedN
    );

    res.set("Cache-Control", "max-age=3600");
    return res.json({ success: true, data });
  } catch (error) {
    logger.error("Benchmarking performance-ranking error", { error: error.message });
    return sendError(res, 500, "benchmarking_fetch_failed", "Failed to compute performance ranking");
  }
});
