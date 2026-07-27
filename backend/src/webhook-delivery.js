/**
 * Deliver distribute-completion webhooks (#295).
 * Failed deliveries are persisted to the database for retry by the
 * background retry job (retry-failed-webhooks.js).
 */

import { listWebhooks, updateWebhookRetryStateWithPayload, resetWebhookRetryCount } from "./database/webhooks.js";
import logger from "./logger.js";
import { parsePositiveInt } from "./utils.js";

const WEBHOOK_TIMEOUT_MS = parsePositiveInt(process.env.WEBHOOK_TIMEOUT_MS, 10_000);

const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const MAX_WEBHOOK_RETRIES = 4;

export async function postWebhook(url, payload) {
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

/**
 * Fire distribute-completion webhooks for a confirmed transaction.
 * Runs asynchronously; errors are logged but do not block the caller.
 * Failed deliveries are persisted to the database for background retry.
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

  const now = new Date();

  for (const webhook of webhooks) {
    postWebhook(webhook.url, payload)
      .then(() => {
        logger.info("Webhook delivered", { url: webhook.url });
        resetWebhookRetryCount(webhook.id);
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const retryCount = (webhook.retry_count ?? 0) + 1;
        const nextRetryTime = new Date(now.getTime() + BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)]);

        logger.warn("Webhook delivery failed, scheduled for retry", {
          url: webhook.url,
          attempt: retryCount,
          maxRetries: MAX_WEBHOOK_RETRIES,
          nextRetryTime: nextRetryTime.toISOString(),
          error: errorMessage,
        });

        updateWebhookRetryStateWithPayload(webhook.id, retryCount, nextRetryTime.toISOString(), JSON.stringify(payload));

        if (retryCount >= MAX_WEBHOOK_RETRIES) {
          logger.error("Webhook delivery exhausted all retries", {
            url: webhook.url,
            webhookId: webhook.id,
            contractId: webhook.contractId,
            retryCount,
          });
        }
      });
  }
}

export const _config = {
  WEBHOOK_TIMEOUT_MS,
  MAX_WEBHOOK_RETRIES,
  BACKOFF_MS,
};
