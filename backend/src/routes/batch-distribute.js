import { Router } from "express";
import { addressToScVal, BatchTransactionBuilder, buildTx, vecToScVal } from "../stellar.js";
import { determineOptimalBatchSize, estimateBatchClaimCosts } from "../services/gas-optimizer.js";
import { validate, batchDistributeSchema, MAX_BATCH_OPERATIONS } from "../validation.js";
import { recordTransaction, addAuditLog } from "../database/index.js";
import { sendError } from "../error-response.js";
import { invalidateContractCaches } from "../cache-invalidation.js";
import { recordTransactionFailure, recordTransactionSuccess } from "../metrics.js";
import logger from "../logger.js";
import { broadcastToContract } from "../websocket.js";

export const batchDistributeRouter = Router();

/**
 * POST /api/v1/batch-distribute
 * Body: { walletAddress, operations: [{ contractId, tokenId, amount? }, ...] }
 *
 * Batches up to MAX_BATCH_OPERATIONS (50, the Soroban-friendly cap) distribute
 * calls for one wallet into a single BatchTransactionBuilder run (#759),
 * collapsing the sequence-number/fee-estimation RPC round trips that would
 * otherwise happen once per contract into one round trip for the whole group.
 *
 * Each operation is still built and returned as its own transaction XDR —
 * batching is transparent to callers and to Soroban itself, it only reduces
 * backend RPC overhead. One operation failing (e.g. a bad contractId or a
 * simulation error) does not fail the others; per-operation results are
 * returned so the caller can retry just the failed ones.
 *
 * Existing single-operation routes (POST /distribute) are unchanged and
 * continue to work independently of this route.
 */
batchDistributeRouter.post(
  "/",
  validate(batchDistributeSchema),
  async (req, res, next) => {
    try {
      const { walletAddress, operations } = req.body;

      // Validate total requested amount and detect duplicate/overlapping
      // contract targets before doing any RPC work — a batch that pays the
      // same contract twice, or overflows a sane total, is almost always a
      // client bug rather than an intentional request.
      const seenContracts = new Set();
      const duplicateContracts = new Set();
      let totalAmount = 0n;
      for (const op of operations) {
        if (seenContracts.has(op.contractId)) {
          duplicateContracts.add(op.contractId);
        }
        seenContracts.add(op.contractId);
        if (op.amount !== undefined) {
          totalAmount += BigInt(op.amount);
        }
      }

      if (duplicateContracts.size > 0) {
        return sendError(
          res,
          400,
          "duplicate_contract_in_batch",
          `Batch contains duplicate contractId(s): ${[...duplicateContracts].join(", ")}`
        );
      }

      // Record each operation as a pending transaction up front so the
      // audit trail and history reflect the whole batch even if some
      // operations fail to build.
      const builder = new BatchTransactionBuilder(walletAddress);
      const pending = operations.map((op) => {
        const transactionId = recordTransaction(op.contractId, "distribute", walletAddress, {
          tokenId: op.tokenId,
          batch: true,
        });
        builder.add({
          contractId: op.contractId,
          method: "distribute",
          args: [addressToScVal(op.tokenId)],
        });
        return { transactionId, contractId: op.contractId, tokenId: op.tokenId };
      });

      const built = await builder.build();

      const results = built.map((result, i) => {
        const { transactionId, contractId, tokenId } = pending[i];
        if (result.ok) {
          recordTransactionSuccess();
          addAuditLog(contractId, "distribution_initiated", walletAddress, {
            transactionId,
            tokenId,
            batch: true,
          });
          invalidateContractCaches(contractId, { reason: "batch-distribute" });

          // Broadcast distribution event for real-time updates
          broadcastToContract(contractId, {
            type: "distribution_completed",
            contractId,
            transactionId,
            timestamp: new Date().toISOString(),
            tokenId,
            batch: true,
          });

          return { contractId, tokenId, transactionId, xdr: result.xdr };
        }
        recordTransactionFailure();
        return {
          contractId,
          tokenId,
          transactionId,
          error: result.error?.message ?? "Failed to build transaction",
        };
      });

      const failureCount = results.filter((r) => r.error).length;

      res.json({
        success: failureCount === 0,
        totalOperations: operations.length,
        totalAmount: totalAmount.toString(),
        succeeded: results.length - failureCount,
        failed: failureCount,
        maxBatchSize: MAX_BATCH_OPERATIONS,
        results,
      });
    } catch (err) {
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/batch-distribute/tokens
 * Body: { contractId, walletAddress, tokens: [Address], idempotencyKey? }
 *
 * Uses the contract's existing batch_distribute() function to distribute
 * multiple tokens in one Soroban invocation. Soroban commits a transaction
 * atomically: if any token payout fails, none of this invocation's state or
 * transfers are committed.
 *
 * Returns a single unsigned XDR calling batch_distribute() with all tokens
 * included in one transaction.
 */
batchDistributeRouter.post(
  "/tokens",
  async (req, res, next) => {
    try {
      const { contractId, walletAddress, tokens, idempotencyKey } = req.body;

      if (!contractId || !walletAddress || !tokens || !Array.isArray(tokens)) {
        return sendError(res, 400, "invalid_request", "contractId, walletAddress, and tokens array are required");
      }

      if (tokens.length === 0) {
        return sendError(res, 400, "invalid_request", "tokens array cannot be empty");
      }

      if (tokens.length > MAX_BATCH_OPERATIONS) {
        return sendError(res, 400, "invalid_request", `maximum ${MAX_BATCH_OPERATIONS} tokens per batch_distribute call`);
      }

      const duplicateTokens = tokens.filter((token, index) => tokens.indexOf(token) !== index);
      if (duplicateTokens.length > 0) {
        return sendError(res, 400, "duplicate_token_in_batch", "tokens must be unique within an atomic batch");
      }

      logger.info("batch_distribute tokens request", { contractId, walletAddress, tokenCount: tokens.length });

      // This represents a pending user action only. Do not record a completed
      // distribution or invalidate caches until the signed XDR succeeds.
      const transactionId = recordTransaction(contractId, "batch_distribute", walletAddress, {
        tokens,
        idempotencyKey,
      });

      const xdr = await buildTx(
        walletAddress,
        contractId,
        "batch_distribute",
        [vecToScVal(tokens.map(addressToScVal))],
      );
      const estimate = estimateBatchClaimCosts(tokens.length, { maxBatchSize: MAX_BATCH_OPERATIONS });

      res.json({
        success: true,
        transactionId,
        contractId,
        tokensIncluded: tokens.length,
        xdr,
        estimate,
      });
    } catch (err) {
      recordTransactionFailure();
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/batch-distribute/tokens/estimate
 * Gives the UI an explicit, assumption-labelled estimate before it asks the
 * wallet to sign. The actual prepared XDR remains the authoritative quote.
 */
batchDistributeRouter.post("/tokens/estimate", (req, res) => {
  const { tokenCount, resourceMaxBatchSize } = req.body ?? {};
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 0) {
    return sendError(res, 400, "invalid_request", "tokenCount must be a non-negative integer");
  }
  try {
    const optimalBatchSize = determineOptimalBatchSize(
      tokenCount,
      { maxBatchSize: MAX_BATCH_OPERATIONS },
      resourceMaxBatchSize,
    );
    return res.json({
      ...estimateBatchClaimCosts(optimalBatchSize, { maxBatchSize: MAX_BATCH_OPERATIONS }),
      optimalBatchSize,
      remaining: tokenCount - optimalBatchSize,
    });
  } catch (error) {
    return sendError(res, 400, "invalid_request", error.message);
  }
});
