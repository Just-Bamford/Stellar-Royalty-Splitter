/**
 * Background webhook retry job — closes #743.
 *
 * `webhook-delivery.js` already persists exponential-backoff retry state
 * (`retry_count`, `next_retry_time`, `payload`) onto the `webhooks` table
 * whenever a delivery attempt fails, but nothing was ever re-driving those
 * rows through delivery again. This job periodically scans for webhooks
 * whose `next_retry_time` has elapsed (via `getWebhooksDueForRetry`) and
 * re-attempts delivery using the persisted payload, following the same
 * backoff schedule and max-retry cutoff as the initial delivery path.
 *
 * Every retry attempt is appended to the delivery history (#1059) and
 * re-signed with the webhook's HMAC secret when one is configured, so the
 * status dashboard reflects retries and receivers can keep verifying
 * signatures.
 */

import crypto from "crypto";
import {
  getWebhooksDueForRetry,
  updateWebhookRetryStateWithPayload,
  resetWebhookRetryCount,
  recordDelivery,
  updateDelivery,
} from "../database/webhooks.js";
import { postWebhook, _config } from "../webhook-delivery.js";
import logger from "../logger.js";

const { BACKOFF_MS, MAX_WEBHOOK_RETRIES } = _config;

const RETRY_JOB_INTERVAL_MS = Number(process.env.WEBHOOK_RETRY_INTERVAL_MS) || 60_000; // check every 60s by default

/**
 * Rebuild signature headers for a retry attempt (#1059). The signature is
 * computed over the exact stored payload bytes so it matches what the
 * receiver would compute over the re-serialized body.
 */
export function buildRetryHeaders(secret, rawPayload, envelope) {
  const headers = {};
  if (envelope?.event) headers["X-Webhook-Event"] = envelope.event;
  if (envelope?.id) headers["X-Webhook-Id"] = envelope.id;
  if (envelope?.timestamp) headers["X-Webhook-Timestamp"] = envelope.timestamp;
  if (secret) {
    const signature = crypto.createHmac("sha256", secret).update(rawPayload ?? "", "utf8").digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }
  return headers;
}

