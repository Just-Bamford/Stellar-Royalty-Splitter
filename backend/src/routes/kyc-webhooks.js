/**
 * KYC Webhook receiver routes (#598).
 *
 * Receives callbacks from KYC providers (Veriff, Jumio) and updates
 * contributor verification_status automatically.
 *
 * POST /api/v1/kyc/webhook/veriff   — Veriff callback
 * POST /api/v1/kyc/webhook/jumio    — Jumio callback
 * GET  /api/v1/kyc/status/:walletAddress  — Current KYC status
 * GET  /api/v1/kyc/events           — Audit log of all KYC events (admin)
 *
 * Webhook signature verification:
 *   Veriff: X-HMAC-SIGNATURE header, HMAC-SHA256 of raw body with KYC_VERIFF_SECRET
 *   Jumio:  Basic Auth via KYC_JUMIO_CALLBACK_SECRET (base64 token in Authorization header)
 */

import express from "express";
import crypto from "crypto";
import logger from "../logger.js";
import { sendError } from "../error-response.js";
import { upsertKycStatus, getKycStatus, logKycEvent, getAllKycEvents, getKycEvents } from "../database/kyc.js";
import { addAuditLog } from "../database/audit.js";
import { isValidStellarAddress } from "../validation.js";
import { upsertContributorOnboarding } from "../database.js";

const router = express.Router();

// ---------------------------------------------------------------------------
// Signature verification helpers
// ---------------------------------------------------------------------------

/**
 * Verify Veriff HMAC-SHA256 signature.
 * Header: X-HMAC-SIGNATURE  (hex digest of HMAC-SHA256 over raw body)
 */
function verifyVeriffSignature(rawBody, signatureHeader) {
  const secret = process.env.KYC_VERIFF_SECRET;
  if (!secret) {
    // If no secret configured, skip verification in development only
    if (process.env.NODE_ENV === "production") {
      logger.error("KYC_VERIFF_SECRET not configured in production");
      return false;
    }
    logger.warn("KYC_VERIFF_SECRET not set — skipping signature check (dev mode)");
    return true;
  }
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(signatureHeader, "hex")
  );
}

/**
 * Verify Jumio Basic Auth callback token.
 * Header: Authorization: Basic <base64(token)>
 */
function verifyJumioAuth(authHeader) {
  const secret = process.env.KYC_JUMIO_CALLBACK_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      logger.error("KYC_JUMIO_CALLBACK_SECRET not configured in production");
      return false;
    }
    logger.warn("KYC_JUMIO_CALLBACK_SECRET not set — skipping auth check (dev mode)");
    return true;
  }
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  const provided = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
  return provided === secret;
}

// ---------------------------------------------------------------------------
// Status mappers — translate provider events to internal verification_status
// ---------------------------------------------------------------------------

/**
 * Map Veriff decision/status to internal KYC status.
 * See: https://developers.veriff.com/#decisions
 */
function mapVeriffStatus(decision) {
  switch ((decision ?? "").toLowerCase()) {
    case "approved":
      return "verified";
    case "declined":
      return "rejected";
    case "resubmission_requested":
    case "review":
    case "started":
      return "pending";
    case "expired":
      return "expired";
    default:
      return "pending";
  }
}

/**
 * Map Jumio callback status to internal KYC status.
 * See: https://github.com/Jumio/implementation-guides/blob/master/netverify/callback.md
 */
function mapJumioStatus(verificationStatus, idScanStatus) {
  const combined = `${verificationStatus ?? ""}:${idScanStatus ?? ""}`.toLowerCase();
  if (combined.includes("approved_verified")) return "verified";
  if (combined.includes("denied") || combined.includes("failed")) return "rejected";
  if (combined.includes("expired")) return "expired";
  return "pending";
}

