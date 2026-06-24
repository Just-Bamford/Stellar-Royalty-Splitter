import { Router } from "express";
import { getMigrationVersion } from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkAllHorizonEndpoints,
  checkAllRpcEndpoints,
  getCurrentHorizonUrl,
  getCurrentRpcUrl,
} from "../stellar.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
let cachedHealth = null;
let cacheExpiresAt = 0;

/**
 * GET /api/v1/health
 * Operator health: DB migration version, network, Horizon, and optional contract status.
 * Issue #393: Includes RPC endpoint health status.
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const [horizon, contract, allHorizons, allRpcs] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
      checkAllHorizonEndpoints(),
      checkAllRpcEndpoints(),
    ]);

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    const body = {
      ok: horizon.connected && contractHealthy,
      dbVersion: getMigrationVersion(),
      network: getNetworkLabel(),
      horizon,
      contract,
      // Issue #393: RPC endpoint health reporting
      rpc: {
        current: getCurrentRpcUrl(),
        endpoints: allRpcs,
      },
      // Issue #393: All Horizon endpoints health
      horizons: allHorizons,
      currentHorizon: getCurrentHorizonUrl(),
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
