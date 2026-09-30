/**
 * Reputation and trust score routes — closes #962.
 *
 * Public endpoints:
 *   GET    /api/v1/reputation/:walletAddress        — get reputation details for a wallet
 *   GET    /api/v1/reputation/leaderboard/top       — top collaborators by trust score
 *   GET    /api/v1/reputation/tier/:tier            — collaborators by reputation tier
 *   GET    /api/v1/reputation/statistics            — overall reputation statistics
 *
 * Admin endpoints (Bearer ADMIN_ROTATE_TOKEN):
 *   POST   /api/v1/reputation/admin/recalculate     — recalculate all trust scores
 *   POST   /api/v1/reputation/admin/activity        — manually record reputation activity
 */

import { Router } from "express";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { parsePagination } from "../validation.js";
import { cacheGet, cacheSet, cacheKey } from "../cache.js";
import {
  getReputationDetails,
  getTopCollaborators,
  getCollaboratorsByTier,
  countCollaboratorsByTier,
  getReputationStatistics,
  recalculateAllTrustScores,
  recordReputationActivity,
  calculateTrustScore,
} from "../database/reputation.js";

export const reputationRouter = Router();

// ─── Admin auth middleware ────────────────────────────────────────────────────

function extractBearerToken(req) {
  const header = req.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function requireAdminToken(req, res, next) {
  const envToken = process.env.ADMIN_ROTATE_TOKEN;
  if (!envToken) {
    return sendError(res, 503, "service_unavailable", "Admin operations are not configured on this server");
  }
  const token = extractBearerToken(req);
  if (!token || token !== envToken) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateStellarAddress(address) {
  return /^G[A-Z2-7]{55}$/.test(address);
}

function validateReputationTier(tier) {
  return ['newcomer', 'bronze', 'silver', 'gold', 'platinum'].includes(tier);
}

// ─── Public: Get reputation for a wallet address ──────────────────────────────

reputationRouter.get("/:walletAddress", (req, res, next) => {
  try {
    const { walletAddress } = req.params;

    if (!validateStellarAddress(walletAddress)) {
      return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
    }

    const cKey = cacheKey("reputation:details", walletAddress);
    const cached = cacheGet(cKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    const reputation = getReputationDetails(walletAddress);
    const responsePayload = {
      success: true,
      data: reputation,
    };

    cacheSet(cKey, responsePayload, 60_000); // 60s TTL
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get top collaborators leaderboard ────────────────────────────────

reputationRouter.get("/leaderboard/top", (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 10;

    if (limit < 1 || limit > 100) {
      return sendError(res, 400, "invalid_limit", "Limit must be between 1 and 100");
    }

    const cKey = cacheKey("reputation:leaderboard:top", limit);
    const cached = cacheGet(cKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    const topCollaborators = getTopCollaborators(limit);
    const responsePayload = {
      success: true,
      data: topCollaborators,
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get collaborators by tier ────────────────────────────────────────

reputationRouter.get("/tier/:tier", (req, res, next) => {
  try {
    const { tier } = req.params;

    if (!validateReputationTier(tier)) {
      return sendError(
        res,
        400,
        "invalid_tier",
        "Tier must be one of: newcomer, bronze, silver, gold, platinum"
      );
    }

    const pagination = parsePagination(req.query, res);
    if (!pagination) return;

    const cKey = cacheKey("reputation:tier", tier, pagination.limit, pagination.offset);
    const cached = cacheGet(cKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    const collaborators = getCollaboratorsByTier(tier, pagination.limit, pagination.offset);
    const total = countCollaboratorsByTier(tier);

    const responsePayload = {
      success: true,
      data: collaborators,
      pagination: {
        total,
        limit: pagination.limit,
        offset: pagination.offset,
      },
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Public: Get overall reputation statistics ────────────────────────────────

reputationRouter.get("/statistics", (req, res, next) => {
  try {
    const cKey = cacheKey("reputation:statistics");
    const cached = cacheGet(cKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    const statistics = getReputationStatistics();
    const responsePayload = {
      success: true,
      data: statistics,
    };

    cacheSet(cKey, responsePayload, 60_000);
    return res.json(responsePayload);
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Recalculate all trust scores ──────────────────────────────────────

reputationRouter.post("/admin/recalculate", requireAdminToken, async (req, res, next) => {
  try {
    logger.info("Starting bulk trust score recalculation", { admin: true });

    const result = recalculateAllTrustScores();

    logger.info("Bulk trust score recalculation completed", result);

    return res.json({
      success: true,
      data: result,
      message: `Recalculated ${result.updated} of ${result.total} trust scores`,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Admin: Record reputation activity ────────────────────────────────────────

reputationRouter.post("/admin/activity", requireAdminToken, async (req, res, next) => {
  try {
    const { walletAddress, activityType, impactScore, details } = req.body;

    if (!walletAddress || !validateStellarAddress(walletAddress)) {
      return sendError(res, 400, "invalid_wallet_address", "Valid walletAddress is required");
    }

    const validActivityTypes = [
      'dispute_opened',
      'dispute_resolved',
      'project_completed',
      'endorsed_by_peer',
      'flagged',
    ];

    if (!activityType || !validActivityTypes.includes(activityType)) {
      return sendError(
        res,
        400,
        "invalid_activity_type",
        `activityType must be one of: ${validActivityTypes.join(", ")}`
      );
    }

    if (typeof impactScore !== 'number') {
      return sendError(res, 400, "invalid_impact_score", "impactScore must be a number");
    }

    recordReputationActivity(walletAddress, activityType, impactScore, details);

    // Recalculate trust score after activity
    const newScore = calculateTrustScore(walletAddress);

    logger.info("Reputation activity recorded", {
      walletAddress,
      activityType,
      impactScore,
      newScore,
    });

    return res.status(201).json({
      success: true,
      data: {
        walletAddress,
        activityType,
        impactScore,
        newScore,
      },
      message: "Reputation activity recorded and trust score updated",
    });
  } catch (err) {
    next(err);
  }
});
