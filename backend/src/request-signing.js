/**
 * Ed25519 HTTP request signature verification (issue #392).
 *
 * Canonical signing message:
 *   METHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256_HEX
 *
 * Headers:
 *   X-Wallet-Address — Stellar G-address of the signer
 *   X-Timestamp      — Unix epoch seconds
 *   X-Nonce          — Unique per-request UUID
 *   X-Signature      — Base64 Ed25519 signature over the canonical message
 */
import { createHash, timingSafeEqual, randomUUID } from "crypto";
import StellarSdk from "@stellar/stellar-sdk";
import { sendError } from "./error-response.js";
import logger from "./logger.js";

const { Keypair } = StellarSdk;

const MAX_SIGNATURE_AGE_MS = parseInt(
  process.env.REQUEST_SIGNING_MAX_AGE_MS ?? String(5 * 60 * 1000),
  10
);

/** When false, unsigned requests are allowed (backwards compatibility). */
export function isRequestSigningRequired() {
  return process.env.REQUEST_SIGNING_REQUIRED === "true";
}

/** In-memory nonce cache with TTL to prevent replay attacks. */
const usedNonces = new Map();

function pruneNonces() {
  const now = Date.now();
  for (const [nonce, expiresAt] of usedNonces) {
    if (expiresAt <= now) usedNonces.delete(nonce);
  }
}

function markNonceUsed(nonce) {
  pruneNonces();
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, Date.now() + MAX_SIGNATURE_AGE_MS);
  return true;
}

export function hashRequestBody(body) {
  const serialized =
    body === undefined || body === null
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Build the canonical message clients must sign.
 */
export function buildCanonicalMessage({ method, path, timestamp, nonce, bodyHash }) {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

/**
 * Verify an Ed25519 signature for a wallet address.
 */
export function verifyWalletSignature(walletAddress, message, signatureBase64) {
  try {
    const keypair = Keypair.fromPublicKey(walletAddress);
    const signature = Buffer.from(signatureBase64, "base64");
    const payload = Buffer.from(message, "utf8");
    return keypair.verify(payload, signature);
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Sign a request (used by tests and documented for clients).
 */
export function signRequest({
  method,
  path,
  body,
  walletSecret,
  timestamp = Math.floor(Date.now() / 1000),
  nonce = randomUUID(),
}) {
  const keypair = Keypair.fromSecret(walletSecret);
  const bodyHash = hashRequestBody(body);
  const message = buildCanonicalMessage({
    method,
    path,
    timestamp,
    nonce,
    bodyHash,
  });
  const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");
  return {
    headers: {
      "X-Wallet-Address": keypair.publicKey(),
      "X-Timestamp": String(timestamp),
      "X-Nonce": nonce,
      "X-Signature": signature,
    },
    message,
  };
}

/**
 * Express middleware — validates Ed25519 signatures on write operations.
 */
export function verifyRequestSignatureMiddleware(req, res, next) {
  const walletAddress = req.get("X-Wallet-Address");
  const timestampHeader = req.get("X-Timestamp");
  const nonce = req.get("X-Nonce");
  const signature = req.get("X-Signature");

  const hasAnyHeader = walletAddress || timestampHeader || nonce || signature;
  const required = isRequestSigningRequired();

  if (!hasAnyHeader && !required) {
    return next();
  }

  if (!walletAddress || !timestampHeader || !nonce || !signature) {
    return sendError(
      res,
      401,
      "missing_signature",
      "Request signature headers are required: X-Wallet-Address, X-Timestamp, X-Nonce, X-Signature"
    );
  }

  if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 401, "invalid_signature", "Invalid wallet address in signature headers");
  }

  const timestampSec = parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestampSec)) {
    return sendError(res, 401, "invalid_signature", "X-Timestamp must be a Unix epoch in seconds");
  }

  const ageMs = Math.abs(Date.now() - timestampSec * 1000);
  if (ageMs > MAX_SIGNATURE_AGE_MS) {
    return sendError(
      res,
      401,
      "signature_expired",
      `Signature timestamp is outside the allowed window (${MAX_SIGNATURE_AGE_MS / 1000}s)`
    );
  }

  if (!markNonceUsed(nonce)) {
    return sendError(res, 401, "replay_detected", "Nonce has already been used");
  }

  const bodyHash = hashRequestBody(req.body);
  const message = buildCanonicalMessage({
    method: req.method,
    path: req.originalUrl.split("?")[0],
    timestamp: timestampSec,
    nonce,
    bodyHash,
  });

  if (!verifyWalletSignature(walletAddress, message, signature)) {
    logger.warn("Request signature verification failed", {
      path: req.originalUrl,
      walletAddress,
    });
    return sendError(res, 401, "invalid_signature", "Request signature verification failed");
  }

  if (
    req.body &&
    typeof req.body === "object" &&
    "walletAddress" in req.body &&
    !safeEqual(req.body.walletAddress, walletAddress)
  ) {
    return sendError(
      res,
      401,
      "wallet_mismatch",
      "X-Wallet-Address does not match body.walletAddress"
    );
  }

  req.signedWalletAddress = walletAddress;
  next();
}

/** Reset nonce cache (tests only). */
export function _resetNonceCache() {
  usedNonces.clear();
}
