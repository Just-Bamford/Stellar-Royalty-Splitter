/**
 * OpenSea marketplace webhook integration — closes #928.
 *
 * POST /api/v1/marketplaces/opensea/webhooks/:contractId
 *   Receives OpenSea "item_sold" event notifications for the royalty
 *   contract identified by :contractId (OpenSea webhooks are configured
 *   per-collection with a caller-chosen URL, so the royalty contractId is
 *   encoded in the URL rather than requiring a separate collection-slug ->
 *   contractId mapping table, which is out of scope here).
 *
 * GET /api/v1/marketplaces/opensea/settings/:contractId
 * POST /api/v1/marketplaces/opensea/settings/:contractId
 *   Read/write the per-contract "marketplace auto-recording enabled" toggle
 *   (issue #928 point 7 — the UI checkbox itself is a frontend concern; this
 *   is the backend setting it persists to).
 *
 * ── Signature verification ──────────────────────────────────────────────
 * HMAC-SHA256 over the raw request body, using OPENSEA_WEBHOOK_SECRET (see
 * .env.example — chosen over reusing OPENSEA_API_KEY so the webhook secret
 * can be rotated independently of the API key used for outbound OpenSea API
 * calls, and because OpenSea's own webhook docs issue a dedicated signing
 * secret per webhook subscription, distinct from the API key). Verified via
 * crypto.timingSafeEqual (constant-time). Missing/invalid signature -> 401.
 *
 * Raw bytes are captured via express.json()'s own `verify` hook (index.js's
 * global JSON parser sets req.rawBody for every request; this route also
 * applies its own `verify`-equipped parser as a fallback for standalone
 * mounting, e.g. in tests, since a second express.json() call is a safe
 * no-op once a body has already been parsed). This avoids
 * routes/kyc-webhooks.js's hand-rolled stream-reading middleware, which only
 * captures the raw body correctly when nothing upstream has already
 * consumed the request stream — not true here, since this router mounts
 * after index.js's global express.json().
 */

import crypto from "crypto";
import express, { Router } from "express";
import { sendError } from "../../error-response.js";
import logger from "../../logger.js";
import {
  parseOpenSeaPayload,
  processOpenSeaSale,
  DEFAULT_ROYALTY_RATE_BPS,
} from "../../services/opensea-sync.js";
import {
  getMarketplaceSettings,
  saveMarketplaceSettings,
} from "../../database/marketplace-events.js";

export const openseaRouter = Router();

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
 * (development / test mode — mirrors routes/kyc-webhooks.js).
 */
export function verifyOpenSeaSignature(rawBody, signature) {
  const secret = process.env.OPENSEA_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn("OpenSea webhook secret not configured; skipping signature verification");
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

// ─── POST /api/v1/marketplaces/opensea/webhooks/:contractId ────────────────

openseaRouter.post(
  "/webhooks/:contractId",
  jsonWithRawBody,
  async (req, res) => {
    const { contractId } = req.params;

    const signature = req.headers["x-opensea-signature"] ?? req.headers["x-signature"] ?? "";
    const rawBody = req.rawBody ?? JSON.stringify(req.body);

    if (!verifyOpenSeaSignature(rawBody, signature)) {
      logger.warn("OpenSea webhook signature verification failed", { contractId, ip: req.ip });
      return sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
    }

    const parsed = parseOpenSeaPayload(req.body);
    if (!parsed) {
      return sendError(res, 400, "invalid_payload", "Missing required OpenSea webhook fields (event id, nft id, sale price, seller, buyer)");
    }

    const rateBps = Number(process.env.OPENSEA_ROYALTY_RATE_BPS) || DEFAULT_ROYALTY_RATE_BPS;

    try {
      const result = await processOpenSeaSale({ contractId, parsed, rateBps, rawPayload: req.body });

      logger.info("OpenSea webhook processed", { contractId, eventId: parsed.eventId, status: result.status });

      return res.status(200).json({ success: true, data: result });
    } catch (err) {
      logger.error("OpenSea webhook processing failed", { contractId, eventId: parsed.eventId, error: err.message });
      return sendError(res, 500, "opensea_processing_error", err.message);
    }
  }
);

// ─── Marketplace auto-recording settings (#928 point 7) ────────────────────

openseaRouter.get("/settings/:contractId", (req, res) => {
  try {
    const settings = getMarketplaceSettings(req.params.contractId);
    return res.json({ success: true, data: settings });
  } catch (err) {
    return sendError(res, 500, "settings_fetch_error", err.message);
  }
});

openseaRouter.post("/settings/:contractId", express.json(), (req, res) => {
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
