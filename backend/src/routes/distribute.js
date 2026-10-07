import { Router } from "express";
import { addressToScVal } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { deduplicationMiddleware, idempotencyMiddleware } from "../idempotency.js";
import {
  recordDistributeCall,
  recordDistributionLatency,
  recordDistributionOutcomeMetric,
  recordTransactionFailure,
  recordTransactionSuccess,
} from "../metrics.js";
import { sendError } from "../error-response.js";
import { invalidateContractCaches } from "../cache-invalidation.js";
import logger from "../logger.js";
import { tieredLimiters } from "../middleware/tieredRateLimit.js";
import { broadcastToContract } from "../websocket.js";
import { runHook } from "../plugins/plugin-framework.js";

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

      // Plugin hook: beforeDistribute — runs before XDR is built (#998).
      // Fail-open: errors in plugins are caught inside runHook; this await
      // never throws and does not block the distribution on plugin failure.
      await runHook("beforeDistribute", { contractId, walletAddress, tokenId });
      // Plugin hook: onPayment — payment initiation event (#998).
      await runHook("onPayment", { contractId, walletAddress, tokenId });

      // Use shared handler to record transaction, build XDR, and log audit
      const buildStart = Date.now();
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
      recordDistributionLatency("build", Date.now() - buildStart);
      recordDistributionOutcomeMetric("built");
      // Invalidate cached history and contract state so the new distribution
      // appears immediately on subsequent reads. Propagates via Redis
      // pub/sub to every other backend instance too (#926).
      invalidateContractCaches(contractId, { reason: "distribute" });

      // Broadcast distribution event to connected WebSocket clients for real-time updates
      broadcastToContract(contractId, {
        type: "distribution_completed",
        contractId,
        transactionId,
        timestamp: new Date().toISOString(),
        requestedAmount: req.body.requestedAmount ?? null,
        tokenId: req.body.tokenId ?? null,
      });

      // Plugin hook: afterDistribute — post-process after distribution is built (#998).
      // Fire-and-forget: runs after response is sent so plugins don't add latency.
      await runHook("afterDistribute", { contractId, walletAddress, transactionId, xdr });

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
