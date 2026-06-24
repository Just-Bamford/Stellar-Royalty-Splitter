import { Router } from "express";
import { addressToScVal } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";
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
