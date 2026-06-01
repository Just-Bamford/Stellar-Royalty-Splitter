import express from "express";
import { registerWebhook, listWebhooks, deleteWebhook } from "../database/webhooks.js";
import {
  validateContractIdMiddleware,
  validateContractId,
  validate,
  webhookRegisterSchema,
} from "../validation.js";
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
      res.status(500).json({ success: false, error: error.message });
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
    res.status(500).json({ success: false, error: error.message });
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
      return res.status(400).json({ success: false, error: "Invalid webhook ID" });
    }

    const removed = deleteWebhook(contractId, parsedId);
    if (!removed) {
      return res.status(404).json({ success: false, error: "Webhook not found" });
    }

    res.json({
      success: true,
      message: "Webhook removed",
    });
  } catch (error) {
    logger.error("Error deleting webhook:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
