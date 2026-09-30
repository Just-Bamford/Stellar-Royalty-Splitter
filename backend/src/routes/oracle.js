import express from "express";
import { sendError } from "../error-response.js";
import {
  storePrediction,
  getLatestPrediction,
  getPredictionHistory,
  storeModelMetadata,
  getLatestModelMetadata,
  getModelMetadata,
  storeMarketData,
  getLatestMarketData,
  getMarketDataHistory,
  calculatePredictionAccuracy,
  getMarketTrends,
} from "../database/index.js";
import { attachRole, requireRole } from "../middleware/rbac.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * #960: Dynamic royalty oracle with ML predictions
 */

/**
 * GET /api/v1/oracle/predict/:contractId
 * Get latest prediction for a contract
 */
router.get("/oracle/predict/:contractId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { horizon = "7d" } = req.query;

    const prediction = getLatestPrediction(contractId, horizon);

    if (!prediction) {
      return res.json({
        success: true,
        prediction: null,
        message: "No predictions available for this contract",
      });
    }

    res.json({
      success: true,
      prediction: {
        ...prediction,
        factors: JSON.parse(prediction.factors),
      },
    });
  } catch (err) {
    logger.error("Failed to get prediction", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get prediction");
  }
});

/**
 * POST /api/v1/oracle/predict
 * Store a new prediction (internal/system use)
 */
router.post("/oracle/predict", attachRole, requireRole("admin"), (req, res) => {
  try {
    const {
      contractId,
      predictedAmount,
      confidence,
      factors,
      modelVersion,
      predictionHorizon = "7d",
    } = req.body;

    if (!contractId || !predictedAmount || confidence === undefined || !factors || !modelVersion) {
      return sendError(res, 400, "validation_failed", "Missing required fields");
    }

    const predictionId = storePrediction({
      contractId,
      predictedAmount,
      confidence,
      factors,
      modelVersion,
      predictionHorizon,
    });

    res.json({
      success: true,
      predictionId,
      message: "Prediction stored successfully",
    });
  } catch (err) {
    logger.error("Failed to store prediction", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to store prediction");
  }
});

/**
 * GET /api/v1/oracle/predictions/:contractId/history
 * Get prediction history for a contract
 */
router.get("/oracle/predictions/:contractId/history", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const predictions = getPredictionHistory(contractId, parseInt(limit), parseInt(offset));

    res.json({
      success: true,
      predictions: predictions.map((p) => ({
        ...p,
        factors: JSON.parse(p.factors),
      })),
    });
  } catch (err) {
    logger.error("Failed to get prediction history", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get prediction history");
  }
});

/**
 * GET /api/v1/oracle/model-info
 * Get latest ML model metadata
 */
router.get("/oracle/model-info", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { version } = req.query;

    const metadata = version ? getModelMetadata(version) : getLatestModelMetadata();

    if (!metadata) {
      return res.json({
        success: true,
        model: null,
        message: "No model metadata available",
      });
    }

    res.json({
      success: true,
      model: {
        ...metadata,
        featuresUsed: JSON.parse(metadata.featuresUsed),
        hyperparameters: metadata.hyperparameters ? JSON.parse(metadata.hyperparameters) : null,
      },
    });
  } catch (err) {
    logger.error("Failed to get model metadata", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get model metadata");
  }
});

/**
 * POST /api/v1/oracle/model
 * Store ML model metadata (admin only)
 */
router.post("/oracle/model", attachRole, requireRole("admin"), (req, res) => {
  try {
    const {
      version,
      accuracy,
      precision,
      recall,
      f1Score,
      trainingDataSize,
      featuresUsed,
      hyperparameters,
      trainedBy,
    } = req.body;

    if (!version || !featuresUsed) {
      return sendError(res, 400, "validation_failed", "version and featuresUsed are required");
    }

    const modelId = storeModelMetadata({
      version,
      accuracy,
      precision,
      recall,
      f1Score,
      trainingDataSize,
      featuresUsed,
      hyperparameters,
      trainedBy: trainedBy || req.user?.walletAddress || "system",
    });

    res.json({
      success: true,
      modelId,
      message: "Model metadata stored successfully",
    });
  } catch (err) {
    logger.error("Failed to store model metadata", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to store model metadata");
  }
});

/**
 * GET /api/v1/oracle/market-data/:contractId
 * Get latest market data for a contract
 */
router.get("/oracle/market-data/:contractId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { source } = req.query;

    const marketData = getLatestMarketData(contractId, source || null);

    if (!marketData) {
      return res.json({
        success: true,
        marketData: null,
        message: "No market data available for this contract",
      });
    }

    res.json({
      success: true,
      marketData: {
        ...marketData,
        metadata: marketData.metadata ? JSON.parse(marketData.metadata) : null,
      },
    });
  } catch (err) {
    logger.error("Failed to get market data", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get market data");
  }
});

/**
 * POST /api/v1/oracle/market-data
 * Store market data snapshot (system use)
 */
router.post("/oracle/market-data", attachRole, requireRole("admin"), (req, res) => {
  try {
    const {
      contractId,
      source,
      floorPrice,
      volumeDay,
      volumeWeek,
      volumeMonth,
      numSales,
      avgSalePrice,
      uniqueBuyers,
      uniqueSellers,
      metadata,
    } = req.body;

    if (!contractId || !source) {
      return sendError(res, 400, "validation_failed", "contractId and source are required");
    }

    const snapshotId = storeMarketData({
      contractId,
      source,
      floorPrice,
      volumeDay,
      volumeWeek,
      volumeMonth,
      numSales,
      avgSalePrice,
      uniqueBuyers,
      uniqueSellers,
      metadata,
    });

    res.json({
      success: true,
      snapshotId,
      message: "Market data stored successfully",
    });
  } catch (err) {
    logger.error("Failed to store market data", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to store market data");
  }
});

/**
 * GET /api/v1/oracle/market-data/:contractId/history
 * Get market data history
 */
router.get("/oracle/market-data/:contractId/history", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { hours = 24, source } = req.query;

    const history = getMarketDataHistory(contractId, parseInt(hours), source || null);

    res.json({
      success: true,
      history: history.map((h) => ({
        ...h,
        metadata: h.metadata ? JSON.parse(h.metadata) : null,
      })),
    });
  } catch (err) {
    logger.error("Failed to get market data history", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get market data history");
  }
});

/**
 * GET /api/v1/oracle/accuracy/:contractId
 * Calculate prediction accuracy
 */
router.get("/oracle/accuracy/:contractId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { days = 7 } = req.query;

    const accuracy = calculatePredictionAccuracy(contractId, parseInt(days));

    res.json({
      success: true,
      accuracy,
    });
  } catch (err) {
    logger.error("Failed to calculate prediction accuracy", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to calculate prediction accuracy");
  }
});

/**
 * GET /api/v1/oracle/trends/:contractId
 * Get market trends
 */
router.get("/oracle/trends/:contractId", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { days = 30 } = req.query;

    const trends = getMarketTrends(contractId, parseInt(days));

    res.json({
      success: true,
      trends,
    });
  } catch (err) {
    logger.error("Failed to get market trends", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get market trends");
  }
});

export const oracleRouter = router;
