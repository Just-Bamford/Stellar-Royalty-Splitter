import { Router } from "express";
import { z } from "zod";
import { validate, contractAddress, stellarAddress } from "../validation.js";
import { sendError } from "../error-response.js";
import { createRequestLogger } from "../logger.js";
import {
  createBatchJob,
  getBatchJob,
  getBatchJobChunks,
  getPendingChunks,
  listBatchJobs,
  markChunkProcessing,
  markChunkCompleted,
  markChunkFailed,
  getBatchMonitoringStats,
} from "../database/index.js";
import { buildAndRecordTransaction } from "./_shared.js";
import { addressToScVal, vecToScVal } from "../stellar.js";

export const batchRouter = Router();

const createBatchSchema = z.object({
  contractId: contractAddress,
  walletAddress: stellarAddress,
  tokenId: contractAddress,
  collaborators: z
    .array(stellarAddress)
    .min(1, "At least one collaborator is required")
    .max(10000, "Cannot batch more than 10000 collaborators"),
});

const resumeSchema = z.object({
  walletAddress: stellarAddress,
});

/**
 * POST /api/v1/batch-distribute
 * Enqueue a large distribution job split into chunks of 100 collaborators.
 * Body: { contractId, walletAddress, tokenId, collaborators: string[] }
 * Returns: { batchJobId, totalChunks, totalCollaborators }
 */
batchRouter.post("/", validate(createBatchSchema), async (req, res, next) => {
  const log = createRequestLogger(req);
  try {
    const { contractId, walletAddress, tokenId, collaborators } = req.body;

    log.info("batch distribute enqueued", {
      contractId,
      walletAddress,
      tokenId,
      collaborators: collaborators.length,
    });

    const batchJobId = createBatchJob(contractId, walletAddress, tokenId, collaborators);
    const job = getBatchJob(batchJobId);

    res.status(202).json({
      batchJobId,
      totalChunks: job.totalChunks,
      totalCollaborators: job.totalCollaborators,
      status: job.status,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/batch-distribute/:batchJobId
 * Get status of a batch job including per-chunk details.
 */
batchRouter.get("/:batchJobId", async (req, res) => {
  const job = getBatchJob(req.params.batchJobId);
  if (!job) return sendError(res, 404, "not_found", "Batch job not found");

  const chunks = getBatchJobChunks(job.id);
  res.json({ ...job, chunks });
});

/**
 * POST /api/v1/batch-distribute/:batchJobId/process
 * Process pending chunks of a batch job (one chunk per call, or all pending).
 * Body: { walletAddress }
 * Returns: { processed: number, failed: number }
 */
batchRouter.post("/:batchJobId/process", validate(resumeSchema), async (req, res, next) => {
  const log = createRequestLogger(req);
  const job = getBatchJob(req.params.batchJobId);
  if (!job) return sendError(res, 404, "not_found", "Batch job not found");

  const { walletAddress } = req.body;
  const chunks = getPendingChunks(job.id);
  if (chunks.length === 0) {
    return res.json({ processed: 0, failed: 0, message: "No pending chunks" });
  }

  let processed = 0;
  let failed = 0;

  for (const chunk of chunks) {
    markChunkProcessing(chunk.id);
    try {
      const collaborators = JSON.parse(chunk.collaborators);
      const scVals = collaborators.map(addressToScVal);
      const collaboratorsVec = vecToScVal(scVals);
      const tokenScVal = addressToScVal(job.tokenId);

      const { transactionId } = await buildAndRecordTransaction({
        contractId: job.contractId,
        walletAddress,
        transactionType: "distribute",
        contractMethod: "batch_distribute",
        scvlArgs: [tokenScVal, collaboratorsVec],
        auditAction: "batch_chunk_initiated",
        auditMetadata: {
          batchJobId: job.id,
          chunkIndex: chunk.chunkIndex,
          collaboratorCount: collaborators.length,
        },
        transactionMetadata: { tokenId: job.tokenId },
        correlationId: req.correlationId,
      });

      markChunkCompleted(chunk.id, transactionId);
      processed++;
      log.info("batch chunk processed", { batchJobId: job.id, chunkIndex: chunk.chunkIndex });
    } catch (err) {
      markChunkFailed(chunk.id, err.message ?? String(err));
      failed++;
      log.error("batch chunk failed", { batchJobId: job.id, chunkIndex: chunk.chunkIndex, error: err.message });
    }
  }

  const updatedJob = getBatchJob(job.id);
  res.json({ processed, failed, status: updatedJob.status });
});

/**
 * POST /api/v1/batch-distribute/:batchJobId/resume
 * Resume failed chunks of a batch job (alias for /process that only retries failed chunks).
 * Body: { walletAddress }
 */
batchRouter.post("/:batchJobId/resume", validate(resumeSchema), async (req, res, next) => {
  const log = createRequestLogger(req);
  const job = getBatchJob(req.params.batchJobId);
  if (!job) return sendError(res, 404, "not_found", "Batch job not found");
  if (!["failed", "partial"].includes(job.status)) {
    return sendError(res, 409, "invalid_state", `Job is in '${job.status}' state, only 'failed' or 'partial' jobs can be resumed`);
  }

  // Delegate to the same processing logic by forwarding to /process
  req.url = `/${req.params.batchJobId}/process`;
  return batchRouter.handle(req, res, next);
});

/**
 * GET /api/v1/batch-distribute
 * List batch jobs for a contract.
 * Query: contractId, limit, offset
 */
batchRouter.get("/", async (req, res) => {
  const { contractId, limit = 20, offset = 0 } = req.query;
  if (!contractId) return sendError(res, 400, "missing_param", "contractId query param is required");

  const jobs = listBatchJobs(contractId, Number(limit), Number(offset));
  res.json({ jobs });
});

/**
 * GET /api/v1/batch-distribute/monitoring/stats
 * Aggregate monitoring stats across all batch jobs.
 */
batchRouter.get("/monitoring/stats", async (_req, res) => {
  const stats = getBatchMonitoringStats();
  res.json(stats);
});
