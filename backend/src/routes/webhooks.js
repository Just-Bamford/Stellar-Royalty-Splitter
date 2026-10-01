import express from "express";
import { registerWebhook, listWebhooks, deleteWebhook } from "../database/webhooks.js";
import {
  validateContractIdMiddleware,
  validateContractId,
  validate,
  validateQuery,
  webhookRegisterSchema,
  webhookEmitSchema,
  webhookDeliveriesQuerySchema,
} from "../validation.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";
import {
  WEBHOOK_EVENTS,
  registerAdvancedWebhook,
  testWebhook,
  emitWebhookEvent,
  getWebhookDeliveryHistory,
  getWebhookDeliveryStats,
} from "../services/webhook-manager.js";
import { rotateWebhookSecret, getWebhookById, parseEvents } from "../database/webhooks.js";
import { generateWebhookSecret } from "../services/webhook-manager.js";

const router = express.Router();

/**
 * POST /api/v1/webhooks/:contractId
 * Register a webhook URL for event notifications (#295, extended #1059).
 * Optional body.events: array of event names to subscribe to (default: all).
 * Returns the per-webhook HMAC secret ONCE — it is never exposed again.
 */
router.post(
  "/webhooks/:contractId",
  validateContractIdMiddleware,
  validate(webhookRegisterSchema),
  (req, res) => {
    try {
      const { contractId } = req.params;
      if (!validateContractId(contractId, res)) return;

      const { url, events } = req.body;

      if (events == null) {
        // Legacy path — exact historical behavior and response shape.
        const webhookId = registerWebhook(contractId, url);

        res.status(201).json({
          success: true,
          webhookId,
          url,
          message: "Webhook registered",
        });
        return;
      }

      const { webhookId, secret, events: subscribed } = registerAdvancedWebhook(
        contractId,
        url,
        events
      );

      res.status(201).json({
        success: true,
        webhookId,
        url,
        events: subscribed,
        secret,
        message: "Webhook registered. Store the secret securely — it is shown only once.",
      });
    } catch (error) {
      if (error?.message?.startsWith("Unsupported webhook event")) {
        return sendError(res, 400, "invalid_webhook_events", error.message);
      }
      logger.error("Error registering webhook:", error);
      sendError(res, 500, "internal_server_error", error.message ?? "Failed to register webhook");
    }
  }
);

/**
 * GET /api/v1/webhooks/events
 * List the supported webhook event names (#1059).
 * NOTE: registered before "/webhooks/:contractId" so "events" is not
 * treated as a contract ID.
 */
router.get("/webhooks/events", (_req, res) => {
  res.json({ success: true, data: [...WEBHOOK_EVENTS] });
});

/**
 * GET /api/v1/webhooks/:contractId
 * List registered webhooks for a contract (#1059: includes event
 * subscriptions and secret presence flag; secrets are never returned).
 */
router.get("/webhooks/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const webhooks = listWebhooks(contractId);

    res.json({
      success: true,
      data: webhooks.map((webhook) => ({
        ...webhook,
        events: parseEvents(webhook.events) ?? [...WEBHOOK_EVENTS],
        hasSecret: webhook.secret != null,
        secret: undefined,
      })),
    });
  } catch (error) {
    logger.error("Error listing webhooks:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to list webhooks");
  }
});

/**
 * GET /api/v1/webhooks/:contractId/deliveries
 * Paginated delivery history for a contract's webhooks (#1059).
 * Query: limit, offset, webhookId, event, status.
 */
router.get(
  "/webhooks/:contractId/deliveries",
  validateContractIdMiddleware,
  validateQuery(webhookDeliveriesQuerySchema),
  (req, res) => {
    try {
      const { contractId } = req.params;
      if (!validateContractId(contractId, res)) return;

      const { limit, offset, webhookId, event, status } = req.query;

      const { data, total } = getWebhookDeliveryHistory({
        contractId,
        webhookId: webhookId ?? null,
        event: event ?? null,
        status: status ?? null,
        limit,
        offset,
      });

      res.json({ success: true, data, pagination: { total, limit, offset } });
    } catch (error) {
      logger.error("Error listing webhook deliveries:", error);
      sendError(res, 500, "internal_server_error", error.message ?? "Failed to list deliveries");
    }
  }
);

