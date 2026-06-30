import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase, getNetworkLabel } from "../stellar.js";
import logger from "../logger.js";
import { validateContractIdMiddleware } from "../validation.js";
import { lookupCollaborators } from "../database/index.js";
import { sendError } from "../error-response.js";
import { recordCacheHit, recordCacheMiss } from "../metrics.js";
import {
  _resetCollaboratorsCache,
  getCachedCollaborators,
  getCollaboratorsCacheKey,
  invalidateCollaboratorsCache,
  setCachedCollaborators,
} from "../collaborators-cache.js";

const {
  Address,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} = StellarSdk;

export const collaboratorsRouter = Router();
export { _resetCollaboratorsCache, invalidateCollaboratorsCache };

/**
 * GET /api/collaborators/lookup?q=G...&limit=10
 * Returns collaborator address suggestions from previous initialize and payout history.
 */
collaboratorsRouter.get("/lookup", (req, res) => {
  const suggestions = lookupCollaborators(req.query.q, req.query.limit);
  res.json({ suggestions });
});

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
    const cacheKey = getCollaboratorsCacheKey(getNetworkLabel(), contractId);
    const cached = getCachedCollaborators(cacheKey);

    if (cached) {
      recordCacheHit("collaborators");
      return res.json(cached);
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
    setCachedCollaborators(cacheKey, results);
    res.json(results);
  } catch (err) {
    next(err);
  }
});
