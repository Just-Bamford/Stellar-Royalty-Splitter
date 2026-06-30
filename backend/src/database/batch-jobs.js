import { db, countWrite } from "./core.js";

export const BATCH_SIZE = 100;

/**
 * Create a new batch distribution job.
 * Splits collaborators into chunks of BATCH_SIZE and creates one batch_job row
 * plus N batch_job_chunks rows.
 *
 * @returns {string} batchJobId
 */
export function createBatchJob(contractId, walletAddress, tokenId, collaborators) {
  const batchJobId = crypto.randomUUID();
  const totalChunks = Math.ceil(collaborators.length / BATCH_SIZE);

  const insertJob = db.prepare(`
    INSERT INTO batch_jobs (id, contractId, walletAddress, tokenId, totalCollaborators, totalChunks, status, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', CURRENT_TIMESTAMP)
  `);

  const insertChunk = db.prepare(`
    INSERT INTO batch_job_chunks (batchJobId, chunkIndex, collaborators, status, createdAt)
    VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `);

  db.transaction(() => {
    insertJob.run(batchJobId, contractId, walletAddress, tokenId, collaborators.length, totalChunks);
    for (let i = 0; i < totalChunks; i++) {
      const chunk = collaborators.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
      insertChunk.run(batchJobId, i, JSON.stringify(chunk));
    }
  })();

  countWrite();
  return batchJobId;
}

/** Get a batch job by ID. */
export function getBatchJob(batchJobId) {
  return db.prepare("SELECT * FROM batch_jobs WHERE id = ?").get(batchJobId);
}

/** List batch jobs for a contract (newest first). */
export function listBatchJobs(contractId, limit = 20, offset = 0) {
  return db
    .prepare("SELECT * FROM batch_jobs WHERE contractId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?")
    .all(contractId, limit, offset);
}

/** Get all chunks for a batch job. */
export function getBatchJobChunks(batchJobId) {
  return db
    .prepare("SELECT * FROM batch_job_chunks WHERE batchJobId = ? ORDER BY chunkIndex ASC")
    .all(batchJobId);
}

/** Get pending/failed chunks ready to process (for resume). */
export function getPendingChunks(batchJobId) {
  return db
    .prepare(`SELECT * FROM batch_job_chunks WHERE batchJobId = ? AND status IN ('pending', 'failed') ORDER BY chunkIndex ASC`)
    .all(batchJobId);
}

/** Mark a chunk as processing. */
export function markChunkProcessing(chunkId) {
  db.prepare("UPDATE batch_job_chunks SET status = 'processing', startedAt = CURRENT_TIMESTAMP WHERE id = ?").run(chunkId);
  countWrite();
}

/** Mark a chunk as completed. */
export function markChunkCompleted(chunkId, transactionId) {
  db.prepare(`UPDATE batch_job_chunks SET status = 'completed', transactionId = ?, completedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(transactionId, chunkId);
  _refreshJobStatus(db.prepare("SELECT batchJobId FROM batch_job_chunks WHERE id = ?").get(chunkId)?.batchJobId);
  countWrite();
}

/** Mark a chunk as failed. */
export function markChunkFailed(chunkId, errorMessage) {
  db.prepare(`UPDATE batch_job_chunks SET status = 'failed', errorMessage = ?, completedAt = CURRENT_TIMESTAMP WHERE id = ?`).run(errorMessage, chunkId);
  _refreshJobStatus(db.prepare("SELECT batchJobId FROM batch_job_chunks WHERE id = ?").get(chunkId)?.batchJobId);
  countWrite();
}

/** Recompute and update the parent batch_job status from chunk statuses. */
function _refreshJobStatus(batchJobId) {
  if (!batchJobId) return;
  const chunks = db.prepare("SELECT status FROM batch_job_chunks WHERE batchJobId = ?").all(batchJobId);
  const statuses = chunks.map((c) => c.status);
  let jobStatus;
  if (statuses.every((s) => s === "completed")) {
    jobStatus = "completed";
  } else if (statuses.some((s) => s === "processing" || s === "pending")) {
    jobStatus = "processing";
  } else if (statuses.every((s) => s === "failed")) {
    jobStatus = "failed";
  } else {
    // mixed completed/failed
    jobStatus = "partial";
  }
  const completedChunks = statuses.filter((s) => s === "completed").length;
  const completedAt = jobStatus === "completed" || jobStatus === "partial" || jobStatus === "failed"
    ? "CURRENT_TIMESTAMP"
    : "NULL";
  db.prepare(`
    UPDATE batch_jobs SET status = ?, completedChunks = ?, completedAt = ${completedAt} WHERE id = ?
  `).run(jobStatus, completedChunks, batchJobId);
}

/** Get monitoring stats (counts by status). */
export function getBatchMonitoringStats() {
  const jobStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM batch_jobs GROUP BY status
  `).all();
  const chunkStats = db.prepare(`
    SELECT status, COUNT(*) as count FROM batch_job_chunks GROUP BY status
  `).all();
  return { jobs: jobStats, chunks: chunkStats };
}
