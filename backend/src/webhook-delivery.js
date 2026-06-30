/**
 * Deliver distribute-completion webhooks with retry logic and dead-letter queue (#295, #401, #428).
 */

import {
  listWebhooks,
  enqueueDeadLetter,
  listAllPendingDeadLetters,
  markDeadLetterRetried,
  deleteOldDeadLetters,
} from "./database/webhooks.js";
import logger from "./logger.js";

function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// #428: Maximum number of delivery attempts before a webhook is permanently
// moved to the dead-letter queue and retrying stops.
const WEBHOOK_MAX_ATTEMPTS = parsePositiveInt(process.env.WEBHOOK_MAX_ATTEMPTS, 3);
const WEBHOOK_MAX_RETRIES = parsePositiveInt(process.env.WEBHOOK_MAX_RETRIES, 3);
const WEBHOOK_RETRY_BASE_MS = parsePositiveInt(process.env.WEBHOOK_RETRY_BASE_MS, 1000);
const WEBHOOK_TIMEOUT_MS = parsePositiveInt(process.env.WEBHOOK_TIMEOUT_MS, 10_000);
const RETRY_SCHEDULER_INTERVAL_MS = parsePositiveInt(
  process.env.WEBHOOK_RETRY_SCHEDULER_MS,
  5 * 60 * 1000, // 5 minutes
);
// #428: Dead-letter records older than this many days are purged on each scheduler tick.
const DLQ_RETENTION_DAYS = parsePositiveInt(process.env.WEBHOOK_DLQ_RETENTION_DAYS, 30);

// #464: Delivery metrics — cumulative counters since process start.
const _metrics = { successCount: 0, failureCount: 0, totalAttempts: 0 };

export function getDeliveryMetrics() {
  return { ..._metrics };
}

export function _resetDeliveryMetrics() {
  _metrics.successCount = 0;
  _metrics.failureCount = 0;
  _metrics.totalAttempts = 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postWebhook(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Stellar-Royalty-Splitter/1.0",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Exported so admin routes can manually retry individual DLQ entries (#428)
export async function deliverWithRetry(url, payload) {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    _metrics.totalAttempts++;
    try {
      await postWebhook(url, payload);
      _metrics.successCount++;
      logger.info("Webhook delivered", { url, attempt });
      return { success: true };
    } catch (error) {
      const isLastAttempt = attempt === WEBHOOK_MAX_RETRIES;
      logger.warn("Webhook delivery failed", {
        url,
        attempt,
        maxRetries: WEBHOOK_MAX_RETRIES,
        error: error instanceof Error ? error.message : String(error),
      });

      if (isLastAttempt) {
        _metrics.failureCount++;
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Webhook delivery exhausted retries", { url });
        return { success: false, error: message };
      }

      const delay = WEBHOOK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  _metrics.failureCount++;
  return { success: false, error: "Unknown failure" };
}

/**
 * Fire distribute-completion webhooks for a confirmed transaction.
 * Runs asynchronously; failed webhooks are written to the dead-letter queue.
 */
export function deliverDistributeWebhooks(transaction) {
  const webhooks = listWebhooks(transaction.contractId);
  if (webhooks.length === 0) {
    return;
  }

  const payload = {
    event: "distribute.confirmed",
    transactionHash: transaction.txHash,
    contractId: transaction.contractId,
    tokenId: transaction.tokenId,
    requestedAmount: transaction.requestedAmount,
    status: transaction.status,
    recipients: (transaction.payouts ?? []).map((payout) => ({
      address: payout.collaboratorAddress,
      amount: payout.amountReceived,
    })),
    timestamp: transaction.blockTime ?? transaction.timestamp,
  };

  for (const webhook of webhooks) {
    deliverWithRetry(webhook.url, payload)
      .then((result) => {
        if (!result.success) {
          enqueueDeadLetter(
            webhook.id,
            transaction.contractId,
            webhook.url,
            payload,
            result.error ?? "Delivery failed",
          );
        }
      })
      .catch((error) => {
        logger.error("Unexpected webhook delivery error", {
          url: webhook.url,
          error: error instanceof Error ? error.message : String(error),
        });
        enqueueDeadLetter(
          webhook.id,
          transaction.contractId,
          webhook.url,
          payload,
          error instanceof Error ? error.message : String(error),
        );
      });
  }
}

/**
 * Retry scheduler: processes dead-letter queue entries every 5 minutes.
 * #428: Stops retrying entries that have reached WEBHOOK_MAX_ATTEMPTS.
 * #428: Purges DLQ records older than DLQ_RETENTION_DAYS days on each tick.
 * Returns the interval handle so callers can stop it (e.g. on shutdown).
 */
export function startWebhookRetryScheduler() {
  const handle = setInterval(async () => {
    // #428: Clean up stale dead-letter records first (>30 days by default)
    try {
      const cleaned = deleteOldDeadLetters(DLQ_RETENTION_DAYS);
      if (cleaned > 0) {
        logger.info("Webhook DLQ: purged old records", { count: cleaned, retentionDays: DLQ_RETENTION_DAYS });
      }
    } catch (err) {
      logger.error("Webhook DLQ: error purging old records", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pending = listAllPendingDeadLetters(50);
    if (pending.length === 0) return;

    logger.info("Webhook retry scheduler: processing dead letters", { count: pending.length });

    for (const entry of pending) {
      // #428: Respect max_attempts — if this entry has already been retried the
      // maximum number of times, log and skip rather than retrying forever.
      if (entry.retryCount >= WEBHOOK_MAX_ATTEMPTS) {
        logger.error("Webhook DLQ: max attempts reached, giving up", {
          id: entry.id,
          url: entry.url,
          retryCount: entry.retryCount,
          maxAttempts: WEBHOOK_MAX_ATTEMPTS,
          lastError: entry.errorMessage,
        });
        // Mark as permanently failed (succeeded=false will increment retryCount
        // one final time so it stays above the threshold and won't be retried again).
        markDeadLetterRetried(entry.id, false, /* permanent */ true);
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(entry.payload);
      } catch {
        logger.warn("Webhook DLQ: invalid payload JSON, marking as permanently failed", { id: entry.id });
        markDeadLetterRetried(entry.id, false, /* permanent */ true);
        continue;
      }

      const result = await deliverWithRetry(entry.url, payload).catch((err) => ({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }));

      markDeadLetterRetried(entry.id, result.success);
      logger.info("Dead letter retry", { id: entry.id, url: entry.url, success: result.success });
    }
  }, RETRY_SCHEDULER_INTERVAL_MS);

  return handle;
}

export const _config = {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_TIMEOUT_MS,
  RETRY_SCHEDULER_INTERVAL_MS,
  DLQ_RETENTION_DAYS,
};
