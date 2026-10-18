/**
 * Advanced webhook manager for external integrations (#1059).
 *
 * Central hub for event-driven outbound webhooks:
 *  - registration with per-webhook event subscriptions + HMAC secret
 *  - real-time delivery via HTTP POST with HMAC-SHA256 signatures
 *  - automatic retry with exponential backoff (shared schedule with
 *    webhook-delivery.js / retry-failed-webhooks.js)
 *  - persistent delivery history + per-contract stats for the dashboard
 *
 * Supported event names:
 *  - distribution.completed   (primary + secondary distributions)
 *  - distribute.confirmed     (legacy alias, kept for backwards compat)
 *  - dispute.created / dispute.resolved
 *  - governance.vote.started / governance.vote.ended
 *  - contract.status.changed
 */

import crypto from "crypto";
import {
  registerWebhook as dbRegisterWebhook,
  getWebhookById,
  listWebhooks,
  listWebhooksForEvent,
  deleteWebhook as dbDeleteWebhook,
  updateWebhookRetryStateWithPayload,
  resetWebhookRetryCount,
  moveToDlq,
  recordDelivery,
  updateDelivery,
  listDeliveries,
  countDeliveries,
  getDeliveryStats,
  parseEvents,
} from "../database/webhooks.js";
import { postWebhook as basePostWebhook, _config } from "../webhook-delivery.js";
import logger from "../logger.js";

export const WEBHOOK_EVENTS = Object.freeze([
  "distribution.completed",
  "distribute.confirmed",
  "dispute.created",
  "dispute.resolved",
  "governance.vote.started",
  "governance.vote.ended",
  "contract.status.changed",
]);

/** Events a newly registered webhook subscribes to when none are given. */
export const DEFAULT_SUBSCRIBED_EVENTS = Object.freeze([...WEBHOOK_EVENTS]);

const { BACKOFF_MS, MAX_WEBHOOK_RETRIES } = _config;

export function isSupportedEvent(event) {
  return WEBHOOK_EVENTS.includes(event);
}

export function normalizeEvents(events) {
  if (events == null) return null;
  if (!Array.isArray(events)) {
    throw new Error("events must be an array of event names");
  }
  const invalid = events.filter((e) => !isSupportedEvent(e));
  if (invalid.length > 0) {
    throw new Error(`Unsupported webhook event(s): ${invalid.join(", ")}`);
  }
  const unique = [...new Set(events)];
  return unique.length === 0 ? null : unique;
}

export function generateWebhookSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Sign a raw request body with the webhook's HMAC-SHA256 secret.
 * Returns the hex digest. `secret` may be null (unsigned delivery).
 */
