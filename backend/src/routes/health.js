import { Router } from "express";
import { getMigrationVersion, db } from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
} from "../stellar.js";
import logger from "../logger.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
let cachedHealth = null;
let cacheExpiresAt = 0;

/**
 * Gather quick DB health metrics — row counts and last-activity timestamp.
 * Wrapped in a try/catch so a DB issue never crashes the health endpoint.
 */
function getDbMetrics() {
  try {
    const txRow = db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
          MAX(timestamp) AS lastActivity
         FROM transactions`
      )
      .get();

    return {
      transactions: {
        total: txRow.total ?? 0,
        confirmed: txRow.confirmed ?? 0,
        failed: txRow.failed ?? 0,
        pending: txRow.pending ?? 0,
        lastActivity: txRow.lastActivity ?? null,
      },
    };
  } catch (err) {
    logger.warn("Health: failed to gather DB metrics", { error: err.message });
    return null;
  }
}

/**
 * GET /api/v1/health
 * Operator health: DB migration version, network, Horizon, contract status,
 * and lightweight DB metrics (#592).
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const [horizon, contract] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
    ]);

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    const dbMetrics = getDbMetrics();

    const body = {
      ok: horizon.connected && contractHealthy,
      dbVersion: getMigrationVersion(),
      network: getNetworkLabel(),
      horizon,
      contract,
      ...(dbMetrics && { dbMetrics }),
      generatedAt: new Date().toISOString(),
    };

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/** Reset cached health (for tests). */
export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
}
