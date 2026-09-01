import { Router } from "express";
import {
  addressToScVal,
  bytes32ToScVal,
  u32ToScVal,
  vecToScVal,
  isContractInitialized,
} from "../stellar.js";
import { createHash } from "crypto";
import { validate, initializeSchema, validateInitializePayloadSize } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { sendError } from "../error-response.js";
import { invalidateContract } from "../cache.js";
import logger from "../logger.js";

export const initializeRouter = Router();

function hashScVal(value) {
  return createHash("sha256").update(value.toXDR()).digest("hex");
}

function initializeHashes(collaborators, shares) {
  return {
    collaboratorsHash: hashScVal(vecToScVal(collaborators.map(addressToScVal))),
    sharesHash: hashScVal(vecToScVal(shares.map(u32ToScVal))),
  };
}

async function buildInitializeTransaction(req, res, next, method, args, type, metadata) {
  try {
    const { contractId, walletAddress } = req.body;
    const { xdr, transactionId } = await buildAndRecordTransaction({
      contractId,
      walletAddress,
      transactionType: type,
      scvlArgs: args,
      auditAction: type === "initialize_commit" ? "initialization_committed" : "contract_initialized",
      auditMetadata: metadata,
      transactionMetadata: { requestedAmount: null, tokenId: null },
    });
    invalidateContract(contractId);
    res.json({ xdr, transactionId });
  } catch (err) {
    if (err.status) return sendError(res, err.status, err.code, err.message);
    next(err);
  }
}

initializeRouter.post("/commit", validateInitializePayloadSize, validate(initializeSchema), async (req, res, next) => {
  const { contractId, collaborators, shares } = req.body;
  try {
    if (await isContractInitialized(contractId)) {
      return sendError(res, 409, "already_initialized", "Contract is already initialized.");
    }
    const { collaboratorsHash, sharesHash } = initializeHashes(collaborators, shares);
    return buildInitializeTransaction(
      req,
      res,
      next,
      "commit_initialize",
      [bytes32ToScVal(collaboratorsHash), bytes32ToScVal(sharesHash)],
      "initialize_commit",
      { collaboratorsHash, sharesHash, collaboratorCount: collaborators.length },
    );
  } catch (err) {
    if (err.status) return sendError(res, err.status, err.code, err.message);
    next(err);
  }
});

initializeRouter.post("/reveal", validateInitializePayloadSize, validate(initializeSchema), async (req, res, next) => {
  const { collaborators, shares } = req.body;
  return buildInitializeTransaction(
    req,
    res,
    next,
    "reveal_initialize",
    [vecToScVal(collaborators.map(addressToScVal)), vecToScVal(shares.map(u32ToScVal))],
    "initialize_reveal",
    { collaboratorCount: collaborators.length, shares },
  );
});

/**
 * POST /api/initialize
 * Body: { contractId, walletAddress, collaborators: string[], shares: number[] }
 * Returns: { xdr, transactionId } — unsigned transaction XDR for the frontend to sign & submit + tracking ID
 */
initializeRouter.post(
  "/",
  validateInitializePayloadSize,
  validate(initializeSchema),
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, collaborators, shares } = req.body;

      // Check if contract is already initialized on-chain
      const alreadyInitialized = await isContractInitialized(contractId);

      // Contract state transition (#745): log before/after initialization
      // state so operators can confirm a contract moved from uninitialized
      // to initialized, and with what collaborator/share configuration.
      logger.info("contract state change: initialize requested", {
        contractId,
        walletAddress,
        stateBefore: { initialized: alreadyInitialized },
        collaboratorCount: collaborators.length,
      });

      if (alreadyInitialized) {
        return sendError(
          res,
          409,
          "already_initialized",
          "Contract is already initialized. Cannot re-initialize an existing contract.",
        );
      }

      // Build ScVal arguments for the contract call
      const collaboratorVec = vecToScVal(collaborators.map(addressToScVal));
      const sharesVec = vecToScVal(shares.map(u32ToScVal));

      // Use shared handler to record transaction, build XDR, and log audit
      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "initialize",
        scvlArgs: [collaboratorVec, sharesVec],
        auditAction: "contract_initialized",
        auditMetadata: {
          collaboratorCount: collaborators.length,
          shares,
        },
        transactionMetadata: {
          requestedAmount: null,
          tokenId: null,
        },
      });

      // Invalidate cached read-only data for this contract so stale state
      // is not served after the new collaborator set is written on-chain.
      invalidateContract(contractId);

      logger.info("contract state change: initialize XDR built", {
        contractId,
        walletAddress,
        transactionId,
        stateAfter: { initialized: true, collaboratorCount: collaborators.length },
        admin: walletAddress,
        collaborators,
        timestamp: new Date().toISOString(),
      });

      res.json({ xdr, transactionId });
    } catch (err) {
      if (err.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);
