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
} from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { createRequestLogger } from "../logger.js";

export const initializeRouter = Router();

async function ensureNotInitialized(contractId, res, log) {
  const alreadyInitialized = await isContractInitialized(contractId);
  if (alreadyInitialized) {
    log?.warn("contract already initialized", { contractId });
    res.status(409).json({
      error: "Contract is already initialized. Cannot re-initialize an existing contract.",
    });
    return false;
  }
  return true;
}

initializeRouter.post(
  "/",
  validateInitializePayloadSize,
  validate(initializeSchema),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, collaborators, shares } = req.body;
      if (!(await ensureNotInitialized(contractId, res, log))) return;

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
        auditMetadata: { collaboratorCount: collaborators.length, shares },
        transactionMetadata: { requestedAmount: null, tokenId: null },
        correlationId: req.correlationId,
      });

      log.info("initialize transaction built", { contractId, transactionId });
      res.json({ xdr, transactionId });
    } catch (err) {
      log.error("initialize failed", {
        error: err.message ?? String(err),
        status: err.status,
      });
      if (err.status) return res.status(err.status).json({ error: err.message });
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
    if (err.status) return res.status(err.status).json({ error: err.message });
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
        auditMetadata: { collaboratorCount: collaborators.length, shares },
        transactionMetadata: { requestedAmount: null, tokenId: null },
        correlationId: req.correlationId,
      });

      res.json({ xdr, transactionId, phase: "reveal" });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  }
);
