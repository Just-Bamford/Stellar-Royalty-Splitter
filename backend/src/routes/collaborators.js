import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase, getNetworkLabel } from "../stellar.js";
import logger from "../logger.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { recordCacheHit, recordCacheMiss } from "../metrics.js";

const {
  Address,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} = StellarSdk;

export const collaboratorsRouter = Router();

// Issue #422: collaborator shares are effectively immutable once a contract
// is initialized, so we cache them for 5 minutes — far longer than the 30s
// contract-state cache — and invalidate immediately on (re-)initialize
// rather than relying solely on the TTL.
const COLLABORATORS_CACHE_TTL_MS = 5 * 60 * 1000;
const collaboratorsCache = new Map();

/** Cache key format: `contract:{network}:{contractId}:collaborators` (#422). */
function getCollaboratorsCacheKey(contractId) {
  return `contract:${getNetworkLabel()}:${contractId}:collaborators`;
}

export function _resetCollaboratorsCache() {
  collaboratorsCache.clear();
}

/** Invalidate the cached collaborator list for a contract (#422). */
export function invalidateCollaboratorsCache(contractId) {
  collaboratorsCache.delete(getCollaboratorsCacheKey(contractId));
}

/**
 * GET /api/collaborators/:contractId
 * Returns: [{ address, basisPoints }]
 *
 * Uses a single read-only simulation of get_all_shares (Map<Address, u32>)
 * instead of N+1 individual get_share calls.
 */
collaboratorsRouter.get("/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const cacheKey = getCollaboratorsCacheKey(contractId);
    const cached = collaboratorsCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < COLLABORATORS_CACHE_TTL_MS) {
      recordCacheHit("collaborators");
      return res.json(cached.data);
    }

    recordCacheMiss("collaborators");
    const contract = new Contract(contractId);

    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0"
    );

    // Single simulation — replaces N+1 individual get_share calls
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_all_shares"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return sendError(res, 400, "contract_simulation_failed", sim.error ?? "Simulation failed");
    }

    const resultVal = sim.result?.retval;
    if (!resultVal) return res.json([]);

    // retval is a Map<Address, u32> — iterate its entries
    const mapEntries = resultVal.map()?.entries ?? [];
    const results = mapEntries.map((entry) => ({
      address: Address.fromScVal(entry.key()).toString(),
      basisPoints: entry.val().u32(),
    }));

    logger.info(`get_all_shares returned ${results.length} collaborators for ${contractId}`);
    collaboratorsCache.set(cacheKey, { data: results, fetchedAt: now });
    res.json(results);
  } catch (err) {
    next(err);
  }
});
