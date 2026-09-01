import express from "express";
import db from "../database/index.js";
import logger from "../logger.js";
import { validateContractIdMiddleware, validateQuery, analyticsQuerySchema } from "../validation.js";
import { sendError } from "../error-response.js";

// Simple in-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

const router = express.Router();

/**
 * GET /api/v1/analytics/multi-contract
 * Aggregate earnings across multiple contracts for a contributor (#568).
 * Must be defined BEFORE /:contractId to avoid being matched as a contract ID.
 *
 * Query params (required):
 *   address   Stellar G... address
 * Optional:
 *   start     YYYY-MM-DD  (default: all time)
 *   end       YYYY-MM-DD
 */
router.get("/analytics/multi-contract", (req, res) => {
  const { address, start, end } = req.query;

  if (!address || !/^G[A-Z2-7]{55}$/.test(address)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      "Valid Stellar address is required (address=G...)"
    );
  }

  try {
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : new Date();

    if (start && isNaN(startDate?.getTime()))
      return sendError(res, 400, "invalid_query_parameter", "Invalid start date. Use YYYY-MM-DD.");
    if (end && isNaN(endDate.getTime()))
      return sendError(res, 400, "invalid_query_parameter", "Invalid end date. Use YYYY-MM-DD.");
    if (startDate && startDate > endDate)
      return sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");

    const cacheKey = `multi:${address}:${startDate?.toISOString() ?? "all"}:${endDate.toISOString()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      res.set("Cache-Control", "max-age=60");
      return res.json(cached.data);
    }

    let query = `
      SELECT
        t.contractId,
        SUM(CAST(dp.amountReceived AS REAL)) AS totalEarned,
        COUNT(*) AS payoutCount,
        AVG(CAST(dp.amountReceived AS REAL)) AS avgPayout,
        MIN(t.timestamp) AS firstActivity,
        MAX(t.timestamp) AS lastActivity
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE dp.collaboratorAddress = ?
        AND t.status = 'confirmed'
    `;
    const params = [address];

    if (startDate) {
      query += ` AND t.timestamp >= ?`;
      params.push(startDate.toISOString());
    }
    query += ` AND t.timestamp <= ?`;
    params.push(endDate.toISOString());
    query += ` GROUP BY t.contractId ORDER BY totalEarned DESC`;

    const perContract = db.prepare(query).all(...params);

    const grandTotal = perContract.reduce((acc, r) => acc + r.totalEarned, 0);
    const totalPayouts = perContract.reduce((acc, r) => acc + r.payoutCount, 0);

    const data = {
      success: true,
      data: {
        address,
        period: {
          start: startDate ? startDate.toISOString() : null,
          end: endDate.toISOString(),
        },
        summary: {
          totalEarned: Math.round(grandTotal * 100) / 100,
          totalPayouts,
          contractCount: perContract.length,
          avgPerContract:
            perContract.length > 0 ? Math.round((grandTotal / perContract.length) * 100) / 100 : 0,
        },
        contracts: perContract.map((r) => ({
          contractId: r.contractId,
          totalEarned: Math.round(r.totalEarned * 100) / 100,
          payoutCount: r.payoutCount,
          avgPayout: Math.round(r.avgPayout * 100) / 100,
          lastActivity: r.lastActivity,
          share: grandTotal > 0 ? Math.round((r.totalEarned / grandTotal) * 10000) / 100 : 0,
        })),
      },
    };

    cache.set(cacheKey, { data, timestamp: Date.now() });
    res.set("Cache-Control", "max-age=60");
    res.json(data);
  } catch (error) {
    logger.error("Multi-contract analytics error:", error);
    sendError(res, 500, "analytics_fetch_failed", "Failed to load multi-contract analytics");
  }
});

router.get("/analytics/:contractId", validateContractIdMiddleware, validateQuery(analyticsQuerySchema), (req, res) => {
  const { contractId } = req.params;
  // req.query has been parsed and validated by validateQuery(analyticsQuerySchema)
  const { start, end, topLimit } = req.query;

  try {
    // Parse date range — schema already validated ISO format and ordering
    const startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    // Create cache key (include topLimit so different topLimit values don't share a cached result)
    const cacheKey = `${contractId}-${startDate.toISOString()}-${endDate.toISOString()}-top${topLimit}`;

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      res.set("Cache-Control", "max-age=60");
      return res.json(cached.data);
    }

    // Run the same SQL-aggregated analytics that were previously provided
    // by the database helper. Use the shared `db` instance.
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
        LIMIT ${topLimit}`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    const collaboratorStats = db
      .prepare(
        `SELECT
          dp.collaboratorAddress as address,
          SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
          COUNT(*) as payoutCount,
          AVG(CAST(dp.amountReceived as REAL)) as avgPayout,
          MIN(t.timestamp) as firstActivity,
          MAX(t.timestamp) as lastActivity
        FROM distribution_payouts dp
        JOIN transactions t ON dp.transactionId = t.id
        WHERE t.contractId = ? AND t.status = 'confirmed'
          AND t.timestamp BETWEEN ? AND ?
        GROUP BY dp.collaboratorAddress
        ORDER BY totalEarned DESC`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    // Primary royalties: payouts from primary distribution transactions
    const primaryRow = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS primaryTotal
         FROM distribution_payouts dp
         JOIN transactions t ON dp.transactionId = t.id
         WHERE t.contractId = ? AND t.status = 'confirmed'
           AND t.type = 'distribute'
           AND t.timestamp BETWEEN ? AND ?`
      )
      .get(contractId, startDate.toISOString(), endDate.toISOString());

    // Secondary royalties: total from secondary royalty distribution events
    const secondaryRow = db
      .prepare(
        `SELECT COALESCE(SUM(CAST(srd.totalRoyaltiesDistributed AS REAL)), 0) AS secondaryTotal
         FROM secondary_royalty_distributions srd
         JOIN transactions t ON srd.transactionId = t.id
         WHERE srd.contractId = ? AND t.status = 'confirmed'
           AND t.timestamp BETWEEN ? AND ?`
      )
      .get(contractId, startDate.toISOString(), endDate.toISOString());

    const data = {
      success: true,
      data: {
        totalDistributed: Math.round((summary.totalDistributed ?? 0) * 100) / 100,
        totalTransactions: summary.totalTransactions ?? 0,
        averagePayout: Math.round((summary.averagePayout ?? 0) * 100) / 100,
        primaryRoyaltiesTotal: Math.round((primaryRow?.primaryTotal ?? 0) * 100) / 100,
        secondaryRoyaltiesTotal: Math.round((secondaryRow?.secondaryTotal ?? 0) * 100) / 100,
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
          avgPayout: Math.round((c.avgPayout ?? 0) * 100) / 100,
        })),
      },
    };

    // Cache the result
    cache.set(cacheKey, { data, timestamp: Date.now() });

    res.set("Cache-Control", "max-age=60");
    res.json(data);
  } catch (error) {
    logger.error("Analytics error:", error);
    sendError(res, 500, "analytics_fetch_failed", "Failed to load analytics data");
  }
});

/**
 * GET /api/v1/analytics/:contractId/volume
 * Transaction volume report: daily/weekly/monthly buckets + success rate (#590).
 *
 * Query params:
 *   start   YYYY-MM-DD  (default: 90 days ago)
 *   end     YYYY-MM-DD  (default: today)
 *   bucket  day | week | month  (default: day)
 */
router.get("/analytics/:contractId/volume", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  const { start, end, bucket = "day" } = req.query;

  try {
    const startDate = start ? new Date(start) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    if (start && isNaN(startDate.getTime()))
      return sendError(res, 400, "invalid_query_parameter", "Invalid start date. Use YYYY-MM-DD.");
    if (end && isNaN(endDate.getTime()))
      return sendError(res, 400, "invalid_query_parameter", "Invalid end date. Use YYYY-MM-DD.");
    if (start && end && startDate > endDate)
      return sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");

    const validBuckets = ["day", "week", "month"];
    const bucketKey = validBuckets.includes(bucket) ? bucket : "day";

    // SQLite strftime formats for each bucket
    const fmtMap = { day: "%Y-%m-%d", week: "%Y-%W", month: "%Y-%m" };
    const fmt = fmtMap[bucketKey];

    const cacheKey = `vol:${contractId}:${bucketKey}:${startDate.toISOString()}:${endDate.toISOString()}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      res.set("Cache-Control", "max-age=60");
      return res.json(cached.data);
    }

    // Per-bucket volume
    const buckets = db
      .prepare(
        `SELECT
          strftime('${fmt}', t.timestamp) AS period,
          COUNT(DISTINCT t.id) AS transactions,
          COALESCE(SUM(CAST(dp.amountReceived AS REAL)), 0) AS volume
        FROM transactions t
        LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
        WHERE t.contractId = ?
          AND t.type != 'initialize'
          AND t.timestamp BETWEEN ? AND ?
        GROUP BY period
        ORDER BY period ASC`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    // Overall success rate for the period
    const statusCounts = db
      .prepare(
        `SELECT status, COUNT(*) AS cnt
         FROM transactions
         WHERE contractId = ?
           AND type != 'initialize'
           AND timestamp BETWEEN ? AND ?
         GROUP BY status`
      )
      .all(contractId, startDate.toISOString(), endDate.toISOString());

    const totals = statusCounts.reduce((acc, r) => {
      acc[r.status] = r.cnt;
      return acc;
    }, {});
    const confirmed = totals.confirmed ?? 0;
    const failed = totals.failed ?? 0;
    const pending = totals.pending ?? 0;
    const total = confirmed + failed + pending;
    const successRate = total > 0 ? Math.round((confirmed / total) * 10000) / 100 : null;

    const data = {
      success: true,
      data: {
        contractId,
        bucket: bucketKey,
        period: { start: startDate.toISOString(), end: endDate.toISOString() },
        successRate,
        statusBreakdown: { confirmed, failed, pending, total },
        buckets: buckets.map((b) => ({
          period: b.period,
          transactions: b.transactions,
          volume: Math.round(b.volume * 100) / 100,
        })),
      },
    };

    cache.set(cacheKey, { data, timestamp: Date.now() });
    res.set("Cache-Control", "max-age=60");
    res.json(data);
  } catch (error) {
    logger.error("Volume analytics error:", error);
    sendError(res, 500, "analytics_fetch_failed", "Failed to load volume analytics");
  }
});

export { router as analyticsRouter };
