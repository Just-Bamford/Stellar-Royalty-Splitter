import { Router } from "express";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase } from "../stellar.js";
import logger from "../logger.js";
import { validateContractIdMiddleware } from "../validation.js";
import { sendError } from "../error-response.js";
import { cacheGetOrFetch, TTL } from "../cache.js";

const {
  Address,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} = StellarSdk;

export const collaboratorsRouter = Router();

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

    const results = await cacheGetOrFetch(
      `collaborators:${contractId}`,
      async () => {
        const contract = new Contract(contractId);
        const dummyAccount = new Account(
          "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
          "0"
        );
        const tx = new TransactionBuilder(dummyAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(contract.call("get_all_shares"))
          .setTimeout(30)
          .build();

        const sim = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(sim)) {
          const err = new Error(sim.error ?? "Simulation failed");
          err.status = 400;
          err.code = "contract_simulation_failed";
          throw err;
        }

        const resultVal = sim.result?.retval;
        if (!resultVal) return [];

        const mapEntries = resultVal.map()?.entries ?? [];
        logger.info(`get_all_shares: ${mapEntries.length} collaborators for ${contractId}`);
        return mapEntries.map((entry) => ({
          address: Address.fromScVal(entry.key()).toString(),
          basisPoints: entry.val().u32(),
        }));
      },
      TTL.COLLABORATORS,
      [contractId],
    );

    res.json(results);
  } catch (err) {
    if (err.status) return sendError(res, err.status, err.code, err.message);
    next(err);
  }
});
