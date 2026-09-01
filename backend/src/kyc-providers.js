/**
 * KYC provider payload normalisation — closes #598.
 *
 * Each provider sends a different webhook format. This module parses
 * each provider's payload and returns a normalised object:
 *
 *   { providerSessionId, walletAddress, outcome, rawPayload }
 *
 * Supported providers:
 *   • Veriff  — sends `verification.status` in a nested `verification` object
 *   • Jumio   — sends `verificationStatus` at top level
 *
 * Adding a new provider: add an entry to PROVIDER_PARSERS below.
 */

import logger from "./logger.js";
import { KYC_EVENT_OUTCOMES } from "./database/kyc.js";

// ─── Veriff status mapping ──────────────────────────────────────────────────

const VERIFF_STATUS_MAP = {
  approved: "approved",
  declined: "declined",
  resubmission_requested: "resubmission_requested",
  expired: "expired",
  abandoned: "abandoned",
};

function parseVeriff(body) {
  const verification = body?.verification;
  if (!verification) {
    throw new Error("Veriff payload missing 'verification' object");
  }

  const sessionId = verification.id;
  if (!sessionId) {
    throw new Error("Veriff payload missing verification.id");
  }

  const rawStatus = (verification.status ?? "").toLowerCase();
  const outcome = VERIFF_STATUS_MAP[rawStatus];
  if (!outcome) {
    throw new Error(`Unrecognised Veriff status: "${rawStatus}"`);
  }

  // Veriff stores the Stellar wallet in vendorData if set by the client
  const walletAddress = verification.vendorData ?? null;

  return { providerSessionId: sessionId, walletAddress, outcome };
}

// ─── Jumio status mapping ───────────────────────────────────────────────────

const JUMIO_STATUS_MAP = {
  approved_verified: "approved",
  denied_fraud: "declined",
  denied_unsupported_id_type: "declined",
  denied_unsupported_id_country: "declined",
  error_not_readable_id: "resubmission_requested",
  no_id_uploaded: "resubmission_requested",
  expired: "expired",
  abandoned: "abandoned",
};

function parseJumio(body) {
  const sessionId = body?.jumioIdScanReference ?? body?.transactionReference;
  if (!sessionId) {
    throw new Error("Jumio payload missing jumioIdScanReference / transactionReference");
  }

  const rawStatus = (body?.verificationStatus ?? body?.idScanStatus ?? "").toLowerCase();
  const outcome = JUMIO_STATUS_MAP[rawStatus] ?? null;
  if (!outcome) {
    throw new Error(`Unrecognised Jumio status: "${rawStatus}"`);
  }

  // Jumio stores merchant reference in customerInternalReference
  const walletAddress = body?.customerInternalReference ?? null;

  return { providerSessionId: sessionId, walletAddress, outcome };
}

// ─── Registry ───────────────────────────────────────────────────────────────

const PROVIDER_PARSERS = { veriff: parseVeriff, jumio: parseJumio };

/**
 * Normalise a KYC provider webhook payload.
 *
 * @param {string} provider  - "veriff" | "jumio"
 * @param {object} body      - Parsed JSON body from the webhook request
 * @returns {{ providerSessionId: string, walletAddress: string|null, outcome: string }}
 * @throws {Error} if the provider is unknown or the payload is malformed
 */
export function normaliseKycPayload(provider, body) {
  const parser = PROVIDER_PARSERS[provider];
  if (!parser) {
    throw new Error(`Unknown KYC provider: "${provider}"`);
  }

  const result = parser(body);

  if (!KYC_EVENT_OUTCOMES.includes(result.outcome)) {
    logger.warn("KYC outcome not in known list", { provider, outcome: result.outcome });
  }

  return result;
}

/**
 * Map a KYC outcome to a contributor_verification step + status update.
 *
 * "approved"                  → step: "verified",       status: "completed"
 * "declined"                  → step: "rejected",       status: "failed"
 * "resubmission_requested"    → step: "kyc",            status: "failed"
 * "expired" | "abandoned"     → step: "kyc",            status: "failed"
 *
 * @param {string} outcome
 * @returns {{ step: string, status: string }}
 */
export function outcomeToVerificationState(outcome) {
  switch (outcome) {
    case "approved":
      return { step: "verified", status: "completed" };
    case "declined":
      return { step: "rejected", status: "failed" };
    case "resubmission_requested":
    case "expired":
    case "abandoned":
    default:
      return { step: "kyc", status: "failed" };
  }
}
