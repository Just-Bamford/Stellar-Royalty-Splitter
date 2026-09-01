/**
 * Contributor Performance Ranking endpoints (#586).
 *
 * GET /api/v1/ranking/:contractId
 *   Query params:
 *     - metric: "totalEarned" | "payoutCount" | "avgPayout"  (default: totalEarned)
 *     - limit:  1-100  (default: 10)
 *     - start:  ISO date string (default: 90 days ago)
 *     - end:    ISO date string (default: now)
 *
 * GET /api/v1/ranking/global
 *   Same params minus contractId — ranks across ALL contracts.
 */
import { Router } from "express";
import { db } from "../database/core.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";

export const rankingRouter = Router();

const VALID_METRICS = ["totalEarned", "payoutCount", "avgPayout"];
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

function parseDateRange(start, end) {
  const startDate = start
    ? new Date(start)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const endDate = end ? new Date(end) : new Date();
  return { startDate, endDate };
}

function validateDateParams(start, end, startDate, endDate, res) {
  if (start && isNaN(startDate.getTime()))
    return sendError(res, 400, "invalid_query_parameter", "Invalid start date. Use YYYY-MM-DD.");
  if (end && isNaN(endDate.getTime()))
    return sendError(res, 400, "invalid_query_parameter", "Invalid end date. Use YYYY-MM-DD.");
  if (start && end && startDate > endDate)
    return sendError(res, 400, "invalid_query_parameter", "start date must be before end date.");
  return null;
}

function buildOrderClause(metric) {
  switch (metric) {
    case "payoutCount":
      return "payoutCount DESC";
    case "avgPayout":
      return "avgPayout DESC";
    default:
      return "totalEarned DESC";
  }
}

/**
 * GET /api/v1/ranking/:contractId
 */
rankingRouter.get("/:contractId", validateContractIdMiddleware, (req, res) => {
  const { contractId } = req.params;
  const { start, end, metric = "totalEarned", limit: rawLimit = "10" } = req.query;

  const metric_ = VALID_METRICS.includes(metric) ? metric : "totalEarned";
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 10, 1), 100);

  const { startDate, endDate } = parseDateRange(start, end);
  const err = validateDateParams(start, end, startDate, endDate, res);
  if (err) return;

  const cacheKey = `contract:${contractId}:${metric_}:${limit}:${startDate.toISOString()}:${endDate.toISOString()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.set("Cache-Control", "max-age=300");
    return res.json(cached.data);
  }

  const orderClause = buildOrderClause(metric_);

  const rows = db
    .prepare(
      `SELECT
        dp.collaboratorAddress AS address,
        CAST(SUM(CAST(dp.amountReceived AS REAL)) AS REAL) AS totalEarned,
        COUNT(*) AS payoutCount,
        CAST(AVG(CAST(dp.amountReceived AS REAL)) AS REAL) AS avgPayout,
        RANK() OVER (ORDER BY ${orderClause}) AS rank
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ?
        AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY ${orderClause}
      LIMIT ?`
    )
    .all(contractId, startDate.toISOString(), endDate.toISOString(), limit);

  const data = {
    contractId,
    metric: metric_,
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    rankings: rows,
  };

  cache.set(cacheKey, { ts: Date.now(), data });
  res.set("Cache-Control", "max-age=300");
  res.json(data);
});

/**
 * GET /api/v1/ranking/global
 * Ranks contributors across all contracts.
 */
rankingRouter.get("/", (req, res) => {
  const { start, end, metric = "totalEarned", limit: rawLimit = "10" } = req.query;

  const metric_ = VALID_METRICS.includes(metric) ? metric : "totalEarned";
  const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 10, 1), 100);

  const { startDate, endDate } = parseDateRange(start, end);
  const err = validateDateParams(start, end, startDate, endDate, res);
  if (err) return;

  const cacheKey = `global:${metric_}:${limit}:${startDate.toISOString()}:${endDate.toISOString()}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.set("Cache-Control", "max-age=300");
    return res.json(cached.data);
  }

  const orderClause = buildOrderClause(metric_);

  const rows = db
    .prepare(
      `SELECT
        dp.collaboratorAddress AS address,
        CAST(SUM(CAST(dp.amountReceived AS REAL)) AS REAL) AS totalEarned,
        COUNT(*) AS payoutCount,
        CAST(AVG(CAST(dp.amountReceived AS REAL)) AS REAL) AS avgPayout,
        COUNT(DISTINCT t.contractId) AS contractCount,
        RANK() OVER (ORDER BY ${orderClause}) AS rank
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY ${orderClause}
      LIMIT ?`
    )
    .all(startDate.toISOString(), endDate.toISOString(), limit);

  const data = {
    scope: "global",
    metric: metric_,
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    rankings: rows,
  };

  cache.set(cacheKey, { ts: Date.now(), data });
  res.set("Cache-Control", "max-age=300");
  res.json(data);
});