export function signPayload(secret, rawBody) {
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Verify an inbound `X-Webhook-Signature` value against the expected HMAC.
 * Uses a constant-time comparison to avoid timing side channels.
 */
export function verifyWebhookSignature(secret, rawBody, signature) {
  if (!secret || !signature) return false;
  const expected = signPayload(secret, rawBody);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(String(signature), "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function buildEnvelope({ contractId, event, data }) {
  return {
    id: crypto.randomUUID(),
    event,
    contractId,
    timestamp: new Date().toISOString(),
    data: data ?? {},
  };
}

function headersFor(secret, envelope, rawBody) {
  const headers = {
    "X-Webhook-Event": envelope.event,
    "X-Webhook-Id": envelope.id,
    "X-Webhook-Timestamp": envelope.timestamp,
  };
  const signature = signPayload(secret, rawBody);
  if (signature) {
    headers["X-Webhook-Signature"] = `sha256=${signature}`;
  }
  return headers;
}

/**
 * POST a pre-built envelope to a URL with signature headers.
 * Records timing so callers can persist delivery history.
 */
export async function deliverToUrl(url, envelope, secret) {
  const rawBody = JSON.stringify(envelope);
  const headers = headersFor(secret, envelope, rawBody);
  const startedAt = Date.now();
  await basePostWebhook(url, envelope, { headers });
  return { durationMs: Date.now() - startedAt, rawBody };
}

/**
 * Register a webhook for a contract.
 * Generates a per-webhook HMAC secret (returned once — callers must store
 * it; it is never exposed again via list endpoints).
 */
export function registerAdvancedWebhook(contractId, url, events = null) {
  const normalized = normalizeEvents(events);
  const secret = generateWebhookSecret();
  const webhookId = dbRegisterWebhook(contractId, url, normalized, secret);
  logger.info("Advanced webhook registered", { contractId, url, webhookId, events: normalized });
  return { webhookId, url, events: normalized ?? [...DEFAULT_SUBSCRIBED_EVENTS], secret };
}

export function deregisterWebhook(contractId, webhookId) {
  return dbDeleteWebhook(contractId, webhookId);
}

/** List webhooks with secrets redacted (only a presence flag is exposed). */
export function listAdvancedWebhooks(contractId) {
  return listWebhooks(contractId).map((webhook) => ({
    id: webhook.id,
    contractId: webhook.contractId,
    url: webhook.url,
    enabled: webhook.enabled,
    events: parseEvents(webhook.events) ?? [...DEFAULT_SUBSCRIBED_EVENTS],
    hasSecret: webhook.secret != null,
    retryCount: webhook.retry_count ?? 0,
    nextRetryTime: webhook.next_retry_time ?? null,
    createdAt: webhook.createdAt,
  }));
}

/**
 * Emit an event to every webhook subscribed to it (fire-and-forget per
 * webhook; the returned promise settles after the FIRST delivery attempt
 * for each subscriber so tests and admin flows can await it).
 */
export async function emitWebhookEvent({ contractId, event, data = {} }) {
  if (!isSupportedEvent(event)) {
    throw new Error(`Unsupported webhook event: ${event}`);
  }
  const subscribers = listWebhooksForEvent(contractId, event);
  if (subscribers.length === 0) return { delivered: 0, failed: 0, attempted: 0 };

  const envelope = buildEnvelope({ contractId, event, data });
  const rawEnvelope = JSON.stringify(envelope);

  let delivered = 0;
  let failed = 0;

  await Promise.all(
    subscribers.map(async (webhook) => {
      const deliveryId = safeRecordDelivery({
        webhookId: webhook.id,
        contractId,
        event,
        url: webhook.url,
        payload: rawEnvelope,
        status: "pending",
        attempts: 1,
      });
      const startedAt = Date.now();
      try {
        await basePostWebhook(webhook.url, envelope, {
          headers: headersFor(webhook.secret, envelope, rawEnvelope),
        });
        delivered++;
        resetWebhookRetryCount(webhook.id);
        if (deliveryId) {
          updateDelivery(deliveryId, {
            status: "delivered",
            httpStatus: 200,
            durationMs: Date.now() - startedAt,
          });
        }
        logger.info("Webhook event delivered", {
          url: webhook.url,
          event,
          webhookId: webhook.id,
        });
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const httpStatus = parseHttpStatus(errorMessage);
        const retryCount = (webhook.retry_count ?? 0) + 1;
        const nextRetryTime = new Date(
          Date.now() + BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)]
        );

        updateWebhookRetryStateWithPayload(
          webhook.id,
          retryCount,
          nextRetryTime.toISOString(),
          rawEnvelope
        );
        if (deliveryId) {
          updateDelivery(deliveryId, {
            status: retryCount >= MAX_WEBHOOK_RETRIES ? "exhausted" : "failed",
            httpStatus,
            error: errorMessage,
            durationMs: Date.now() - startedAt,
          });
        }
        logger.warn("Webhook event delivery failed, scheduled for retry", {
          url: webhook.url,
          event,
          attempt: retryCount,
          maxRetries: MAX_WEBHOOK_RETRIES,
          nextRetryTime: nextRetryTime.toISOString(),
          error: errorMessage,
        });

        if (retryCount >= MAX_WEBHOOK_RETRIES) {
          try {
            moveToDlq(webhook.id, webhook.url, contractId, rawEnvelope, errorMessage, retryCount);
          } catch (dlqErr) {
            logger.error("Failed to move webhook to DLQ", {
              webhookId: webhook.id,
              error: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
            });
          }
        }
      }
    })
  );

  return { delivered, failed, attempted: subscribers.length };
}

function safeRecordDelivery(entry) {
  try {
    return recordDelivery(entry);
  } catch (err) {
    logger.warn("Failed to record webhook delivery", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function parseHttpStatus(errorMessage) {
  const match = /HTTP (\d{3})/.exec(errorMessage);
  return match ? Number(match[1]) : null;
}

/**
 * Manually test a webhook: sends a `webhook.test` ping event signed with
 * the webhook's secret and records the outcome in the delivery history.
 * Returns the delivery result (does not throw on remote failure).
 */
export async function testWebhook(contractId, webhookId) {
  const webhook = getWebhookById(webhookId, contractId);
  if (!webhook || !webhook.enabled) {
    const err = new Error("Webhook not found");
    err.status = 404;
    throw err;
  }
  const envelope = buildEnvelope({
    contractId,
    event: "webhook.test",
    data: { webhookId: webhook.id, url: webhook.url, message: "Manual webhook test" },
  });
  const rawEnvelope = JSON.stringify(envelope);
  const deliveryId = safeRecordDelivery({
    webhookId: webhook.id,
    contractId,
    event: "webhook.test",
    url: webhook.url,
    payload: rawEnvelope,
    status: "pending",
    attempts: 1,
  });
  const startedAt = Date.now();
  try {
    const { durationMs } = await deliverToUrl(webhook.url, envelope, webhook.secret);
    if (deliveryId) {
      updateDelivery(deliveryId, {
        status: "delivered",
        httpStatus: 200,
        durationMs: durationMs ?? Date.now() - startedAt,
      });
    }
    return { success: true, deliveryId, event: envelope.event, durationMs: Date.now() - startedAt };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (deliveryId) {
      updateDelivery(deliveryId, {
        status: "failed",
        httpStatus: parseHttpStatus(errorMessage),
        error: errorMessage,
        durationMs: Date.now() - startedAt,
      });
    }
    return { success: false, deliveryId, event: envelope.event, error: errorMessage };
  }
}

export function getWebhookDeliveryHistory(filters) {
  return {
    data: listDeliveries(filters),
    total: countDeliveries(filters),
  };
}

export function getWebhookDeliveryStats(contractId) {
  return getDeliveryStats(contractId);
}

export const _managerConfig = {
  BACKOFF_MS,
  MAX_WEBHOOK_RETRIES,
};
