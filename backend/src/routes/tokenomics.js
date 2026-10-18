import express from "express";
import { sendError } from "../error-response.js";
import logger from "../logger.js";
import {
  buildTokenEconomicsModel,
  simulateDistribution,
  projectionToCsv,
} from "../services/token-economics.js";
import {
  buildVestingAnalytics,
  simulateVesting,
  buildVestingSchedule,
} from "../services/vesting-analytics.js";

const router = express.Router();

/**
 * #1062: Advanced token economics and vesting analytics.
 *
 * All endpoints are read-only projections — no persisted state is mutated.
 */

function parseOptions(body = {}) {
  return {
    asOf: body.asOf,
    horizonMonths:
      body.horizonMonths !== undefined ? Number(body.horizonMonths) : undefined,
    intervalDays:
      body.intervalDays !== undefined ? Number(body.intervalDays) : undefined,
  };
}

/**
 * POST /api/v1/tokenomics/model
 * Body: { config?, options? }
 * Returns the full token economics model (current supply, projection, dilution, unlocks).
 */
router.post("/model", (req, res) => {
  try {
    const { config = {}, options = {} } = req.body ?? {};
    const model = buildTokenEconomicsModel(config, parseOptions(options));
    res.set("Cache-Control", "no-store");
    res.json({ success: true, data: model });
  } catch (error) {
    logger.warn("Token economics model failed", { error: error.message });
    return sendError(res, 400, "invalid_config", error.message);
  }
});

/**
 * POST /api/v1/tokenomics/simulate
 * Body: { config, scenario?, options? }
 * Returns base vs scenario projections plus a comparison ("what-if").
 */
router.post("/simulate", (req, res) => {
  try {
    const { config = {}, scenario = {}, options = {} } = req.body ?? {};
    const result = simulateDistribution(config, scenario, parseOptions(options));
    res.json({ success: true, data: result });
  } catch (error) {
    logger.warn("Token distribution simulation failed", { error: error.message });
    return sendError(res, 400, "invalid_config", error.message);
  }
});

/**
 * POST /api/v1/tokenomics/vesting
 * Body: { schedules: [...], options? }
 * Returns aggregate vesting analytics, unlock events and projections.
 */
router.post("/vesting", (req, res) => {
  try {
    const { schedules = [], options = {} } = req.body ?? {};
    if (!Array.isArray(schedules)) {
      return sendError(res, 400, "validation_failed", "schedules must be an array");
    }
    const analytics = buildVestingAnalytics(schedules, parseOptions(options));
    res.json({ success: true, data: analytics });
  } catch (error) {
    logger.warn("Vesting analytics failed", { error: error.message });
    return sendError(res, 400, "invalid_schedule", error.message);
  }
});

/**
 * POST /api/v1/tokenomics/vesting/simulate
 * Body: { schedule, overrides?, options? }
 * Compares a base schedule against a parameterised scenario.
 */
router.post("/vesting/simulate", (req, res) => {
  try {
    const { schedule, overrides = {}, options = {} } = req.body ?? {};
    if (!schedule || typeof schedule !== "object") {
      return sendError(res, 400, "validation_failed", "schedule is required");
    }
    const result = simulateVesting(schedule, overrides, parseOptions(options));
    res.json({ success: true, data: result });
  } catch (error) {
    logger.warn("Vesting simulation failed", { error: error.message });
    return sendError(res, 400, "invalid_schedule", error.message);
  }
});

/**
 * POST /api/v1/tokenomics/vesting/schedule
 * Body: { schedule, options? }
 * Returns a single schedule with its vesting curve.
 */
router.post("/vesting/schedule", (req, res) => {
  try {
    const { schedule, options = {} } = req.body ?? {};
    if (!schedule || typeof schedule !== "object") {
      return sendError(res, 400, "validation_failed", "schedule is required");
    }
    const result = buildVestingSchedule(schedule, options);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.warn("Vesting schedule build failed", { error: error.message });
    return sendError(res, 400, "invalid_schedule", error.message);
  }
});

/**
 * POST /api/v1/tokenomics/export/supply
 * Body: { config?, options? }
 * Returns a CSV projection timeline for download.
 */
router.post("/export/supply", (req, res) => {
  try {
    const { config = {}, options = {} } = req.body ?? {};
    const model = buildTokenEconomicsModel(config, parseOptions(options));
    const csv = projectionToCsv(model.projection);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="token-supply-projection.csv"',
    );
    res.send(csv);
  } catch (error) {
    logger.warn("Token supply export failed", { error: error.message });
    return sendError(res, 400, "invalid_config", error.message);
  }
});

export const tokenomicsRouter = router;
