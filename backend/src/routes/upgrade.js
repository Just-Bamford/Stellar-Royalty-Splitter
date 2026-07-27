/**
 * Contract Upgrade Workflow routes — closes #604.
 *
 * POST /api/v1/contract/upgrade
 *   Body: { contractId, walletAddress, wasmHash }
 *   Builds an unsigned XDR for `update_wasm(wasm_hash)`.  The caller
 *   signs and submits it; the contract's WASM is replaced without
 *   redeployment — all instance storage (collaborators, shares, etc.)
 *   is preserved and distributions are uninterrupted.
 *
 * GET  /api/v1/contract/version/:contractId
 *   Returns the on-chain contract version string stored during initialize().
 */

import { Router } from "express";
import { z } from "zod";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase, retryBuildTx } from "../stellar.js";
import { sendError, sendValidationError } from "../error-response.js";
import { stellarAddress, contractAddress, validateContractIdMiddleware } from "../validation.js";
import { addAuditLog } from "../database/index.js";

const { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, Account, xdr } = StellarSdk;

export const upgradeRouter = Router();

const upgradeSchema = z.object({
  contractId:    contractAddress,
  walletAddress: stellarAddress,
  // 64-character hex string representing the 32-byte WASM hash
  wasmHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "wasmHash must be a 64-character hex string"),
});

// ─── POST /api/v1/contract/upgrade ────────────────────────────────────────

upgradeRouter.post("/upgrade", async (req, res, next) => {
  const result = upgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { contractId, walletAddress, wasmHash } = result.data;

  try {
    // Convert hex wasmHash → ScVal bytes (BytesN<32>) expected by update_wasm
    const hashBytes = Buffer.from(wasmHash, "hex");
    const wasmHashScVal = xdr.ScVal.scvBytes(hashBytes);

    const txXdr = await retryBuildTx(walletAddress, contractId, "update_wasm", [wasmHashScVal]);

    addAuditLog(contractId, "upgrade_initiated", walletAddress, { wasmHash });

    return res.json({ xdr: txXdr, wasmHash });
  } catch (err) {
    if (err.status) {
      return sendError(res, err.status, err.code, err.message);
    }
    next(err);
  }
});

// ─── GET /api/v1/contract/version/:contractId ─────────────────────────────

upgradeRouter.get("/version/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const contract = new Contract(contractId);

    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0"
    );

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("get_version"))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(sim)) {
      return sendError(res, 400, "contract_simulation_failed", sim.error ?? "Simulation failed");
    }

    const retval = sim.result?.retval;
    const version = retval ? StellarSdk.scValToNative(retval) : null;

    return res.json({ success: true, data: { contractId, version: version ?? null } });
  } catch (err) {
    next(err);
  }
});
