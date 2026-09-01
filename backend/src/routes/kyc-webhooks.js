/**
 * KYC provider webhook receivers — closes #598.
 *
 * POST /api/v1/kyc/webhook/:provider
 *   Receives KYC completion callbacks from Veriff and Jumio.
 *   Validates the provider-specific HMAC signature, normalises the payload,
 *   persists the raw event, updates contributor_verification, and writes
 *   an audit log entry.
 *
 * GET /api/v1/kyc/events/:walletAddress
 *   Returns paginated KYC event history for a contributor (admin use).
 */

import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { sendError, sendValidationError } from "../error-response.js";
import { normaliseKycPayload, outcomeToVerificationState } from "../kyc-providers.js";
import {
  recordKycEvent,
  getKycEventsByWallet,
  countKycEventsByWallet,
  KYC_PROVIDERS,
} from "../database/index.js";
import { upsertVerification, addAuditLog } from "../database/index.js";
import logger from "../logger.js";

export const kycWebhooksRouter = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature sent by a KYC provider.
 * Returns true if the signature matches or if no secret is configured
 * (development / test mode).
 *
 * @param {string} provider  - "veriff" | "jumio"
 * @param {string} rawBody   - Raw request body string
 * @param {string} signature - Value from X-Hmac-Signature or X-Auth-Client header
 */
function verifySignature(provider, rawBody, signature) {
  const secret = process.env[`KYC_${provider.toUpperCase()}_WEBHOOK_SECRET`];
  if (!secret) {
    // No secret configured — allow through (useful in dev; warn loudly)
    logger.warn("KYC webhook secret not configured; skipping signature verification", { provider });
    return true;
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // Constant-time comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(signature ?? ""), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Raw body capture middleware ─────────────────────────────────────────────
// express.json() already consumed the body upstream, but we need the raw bytes
// for HMAC verification. We store the raw body on req before JSON parsing when
// the route is mounted.  Callers that need the raw body should use
// req.rawBody (set by the capture middleware below).

function captureRawBody(req, res, next) {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    data += chunk;
  });
  req.on("end", () => {
    req.rawBody = data;
    try {
      req.body = JSON.parse(data);
    } catch {
      req.body = {};
    }
    next();
  });
}

// ─── POST /api/v1/kyc/webhook/:provider ─────────────────────────────────────

kycWebhooksRouter.post(
  "/webhook/:provider",
  // Override express.json() body parsing so we capture the raw bytes
  (req, res, next) => {
    // If rawBody is already set (unit tests inject parsed body directly), skip.
    if (req.rawBody !== undefined) return next();
    captureRawBody(req, res, next);
  },
  async (req, res) => {
    const { provider } = req.params;

    if (!KYC_PROVIDERS.includes(provider)) {
      return sendError(res, 400, "unsupported_provider", `Unsupported KYC provider: "${provider}"`);
    }

    // Signature verification — header differs per provider
    const sig =
      req.headers["x-hmac-signature"] ??
      req.headers["x-auth-client"] ??
      req.headers["x-signature"] ??
      "";

    const rawBody =
      req.rawBody ?? (typeof req.body === "string" ? req.body : JSON.stringify(req.body));

    if (!verifySignature(provider, rawBody, sig)) {
      logger.warn("KYC webhook signature verification failed", { provider, ip: req.ip });
      return sendError(res, 401, "invalid_signature", "Webhook signature verification failed");
    }

    // Normalise provider payload
    let parsed;
    try {
      parsed = normaliseKycPayload(provider, req.body);
    } catch (err) {
      logger.warn("KYC payload parse error", { provider, error: err.message });
      return sendError(res, 400, "invalid_payload", err.message);
    }

    const { providerSessionId, walletAddress, outcome } = parsed;
    const rawPayload = rawBody ?? JSON.stringify(req.body);

    // Persist the raw event
    const eventId = recordKycEvent({
      provider,
      providerSessionId,
      walletAddress,
      outcome,
      rawPayload,
    });

    logger.info("KYC event received", {
      provider,
      providerSessionId,
      walletAddress,
      outcome,
      eventId,
    });

    // Update contributor_verification if we have a wallet address
    let verificationRecord = null;
    if (walletAddress && /^G[A-Z2-7]{54}$/.test(walletAddress)) {
      const { step, status } = outcomeToVerificationState(outcome);

      verificationRecord = upsertVerification(
        walletAddress,
        step,
        status,
        `KYC ${outcome} via ${provider} (session: ${providerSessionId})`
      );

      // Audit log entry
      addAuditLog("SYSTEM", "kyc_verification_updated", walletAddress, {
        provider,
        providerSessionId,
        outcome,
        step,
        status,
        kycEventId: eventId,
      });

      logger.info("Contributor verification updated from KYC callback", {
        walletAddress,
        step,
        status,
        provider,
      });
    } else if (walletAddress) {
      logger.warn("KYC callback contained invalid wallet address format", {
        walletAddress,
        provider,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        eventId,
        provider,
        providerSessionId,
        outcome,
        walletAddress: walletAddress ?? null,
        verification: verificationRecord,
      },
    });
  }
);

// ─── GET /api/v1/kyc/events/:walletAddress ──────────────────────────────────

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

kycWebhooksRouter.get("/events/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!/^G[A-Z2-7]{54}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar address format");
  }

  const result = eventsQuerySchema.safeParse(req.query);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { limit, offset } = result.data;

  const events = getKycEventsByWallet(walletAddress, limit, offset);
  const total = countKycEventsByWallet(walletAddress);

  // Parse rawPayload back to object for cleaner API response
  const data = events.map((e) => {
    let payload = null;
    try {
      payload = JSON.parse(e.rawPayload);
    } catch {
      payload = e.rawPayload;
    }
    return { ...e, rawPayload: payload };
  });

  return res.json({
    success: true,
    data,
    pagination: { total, limit, offset },
  });
});
