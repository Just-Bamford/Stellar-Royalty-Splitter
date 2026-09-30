/**
 * Token Swap Aggregator API Routes (#974)
 */

import express from "express";
import { sendError } from "../error-response.js";
import {
  findBestSwapRate,
  estimateSwapOutput,
  getSwapRateHistory,
} from "../services/swap-aggregator.js";
import logger from "../logger.js";
import { startSpan } from "../tracing.js";

const router = express.Router();

/**
 * POST /api/v1/swap/quote
 * Get swap quotes from multiple DEXes
 * 
 * Body:
 * {
 *   "sourceAsset": "native" or "CODE:ISSUER",
 *   "destAsset": "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
 *   "amount": "100"
 * }
 */
router.post("/quote", async (req, res) => {
  return startSpan("api.swap.quote", { method: "POST" }, async () => {
    try {
      const { sourceAsset, destAsset, amount } = req.body;

      if (!sourceAsset || !destAsset || !amount) {
        return sendError(res, 400, "invalid_request", "sourceAsset, destAsset, and amount are required");
      }

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        return sendError(res, 400, "invalid_amount", "Amount must be a positive number");
      }

      const result = await findBestSwapRate(sourceAsset, destAsset, amount);

      res.status(200).json({
        success: true,
        quote: result.best,
        alternatives: result.alternatives,
        savings: result.savings,
      });
    } catch (error) {
      logger.error("Swap quote failed", { error: error.message, body: req.body });
      return sendError(res, 500, "swap_quote_failed", error.message);
    }
  });
});

/**
 * POST /api/v1/swap/estimate
 * Estimate swap output (lighter endpoint for UI)
 * 
 * Body:
 * {
 *   "sourceAsset": "native",
 *   "destAsset": "USDC:ISSUER",
 *   "amount": "100"
 * }
 */
router.post("/estimate", async (req, res) => {
  return startSpan("api.swap.estimate", { method: "POST" }, async () => {
    try {
      const { sourceAsset, destAsset, amount } = req.body;

      if (!sourceAsset || !destAsset || !amount) {
        return sendError(res, 400, "invalid_request", "sourceAsset, destAsset, and amount are required");
      }

      const amountNum = parseFloat(amount);
      if (isNaN(amountNum) || amountNum <= 0) {
        return sendError(res, 400, "invalid_amount", "Amount must be a positive number");
      }

      const estimate = await estimateSwapOutput(sourceAsset, destAsset, amount);

      res.status(200).json({
        success: true,
        ...estimate,
      });
    } catch (error) {
      logger.error("Swap estimate failed", { error: error.message, body: req.body });
      return sendError(res, 500, "swap_estimate_failed", error.message);
    }
  });
});

/**
 * GET /api/v1/swap/rate-history
 * Get historical swap rates for analytics
 * 
 * Query params:
 * - sourceAsset: Asset code or "native"
 * - destAsset: Asset code:issuer
 * - hours: Lookback period (default: 24)
 * - interval: Time interval in minutes (default: 60)
 */
router.get("/rate-history", async (req, res) => {
  return startSpan("api.swap.rate_history", { method: "GET" }, async () => {
    try {
      const { sourceAsset, destAsset, hours, interval } = req.query;

      if (!sourceAsset || !destAsset) {
        return sendError(res, 400, "invalid_request", "sourceAsset and destAsset are required");
      }

      const hoursNum = hours ? parseInt(hours, 10) : 24;
      const intervalNum = interval ? parseInt(interval, 10) : 60;

      if (isNaN(hoursNum) || hoursNum <= 0 || hoursNum > 168) {
        return sendError(res, 400, "invalid_hours", "Hours must be between 1 and 168");
      }

      if (isNaN(intervalNum) || intervalNum <= 0) {
        return sendError(res, 400, "invalid_interval", "Interval must be a positive number");
      }

      const history = await getSwapRateHistory(sourceAsset, destAsset, {
        hours: hoursNum,
        interval: intervalNum,
      });

      res.status(200).json({
        success: true,
        ...history,
      });
    } catch (error) {
      logger.error("Swap rate history failed", { error: error.message, query: req.query });
      return sendError(res, 500, "rate_history_failed", error.message);
    }
  });
});

/**
 * GET /api/v1/swap/supported-assets
 * List supported assets for swapping
 */
router.get("/supported-assets", async (req, res) => {
  return startSpan("api.swap.supported_assets", { method: "GET" }, async () => {
    try {
      // For now, return common Stellar assets
      // Future: Query from DEXes dynamically
      const assets = [
        {
          code: "XLM",
          issuer: "native",
          name: "Stellar Lumens",
          type: "native",
        },
        {
          code: "USDC",
          issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
          name: "USD Coin",
          type: "credit_alphanum4",
        },
        {
          code: "AQUA",
          issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
          name: "Aquarius",
          type: "credit_alphanum4",
        },
        // Add more assets as needed
      ];

      res.status(200).json({
        success: true,
        assets,
      });
    } catch (error) {
      logger.error("Failed to fetch supported assets", { error: error.message });
      return sendError(res, 500, "fetch_assets_failed", error.message);
    }
  });
});

export { router as swapAggregatorRouter };
