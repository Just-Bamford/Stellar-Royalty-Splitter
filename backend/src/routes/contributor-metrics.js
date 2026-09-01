/**
 * Contributor performance metrics routes — closes #600.
 *
 * GET /api/v1/contributor-metrics/:walletAddress
 *   Returns success_rate, avg_payout_time, reliability_score,
 *   trend data for charting, and summary totals.
 *
 * POST /api/v1/contributor-metrics/:walletAddress/refresh
 *   Force-recomputes metrics for a contributor (admin / operator use).
 *
 * GET /api/v1/contributor-metrics/leaderboard/:contractId
 *   Returns ranked metrics for all contributors on a contract.
 *
 * POST /api/v1/contributor-metrics/recompute/:contractId
 *   Bulk recomputes metrics for all contributors on a contract.
 */

import { Router } from "express";
import { z } from "zod";
import { contractAddress } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";
import {
  getOrComputeMetrics,
  recomputeMetrics,
  getContractLeaderboard,
  recomputeContractMetrics,
} from "../database/index.js";
import { addAuditLog } from "../database/index.js";

export const contributorMetricsRouter = Router();

// ─── GET /api/v1/contributor-metrics/:walletAddress ──────────────────────────

const profileQuerySchema = z.object({
  refresh: z.coerce.boolean().optional().default(false),
  maxAgeMs: z.coerce.number().int().min(0).optional().default(300_000),
});

contributorMetricsRouter.get("/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const queryResult = profileQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return sendValidationError(
      res,
      queryResult.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { refresh, maxAgeMs } = queryResult.data;

  const metrics = refresh
    ? recomputeMetrics(walletAddress)
    : getOrComputeMetrics(walletAddress, maxAgeMs);

  return res.json({ success: true, data: metrics });
});

// ─── POST /api/v1/contributor-metrics/:walletAddress/refresh ─────────────────

contributorMetricsRouter.post("/:walletAddress/refresh", (req, res) => {
  const { walletAddress } = req.params;

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const metrics = recomputeMetrics(walletAddress);

  addAuditLog("SYSTEM", "contributor_metrics_refreshed", walletAddress, {
    successRate: metrics.successRate,
    reliabilityScore: metrics.reliabilityScore,
  });

  return res.json({ success: true, data: metrics });
});

// ─── GET /api/v1/contributor-metrics/leaderboard/:contractId ─────────────────

const leaderboardQuerySchema = z.object({
  sortBy: z.enum(["reliabilityScore", "successRate", "totalPayouts", "totalEarned", "avgPayoutTime"])
    .optional()
    .default("reliabilityScore"),
  limit:  z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

contributorMetricsRouter.get("/leaderboard/:contractId", (req, res) => {
  const { contractId } = req.params;

  // Validate contract address format
  const contractResult = contractAddress.safeParse(contractId);
  if (!contractResult.success) {
    return sendError(res, 400, "invalid_contract_address", "Invalid contract address format");
  }

  const queryResult = leaderboardQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return sendValidationError(
      res,
      queryResult.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { sortBy, limit, offset } = queryResult.data;
  const data = getContractLeaderboard(contractId, { sortBy, limit, offset });

  return res.json({ success: true, data, query: { sortBy, limit, offset } });
});

// ─── POST /api/v1/contributor-metrics/recompute/:contractId ──────────────────

contributorMetricsRouter.post("/recompute/:contractId", (req, res) => {
  const { contractId } = req.params;

  const contractResult = contractAddress.safeParse(contractId);
  if (!contractResult.success) {
    return sendError(res, 400, "invalid_contract_address", "Invalid contract address format");
  }

  const updated = recomputeContractMetrics(contractId);

  addAuditLog(contractId, "contributor_metrics_bulk_recomputed", "system", { updated });

  return res.json({ success: true, data: { updated } });
});
