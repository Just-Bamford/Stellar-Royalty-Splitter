import { Router } from "express";
import { addressToScVal, getRecommendedFee } from "../stellar.js";
import { validate, distributeSchema } from "../validation.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { recordTransactionFee } from "../database/index.js";
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

      const feeStroops = await getRecommendedFee();
      recordTransactionFee(transactionId, contractId, feeStroops);
      // Invalidate cached history and contract state so the new distribution
      // appears immediately on subsequent reads. Propagates via Redis
      // pub/sub to every other backend instance too (#926).
      invalidateContractCaches(contractId, { reason: "distribute" });

      // Broadcast to connected WebSocket clients that an unsigned XDR is ready
      // (#1177). Nothing has been submitted or paid out yet — the wallet still
      // has to sign and submit it — so this is "distribution_pending", not "distribution_completed".
      // `distribution_completed` is emitted by POST /transaction/confirm/:txHash
      // (routes/history.js) once Horizon reports the transaction confirmed.
      broadcastToContract(contractId, {
        type: "distribution_pending",
        contractId,
        transactionId,
        timestamp: new Date().toISOString(),
        requestedAmount: req.body.requestedAmount ?? null,
        tokenId: req.body.tokenId ?? null,
      });

      // Plugin hook: afterDistribute — post-process after distribution is built (#998).
      // Fire-and-forget: do not await — plugins must not block the response.
      void runHook("afterDistribute", { contractId, walletAddress, transactionId, xdr }).catch(
        (err) => {
          logger.error("afterDistribute plugin hook failed", { error: err.message });
        },
      );

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
