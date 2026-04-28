import { Router } from "express";
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  Account,
} from "@stellar/stellar-sdk";
import { isContractInitialized, server, networkPassphrase, addressToScVal } from "../stellar.js";
import { validateContractIdMiddleware } from "../validation.js";

export const contractRouter = Router();

contractRouter.get("/status/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const initialized = await isContractInitialized(contractId);
    res.json({ initialized });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contract/balance/:contractId?tokenId=...
 * Returns the contract's token balance via simulation.
 * Response: { balance: string }
 */
contractRouter.get("/balance/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const { tokenId } = req.query;
    if (!tokenId) return res.status(400).json({ error: "tokenId query param required" });

    const contract = new Contract(contractId);
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_balance", addressToScVal(tokenId)))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return res.status(400).json({ error: sim.error });
    }

    const retval = sim.result?.retval;
    // get_balance returns i128
    const balance = retval?.i128()
      ? (BigInt(retval.i128().hi()) << 64n | BigInt(retval.i128().lo())).toString()
      : "0";

    res.json({ balance });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/contract/collaborator-count/:contractId
 * Returns the number of collaborators via simulation.
 * Response: { contractId, count: number }
 */
contractRouter.get("/collaborator-count/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("collaborator_count"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return res.status(400).json({ error: sim.error });
    }

    const count = sim.result?.retval?.u32() ?? 0;
    res.json({ contractId, count });
  } catch (err) {
    next(err);
  }
});
 * Returns the sum of all collaborator shares via simulation.
 * Response: { contractId, totalShares: number }
 */
contractRouter.get("/shares-total/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);

    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_total_shares"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return res.status(400).json({ error: sim.error });
    }

    const resultVal = sim.result?.retval;
    const totalShares = resultVal?.u32() ?? 0;

    res.json({ contractId, totalShares });
  } catch (err) {
    next(err);
  }
});

