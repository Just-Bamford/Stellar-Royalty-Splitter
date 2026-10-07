/**
 * SendGrid event webhook handler — /api/v1/webhooks/sendgrid
 *
 * SendGrid POSTs an array of event objects to this endpoint. The handler:
 *   1. Verifies the HMAC-SHA256 signature (using SENDGRID_WEBHOOK_SECRET).
 *   2. Delegates to processSendGridWebhookEvents() which tracks delivery,
 *      bounce, and complaint events, updating the in-process email status
 *      store accordingly.
 *
 * Configure in SendGrid dashboard:
 *   POST {BASE_URL}/api/v1/webhooks/sendgrid
 *   Events: delivered, bounce, spamreport, unsubscribe, open, click, dropped, deferred
 *
 * Env vars:
 *   SENDGRID_WEBHOOK_SECRET — secret from SendGrid Mail Settings → Event Webhook
 *                             When unset, signature verification is skipped with a
 *                             warning (development only — always set in production).
 */

import { Router } from "express";
import crypto from "crypto";
import logger from "../../logger.js";
import { sendError } from "../../error-response.js";
import { processSendGridWebhookEvents } from "../../services/sendgrid.js";

export const sendgridWebhookRouter = Router();

// ─── Signature verification ────────────────────────────────────────────────────

/**
 * SendGrid signs webhook payloads using ECDSA with a public key when Signed
 * Event Webhooks are enabled, or with a simple HMAC-SHA256 secret (legacy).
 *
 * This implementation supports the simpler HMAC-SHA256 approach (SENDGRID_WEBHOOK_SECRET).
 * To use Signed Event Webhooks (EC key), upgrade to @sendgrid/eventwebhook and
 * swap out this function.
 *
 * @param {string} rawBody   — raw request body string
 * @param {string} signature — value of X-Twilio-Email-Event-Webhook-Signature header
 * @param {string} secret    — SENDGRID_WEBHOOK_SECRET env value
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret) return false;
  try {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/webhooks/sendgrid
 *
 * Receives SendGrid event notifications. Body is an array of event objects.
 * Returns 200 quickly (SendGrid retries on non-2xx); processing is synchronous
 * but fast (in-memory map updates + structured logging).
 */
sendgridWebhookRouter.post("/", (req, res) => {
  const secret = process.env.SENDGRID_WEBHOOK_SECRET;
  const signature = req.headers["x-twilio-email-event-webhook-signature"]
    ?? req.headers["x-sendgrid-signature"];
  const rawBody = req.rawBody ?? JSON.stringify(req.body);

  // Signature verification
  if (secret) {
    if (!signature) {
      logger.warn("SendGrid webhook: missing signature header");
      return sendError(res, 401, "missing_signature", "Missing webhook signature");
    }
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      logger.warn("SendGrid webhook: invalid signature");
      return sendError(res, 401, "invalid_signature", "Invalid webhook signature");
    }
  } else {
    logger.warn(
      "SENDGRID_WEBHOOK_SECRET is not set — skipping signature verification (unsafe in production)"
    );
  }

  const events = req.body;
  if (!Array.isArray(events)) {
    return sendError(res, 400, "invalid_payload", "Webhook body must be an array of events");
  }

  if (events.length === 0) {
    return res.status(200).json({ success: true, processed: 0 });
  }

  const { processed, errors } = processSendGridWebhookEvents(events);

  logger.info("SendGrid webhook batch processed", { processed, errors, total: events.length });

  // Always respond 200 to prevent SendGrid from retrying the batch.
  // Individual event errors are logged but do not affect the HTTP status.
  res.status(200).json({ success: true, processed, errors });
});
