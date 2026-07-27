/**
 * Background job: Retry failed webhook deliveries with exponential backoff.
 *
 * Retry strategy:
 *   - Scans for webhooks with retry_count < 4 and next_retry_time <= now
 *   - Exponential backoff: 1m, 5m, 15m, 1h between retries
 *   - Each retry attempt is logged and persisted to the database
 *   - On success, retry state is reset
 *   - After 4 failed retries, admin is notified via email
 *
 * Retry state persistence:
 *   - retry_count and next_retry_time are persisted in the webhooks table
 *   - On restart, the job picks up where it left off (no in-memory state needed)
 *   - Status transitions: retry_count incremented, next_retry_time set on failure
 */

import { getWebhooksDueForRetry, updateWebhookRetryState, resetWebhookRetryCount } from "../database/webhooks.js";
import { postWebhook } from "../webhook-delivery.js";
import { sendEmail, isEmailConfigured } from "../email/email-service.js";
import { addAuditLog } from "../database/index.js";
import logger from "../logger.js";
import { parsePositiveInt } from "../utils.js";

/** How often the scheduler checks for retry-eligible webhooks (default 30s). */
const RETRY_CHECK_INTERVAL_MS = parsePositiveInt(
  process.env.RETRY_CHECK_INTERVAL_MS,
  30_000
);

const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const MAX_WEBHOOK_RETRIES = 4;

/** Track which webhooks we've already alerted on to avoid duplicate notifications. */
const alertedExhaustedIds = new Set();

/**
 * Send admin alert that a webhook delivery has exhausted all retries.
 */
