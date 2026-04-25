import { Router } from "express";
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { server, networkPassphrase } from "../stellar.js";

export const contractRouter = Router();

/**
 * GET /api/contract/version/:contractId
 * Returns the contract version stored on-chain via simulation.
 * Response: { contractId, version: string }
 */
contractRouter.get("/version/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);

    // Simulate version() call (read-only, no signing required)
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("version"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      const errorMsg = sim.error?.toString() || '';
      if (errorMsg.includes('not initialized')) {
        return res.status(404).json({ error: 'Contract not initialized' });
      }
      return res.status(400).json({ error: sim.error });
    }

    // Parse the returned String
    const resultVal = sim.result?.retval;
    if (!resultVal) {
      return res.status(404).json({ error: "Version not found" });
    }

    const version = resultVal.string()?.toString() ?? "unknown";

    res.json({ contractId, version });
  } catch (err) {
    next(err);
  }
});
