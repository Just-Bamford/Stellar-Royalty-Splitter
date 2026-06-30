import { Router } from "express";
import { addressToScVal, vecToScVal } from "../stellar.js";
import { validate, distributeSchema, batchDistributeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { idempotencyMiddleware } from "../idempotency.js";
import { createRequestLogger } from "../logger.js";
import {
  recordDistributeCall,
  recordTransactionFailure,
  recordTransactionSuccess,
} from "../metrics.js";
import { sendError } from "../error-response.js";

export const distributeRouter = Router();

/**
 * POST /api/distribute
 * Body: { contractId, walletAddress, tokenId }
 * Headers: Idempotency-Key (optional) — prevents duplicate submissions
 * Returns: { xdr, transactionId } — unsigned transaction XDR + tracking ID
 */
distributeRouter.post(
  "/",
  (_req, _res, next) => {
    recordDistributeCall();
    next();
  },
  idempotencyMiddleware,
  validate(distributeSchema),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, tokenId } = req.body;

      log.info("distribute requested", { contractId, walletAddress, tokenId });

      // Use shared handler to record transaction, build XDR, and log audit
      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "distribute",
        scvlArgs: [addressToScVal(tokenId)],
        auditAction: "distribution_initiated",
        auditMetadata: { tokenId },
        transactionMetadata: { tokenId },
        correlationId: req.correlationId,
      });

      log.info("distribute transaction built", { contractId, transactionId });
      recordTransactionSuccess();
      res.json({ xdr, transactionId });
    } catch (err) {
      log.error("distribute failed", {
        error: err.message ?? String(err),
        status: err.status,
      });
      recordTransactionFailure();
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * POST /api/distribute/batch
 * Body: { contractId, walletAddress, tokenIds }
 * Headers: Idempotency-Key (optional)
 * Returns: { xdr, transactionId }
 */
distributeRouter.post(
  "/batch",
  (_req, _res, next) => {
    recordDistributeCall();
    next();
  },
  idempotencyMiddleware,
  validate(batchDistributeSchema),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, tokenIds } = req.body;

      log.info("batch distribute requested", { contractId, walletAddress, tokenIds });

      const tokenScVals = tokenIds.map(addressToScVal);
      const tokensVecVal = vecToScVal(tokenScVals);

      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "distribute",
        contractMethod: "batch_distribute",
        scvlArgs: [tokensVecVal],
        auditAction: "batch_distribution_initiated",
        auditMetadata: { tokenIds },
        transactionMetadata: { tokenId: tokenIds.join(",") },
        correlationId: req.correlationId,
      });

      log.info("batch distribute transaction built", { contractId, transactionId });
      recordTransactionSuccess();
      res.json({ xdr, transactionId });
    } catch (err) {
      log.error("batch distribute failed", {
        error: err.message ?? String(err),
        status: err.status,
      });
      recordTransactionFailure();
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);