/**
 * GET /api/v1/webhooks/:contractId/delivery-stats
 * Aggregate delivery stats for the status dashboard (#1059).
 */
router.get("/webhooks/:contractId/delivery-stats", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    res.json({ success: true, data: getWebhookDeliveryStats(contractId) });
  } catch (error) {
    logger.error("Error fetching webhook delivery stats:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch stats");
  }
});

/**
 * POST /api/v1/webhooks/:contractId/emit
 * Emit an event to all subscribed webhooks (#1059). Used by external
 * triggers (e.g. governance votes, contract status changes) and manual testing.
 */
router.post(
  "/webhooks/:contractId/emit",
  validateContractIdMiddleware,
  validate(webhookEmitSchema),
  async (req, res) => {
    try {
      const { contractId } = req.params;
      if (!validateContractId(contractId, res)) return;

      const { event, data } = req.body;
      const result = await emitWebhookEvent({ contractId, event, data });

      res.status(202).json({ success: true, event, ...result });
    } catch (error) {
      logger.error("Error emitting webhook event:", error);
      sendError(res, 500, "internal_server_error", error.message ?? "Failed to emit event");
    }
  }
);

/**
 * POST /api/v1/webhooks/:contractId/:webhookId/test
 * Manually send a signed `webhook.test` ping to a webhook (#1059).
 */
router.post("/webhooks/:contractId/:webhookId/test", validateContractIdMiddleware, async (req, res) => {
  try {
    const { contractId, webhookId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const parsedId = parseInt(webhookId, 10);
    if (Number.isNaN(parsedId) || parsedId <= 0) {
      return sendError(res, 400, "invalid_webhook_id", "Invalid webhook ID");
    }

    const result = await testWebhook(contractId, parsedId);
    if (result.success) {
      return res.json({ success: true, message: "Test webhook delivered", ...result });
    }
    return res.status(502).json({ success: false, message: "Test webhook failed", ...result });
  } catch (error) {
    if (error?.status === 404) {
      return sendError(res, 404, "not_found", "Webhook not found");
    }
    logger.error("Error testing webhook:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to test webhook");
  }
});

/**
 * POST /api/v1/webhooks/:contractId/:webhookId/rotate-secret
 * Rotate a webhook's HMAC signing secret (#1059). Returns the new secret
 * once — update the receiver before the old secret stops working.
 */
router.post(
  "/webhooks/:contractId/:webhookId/rotate-secret",
  validateContractIdMiddleware,
  (req, res) => {
    try {
      const { contractId, webhookId } = req.params;
      if (!validateContractId(contractId, res)) return;

      const parsedId = parseInt(webhookId, 10);
      if (Number.isNaN(parsedId) || parsedId <= 0) {
        return sendError(res, 400, "invalid_webhook_id", "Invalid webhook ID");
      }

      const webhook = getWebhookById(parsedId, contractId);
      if (!webhook || !webhook.enabled) {
        return sendError(res, 404, "not_found", "Webhook not found");
      }

      const secret = generateWebhookSecret();
      rotateWebhookSecret(parsedId, secret);

      res.json({
        success: true,
        webhookId: parsedId,
        secret,
        message: "Secret rotated. Store it securely — it is shown only once.",
      });
    } catch (error) {
      logger.error("Error rotating webhook secret:", error);
      sendError(res, 500, "internal_server_error", error.message ?? "Failed to rotate secret");
    }
  }
);

/**
 * DELETE /api/v1/webhooks/:contractId/:webhookId
 * Disable a registered webhook.
 */
router.delete("/webhooks/:contractId/:webhookId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId, webhookId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const parsedId = parseInt(webhookId, 10);
    if (Number.isNaN(parsedId) || parsedId <= 0) {
      return sendError(res, 400, "invalid_webhook_id", "Invalid webhook ID");
    }

    const removed = deleteWebhook(contractId, parsedId);
    if (!removed) {
      return sendError(res, 404, "not_found", "Webhook not found");
    }

    res.json({
      success: true,
      message: "Webhook removed",
    });
  } catch (error) {
    logger.error("Error deleting webhook:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to delete webhook");
  }
});

export default router;
