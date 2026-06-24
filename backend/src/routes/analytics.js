import express from "express";
import db from "../database/index.js";
import { createRequestLogger } from "../logger.js";
import { validateContractIdMiddleware, analyticsQuerySchema } from "../validation.js";
import { sendError, sendValidationError } from "../error-response.js";

// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

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

    // Create cache key
    const cacheKey = `${contractId}-${startDate.toISOString()}-${endDate.toISOString()}`;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      log.debug("analytics cache hit", { contractId, cacheKey });
      res.set("Cache-Control", "max-age=60");
      return res.json(cached.data);
    }

    log.info("analytics query started", {
      contractId,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });

    const queryStart = Date.now();

    const summary = db
      .prepare(
        `SELECT
          COUNT(DISTINCT t.id) as totalTransactions,
          COALESCE(SUM(CAST(dp.amountReceived as REAL)), 0) as totalDistributed,
          COALESCE(AVG(CAST(dp.amountReceived as REAL)), 0) as averagePayout
        FROM transactions t
        LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
        WHERE t.contractId = ? AND t.status = 'confirmed'
          AND t.type != 'initialize'
          AND t.timestamp BETWEEN ? AND ?`
      )
      .get(contractId, startDate.toISOString(), endDate.toISOString());

    const trends = db
      .prepare(
        `SELECT
          DATE(t.timestamp) as date,
          SUM(CAST(dp.amountReceived as REAL)) as amount,
          COUNT(*) as count
        FROM distribution_payouts dp
        JOIN transactions t ON dp.transactionId = t.id
        WHERE t.contractId = ? AND t.status = 'confirmed'
          AND t.timestamp BETWEEN ? AND ?
        GROUP BY DATE(t.timestamp)
        ORDER BY date ASC`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    const topEarners = db
      .prepare(
        `SELECT
          dp.collaboratorAddress as address,
          SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
          COUNT(*) as payouts
        FROM distribution_payouts dp
        JOIN transactions t ON dp.transactionId = t.id
        WHERE t.contractId = ? AND t.status = 'confirmed'
          AND t.timestamp BETWEEN ? AND ?
        GROUP BY dp.collaboratorAddress
        ORDER BY totalEarned DESC
        LIMIT 10`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    const collaboratorStats = db
      .prepare(
        `SELECT
          dp.collaboratorAddress as address,
          SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
          COUNT(*) as payoutCount
        FROM distribution_payouts dp
        JOIN transactions t ON dp.transactionId = t.id
        WHERE t.contractId = ? AND t.status = 'confirmed'
          AND t.timestamp BETWEEN ? AND ?
        GROUP BY dp.collaboratorAddress
        ORDER BY totalEarned DESC
        LIMIT ?`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString(), collaboratorLimit);

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
