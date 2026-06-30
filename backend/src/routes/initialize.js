import { Router } from "express";
import {
  addressToScVal,
  u32ToScVal,
  vecToScVal,
  bytesN32HexToScVal,
  isContractInitialized,
} from "../stellar.js";
import {
  validate,
  initializeSchema,
  commitInitializeSchema,
  revealInitializeSchema,
  validateInitializePayloadSize,
  validateRoyaltySplitMiddleware,
} from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { createRequestLogger } from "../logger.js";
import { recordNonceIfNew } from "../database/index.js";
import { sendError } from "../error-response.js";
import { invalidateCollaboratorsCache } from "../collaborators-cache.js";

export const initializeRouter = Router();

async function ensureNotInitialized(contractId, res, log) {
  const alreadyInitialized = await isContractInitialized(contractId);
  if (alreadyInitialized) {
    log?.warn("contract already initialized", { contractId });
    sendError(res, 409, "conflict", "Contract is already initialized. Cannot re-initialize an existing contract.");
    return false;
  }
  return true;
}

initializeRouter.post(
  "/",
  validateInitializePayloadSize,
  validateRoyaltySplitMiddleware,
  validate(initializeSchema),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, collaborators, shares, nonce } = req.body;
      if (!(await ensureNotInitialized(contractId, res, log))) return;

      if (nonce && !recordNonceIfNew(contractId, nonce)) {
        log.warn("duplicate initialize nonce rejected", { contractId, nonce });
        return sendError(
          res,
          409,
          "duplicate_nonce",
          "A request with this nonce has already been processed for this contract."
        );
      }

      log.info("initialize requested", {
        contractId,
        walletAddress,
        collaboratorCount: collaborators.length,
      });

      const collaboratorVec = vecToScVal(collaborators.map(addressToScVal));
      const sharesVec = vecToScVal(shares.map(u32ToScVal));

      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "initialize",
        scvlArgs: [collaboratorVec, sharesVec],
        auditAction: "contract_initialized",
        auditMetadata: { collaboratorCount: collaborators.length, collaborators, shares },
        transactionMetadata: { requestedAmount: null, tokenId: null },
        correlationId: req.correlationId,
      });

      invalidateCollaboratorsCache(contractId);
      log.info("initialize transaction built", { contractId, transactionId });
      res.json({ xdr, transactionId });
    } catch (err) {
      log.error("initialize failed", {
        error: err.message ?? String(err),
        status: err.status,
      });
      if (err.status) return sendError(res, err.status, undefined, err.message);
      next(err);
    }
  }
);

/** POST /api/v1/initialize/commit — commit-reveal phase 1 (#403) */
initializeRouter.post("/commit", validate(commitInitializeSchema), async (req, res, next) => {
  const log = createRequestLogger(req);
  try {
    const { contractId, walletAddress, collaboratorsHash, sharesHash, nonce } = req.body;
    if (!(await ensureNotInitialized(contractId, res, log))) return;

    const { xdr, transactionId } = await buildAndRecordTransaction({
      contractId,
      walletAddress,
      transactionType: "initialize",
      contractMethod: "commit_initialize",
      scvlArgs: [
        addressToScVal(walletAddress),
        bytesN32HexToScVal(collaboratorsHash),
        bytesN32HexToScVal(sharesHash),
        bytesN32HexToScVal(nonce),
      ],
      auditAction: "initialize_committed",
      auditMetadata: { collaboratorsHash, sharesHash },
      transactionMetadata: { requestedAmount: null, tokenId: null },
      correlationId: req.correlationId,
    });

    res.json({ xdr, transactionId, phase: "commit" });
  } catch (err) {
    if (err.status) return sendError(res, err.status, undefined, err.message);
    next(err);
  }
});

/** POST /api/v1/initialize/reveal — commit-reveal phase 2 (#403) */
initializeRouter.post(
  "/reveal",
  validateInitializePayloadSize,
  validate(revealInitializeSchema),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, collaborators, shares, salt } = req.body;
      if (!(await ensureNotInitialized(contractId, res, log))) return;

      const collaboratorVec = vecToScVal(collaborators.map(addressToScVal));
      const sharesVec = vecToScVal(shares.map(u32ToScVal));

      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "initialize",
        contractMethod: "reveal_initialize",
        scvlArgs: [collaboratorVec, sharesVec, bytesN32HexToScVal(salt)],
        auditAction: "initialize_revealed",
        auditMetadata: { collaboratorCount: collaborators.length, collaborators, shares },
        transactionMetadata: { requestedAmount: null, tokenId: null },
        correlationId: req.correlationId,
      });

      invalidateCollaboratorsCache(contractId);
      res.json({ xdr, transactionId, phase: "reveal" });
    } catch (err) {
      if (err.status) return sendError(res, err.status, undefined, err.message);
      next(err);
    }
  }
);
