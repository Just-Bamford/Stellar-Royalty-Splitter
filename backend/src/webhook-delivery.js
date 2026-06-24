/**
 * Deliver distribute-completion webhooks with retry logic and dead-letter queue (#295, #401).
 */

import {
  listWebhooks,
  enqueueDeadLetter,
  listAllPendingDeadLetters,
  markDeadLetterRetried,
} from "./database/webhooks.js";
import logger from "./logger.js";

function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WEBHOOK_MAX_RETRIES = parsePositiveInt(process.env.WEBHOOK_MAX_RETRIES, 3);
const WEBHOOK_RETRY_BASE_MS = parsePositiveInt(process.env.WEBHOOK_RETRY_BASE_MS, 1000);
const WEBHOOK_TIMEOUT_MS = parsePositiveInt(process.env.WEBHOOK_TIMEOUT_MS, 10_000);
const RETRY_SCHEDULER_INTERVAL_MS = parsePositiveInt(
  process.env.WEBHOOK_RETRY_SCHEDULER_MS,
  5 * 60 * 1000, // 5 minutes
);

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

async function deliverWithRetry(url, payload) {
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    try {
      await postWebhook(url, payload);
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
        const message = error instanceof Error ? error.message : String(error);
        logger.error("Webhook delivery exhausted retries", { url });
        return { success: false, error: message };
      }

      const delay = WEBHOOK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
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
 * Returns the interval handle so callers can stop it (e.g. on shutdown).
 */
export function startWebhookRetryScheduler() {
  const handle = setInterval(async () => {
    const pending = listAllPendingDeadLetters(50);
    if (pending.length === 0) return;

    logger.info("Webhook retry scheduler: processing dead letters", { count: pending.length });

    for (const entry of pending) {
      let payload;
      try {
        payload = JSON.parse(entry.payload);
      } catch {
        markDeadLetterRetried(entry.id, false);
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
  WEBHOOK_MAX_RETRIES,
  WEBHOOK_RETRY_BASE_MS,
  WEBHOOK_TIMEOUT_MS,
  RETRY_SCHEDULER_INTERVAL_MS,
};
