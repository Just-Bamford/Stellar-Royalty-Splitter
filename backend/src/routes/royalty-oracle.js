import { Router } from "express";
import { requireRole } from "../middleware/rbac.js";
import { addAuditLog } from "../database/audit.js";
import {
  approveRecommendation,
  collectMarketData,
  getMarketSnapshot,
  getRecommendation,
  listRecommendations,
} from "../services/royalty-oracle.js";
import { sendError } from "../error-response.js";

export const royaltyOracleRouter = Router();

royaltyOracleRouter.get("/recommendations", requireRole("viewer"), (_req, res) => {
  res.json({ success: true, data: listRecommendations() });
});

royaltyOracleRouter.get("/recommendations/:collectionId", requireRole("viewer"), (req, res) => {
  const recommendation = getRecommendation(req.params.collectionId);
  if (!recommendation) return sendError(res, 404, "not_found", "No recommendation found");
  res.json({ success: true, data: recommendation, market: getMarketSnapshot(req.params.collectionId) });
});

royaltyOracleRouter.post("/collect", requireRole("operator"), async (req, res) => {
  try {
    const { collectionId, floorPrice, volume, supply, creatorTier, source } = req.body ?? {};
    if (!collectionId || typeof collectionId !== "string") {
      return sendError(res, 400, "validation_error", "collectionId is required");
    }
    const recommendation = await collectMarketData(collectionId, async () => ({
      floorPrice,
      volume,
      supply,
      creatorTier,
      source: source ?? "api",
    }));
    addAuditLog(collectionId, "oracle_market_data_collected", req.headers["x-api-key"] ?? req.ip, {
      recommendation: recommendation.recommendedRate,
      source: recommendation.features,
    });
    res.status(201).json({ success: true, data: recommendation });
  } catch (error) {
    sendError(res, 400, "oracle_collection_failed", error.message);
  }
});

royaltyOracleRouter.post("/recommendations/:collectionId/decision", requireRole("admin"), (req, res) => {
  try {
    const approved = req.body?.approved;
    if (typeof approved !== "boolean") return sendError(res, 400, "validation_error", "approved must be boolean");
    const actor = req.headers["x-api-key"] ?? req.ip;
    const recommendation = approveRecommendation(req.params.collectionId, actor, approved);
    addAuditLog(req.params.collectionId, approved ? "oracle_recommendation_approved" : "oracle_recommendation_rejected", actor, {
      recommendedRate: recommendation.recommendedRate,
    });
    res.json({ success: true, data: recommendation });
  } catch (error) {
    sendError(res, 404, "not_found", error.message);
  }
});