// ---------------------------------------------------------------------------
// Middleware: capture raw body for HMAC verification
// ---------------------------------------------------------------------------
function rawBodyCapture(req, res, next) {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    req.rawBody = raw;
    try {
      req.body = JSON.parse(raw || "{}");
    } catch {
      req.body = {};
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/kyc/webhook/veriff
// ---------------------------------------------------------------------------
router.post("/webhook/veriff", rawBodyCapture, (req, res) => {
  const signature = req.headers["x-hmac-signature"];

  if (!verifyVeriffSignature(req.rawBody, signature)) {
    logger.warn("Veriff webhook: invalid signature", { ip: req.ip });
    return sendError(res, 401, "invalid_signature", "Invalid webhook signature");
  }

  const payload = req.body;
  /*
   * Expected Veriff payload shape:
   * {
   *   "verification": {
   *     "id": "session-uuid",
   *     "status": "approved",
   *     "person": { "idNumber": "G...", ... },
   *     "vendorData": "<walletAddress>",
   *     "decision": { "status": "approved" }
   *   }
   * }
   */
  const verification = payload?.verification ?? payload;
  const decision = verification?.status ?? verification?.decision?.status;
  // vendorData is where integrations pass custom metadata (we use wallet address)
  const walletAddress = verification?.vendorData ?? verification?.person?.idNumber ?? null;
  const sessionId = verification?.id ?? null;

  const resolvedStatus = mapVeriffStatus(decision);

  logger.info("Veriff KYC webhook received", {
    sessionId,
    decision,
    resolvedStatus,
    walletAddress: walletAddress ? `${walletAddress.substring(0, 8)}...` : "unknown",
  });

  // Always log the event
  const eventId = logKycEvent(
    "veriff",
    decision ?? "unknown",
    walletAddress,
    JSON.stringify(payload),
    resolvedStatus
  );

  if (!walletAddress || !isValidStellarAddress(walletAddress)) {
    logger.warn("Veriff webhook: could not resolve wallet address", { sessionId, eventId });
    // Still return 200 — we logged it, provider should not retry
    return res.json({ success: true, eventId, note: "wallet_address_unresolved" });
  }

  // Update KYC status in database
  const kycRecord = upsertKycStatus(walletAddress, resolvedStatus, "veriff", sessionId);

  // Sync kycStatus to the onboarding checklist
  try {
    upsertContributorOnboarding(walletAddress, {
      kycStatus: resolvedStatus === "verified" ? "verified" : resolvedStatus === "rejected" ? "unverified" : "pending",
    });
  } catch (err) {
    logger.warn("Failed to sync KYC status to onboarding", { walletAddress, error: err.message });
  }

  // Audit log
  addAuditLog("system", "kyc_status_updated", "veriff-webhook", {
    walletAddress,
    sessionId,
    decision,
    resolvedStatus,
    eventId,
  });

  return res.json({ success: true, eventId, walletAddress, resolvedStatus });
});

// ---------------------------------------------------------------------------
// POST /api/v1/kyc/webhook/jumio
// ---------------------------------------------------------------------------
router.post("/webhook/jumio", express.json(), (req, res) => {
  const authHeader = req.headers["authorization"];

  if (!verifyJumioAuth(authHeader)) {
    logger.warn("Jumio webhook: invalid auth", { ip: req.ip });
    return sendError(res, 401, "invalid_auth", "Invalid webhook authorization");
  }

  const payload = req.body;
  /*
   * Expected Jumio callback shape:
   * {
   *   "jumioIdScanReference": "scan-uuid",
   *   "merchantIdScanReference": "<walletAddress>",
   *   "verificationStatus": "APPROVED_VERIFIED",
   *   "idScanStatus": "SUCCESS",
   *   ...
   * }
   */
  const walletAddress = payload?.merchantIdScanReference ?? payload?.customerId ?? null;
  const verificationStatus = payload?.verificationStatus ?? null;
  const idScanStatus = payload?.idScanStatus ?? null;
  const sessionId = payload?.jumioIdScanReference ?? null;

  const resolvedStatus = mapJumioStatus(verificationStatus, idScanStatus);

  logger.info("Jumio KYC webhook received", {
    sessionId,
    verificationStatus,
    idScanStatus,
    resolvedStatus,
    walletAddress: walletAddress ? `${walletAddress.substring(0, 8)}...` : "unknown",
  });

  const eventId = logKycEvent(
    "jumio",
    `${verificationStatus ?? "unknown"}:${idScanStatus ?? ""}`,
    walletAddress,
    JSON.stringify(payload),
    resolvedStatus
  );

  if (!walletAddress || !isValidStellarAddress(walletAddress)) {
    logger.warn("Jumio webhook: could not resolve wallet address", { sessionId, eventId });
    return res.json({ success: true, eventId, note: "wallet_address_unresolved" });
  }

  const kycRecord = upsertKycStatus(walletAddress, resolvedStatus, "jumio", sessionId);

  try {
    upsertContributorOnboarding(walletAddress, {
      kycStatus: resolvedStatus === "verified" ? "verified" : resolvedStatus === "rejected" ? "unverified" : "pending",
    });
  } catch (err) {
    logger.warn("Failed to sync KYC status to onboarding", { walletAddress, error: err.message });
  }

  addAuditLog("system", "kyc_status_updated", "jumio-webhook", {
    walletAddress,
    sessionId,
    verificationStatus,
    idScanStatus,
    resolvedStatus,
    eventId,
  });

  return res.json({ success: true, eventId, walletAddress, resolvedStatus });
});

// ---------------------------------------------------------------------------
// GET /api/v1/kyc/status/:walletAddress
// ---------------------------------------------------------------------------
router.get("/status/:walletAddress", (req, res) => {
  const { walletAddress } = req.params;

  if (!isValidStellarAddress(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "Invalid Stellar wallet address");
  }

  const record = getKycStatus(walletAddress);
  const events = getKycEvents(walletAddress, 10);

  return res.json({
    success: true,
    data: {
      walletAddress,
      verification_status: record?.verification_status ?? "not_started",
      provider: record?.provider ?? null,
      provider_session_id: record?.provider_session_id ?? null,
      updated_at: record?.updated_at ?? null,
      recentEvents: events.map((e) => ({
        id: e.id,
        provider: e.provider,
        event_type: e.event_type,
        resolved_status: e.resolved_status,
        created_at: e.created_at,
      })),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/kyc/events — Admin: full event audit log
// ---------------------------------------------------------------------------
router.get("/events", (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const events = getAllKycEvents(limit, offset);

  return res.json({
    success: true,
    data: events,
    pagination: { limit, offset, count: events.length },
  });
});

export { router as kycWebhooksRouter };