function safeRecordDelivery(entry) {
  try {
    return recordDelivery(entry);
  } catch (err) {
    logger.warn("Failed to record webhook retry delivery", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function safeUpdateDelivery(deliveryId, fields) {
  try {
    updateDelivery(deliveryId, fields);
  } catch (err) {
    logger.warn("Failed to update webhook retry delivery", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-attempt delivery for every webhook currently due for retry.
 * Runs sequentially per webhook so one slow/hanging endpoint cannot starve
 * the others indefinitely within a single pass — each attempt still has its
 * own timeout via `postWebhook`.
 *
 * @param {Date} [now] override "now" for deterministic tests
 * @returns {Promise<{ attempted: number, succeeded: number, failed: number, exhausted: number }>}
 */
export async function executeWebhookRetryRun(now = new Date()) {
  const due = getWebhooksDueForRetry(now);

  let succeeded = 0;
  let failed = 0;
  let exhausted = 0;

  for (const webhook of due) {
    let payload;
    try {
      payload = JSON.parse(webhook.payload);
    } catch (err) {
      logger.error("Webhook retry: stored payload is not valid JSON, skipping", {
        webhookId: webhook.id,
        error: err.message,
      });
      continue;
    }

    const event = typeof payload?.event === "string" ? payload.event : "unknown";
    const headers = buildRetryHeaders(webhook.secret, webhook.payload, payload);
    const deliveryId = safeRecordDelivery({
      webhookId: webhook.id,
      contractId: webhook.contractId,
      event,
      url: webhook.url,
      payload: webhook.payload,
      status: "pending",
      attempts: (webhook.retry_count ?? 0) + 1,
    });
    const startedAt = Date.now();

    try {
      await postWebhook(webhook.url, payload, { headers });
      logger.info("Webhook retry delivered", { webhookId: webhook.id, url: webhook.url });
      resetWebhookRetryCount(webhook.id);
      if (deliveryId != null) {
        safeUpdateDelivery(deliveryId, {
          status: "delivered",
          httpStatus: 200,
          durationMs: Date.now() - startedAt,
        });
      }
      succeeded++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const retryCount = (webhook.retry_count ?? 0) + 1;
      const httpStatus = /HTTP (\d{3})/.exec(errorMessage)?.[1] ?? null;

      if (retryCount >= MAX_WEBHOOK_RETRIES) {
        // Exhausted all retries — stop scheduling further attempts by
        // clearing next_retry_time while keeping retry_count at/above the
        // max so getWebhooksDueForRetry() (retry_count < MAX) excludes it,
        // and log at error level so an admin can be alerted.
        updateWebhookRetryStateWithPayload(webhook.id, retryCount, null, webhook.payload);
        logger.error("Webhook delivery permanently failed after max retries", {
          webhookId: webhook.id,
          contractId: webhook.contractId,
          url: webhook.url,
          retryCount,
          maxRetries: MAX_WEBHOOK_RETRIES,
          error: errorMessage,
        });
        if (deliveryId != null) {
          safeUpdateDelivery(deliveryId, {
            status: "exhausted",
            httpStatus: httpStatus != null ? Number(httpStatus) : null,
            error: errorMessage,
            durationMs: Date.now() - startedAt,
          });
        }
        exhausted++;
        failed++;
        continue;
      }

      const nextRetryTime = new Date(
        now.getTime() + BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)],
      );
      updateWebhookRetryStateWithPayload(webhook.id, retryCount, nextRetryTime.toISOString(), webhook.payload);
      logger.warn("Webhook retry attempt failed, rescheduled", {
        webhookId: webhook.id,
        url: webhook.url,
        attempt: retryCount,
        maxRetries: MAX_WEBHOOK_RETRIES,
        nextRetryTime: nextRetryTime.toISOString(),
        error: errorMessage,
      });
      if (deliveryId != null) {
        safeUpdateDelivery(deliveryId, {
          status: "failed",
          httpStatus: httpStatus != null ? Number(httpStatus) : null,
          error: errorMessage,
          durationMs: Date.now() - startedAt,
        });
      }
      failed++;
    }
  }

  if (due.length > 0) {
    logger.info("Webhook retry job run completed", {
      event: "webhook_retry_job_completed",
      attempted: due.length,
      succeeded,
      failed,
      exhausted,
    });
  }

  return { attempted: due.length, succeeded, failed, exhausted };
}

let _retryTimer = null;

/**
 * Start the periodic webhook retry scheduler.
 *
 * @param {number} [intervalMs] override interval in milliseconds
 * @returns {{ stop: () => void }}
 */
export function startWebhookRetryScheduler(intervalMs = RETRY_JOB_INTERVAL_MS) {
  if (_retryTimer) {
    stopWebhookRetryScheduler();
  }

  logger.info(`Starting webhook retry scheduler (interval: ${intervalMs}ms)`, {
    event: "webhook_retry_scheduler_started",
    intervalMs,
  });

  _retryTimer = setInterval(() => {
    executeWebhookRetryRun().catch((err) => {
      logger.error("Unhandled error in scheduled webhook retry run", {
        event: "webhook_retry_scheduler_error",
        error: err.message,
      });
    });
  }, intervalMs);

  // Don't let the timer keep the process alive.
  if (_retryTimer && _retryTimer.unref) {
    _retryTimer.unref();
  }

  return {
    stop: stopWebhookRetryScheduler,
  };
}

/**
 * Stop the periodic webhook retry scheduler.
 */
export function stopWebhookRetryScheduler() {
  if (_retryTimer) {
    clearInterval(_retryTimer);
    _retryTimer = null;
    logger.info("Webhook retry scheduler stopped", { event: "webhook_retry_scheduler_stopped" });
  }
}
