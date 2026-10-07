/**
 * Coinbase Commerce payment routes.
 */

import express from "express";
import { createCharge, getCharge, refundCharge, verifyWebhookSignature } from "../../services/coinbase-commerce.js";
import logger from "../../logger.js";

const router = express.Router();

router.post("/create", async (req, res) => {
  try {
    const { amount, currency, metadata } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const charge = await createCharge(amount, currency || "USD", metadata);
    res.json({ charge });
  } catch (error) {
    logger.error("Coinbase charge creation failed", { error: error.message });
    res.status(500).json({ error: "Failed to create charge" });
  }
});

router.get("/:chargeId", async (req, res) => {
  try {
    const { chargeId } = req.params;
    const charge = await getCharge(chargeId);
    res.json({ charge });
  } catch (error) {
    logger.error("Coinbase charge retrieval failed", { error: error.message });
    res.status(500).json({ error: "Failed to retrieve charge" });
  }
});

router.post("/:chargeId/refund", async (req, res) => {
  try {
    const { chargeId } = req.params;
    const { amount } = req.body;

    const refund = await refundCharge(chargeId, amount);
    res.json({ refund });
  } catch (error) {
    logger.error("Coinbase refund failed", { error: error.message });
    res.status(500).json({ error: "Failed to process refund" });
  }
});

router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-cc-webhook-signature"];
    const payload = JSON.stringify(req.body);

    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(401).json({ error: "Invalid signature" });
    }

    const { event } = req.body;
    logger.info("Coinbase webhook received", { event: event.type });

    if (event.type === "charge:confirmed") {
      const chargeId = event.data.id;
      logger.info("Payment confirmed", { chargeId });
    }

    res.json({ received: true });
  } catch (error) {
    logger.error("Coinbase webhook processing failed", { error: error.message });
    res.status(500).json({ error: "Failed to process webhook" });
  }
});

export default router;
