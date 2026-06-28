import { Router } from "express";
import {
  buildTx,
  addressToScVal,
  i128ToScVal,
  server,
} from "../stellar.js";
import {
  queueBatchEntry,
  getPendingBatches,
  getBatchHistory,
  updateBatchStatus,
  getBatchMetrics,
  getBatchEfficiencyMetrics,
  getBatchDistributions,
  addAuditLog,
} from "../database/index.js";
import { idempotencyMiddleware } from "../idempotency.js";
import {
  validate,
  validateContractIdMiddleware,
  parsePagination,
} from "../validation.js";
import { sendError } from "../error-response.js";
import { createRequestLogger } from "../logger.js";

export const batchQueueRouter = Router();

/**
 * POST /api/batch-queue/queue
 * Queue a secondary royalty for batch processing.
 *
 * Body: { contractId, walletAddress, token, amount }
 * Returns: { queuedBatchId, windowExpires, estimatedProcessTime }
 *
 * Batching Strategy:
 * - Royalties within a 5-minute window are combined
 * - Max 50 entries per batch to prevent unbounded queues
 * - When window expires, batch is ready for processing
 */
batchQueueRouter.post(
  "/queue",
  idempotencyMiddleware,
  validate({
    type: "object",
    properties: {
      contractId: { type: "string", minLength: 56, maxLength: 56 },
      walletAddress: { type: "string", minLength: 56, maxLength: 56 },
      token: { type: "string", minLength: 56, maxLength: 56 },
      amount: { type: "number", minimum: 0 },
    },
    required: ["contractId", "walletAddress", "token", "amount"],
    additionalProperties: false,
  }),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress, token, amount } = req.body;

      log.info("queue batch requested", { contractId, token, amount });

      // Queue the batch entry in backend
      const batchId = Math.floor(Date.now() / 1000); // Use timestamp as batch ID
      const entryId = queueBatchEntry(contractId, batchId, token, BigInt(Math.floor(amount)));

      // Calculate window expiration (5 minutes = 300 seconds from now)
      const windowExpires = Math.floor(Date.now() / 1000) + 300;

      // Log audit trail
      addAuditLog(contractId, "batch_queued", walletAddress, {
        batchId,
        token,
        amount: amount.toString(),
        entryId,
      });

      log.info("batch queued", { contractId, batchId, entryId });

      res.json({
        queuedBatchId: batchId,
        entryId,
        windowExpires,
        estimatedProcessTime: "5 minutes",
        amount,
      });
    } catch (err) {
      log.error("queue batch failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * POST /api/batch-queue/process
 * Process all pending batches that have reached window expiration.
 *
 * Body: { contractId, walletAddress }
 * Returns: { processedBatches, totalDistributed, gasEstimate }
 */
batchQueueRouter.post(
  "/process",
  idempotencyMiddleware,
  validate({
    type: "object",
    properties: {
      contractId: { type: "string", minLength: 56, maxLength: 56 },
      walletAddress: { type: "string", minLength: 56, maxLength: 56 },
    },
    required: ["contractId", "walletAddress"],
    additionalProperties: false,
  }),
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId, walletAddress } = req.body;

      log.info("process batch queue requested", { contractId });

      // Call contract to process batch queue
      const txXdr = await buildTx(walletAddress, contractId, "process_batch_queue", []);

      // Log audit trail
      addAuditLog(contractId, "batch_process_initiated", walletAddress, {
        action: "process_batch_queue",
      });

      log.info("batch queue process transaction built", { contractId });

      res.json({
        xdr: txXdr,
        action: "process_batch_queue",
        note: "Sign and submit transaction to process queued batches",
      });
    } catch (err) {
      log.error("process batch queue failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * GET /api/batch-queue/pending/:contractId
 * Get all pending batches for a contract.
 *
 * Query: { limit?, offset? }
 * Returns: { pending: [BatchEntry], count }
 */
batchQueueRouter.get(
  "/pending/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId } = req.params;
      const { limit, offset } = parsePagination(req);

      log.info("get pending batches requested", { contractId, limit, offset });

      const pending = getPendingBatches(contractId);
      const sliced = pending.slice(offset, offset + limit);

      res.json({
        pending: sliced.map((b) => ({
          id: b.id,
          batchId: b.batchId,
          token: b.token,
          totalAmount: b.totalAmount,
          status: b.status,
          retryCount: b.retryCount,
          createdAt: b.createdAt,
        })),
        count: pending.length,
        offset,
        limit,
      });
    } catch (err) {
      log.error("get pending batches failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * GET /api/batch-queue/history/:contractId
 * Get batch processing history with optional status filter.
 *
 * Query: { limit?, offset?, status? }
 * Status: 0=pending, 1=processing, 2=completed, 3=failed
 * Returns: { history: [BatchEntry], count }
 */
batchQueueRouter.get(
  "/history/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId } = req.params;
      const { limit, offset } = parsePagination(req);
      const status = req.query.status ? parseInt(req.query.status, 10) : null;

      log.info("get batch history requested", { contractId, limit, offset, status });

      const history = getBatchHistory(contractId, limit, offset, status);

      res.json({
        history: history.map((b) => ({
          id: b.id,
          batchId: b.batchId,
          token: b.token,
          totalAmount: b.totalAmount,
          status: b.status,
          retryCount: b.retryCount,
          createdAt: b.createdAt,
          processedAt: b.processedAt,
        })),
        count: history.length,
        offset,
        limit,
        statusFilter: status,
      });
    } catch (err) {
      log.error("get batch history failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * GET /api/batch-queue/metrics/:contractId
 * Get batch processing metrics and efficiency data.
 *
 * Returns: {
 *   totalBatches, completedBatches, failedBatches,
 *   totalDistributed, averageBatchSize,
 *   estimatedGasSaved, efficiency
 * }
 */
batchQueueRouter.get(
  "/metrics/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId } = req.params;

      log.info("get batch metrics requested", { contractId });

      const metrics = getBatchEfficiencyMetrics(contractId);

      res.json({
        metrics: {
          totalBatches: metrics.totalBatches,
          completedBatches: metrics.completedBatches,
          failedBatches: metrics.failedBatches,
          totalDistributed: metrics.totalDistributed.toString(),
          averageBatchSize: metrics.averageBatchSize.toString(),
          lastBatchTimestamp: metrics.lastBatchTimestamp,
          estimatedGasSaved: metrics.estimatedGasSaved.toString(),
          efficiency: {
            avgRecipientsPerBatch: metrics.efficiency.avgRecipientsPerBatch,
            estimatedSavingsPerBatch: metrics.efficiency.estimatedSavingsPerBatch,
            totalSavingsEstimate: metrics.efficiency.totalSavingsEstimate,
          },
        },
      });
    } catch (err) {
      log.error("get batch metrics failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);

/**
 * GET /api/batch-queue/distributions/:contractId
 * Get completed batch distributions with payouts.
 *
 * Query: { limit?, offset?, batchId? }
 * Returns: { distributions: [BatchDistribution], count }
 */
batchQueueRouter.get(
  "/distributions/:contractId",
  validateContractIdMiddleware,
  async (req, res, next) => {
    const log = createRequestLogger(req);
    try {
      const { contractId } = req.params;
      const { limit, offset } = parsePagination(req);
      const batchId = req.query.batchId ? parseInt(req.query.batchId, 10) : null;

      log.info("get batch distributions requested", { contractId, limit, offset, batchId });

      const distributions = getBatchDistributions(contractId, limit, offset, batchId);

      res.json({
        distributions: distributions.map((d) => ({
          id: d.id,
          batchId: d.batchId,
          totalAmount: d.totalAmount,
          collaborators: d.collaborators ? JSON.parse(d.collaborators) : [],
          transactionId: d.transactionId,
          processedAt: d.processedAt,
        })),
        count: distributions.length,
        offset,
        limit,
        batchIdFilter: batchId,
      });
    } catch (err) {
      log.error("get batch distributions failed", { error: err.message ?? String(err) });
      if (err.status) {
        return sendError(res, err.status, undefined, err.message);
      }
      next(err);
    }
  }
);
