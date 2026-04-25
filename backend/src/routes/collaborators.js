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

export const collaboratorsRouter = Router();

/**
 * GET /api/collaborators/:contractId
 * Returns: [{ address, basisPoints }]
 *
 * Uses a read-only simulation (no signing required).
 */
collaboratorsRouter.get("/:contractId", async (req, res, next) => {
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

    // Fetch share for each address
    const results = await Promise.all(
      addresses.map(async (addr) => {
        const shareTx = new TransactionBuilder(dummyAccount, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(contract.call("get_share", addressToScVal(addr)))
          .setTimeout(30)
          .build();

        const shareSim = await server.simulateTransaction(shareTx);
        const bp = SorobanRpc.Api.isSimulationError(shareSim)
          ? 0
          : (shareSim.result?.retval?.u32() ?? 0);

        return { address: addr, basisPoints: bp };
      }),
    );

    res.json(results);
  } catch (err) {
    next(err);
  }
});
