import { Router } from "express";
import {
  Address,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { server, networkPassphrase } from "../stellar.js";
import logger from "../logger.js";

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
    const contract = new Contract(contractId);

    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
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
      return res.status(400).json({ error: sim.error });
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
    res.json(results);
  } catch (err) {
    next(err);
  }
});
