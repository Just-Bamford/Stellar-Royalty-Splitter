/**
 * Rarible marketplace webhook integration — closes #954.
 *
 * POST /api/v1/marketplaces/rarible/webhooks/:contractId
 * POST /api/v1/marketplaces/rarible/webhooks
 *   Receives Rarible Order-activity (sale) notifications for the royalty
 *   contract they belong to.
 *
 *   Both shapes are supported because Rarible's webhook is configured
 *   against a single URL while this backend's royalty contract is a Soroban
 *   contract id that Rarible knows nothing about:
 *     - `/webhooks/:contractId` encodes the royalty contract in the URL,
 *       matching routes/marketplaces/opensea.js (one Rarible webhook per
 *       royalty contract).
 *     - `/webhooks` accepts `contractId` in the body for deployments that
 *       register a single Rarible webhook and route it here.
 *   The handler is identical; only the source of the contract id differs.
 *
 * GET /api/v1/marketplaces/rarible/settings/:contractId
 * POST /api/v1/marketplaces/rarible/settings/:contractId
 *   Read/write the per-contract "marketplace auto-recording enabled" toggle.
 *   The setting itself is per-contract and provider-agnostic
 *   (`marketplace_settings`), so it is shared with the OpenSea integration.
 *
 * ── Signature verification ──────────────────────────────────────────────
 * HMAC-SHA256 over the raw request body using RARIBLE_WEBHOOK_SECRET,
 * compared in constant time via crypto.timingSafeEqual. Missing or invalid
 * signature -> 401. As with OpenSea, a dedicated secret is used rather than
 * reusing an API key so the webhook secret can be rotated on its own, and an
 * unset secret skips verification with a warning for development/test only.
 *
 * Raw bytes are captured with express.json()'s own `verify` hook, which is a
 * safe no-op when a body has already been parsed upstream (index.js installs
 * a global JSON parser that sets req.rawBody).
 */

import crypto from "crypto";
import express, { Router } from "express";
import { sendError } from "../../error-response.js";
import logger from "../../logger.js";
import {
  parseRariblePayload,
  processRaribleSale,
  DEFAULT_ROYALTY_RATE_BPS,
} from "../../services/rarible-sync.js";
import {
  getMarketplaceSettings,
  saveMarketplaceSettings,
} from "../../database/marketplace-events.js";

export const raribleRouter = Router();

// Captures the raw request bytes (needed for HMAC verification) alongside
// the parsed JSON body, on this route only.
const jsonWithRawBody = express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
});

/**
 * Verify an HMAC-SHA256 signature over the raw request body.
 * Returns true if the signature matches or if no secret is configured
 * (development / test mode — mirrors routes/marketplaces/opensea.js).
 *
 * @param {string} rawBody
 * @param {string} signature
 * @returns {boolean}
 */
export function verifyRaribleSignature(rawBody, signature) {
  const secret = process.env.RARIBLE_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("Rarible webhook secret not configured; skipping signature verification");
    return true;
  }
  if (!signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── POST /api/v1/marketplaces/rarible/webhooks[/:contractId] ──────────────

async function handleRaribleWebhook(req, res) {
  // The URL wins when present; otherwise fall back to the body so a single
  // deployment-wide webhook URL can serve every royalty contract.
  const contractId = req.params.contractId ?? req.body?.contractId;
  if (!contractId) {
    return sendError(
      res,
      400,
      "missing_contract_id",
      "contractId is required, either in the URL or in the request body"
    );
  }

  const signature = req.headers["x-rarible-signature"] ?? req.headers["x-signature"] ?? "";
  const rawBody = req.rawBody ?? JSON.stringify(req.body);

  if (!verifyRaribleSignature(rawBody, signature)) {
    logger.warn("Rarible webhook signature verification failed", { contractId, ip: req.ip });
    return sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
  }

  const parsed = parseRariblePayload(req.body);
  if (!parsed) {
    return sendError(
      res,
      400,
      "invalid_payload",
      "Missing required Rarible webhook fields (activity id, nft id, sale price, seller, buyer) or an unsupported chain"
    );
  }

  const rateBps = Number(process.env.RARIBLE_ROYALTY_RATE_BPS) || DEFAULT_ROYALTY_RATE_BPS;

  try {
    const result = await processRaribleSale({
      contractId,
      parsed,
      rateBps,
      rawPayload: req.body,
    });

    logger.info("Rarible webhook processed", {
      contractId,
      eventId: parsed.eventId,
      chain: parsed.chain,
      status: result.status,
    });

    return res.status(200).json({ success: true, data: result });
  } catch (err) {
    // A non-2xx tells Rarible to redeliver; the event id keeps the retry
    // idempotent if it was in fact persisted before the failure.
    logger.error("Rarible webhook processing failed", {
      contractId,
      eventId: parsed.eventId,
      chain: parsed.chain,
      error: err.message,
    });
    return sendError(res, 500, "rarible_processing_error", err.message);
  }
}

raribleRouter.post("/webhooks/:contractId", jsonWithRawBody, handleRaribleWebhook);
raribleRouter.post("/webhooks", jsonWithRawBody, handleRaribleWebhook);

// ─── Marketplace auto-recording settings ──────────────────────────────────

raribleRouter.get("/settings/:contractId", (req, res) => {
  try {
    const settings = getMarketplaceSettings(req.params.contractId);
    return res.json({ success: true, data: settings });
  } catch (err) {
    return sendError(res, 500, "settings_fetch_error", err.message);
  }
});

raribleRouter.post("/settings/:contractId", express.json(), (req, res) => {
  const { autoRecordingEnabled } = req.body;
  if (typeof autoRecordingEnabled !== "boolean") {
    return sendError(res, 400, "validation_error", "autoRecordingEnabled (boolean) is required");
  }
  try {
    const saved = saveMarketplaceSettings(req.params.contractId, autoRecordingEnabled);
    return res.json({ success: true, data: saved });
  } catch (err) {
    return sendError(res, 500, "settings_save_error", err.message);
  }
});
