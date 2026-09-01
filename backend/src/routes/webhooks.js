import express from "express";
import { registerWebhook, listWebhooks, deleteWebhook } from "../database/webhooks.js";
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

export default router;
