import { Router } from "express";
import { getMigrationVersion } from "../database/index.js";
import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
} from "../stellar.js";
import { ContractStateCache } from "../cache/contractStateCache.js";
import { SorobanRpc, Contract, TransactionBuilder, Networks, BASE_FEE } from "@stellar/stellar-sdk";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
let cachedHealth = null;
let cacheExpiresAt = 0;

// #399: Shared contract state cache
export const contractStateCache = new ContractStateCache(30);

healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    const checkStart = now;

    const contractId = getConfiguredContractId();
    const [horizon, contract] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
    ]);

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    // #399: Admin cache consistency check
    let adminCheck = {
      status: "not_configured",
      cachedAdmin: null,
      liveAdmin: null,
      cacheStale: false,
      verifiedAt: null,
    };

    if (contractId && contract.deployed) {
      const cachedAdmin = await contractStateCache.getAdmin();
      const cacheStats = contractStateCache.getStats();

      let liveAdmin = null;
      let adminStatus = "unknown";
      let cacheStale = false;
      let verifiedAt = null;

      if (!cachedAdmin || cacheStats.isAdminStale) {
        try {
          const sorobanServer = new SorobanRpc.Server(process.env.SOROBAN_RPC_URL);
          const contractObj = new Contract(contractId);
          const sourceKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
          const sourceAccount = await sorobanServer.getAccount(sourceKey);

          const tx = new TransactionBuilder(sourceAccount, {
            fee: BASE_FEE,
            networkPassphrase:
              process.env.STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
          })
            .addOperation(contractObj.call("get_admin"))
            .setTimeout(30)
            .build();

          const simResult = await sorobanServer.simulateTransaction(tx);
          liveAdmin = simResult.result?.retval?.toString?.() || null;
          verifiedAt = new Date().toISOString();

          if (cachedAdmin && liveAdmin && cachedAdmin !== liveAdmin) {
            cacheStale = true;
            adminStatus = "stale";
            await contractStateCache.invalidateAdmin();
            if (liveAdmin) contractStateCache.setAdmin(liveAdmin);
          } else {
            adminStatus = "verified";
            if (liveAdmin && !cachedAdmin) contractStateCache.setAdmin(liveAdmin);
          }
        } catch (chainErr) {
          adminStatus = "chain_error";
        }
      } else {
        adminStatus = "cached";
      }

      adminCheck = {
        status: adminStatus,
        cachedAdmin,
        liveAdmin,
        cacheStale,
        verifiedAt,
        cacheKeys: cacheStats.keys,
        cacheTtl: cacheStats.ttl,
        adminLastInvalidated: cacheStats.adminInvalidationTime
          ? new Date(cacheStats.adminInvalidationTime).toISOString()
          : null,
      };
    }

    const body = {
      ok: horizon.connected && contractHealthy && !adminCheck.cacheStale,
      dbVersion: getMigrationVersion(),
      network: getNetworkLabel(),
      horizon,
      contract,
      admin: adminCheck,
      responseTimeMs: Date.now() - checkStart,
    };

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
}