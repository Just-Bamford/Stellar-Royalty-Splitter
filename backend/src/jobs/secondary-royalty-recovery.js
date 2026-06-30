/**
 * Recovery job for failed secondary royalty distributions.
 * Processes items from the retry queue with exponential backoff and
 * moves permanently failed items to the dead-letter queue.
 */

import {
  getReadyRetryItems,
  updateRetryItem,
  removeFromRetryQueue,
  moveToDeadLetterQueue,
  commitSecondaryDistributionAtomic,
} from "../database/index.js";
import { buildTx, addressToScVal } from "../stellar.js";
import logger from "../logger.js";

const MAX_RETRIES = 5;
const RETRY_BATCH_SIZE = 10;
const RETRY_INTERVAL_MS = 5000; // Check every 5 seconds

let recoveryInterval = null;
let isRunning = false;

/**
 * Process a single retry item.
 * Attempts to rebuild the transaction and commit it atomically.
 */
async function processRetryItem(item) {
  const {
    id,
    contractId,
    walletAddress,
    tokenId,
    collaborators,
    totalRoyalties,
    numberOfSales,
    pendingSaleIds,
    totalDustAllocated,
    dustAuditData,
    retryCount,
  } = item;

  try {
    // Rebuild the Stellar XDR
    const txXdr = await buildTx(walletAddress, contractId, "distribute_secondary_royalties", [
      addressToScVal(tokenId),
    ]);

    // Commit the distribution atomically
    const transactionId = commitSecondaryDistributionAtomic({
      contractId,
      walletAddress,
      totalRoyalties: BigInt(totalRoyalties),
      numberOfSales,
      pendingSaleIds,
      totalDustAllocated: BigInt(totalDustAllocated),
      dustAuditData,
    });

    // Success - remove from retry queue
    removeFromRetryQueue(id);

    logger.info("Secondary royalty distribution recovery succeeded", {
      contractId,
      tokenId,
      retryCount,
      transactionId,
    });

    return { success: true, transactionId };
  } catch (error) {
    const errorMessage = error.message || String(error);

    if (retryCount >= MAX_RETRIES) {
      // Max retries reached - move to dead-letter queue
      moveToDeadLetterQueue(id, "max_retries_exceeded");
      logger.error("Secondary royalty distribution max retries exceeded, moved to DLQ", {
        contractId,
        tokenId,
        retryCount,
        error: errorMessage,
      });
      return { success: false, movedToDlq: true };
    }

    // Update retry item with new error and schedule next retry
    updateRetryItem(id, errorMessage);

    logger.warn("Secondary royalty distribution retry failed, will retry later", {
      contractId,
      tokenId,
      retryCount,
      error: errorMessage,
    });

    return { success: false, willRetry: true };
  }
}

/**
 * Process all ready retry items in a batch.
 */
async function processRetryBatch() {
  if (isRunning) {
    logger.debug("Recovery job already running, skipping this cycle");
    return;
  }

  isRunning = true;

  try {
    const items = getReadyRetryItems(RETRY_BATCH_SIZE);

    if (items.length === 0) {
      logger.debug("No items ready for retry");
      return;
    }

    logger.info(`Processing ${items.length} retry items`);

    const results = await Promise.allSettled(
      items.map((item) => processRetryItem(item))
    );

    const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.success).length;
    const willRetry = results.filter((r) => r.status === "fulfilled" && r.value.willRetry).length;
    const movedToDlq = results.filter((r) => r.status === "fulfilled" && r.value.movedToDlq).length;
    const failed = results.filter((r) => r.status === "rejected").length;

    logger.info("Retry batch processing complete", {
      total: items.length,
      succeeded,
      willRetry,
      movedToDlq,
      failed,
    });
  } catch (error) {
    logger.error("Error processing retry batch", {
      error: error.message || String(error),
    });
  } finally {
    isRunning = false;
  }
}

/**
 * Start the recovery job.
 * Runs on an interval to process ready retry items.
 */
export function startRecoveryJob() {
  if (recoveryInterval) {
    logger.warn("Recovery job already running");
    return;
  }

  logger.info("Starting secondary royalty recovery job", {
    intervalMs: RETRY_INTERVAL_MS,
    batchSize: RETRY_BATCH_SIZE,
    maxRetries: MAX_RETRIES,
  });

  recoveryInterval = setInterval(processRetryBatch, RETRY_INTERVAL_MS);

  // Process immediately on startup
  processRetryBatch();
}

/**
 * Stop the recovery job.
 */
export function stopRecoveryJob() {
  if (recoveryInterval) {
    clearInterval(recoveryInterval);
    recoveryInterval = null;
    logger.info("Stopped secondary royalty recovery job");
  }
}

/**
 * Manually trigger a retry batch processing.
 * Useful for testing or manual intervention.
 */
export async function triggerManualRetry() {
  logger.info("Manual retry triggered");
  return processRetryBatch();
}

// Auto-start on module import if not in test mode
if (process.env.NODE_ENV !== "test" && !process.env.DISABLE_RECOVERY_JOB) {
  startRecoveryJob();
}

// Graceful shutdown
process.on("SIGTERM", stopRecoveryJob);
process.on("SIGINT", stopRecoveryJob);
