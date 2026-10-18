/**
 * Deliver distribute-completion webhooks (#295).
 * Failed deliveries are persisted to the database for retry by the
 * background retry job (retry-failed-webhooks.js).
 */

import { createHmac } from "crypto";
import { listWebhooks, updateWebhookRetryStateWithPayload, resetWebhookRetryCount, moveToDlq } from "./database/webhooks.js";
import logger from "./logger.js";
import { parsePositiveInt } from "./utils.js";

const WEBHOOK_TIMEOUT_MS = parsePositiveInt(process.env.WEBHOOK_TIMEOUT_MS, 10_000);

const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const MAX_WEBHOOK_RETRIES = 4;

/**
 * Compute an HMAC-SHA256 signature over the exact JSON body bytes.
 * Returns a "sha256=<hex>" string following the convention used by GitHub,
 * Stripe, and others so receivers can verify with a standard one-liner.
 *
 * @param {string} body   - Serialised JSON string that will be sent as the body.
 * @param {string} secret - Webhook's stored signing secret.
 * @returns {string}        e.g. "sha256=abc123..."
 */
export function computeWebhookSignature(body, secret) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export async function postWebhook(url, payload, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  // Serialise once so the bytes used for the HMAC match the body exactly (#1141).
  const body = JSON.stringify(payload);

  // Build signature header when a secret is supplied; skip for legacy rows
  // with no stored secret so existing callers are unaffected.
  const signatureHeaders = {};
  if (options.secret) {
    signatureHeaders["X-Webhook-Signature"] = computeWebhookSignature(body, options.secret);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Stellar-Royalty-Splitter/1.0",
        ...signatureHeaders,
        ...(options.headers ?? {}),
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }

    return response;
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
    postWebhook(webhook.url, payload, { secret: webhook.secret ?? null })
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
          logger.error("Webhook delivery exhausted all retries, moving to DLQ", {
            url: webhook.url,
            webhookId: webhook.id,
            contractId: webhook.contractId,
            retryCount,
          });

          try {
            moveToDlq(webhook.id, webhook.url, webhook.contractId, JSON.stringify(payload), errorMessage, retryCount);
          } catch (dlqErr) {
            logger.error("Failed to move webhook to DLQ", {
              webhookId: webhook.id,
              error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
            });
          }
        }
      });
  }
}

export const _config = {
  WEBHOOK_TIMEOUT_MS,
  MAX_WEBHOOK_RETRIES,
  BACKOFF_MS,
};
