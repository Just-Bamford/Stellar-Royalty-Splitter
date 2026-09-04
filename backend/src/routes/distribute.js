import { Router } from "express";
import { addressToScVal } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { deduplicationMiddleware, idempotencyMiddleware } from "../idempotency.js";
import {
  recordDistributeCall,
  recordTransactionFailure,
  recordTransactionSuccess,
} from "../metrics.js";
import { sendError } from "../error-response.js";
import { invalidateContract } from "../cache.js";
import logger from "../logger.js";
import { tieredLimiters } from "../middleware/tieredRateLimit.js";
import { broadcastToContract } from "../websocket.js";

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
  ...tieredLimiters,
  deduplicationMiddleware("distribute"),
  idempotencyMiddleware,
  validate(distributeSchema),
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, tokenId } = req.body;

      // Distribution lifecycle (#745): "started" is logged here at the route
      // boundary; "simulation_built"/"failed" are logged inside
      // buildAndRecordTransaction (shared by every transaction-building
      // route). There is no submission/confirmation step to log here — this
      // endpoint only returns unsigned XDR for the wallet to sign and submit
      // directly, so the backend never observes the on-chain outcome.
      logger.info("distribution started", { contractId, walletAddress, tokenId });

      // Use shared handler to record transaction, build XDR, and log audit
      const { xdr, transactionId } = await buildAndRecordTransaction({
        contractId,
        walletAddress,
        transactionType: "distribute",
        scvlArgs: [addressToScVal(tokenId)],
        auditAction: "distribution_initiated",
        auditMetadata: { tokenId },
        transactionMetadata: { tokenId },
      });

      recordTransactionSuccess();
      // Invalidate cached history and contract state so the new distribution
      // appears immediately on subsequent reads.
      invalidateContract(contractId);

      // Broadcast distribution event to connected WebSocket clients for real-time updates
      broadcastToContract(contractId, {
        type: "distribution_completed",
        contractId,
        transactionId,
        timestamp: new Date().toISOString(),
        requestedAmount: req.body.requestedAmount ?? null,
        tokenId: req.body.tokenId ?? null,
      });

      res.json({ xdr, transactionId });
    } catch (err) {
      recordTransactionFailure();
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);
