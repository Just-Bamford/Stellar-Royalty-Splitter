/**
 * API Routes for AI-powered earnings forecasting (#1037).
 *
 * GET  /api/v1/analytics/forecast-model            -> 30/60/90-day forecast
 * POST /api/v1/analytics/forecast-model/train        -> trigger weekly training
 * GET  /api/v1/analytics/forecast-model/accuracy     -> predictions-vs-actuals
 * GET  /api/v1/analytics/forecast-model/history    -> prior weekly forecasts
 */

import express from "express";
import earningsForecaster from "../../services/earnings-forecaster.js";
import { sendError } from "../../error-response.js";
import logger from "../../logger.js";

const router = express.Router();

/**
 * GET /api/v1/analytics/forecast-model
 *
 * Generates (or returns the cached weekly) ML-powered earnings forecast with
 * 30/60/90-day projections, confidence intervals, trend and seasonality.
 */
router.get("/", async (req, res) => {
  try {
    const { contractId, address, days } = req.query;

    if (!contractId) {
      sendError(res, 400, "validation_failed", "contractId query parameter is required");
      return;
    }

    const horizonDays = days ? Math.min(parseInt(days, 10), 365) : 90;
    const weekMs = earningsForecaster.WEEKLY_FORECAST_COOL_DOWN_MS;

    // Return the cached forecast if it is less than the weekly cool-down old;
    // otherwise refresh from the model.
    const cached = earningsForecaster.getForecast(contractId, address);
    const cachedIsFresh =
      cached && Date.now() - cached.generatedAt * 1000 < weekMs;

    let forecast;
    let fromCache = false;
    if (cached && cachedIsFresh && (cached.forecast.horizonDays || 90) === horizonDays) {
      forecast = cached.forecast;
      fromCache = true;
    } else {
      forecast = await earningsForecaster.generateForecast(contractId, address, {
        horizonDays,
      });
    }
    forecast.fromCache = fromCache;

    res.set("Cache-Control", "max-age=300");
    res.json({
      success: true,
      contractId,
      address: address || null,
      horizonDays: horizonDays,
      forecast,
    });
  } catch (error) {
    logger.error("Forecast generation failed", { error: error.message });
    sendError(res, 500, "forecast_generation_failed", error.message);
  }
});

/**
 * POST /api/v1/analytics/forecast-model/train
 *
 * Trigger a fresh forecast (re-train / re-predict) for a specific contract or
 * for all contracts (weekly batch update).
 */
router.post("/train", async (req, res) => {
  try {
    const { contractId, address, horizonDays = 90 } = req.body || {};

    let forecast;
    if (contractId) {
      forecast = await earningsForecaster.generateForecast(contractId, address, {
        horizonDays,
      });
    } else {
      const results = await earningsForecaster.trainWeeklyForecast();
      return res.json({
        success: true,
        message: `Weekly forecast trained for ${results.length} contract(s)`,
        results,
      });
    }

    res.json({
      success: true,
      message: "Forecast trained successfully",
      forecast,
    });
  } catch (error) {
    logger.error("Forecast training failed", { error: error.message });
    sendError(res, 500, "forecast_training_failed", error.message);
  }
});

/**
 * GET /api/v1/analytics/forecast-model/accuracy
 *
 * Return accuracy metrics (predictions vs actuals) for a contract.
 */
router.get("/accuracy", (req, res) => {
  try {
    const { contractId, address } = req.query;
    if (!contractId) {
      sendError(res, 400, "validation_failed", "contractId query parameter is required");
      return;
    }

    const metrics = earningsForecaster.getForecastAccuracy(contractId, address);
    res.json({
      success: true,
      contractId,
      address: address || null,
      accuracy: metrics,
    });
  } catch (error) {
    logger.error("Forecast accuracy retrieval failed", { error: error.message });
    sendError(res, 500, "forecast_accuracy_failed", error.message);
  }
});

/**
 * GET /api/v1/analytics/forecast-model/history
 *
 * Return prior weekly forecasts (model-update cadence) for the contract.
 */
router.get("/history", (req, res) => {
  try {
    const { contractId, address, limit = 12 } = req.query;
    if (!contractId) {
      sendError(res, 400, "validation_failed", "contractId query parameter is required");
      return;
    }

    const history = earningsForecaster.getForecastHistory(
      contractId,
      address,
      parseInt(limit, 10),
    );
    res.json({
      success: true,
      contractId,
      address: address || null,
      history,
    });
  } catch (error) {
    logger.error("Forecast history retrieval failed", { error: error.message });
    sendError(res, 500, "forecast_history_failed", error.message);
  }
});

export { router as forecastModelRouter };
