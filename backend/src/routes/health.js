import { Router } from "express";
import { getMigrationVersion, getQueryProfilerMetrics } from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkAllHorizonEndpoints,
  checkAllRpcEndpoints,
  getCurrentHorizonUrl,
  getCurrentRpcUrl,
  getContractAdmin, // #399: Fetch live admin from chain
} from "../stellar.js";
import { getCacheManager } from "../cache.js";
import logger from "../logger.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
let cachedHealth = null;
let cacheExpiresAt = 0;

/**
 * GET /api/v1/health
 * Operator health: DB migration version, network, Horizon, RPC, contract status,
 * and admin consistency verification (#399).
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const cache = getCacheManager();

    const [horizon, contract, allHorizons, allRpcs, adminConsistency] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
      checkAllHorizonEndpoints(),
      checkAllRpcEndpoints(),
      // #399: Verify cached admin matches on-chain state
      cache.verifyAdminConsistency(() => getContractAdmin(contractId)),
    ]);

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    const body = {
      ok: horizon.connected && contractHealthy,
      dbVersion: getMigrationVersion(),
      network: getNetworkLabel(),
      horizon,
      contract,
      queryProfiler: getQueryProfilerMetrics(),
      // #393: RPC endpoint health reporting
      rpc: {
        current: getCurrentRpcUrl(),
        endpoints: allRpcs,
      },
      // #393: All Horizon endpoints health
      horizons: allHorizons,
      currentHorizon: getCurrentHorizonUrl(),
      // #399: Admin consistency check
      admin: {
        current: adminConsistency.liveAdmin,
        cached: adminConsistency.cachedAdmin,
        consistent: adminConsistency.consistent,
        checkLatencyMs: adminConsistency.elapsedMs,
      },
    };

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/health/query-performance
 * Exposes in-process query profiling metrics for operators and dashboards.
 */
healthRouter.get("/query-performance", (_req, res) => {
  res.json(getQueryProfilerMetrics());
});

/** Reset cached health (for tests). */
export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
}

// #399: Expose endpoint to force cache invalidation (for ops/debugging)
healthRouter.post("/invalidate-cache", async (_req, res, next) => {
  try {
    const cache = getCacheManager();
    await cache.invalidateAdmin();
    clearHealthCache();
    logger.info("[Health] Admin cache manually invalidated");
    res.json({ success: true, message: "Admin cache invalidated" });
  } catch (err) {
    next(err);
  }
});