export async function sendWebhookRetryExhaustedAlert(webhook) {
  const adminEmail = process.env.ADMIN_ALERT_EMAIL;

  logger.error("Webhook retry exhausted — all 4 retries failed", {
    event: "webhook_retry_exhausted",
    webhookId: webhook.id,
    contractId: webhook.contractId,
    url: webhook.url,
    retryCount: webhook.retry_count,
  });

  if (!adminEmail) {
    logger.warn("ADMIN_ALERT_EMAIL not configured; skipping webhook retry-exhausted email notification", {
      webhookId: webhook.id,
    });
    return { sent: false, reason: "admin_email_not_configured" };
  }

  if (!isEmailConfigured()) {
    logger.warn("SMTP not configured; skipping webhook retry-exhausted email notification", {
      webhookId: webhook.id,
    });
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = `[ALERT] Webhook retry exhausted — Contract ${webhook.contractId}`;
  const text = [
    `A webhook delivery has failed all ${MAX_WEBHOOK_RETRIES} retry attempts.`,
    ``,
    `Webhook ID: ${webhook.id}`,
    `Contract ID: ${webhook.contractId}`,
    `Webhook URL: ${webhook.url}`,
    `Retry Count: ${webhook.retry_count}`,
    `Last Retry Time: ${webhook.next_retry_time ?? "N/A"}`,
    ``,
    `Manual intervention is required.`,
  ].join("\n");

  const html = `
    <h2>⚠️ Webhook Retry Exhausted</h2>
    <p>A webhook delivery has failed all <strong>${MAX_WEBHOOK_RETRIES}</strong> retry attempts and requires manual intervention.</p>
    <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">
      <tr><td><strong>Webhook ID</strong></td><td>${webhook.id}</td></tr>
      <tr><td><strong>Contract ID</strong></td><td>${webhook.contractId}</td></tr>
      <tr><td><strong>Webhook URL</strong></td><td>${webhook.url}</td></tr>
      <tr><td><strong>Retry Count</strong></td><td>${webhook.retry_count}</td></tr>
      <tr><td><strong>Last Retry Time</strong></td><td>${webhook.next_retry_time ?? "N/A"}</td></tr>
    </table>
    <p>Please investigate and resolve this issue manually.</p>
  `;

  try {
    const result = await sendEmail({ to: adminEmail, subject, html, text });
    if (result.sent) {
      logger.info("Webhook retry-exhausted alert email sent", {
        webhookId: webhook.id,
        adminEmail,
      });
    }
    return result;
  } catch (error) {
    logger.error("Failed to send webhook retry-exhausted alert email", {
      webhookId: webhook.id,
      error: error.message,
    });
    return { sent: false, reason: error.message };
  }
}

/**
 * Attempt to retry a single failed webhook delivery.
 * Returns the outcome: 'retried', 'exhausted', or 'error'.
 */
export async function retryWebhookDelivery(webhook, now = new Date()) {
  const retryNumber = webhook.retry_count + 1;
  const backoffMs = BACKOFF_MS[webhook.retry_count] ?? BACKOFF_MS[BACKOFF_MS.length - 1];

  logger.info("Retrying failed webhook delivery", {
    event: "webhook_retry_attempt",
    webhookId: webhook.id,
    contractId: webhook.contractId,
    url: webhook.url,
    retryNumber,
    maxRetries: MAX_WEBHOOK_RETRIES,
    backoffMs,
  });

  // Log the retry attempt to audit trail
  addAuditLog(webhook.contractId, "webhook_retry_attempt", "system", {
    webhookId: webhook.id,
    url: webhook.url,
    retryNumber,
    maxRetries: MAX_WEBHOOK_RETRIES,
    backoffMs,
  });

  try {
    const payload = webhook.payload ? JSON.parse(webhook.payload) : {
      event: "distribute.confirmed",
      contractId: webhook.contractId,
      timestamp: now.toISOString(),
    };

    await postWebhook(webhook.url, payload);

    // Delivery succeeded — reset retry state
    resetWebhookRetryCount(webhook.id);

    addAuditLog(webhook.contractId, "webhook_retry_succeeded", "system", {
      webhookId: webhook.id,
      url: webhook.url,
      retryNumber,
    });

    logger.info("Webhook retry succeeded", {
      event: "webhook_retry_succeeded",
      webhookId: webhook.id,
      retryNumber,
    });

    return "retried";
  } catch (error) {
    const errorMessage = error?.message ?? String(error);

    // Delivery failed — update retry metadata
    const newRetryCount = retryNumber;
    const nextRetryTime = new Date(now.getTime() + (BACKOFF_MS[Math.min(newRetryCount, BACKOFF_MS.length - 1)]));

    updateWebhookRetryState(webhook.id, newRetryCount, nextRetryTime.toISOString());

    addAuditLog(webhook.contractId, "webhook_retry_failed", "system", {
      webhookId: webhook.id,
      url: webhook.url,
      retryNumber,
      error: errorMessage,
    });

    logger.warn("Webhook retry failed", {
      event: "webhook_retry_failed",
      webhookId: webhook.id,
      retryNumber,
      error: errorMessage,
    });

    // Check if all retries are now exhausted
    if (newRetryCount >= MAX_WEBHOOK_RETRIES) {
      const exhaustedWebhook = {
        ...webhook,
        retry_count: newRetryCount,
        next_retry_time: nextRetryTime.toISOString(),
      };

      if (!alertedExhaustedIds.has(webhook.id)) {
        alertedExhaustedIds.add(webhook.id);
        await sendWebhookRetryExhaustedAlert(exhaustedWebhook);

        addAuditLog(webhook.contractId, "webhook_retry_exhausted", "system", {
          webhookId: webhook.id,
          url: webhook.url,
          totalRetries: newRetryCount,
          finalError: errorMessage,
          adminNotified: true,
        });
      }

      return "exhausted";
    }

    return "error";
  }
}

/**
 * Main retry job: scan for eligible webhooks and retry them.
 * Called periodically by the scheduler.
 *
 * @param {Date} [now] - Current time (injectable for testing)
 * @returns {Object} Summary of what was processed
 */
export async function retryFailedWebhooks(now = new Date()) {
  const eligible = getWebhooksDueForRetry(now);

  if (eligible.length === 0) {
    return { processed: 0, retried: 0, exhausted: 0, errors: 0 };
  }

  logger.info("Found retry-eligible failed webhooks", {
    count: eligible.length,
  });

  let retried = 0;
  let exhausted = 0;
  let errors = 0;

  for (const webhook of eligible) {
    try {
      const outcome = await retryWebhookDelivery(webhook, now);
      if (outcome === "retried") retried++;
      else if (outcome === "exhausted") exhausted++;
      else errors++;
    } catch (error) {
      errors++;
      logger.error("Unexpected error processing webhook retry", {
        webhookId: webhook.id,
        error: error.message,
      });
    }
  }

  const result = { processed: eligible.length, retried, exhausted, errors };
  logger.info("Webhook retry job completed", result);
  return result;
}

/**
 * Start the webhook retry scheduler. Returns a stop function.
 */
export function startWebhookRetryScheduler() {
  logger.info("Starting webhook retry scheduler", {
    intervalMs: RETRY_CHECK_INTERVAL_MS,
    maxRetries: MAX_WEBHOOK_RETRIES,
    backoffMs: BACKOFF_MS,
  });

  const interval = setInterval(async () => {
    try {
      await retryFailedWebhooks();
    } catch (error) {
      logger.error("Webhook retry scheduler error", { error: error.message });
    }
  }, RETRY_CHECK_INTERVAL_MS);

  // Don't block process exit on this timer
  interval.unref();

  return {
    stop() {
      clearInterval(interval);
      logger.info("Webhook retry scheduler stopped");
    },
    interval,
  };
}

/** Reset internal state (for tests). */
export function _resetAlertedExhaustedIds() {
  alertedExhaustedIds.clear();
}

export const _config = {
  RETRY_CHECK_INTERVAL_MS,
  MAX_WEBHOOK_RETRIES,
  BACKOFF_MS,
};