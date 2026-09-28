/**
 * Coinbase Commerce integration for payment processing.
 *
 * Supports:
 * - Creating charges for custom amounts
 * - Accepting payments in USD, EUR, and other fiat currencies
 * - Webhook notifications for payment status
 * - Refund handling
 */

import logger from "../logger.js";

const COINBASE_API_URL = "https://api.commerce.coinbase.com";

async function createCharge(amount, currency = "USD", metadata = {}) {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) {
    throw new Error("COINBASE_COMMERCE_API_KEY not configured");
  }

  try {
    const response = await fetch(`${COINBASE_API_URL}/charges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CC-Api-Key": apiKey,
        "X-CC-Version": "2018-03-22",
      },
      body: JSON.stringify({
        name: "Royalty Payment",
        description: "Payment for royalty distribution",
        pricing_type: "fixed_price",
        local_price: {
          amount: amount.toString(),
          currency: currency,
        },
        metadata,
      }),
    });

    if (!response.ok) {
      throw new Error(`Coinbase API error: ${response.status}`);
    }

    const data = await response.json();
    logger.info("Coinbase charge created", { chargeId: data.data.id });

    return data.data;
  } catch (error) {
    logger.error("Failed to create Coinbase charge", { error: error.message });
    throw error;
  }
}

async function getCharge(chargeId) {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) {
    throw new Error("COINBASE_COMMERCE_API_KEY not configured");
  }

  try {
    const response = await fetch(`${COINBASE_API_URL}/charges/${chargeId}`, {
      method: "GET",
      headers: {
        "X-CC-Api-Key": apiKey,
        "X-CC-Version": "2018-03-22",
      },
    });

    if (!response.ok) {
      throw new Error(`Coinbase API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data;
  } catch (error) {
    logger.error("Failed to get Coinbase charge", { chargeId, error: error.message });
    throw error;
  }
}

async function refundCharge(chargeId, amount = null) {
  const apiKey = process.env.COINBASE_COMMERCE_API_KEY;
  if (!apiKey) {
    throw new Error("COINBASE_COMMERCE_API_KEY not configured");
  }

  try {
    const body = amount ? { amount: { amount: amount.toString() } } : {};
    const response = await fetch(`${COINBASE_API_URL}/charges/${chargeId}/refund`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CC-Api-Key": apiKey,
        "X-CC-Version": "2018-03-22",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Coinbase API error: ${response.status}`);
    }

    const data = await response.json();
    logger.info("Coinbase charge refunded", { chargeId });

    return data.data;
  } catch (error) {
    logger.error("Failed to refund Coinbase charge", { chargeId, error: error.message });
    throw error;
  }
}

function verifyWebhookSignature(payload, signature) {
  const webhookSecret = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("COINBASE_COMMERCE_WEBHOOK_SECRET not configured");
  }

  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha256", webhookSecret);
  hmac.update(payload);
  const expectedSignature = hmac.digest("hex");

  return signature === expectedSignature;
}

export { createCharge, getCharge, refundCharge, verifyWebhookSignature };
