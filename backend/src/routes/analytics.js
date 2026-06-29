import express from "express";
import { getAnalyticsData } from "../database/index.js";
import { createRequestLogger } from "../logger.js";
import { validateContractIdMiddleware, analyticsQuerySchema } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";

const router = express.Router();

router.get("/analytics/:contractId", validateContractIdMiddleware, (req, res) => {
  const log = createRequestLogger(req);
  const { contractId } = req.params;

  const queryResult = analyticsQuerySchema.safeParse(req.query);
  if (!queryResult.success) {
    return sendValidationError(
      res,
      queryResult.error.issues.map((e) => ({
        field: e.path.join(".") || "query",
        message: e.message,
      }))
    );
  }

  const { start, end, collaboratorLimit = 10 } = queryResult.data;

  try {
    // Parse date range
    const startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    // Validate parsed dates
    if (start && isNaN(startDate.getTime())) {
      log.warn("analytics invalid start date", { contractId, start });
      return sendError(res, 400, "invalid_query_parameter", "Invalid start date. Use YYYY-MM-DD.");
    }
    if (end && isNaN(endDate.getTime())) {
      log.warn("analytics invalid end date", { contractId, end });
      return sendError(res, 400, "invalid_query_parameter", "Invalid end date. Use YYYY-MM-DD.");
    }
    if (start && end && startDate > endDate) {
      log.warn("analytics start date after end date", { contractId, start, end });
      return sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");
    }

    log.info("analytics query started", {
      contractId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });

    const queryStart = Date.now();

    // #503: single set-based query path (no per-transaction N+1) with a 60s
    // cache, both owned by the data layer so every caller shares the same plan.
    const { summary, trends, topEarners, collaboratorStats } = getAnalyticsData(
      contractId,
      startDate.toISOString(),
      endDate.toISOString(),
      collaboratorLimit
    );

    log.info("analytics query completed", {
      contractId,
      durationMs: Date.now() - queryStart,
      totalTransactions: summary.totalTransactions,
    });

    const data = {
      success: true,
      data: {
        totalDistributed: Math.round((summary.totalDistributed ?? 0) * 100) / 100,
        totalTransactions: summary.totalTransactions ?? 0,
        averagePayout: Math.round((summary.averagePayout ?? 0) * 100) / 100,
        topEarners: topEarners.map((e) => ({
          ...e,
          totalEarned: Math.round(e.totalEarned * 100) / 100,
        })),
        distributionTrends: trends.map((t) => ({
          ...t,
          amount: Math.round(t.amount * 100) / 100,
        })),
        collaboratorStats: collaboratorStats.map((c) => ({
          ...c,
          totalEarned: Math.round(c.totalEarned * 100) / 100,
        })),
      },
    };

    // Cache the result
    cache.set(cacheKey, { data, timestamp: Date.now() });

    res.set("Cache-Control", "max-age=60");
    res.json(data);
  } catch (error) {
    log.error("analytics query failed", {
      contractId,
      error: error.message ?? String(error),
      stack: error.stack,
    });
    sendError(res, 500, "analytics_fetch_failed", "Failed to load analytics data");
  }
});

export { router as analyticsRouter };
