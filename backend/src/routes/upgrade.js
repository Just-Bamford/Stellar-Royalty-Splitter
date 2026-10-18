/**
 * Contract Upgrade Workflow routes — closes #604, #1071.
 *
 * Implements proxy pattern, upgrade proposals, governance voting,
 * 24-48h timelock enforcement, execution, rollback, and monitoring.
 */

import { Router } from "express";
import { z } from "zod";
import StellarSdk from "@stellar/stellar-sdk";
import { server, networkPassphrase, retryBuildTx } from "../stellar.js";
import { sendError, sendValidationError } from "../error-response.js";
import { stellarAddress, contractAddress, validateContractIdMiddleware } from "../validation.js";
import { addAuditLog } from "../database/index.js";
import {
  upgradeManager,
  MIN_UPGRADE_TIMELOCK_SECS,
  MAX_UPGRADE_TIMELOCK_SECS,
} from "../services/upgrade-manager.js";

const { Contract, SorobanRpc, TransactionBuilder, BASE_FEE, Account, xdr } = StellarSdk;

export const upgradeRouter = Router();

const upgradeSchema = z.object({
  contractId:    contractAddress,
  walletAddress: stellarAddress,
  wasmHash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "wasmHash must be a 64-character hex string"),
});

const proposeUpgradeSchema = z.object({
  contractId: contractAddress,
  proposer: stellarAddress,
  newWasmHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "newWasmHash must be a 64-character hex string"),
  newVersion: z.string().min(1, "newVersion is required"),
  description: z.string().min(1, "description is required"),
  timelockDelaySeconds: z.number().int().min(MIN_UPGRADE_TIMELOCK_SECS).max(MAX_UPGRADE_TIMELOCK_SECS).optional(),
  votingDurationSeconds: z.number().int().positive().optional(),
});

const voteUpgradeSchema = z.object({
  proposalId: z.number().int().positive(),
  voter: stellarAddress,
  approve: z.boolean(),
  weight: z.number().int().positive().optional(),
});

const scheduleUpgradeSchema = z.object({
  proposalId: z.number().int().positive(),
  caller: stellarAddress,
});

const executeUpgradeSchema = z.object({
  proposalId: z.number().int().positive(),
  caller: stellarAddress,
});

const rollbackUpgradeSchema = z.object({
  contractId: contractAddress,
  caller: stellarAddress,
  reason: z.string().optional(),
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

// ─── POST /api/v1/contract/upgrade/propose (#1071) ────────────────────────
upgradeRouter.post("/upgrade/propose", async (req, res, next) => {
  const result = proposeUpgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  try {
    const proposal = await upgradeManager.proposeUpgrade(result.data);
    addAuditLog(result.data.contractId, "upgrade_proposed", result.data.proposer, {
      proposalId: proposal.proposal_id,
      newWasmHash: result.data.newWasmHash,
      newVersion: result.data.newVersion,
    });
    return res.status(201).json({ success: true, data: proposal });
  } catch (err) {
    return sendError(res, 400, "propose_upgrade_failed", err.message);
  }
});

// ─── POST /api/v1/contract/upgrade/vote (#1071) ───────────────────────────
upgradeRouter.post("/upgrade/vote", async (req, res, next) => {
  const result = voteUpgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  try {
    const proposal = await upgradeManager.castVote(result.data);
    return res.json({ success: true, data: proposal });
  } catch (err) {
    return sendError(res, 400, "vote_upgrade_failed", err.message);
  }
});

// ─── POST /api/v1/contract/upgrade/schedule (#1071) ───────────────────────
upgradeRouter.post("/upgrade/schedule", async (req, res, next) => {
  const result = scheduleUpgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  try {
    const scheduled = await upgradeManager.scheduleUpgrade(result.data);
    return res.json({ success: true, data: scheduled });
  } catch (err) {
    return sendError(res, 400, "schedule_upgrade_failed", err.message);
  }
});

// ─── POST /api/v1/contract/upgrade/execute (#1071) ────────────────────────
upgradeRouter.post("/upgrade/execute", async (req, res, next) => {
  const result = executeUpgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  try {
    const executed = await upgradeManager.executeUpgrade(result.data);
    return res.json({ success: true, data: executed });
  } catch (err) {
    return sendError(res, 400, "execute_upgrade_failed", err.message);
  }
});

// ─── POST /api/v1/contract/upgrade/rollback (#1071) ───────────────────────
upgradeRouter.post("/upgrade/rollback", async (req, res, next) => {
  const result = rollbackUpgradeSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  try {
    const rollback = await upgradeManager.rollbackUpgrade(result.data);
    return res.json({ success: true, data: rollback });
  } catch (err) {
    return sendError(res, 400, "rollback_upgrade_failed", err.message);
  }
});

// ─── GET /api/v1/contract/upgrade/proposals/:contractId (#1071) ───────────
upgradeRouter.get("/upgrade/proposals/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const proposals = upgradeManager.listProposals(req.params.contractId);
    return res.json({ success: true, data: proposals });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/contract/upgrade/monitor/:contractId (#1071) ─────────────
upgradeRouter.get("/upgrade/monitor/:contractId", validateContractIdMiddleware, async (req, res, next) => {
  try {
    const monitorData = await upgradeManager.monitorUpgradeSuccess(req.params.contractId);
    return res.json({ success: true, data: monitorData });
  } catch (err) {
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
