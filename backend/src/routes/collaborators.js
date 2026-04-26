import { Router } from "express";
import {
  Address,
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { server, networkPassphrase, addressToScVal } from "../stellar.js";
import { validateContractIdMiddleware } from "../validation.js";
import logger from "../logger.js";

export const collaboratorsRouter = Router();

/**
 * GET /api/collaborators/:contractId
 * Returns: [{ address, basisPoints }]
 *
 * Uses a read-only simulation (no signing required).
 */
collaboratorsRouter.get("/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);

    // Simulate get_collaborators
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_collaborators"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return res.status(400).json({ error: sim.error });
    }

    // Parse the returned Vec<Address>
    const resultVal = sim.result?.retval;
    if (!resultVal) return res.json([]);

    const addresses =
      resultVal.vec()?.map((scv) => Address.fromScVal(scv).toString()) ?? [];

    // Fetch share for each address — use allSettled so a single RPC failure
    // doesn't abort the entire request (#130)
    const settled = await Promise.allSettled(
      addresses.map(async (addr) => {
        // #132: validate address is a known collaborator before calling get_share
        const isCollabTx = new TransactionBuilder(dummyAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(contract.call("is_collaborator", addressToScVal(addr)))
          .setTimeout(30)
          .build();

        const isCollabSim = await server.simulateTransaction(isCollabTx);
        const isCollab = !SorobanRpc.Api.isSimulationError(isCollabSim) &&
          (isCollabSim.result?.retval?.bool() ?? false);

        if (!isCollab) {
          throw new Error(`${addr} is not a registered collaborator`);
        }

        const shareTx = new TransactionBuilder(dummyAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(contract.call("get_share", addressToScVal(addr)))
          .setTimeout(30)
          .build();

        const shareSim = await server.simulateTransaction(shareTx);
        if (SorobanRpc.Api.isSimulationError(shareSim)) {
          throw new Error(shareSim.error);
        }
        return { address: addr, basisPoints: shareSim.result?.retval?.u32() ?? 0, status: "success" };
      }),
    );

    const results = settled.map((result, i) => {
      if (result.status === "fulfilled") return result.value;
      logger.warn(`Failed to fetch share for ${addresses[i]}: ${result.reason?.message ?? result.reason}`);
      return { address: addresses[i], basisPoints: 0, status: "failed" };
    });

    res.json(results);
  } catch (err) {
    next(err);
  }
});
