/**
 * Contributor Performance Metrics routes (#600).
 *
 * GET  /api/v1/contributor-performance/leaderboard/:contractId
 *   Top contributors ranked by reliability_score for a contract.
 *
 * POST /api/v1/contributor-performance/compute
 *   Trigger metric computation for a contributor + contract + period (admin/system).
 *
 * GET  /api/v1/contributor-performance/:walletAddress
 *   Profile page metrics for a contributor (all contracts, trend history).
 *
 * GET  /api/v1/contributor-performance/:walletAddress/contract/:contractId
 *   Live metrics for a contributor on a specific contract.
 *
 * NOTE: Static prefix routes (leaderboard, compute) are registered BEFORE
 * parameterised routes (/:walletAddress) to prevent Express swallowing them.
 */

import { Router } from "express";
import {
  computeAndSavePerformance,
  computeLiveMetrics,
  getContributorProfile,
  getContractPerformanceLeaderboard,
} from "../database/contributor-performance.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/audit.js";
import logger from "../logger.js";

const router = Router();

function isValidStellarAddress(addr) {
  return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
}

function parseDateRange(start, end) {
  const startDate = start
    ? new Date(start)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const endDate = end ? new Date(end) : new Date();
  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// GET /api/v1/contributor-performance/leaderboard/:contractId
// Registered FIRST — static prefix beats /:walletAddress
// ---------------------------------------------------------------------------
router.get("/leaderboard/:contractId", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

  try {
    const leaderboard = getContractPerformanceLeaderboard(contractId, limit);

    return res.json({
      success: true,
      contractId,
      data: leaderboard.map((row, idx) => ({ ...row, rank: idx + 1 })),
    });
  } catch (err) {
    logger.error("Failed to get leaderboard", { contractId, error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get leaderboard");
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/contributor-performance/compute
// Admin/system: compute and persist metrics for a contributor in a period
// Registered BEFORE /:walletAddress so the path is not captured as a wallet.
// ---------------------------------------------------------------------------
router.post("/compute", (req, res) => {
  const { walletAddress, contractId, periodStart, periodEnd } = req.body;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar wallet address");
  }
  if (!contractId || !/^C[A-Z2-7]{55}$/.test(contractId)) {
    return sendError(res, 400, "invalid_contract_id", "Invalid contract ID");
  }
  if (!periodStart || !periodEnd) {
    return sendError(res, 400, "validation_error", "periodStart and periodEnd are required");
  }

  try {
    const record = computeAndSavePerformance(walletAddress, contractId, periodStart, periodEnd);

    addAuditLog(contractId, "contributor_metrics_computed", "system", {
      walletAddress,
      periodStart,
      periodEnd,
      reliability_score: record?.reliability_score,
    });

    return res.json({ success: true, data: record });
  } catch (err) {
    logger.error("Failed to compute metrics", { walletAddress, contractId, error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to compute metrics");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributor-performance/:walletAddress
// Profile page — all contracts, trend history (last 12 periods)
// ---------------------------------------------------------------------------
router.get("/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar wallet address");
  }

  try {
    const history = getContributorProfile(walletAddress);

    // Aggregate across all contracts for summary
    const latestByContract = {};
    for (const row of history) {
      if (
        !latestByContract[row.contractId] ||
        row.period_start > latestByContract[row.contractId].period_start
      ) {
        latestByContract[row.contractId] = row;
      }
    }

    const latestRecords = Object.values(latestByContract);
    const overallReliability =
      latestRecords.length > 0
        ? Math.round(
            (latestRecords.reduce((sum, r) => sum + r.reliability_score, 0) /
              latestRecords.length) *
              100
          ) / 100
        : 0;

    const overallEarned = latestRecords.reduce((sum, r) => sum + (r.total_earned ?? 0), 0);

    return res.json({
      success: true,
      data: {
        walletAddress,
        summary: {
          overall_reliability_score: overallReliability,
          total_earned_all_contracts: Math.round(overallEarned * 100) / 100,
          active_contracts: latestRecords.length,
        },
        history,
        latestByContract: latestRecords,
      },
    });
  } catch (err) {
    logger.error("Failed to get contributor profile", { walletAddress, error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get profile");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/contributor-performance/:walletAddress/contract/:contractId
// Real-time metrics for a contributor on a specific contract
// ---------------------------------------------------------------------------
router.get("/:walletAddress/contract/:contractId", validateContractIdMiddleware, (req, res) => {
  const { walletAddress, contractId } = req.params;
  const { start, end } = req.query;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar wallet address");
  }

  const { startDate, endDate } = parseDateRange(start, end);

  if (start && isNaN(startDate.getTime())) {
    return sendError(res, 400, "invalid_query_parameter", "Invalid start date");
  }
  if (end && isNaN(endDate.getTime())) {
    return sendError(res, 400, "invalid_query_parameter", "Invalid end date");
  }

  try {
    const metrics = computeLiveMetrics(
      walletAddress,
      contractId,
      startDate.toISOString(),
      endDate.toISOString()
    );

    return res.json({ success: true, data: metrics });
  } catch (err) {
    logger.error("Failed to compute live metrics", { walletAddress, contractId, error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to compute metrics");
  }
});

export { router as contributorPerformanceRouter };
