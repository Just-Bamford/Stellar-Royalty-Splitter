import express from "express";
import { registerWebhook, listWebhooks, deleteWebhook, getDeliveryAttempts, getDeliveryStats, getContractDeliveryStats } from "../database/webhooks.js";
import {
  validateContractIdMiddleware,
  validateContractId,
  validate,
  webhookRegisterSchema,
} from "../validation.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * POST /api/v1/webhooks/:contractId
 * Register a webhook URL for distribute completion notifications (#295).
 */
router.post(
  "/webhooks/:contractId",
  validateContractIdMiddleware,
  validate(webhookRegisterSchema),
  (req, res) => {
    try {
      const { contractId } = req.params;
      if (!validateContractId(contractId, res)) return;

      const { url } = req.body;
      const webhookId = registerWebhook(contractId, url);

      res.status(201).json({
        success: true,
        webhookId,
        url,
        message: "Webhook registered",
      });
    } catch (error) {
      logger.error("Error registering webhook:", error);
      sendError(res, 500, "internal_server_error", error.message ?? "Failed to register webhook");
    }
  },
);

/**
 * GET /api/v1/webhooks/:contractId
 * List registered webhooks for a contract.
 */
router.get("/webhooks/:contractId", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const webhooks = listWebhooks(contractId);

    res.json({
      success: true,
      data: webhooks,
    });
  } catch (error) {
    logger.error("Error listing webhooks:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to list webhooks");
  }
});

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

/**
 * GET /api/v1/webhooks/:contractId/:webhookId/status
 * Delivery status and recent attempts for a single webhook (#506).
 */
router.get("/webhooks/:contractId/:webhookId/status", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId, webhookId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const parsedId = parseInt(webhookId, 10);
    if (Number.isNaN(parsedId) || parsedId <= 0) {
      return sendError(res, 400, "invalid_webhook_id", "Invalid webhook ID");
    }

    const stats = getDeliveryStats(parsedId);
    const attempts = getDeliveryAttempts(parsedId, 20);

    const total = stats?.total ?? 0;
    const successes = stats?.successes ?? 0;

    res.json({
      success: true,
      data: {
        webhookId: parsedId,
        total,
        successes,
        failures: total - successes,
        successRate: total > 0 ? Math.round((successes / total) * 100) : null,
        avgLatencyMs: stats?.avgLatencyMs ? Math.round(stats.avgLatencyMs) : null,
        lastAttempt: stats?.lastAttempt ?? null,
        recentAttempts: attempts,
      },
    });
  } catch (error) {
    logger.error("Error fetching webhook status:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch webhook status");
  }
});

/**
 * GET /api/v1/webhooks/:contractId/stats
 * Delivery statistics for all webhooks under a contract (#506).
 */
router.get("/webhooks/:contractId/stats", validateContractIdMiddleware, (req, res) => {
  try {
    const { contractId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const rows = getContractDeliveryStats(contractId);
    const data = rows.map((r) => ({
      webhookId: r.webhookId,
      url: r.url,
      total: r.total ?? 0,
      successes: r.successes ?? 0,
      failures: (r.total ?? 0) - (r.successes ?? 0),
      successRate: r.total > 0 ? Math.round((r.successes / r.total) * 100) : null,
      avgLatencyMs: r.avgLatencyMs ? Math.round(r.avgLatencyMs) : null,
      lastAttempt: r.lastAttempt ?? null,
    }));

    res.json({ success: true, data });
  } catch (error) {
    logger.error("Error fetching webhook stats:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to fetch webhook stats");
  }
});

/**
 * POST /api/v1/webhooks/:contractId/:webhookId/test
 * Send a test ping to a registered webhook (#506).
 */
router.post("/webhooks/:contractId/:webhookId/test", validateContractIdMiddleware, async (req, res) => {
  try {
    const { contractId, webhookId } = req.params;
    if (!validateContractId(contractId, res)) return;

    const parsedId = parseInt(webhookId, 10);
    if (Number.isNaN(parsedId) || parsedId <= 0) {
      return sendError(res, 400, "invalid_webhook_id", "Invalid webhook ID");
    }

    const webhooks = listWebhooks(contractId);
    const webhook = webhooks.find((w) => w.id === parsedId);
    if (!webhook) {
      return sendError(res, 404, "not_found", "Webhook not found");
    }

    const payload = { event: "webhook.test", contractId, webhookId: parsedId, timestamp: new Date().toISOString() };
    const start = Date.now();
    let success = false;
    let statusCode = null;
    let errorMessage = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Stellar-Royalty-Splitter/1.0" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = response.status;
      success = response.ok;
      if (!response.ok) errorMessage = `HTTP ${response.status}`;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - start;
    const { recordDeliveryAttempt } = await import("../database/webhooks.js");
    recordDeliveryAttempt({ webhookId: parsedId, contractId, success, statusCode, errorMessage, durationMs, attempt: 1 });

    res.json({ success: true, delivered: success, statusCode, durationMs, errorMessage });
  } catch (error) {
    logger.error("Error testing webhook:", error);
    sendError(res, 500, "internal_server_error", error.message ?? "Failed to test webhook");
  }
});

export default router;
