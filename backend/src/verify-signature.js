/**
 * Ed25519 request signature verification middleware (#392).
 *
 * Protects write endpoints (POST/PUT/DELETE) against CSRF, replay attacks, and
 * request tampering. The client signs a canonical payload with their Ed25519
 * private key (Stellar keypair); this middleware verifies the signature before
 * the route handler runs.
 *
 * Request contract
 * ----------------
 * Every protected request must include:
 *
 *   X-Signature   — hex-encoded 64-byte Ed25519 signature of the canonical
 *                   signed string (see below).
 *   X-Signed-By   — the Stellar G... public key whose private key signed the
 *                   request (e.g. the wallet address from the body).
 *   X-Nonce       — a unique random string (16–128 chars, alphanumeric +
 *                   hyphens/underscores) used to prevent replay attacks. Each
 *                   nonce is remembered for NONCE_TTL_MS (default: 10 min) and
 *                   rejected on re-use.
 *   X-Timestamp   — Unix timestamp in milliseconds (string). Requests older
 *                   than SIGNATURE_MAX_AGE_MS (default: 5 min) are rejected.
 *
 * Canonical signed string
 * -----------------------
 * The client must sign the UTF-8 bytes of:
 *
 *   <METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<BODY_SHA256_HEX>
 *
 * where:
 *   METHOD           — uppercase HTTP verb, e.g. "POST"
 *   PATH             — req.originalUrl (path + query string)
 *   TIMESTAMP        — same ms-epoch string sent in X-Timestamp
 *   NONCE            — same value sent in X-Nonce
 *   BODY_SHA256_HEX  — lowercase hex SHA-256 of the raw request body bytes
 *                      (use SHA-256 of empty bytes when there is no body)
 *
 * Environment flags
 * -----------------
 *   SIGNATURE_VERIFICATION_ENABLED  — "false" disables enforcement while
 *                                      keeping warning logs (gradual rollout).
 *                                      Default: "true".
 *   SIGNATURE_MAX_AGE_MS            — max timestamp age in ms (default: 300000)
 *   SIGNATURE_NONCE_TTL_MS          — how long nonces are remembered (default: 600000)
 *   SIGNATURE_NONCE_MAX_ENTRIES     — nonce cache capacity (default: 50000)
 */

import { createHash } from "crypto";
import StellarSdk from "@stellar/stellar-sdk";
import logger from "./logger.js";
import { sendError } from "./error-response.js";

const { Keypair } = StellarSdk;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const SIGNATURE_MAX_AGE_MS = parseInt(
  process.env.SIGNATURE_MAX_AGE_MS ?? String(5 * 60 * 1000),
  10,
);

export const NONCE_TTL_MS = parseInt(
  process.env.SIGNATURE_NONCE_TTL_MS ?? String(10 * 60 * 1000),
  10,
);

export const NONCE_MAX_ENTRIES = parseInt(
  process.env.SIGNATURE_NONCE_MAX_ENTRIES ?? "50000",
  10,
);

function isEnforcementEnabled() {
  return process.env.SIGNATURE_VERIFICATION_ENABLED !== "false";
}

// ---------------------------------------------------------------------------
// Nonce cache — bounded, LRU-style via Map insertion order
//
// Maps nonce → expiresAt (Unix ms). On each write we evict expired entries
// first; if still at capacity we evict the oldest entry (first key in Map).
// ---------------------------------------------------------------------------

const nonceCache = new Map();

function evictExpired() {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonceCache) {
    if (expiresAt <= now) nonceCache.delete(nonce);
  }
}

function isNonceSeen(nonce) {
  evictExpired();
  const expiresAt = nonceCache.get(nonce);
  return expiresAt !== undefined && expiresAt > Date.now();
}

function recordNonce(nonce) {
  evictExpired();
  if (nonceCache.size >= NONCE_MAX_ENTRIES) {
    nonceCache.delete(nonceCache.keys().next().value);
  }
  nonceCache.set(nonce, Date.now() + NONCE_TTL_MS);
}

/** Nonce cache stats for monitoring. */
export function getNonceCacheStats() {
  evictExpired();
  return { size: nonceCache.size, maxEntries: NONCE_MAX_ENTRIES, ttlMs: NONCE_TTL_MS };
}

/** Reset nonce cache — tests only. */
export function _clearNonceCache() {
  nonceCache.clear();
}

// ---------------------------------------------------------------------------
// Canonical signed-string builder (shared between backend and test helpers)
// ---------------------------------------------------------------------------

/**
 * Build the UTF-8 buffer the client must sign.
 *
 * @param {string}          method    - Uppercase HTTP method ("POST")
 * @param {string}          path      - req.originalUrl
 * @param {string}          timestamp - ms-epoch string from X-Timestamp
 * @param {string}          nonce     - value from X-Nonce
 * @param {Buffer|undefined} rawBody  - raw request body bytes (may be empty/null)
 * @returns {Buffer}
 */
export function buildSignedString(method, path, timestamp, nonce, rawBody) {
  const bodyHash = createHash("sha256")
    .update(rawBody && rawBody.length > 0 ? rawBody : Buffer.alloc(0))
    .digest("hex");

  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  return Buffer.from(canonical, "utf8");
}

// ---------------------------------------------------------------------------
// Header extraction & coarse validation
// ---------------------------------------------------------------------------

const NONCE_RE = /^[a-zA-Z0-9_-]{16,128}$/;
const HEX_SIG_RE = /^[0-9a-fA-F]{128}$/; // 64 bytes → 128 hex chars
const STELLAR_PUBKEY_RE = /^G[A-Z2-7]{55}$/;

/**
 * Extract and validate the four required signature headers.
 *
 * @returns {{ signature, signedBy, nonce, timestamp, tsNum }} on success
 *          or { error: { status, code, message } } on failure
 */
function extractHeaders(req) {
  const rawSig = req.headers["x-signature"];
  const signedBy = req.headers["x-signed-by"];
  const nonce = req.headers["x-nonce"];
  const timestamp = req.headers["x-timestamp"];

  if (!rawSig || !signedBy || !nonce || !timestamp) {
    return {
      error: {
        status: 401,
        code: "missing_signature",
        message:
          "Request must include X-Signature, X-Signed-By, X-Nonce, and X-Timestamp headers",
      },
    };
  }

  if (!HEX_SIG_RE.test(rawSig)) {
    return {
      error: {
        status: 400,
        code: "invalid_signature_format",
        message:
          "X-Signature must be a 128-character hex string (64-byte Ed25519 signature)",
      },
    };
  }

  if (!STELLAR_PUBKEY_RE.test(signedBy)) {
    return {
      error: {
        status: 400,
        code: "invalid_signer_format",
        message: "X-Signed-By must be a valid Stellar public key (G...)",
      },
    };
  }

  if (!NONCE_RE.test(nonce)) {
    return {
      error: {
        status: 400,
        code: "invalid_nonce_format",
        message:
          "X-Nonce must be 16–128 alphanumeric characters, hyphens, or underscores",
      },
    };
  }

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return {
      error: {
        status: 400,
        code: "invalid_timestamp_format",
        message: "X-Timestamp must be a positive integer (Unix milliseconds)",
      },
    };
  }

  return { signature: rawSig, signedBy, nonce, timestamp, tsNum };
}

// ---------------------------------------------------------------------------
// Core verification logic (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Verify an Ed25519 request signature.
 *
 * @param {object} params
 * @param {string}          params.method    - HTTP method
 * @param {string}          params.path      - req.originalUrl
 * @param {string}          params.signedBy  - Stellar G... public key
 * @param {string}          params.signature - hex-encoded 64-byte signature
 * @param {string}          params.nonce     - nonce from header
 * @param {string}          params.timestamp - ms-epoch string from header
 * @param {number}          params.tsNum     - parsed numeric timestamp
 * @param {Buffer|undefined} params.rawBody  - raw request body
 * @param {number}          [params.now]     - override clock for testing
 * @returns {{ ok: true } | { ok: false, status, code, message }}
 */
export function verifyRequestSignature({
  method,
  path,
  signedBy,
  signature,
  nonce,
  timestamp,
  tsNum,
  rawBody,
  now = Date.now(),
}) {
  // 1. Timestamp window
  const age = now - tsNum;
  if (age < 0 || age > SIGNATURE_MAX_AGE_MS) {
    return {
      ok: false,
      status: 401,
      code: "signature_expired",
      message: `Request timestamp is outside the allowed ±${SIGNATURE_MAX_AGE_MS / 1000}s window`,
    };
  }

  // 2. Nonce replay guard
  if (isNonceSeen(nonce)) {
    return {
      ok: false,
      status: 401,
      code: "nonce_reused",
      message: "Nonce has already been used. Each request must carry a unique nonce.",
    };
  }

  // 3. Parse public key
  let keypair;
  try {
    keypair = Keypair.fromPublicKey(signedBy);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_public_key",
      message: "X-Signed-By contains an invalid Stellar public key",
    };
  }

  // 4. Decode signature
  let sigBuffer;
  try {
    sigBuffer = Buffer.from(signature, "hex");
  } catch {
    return {
      ok: false,
      status: 400,
      code: "invalid_signature_encoding",
      message: "X-Signature could not be decoded as hex",
    };
  }

  // 5. Verify Ed25519 signature
  const signedString = buildSignedString(method, path, timestamp, nonce, rawBody);
  let valid = false;
  try {
    valid = keypair.verify(signedString, sigBuffer);
  } catch {
    valid = false;
  }

  if (!valid) {
    return {
      ok: false,
      status: 401,
      code: "invalid_signature",
      message: "Signature verification failed. The request may have been tampered with.",
    };
  }

  // 6. Record nonce only after successful verification to prevent DoS via
  //    flooding the cache with invalid signatures.
  recordNonce(nonce);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Signature verification middleware for write endpoints.
 *
 * When SIGNATURE_VERIFICATION_ENABLED=false the middleware logs a warning
 * and passes the request through (permissive mode for gradual rollout).
 *
 * Usage:
 *   app.use("/api/v1/distribute", verifySignatureMiddleware);
 *   // or per-route:
 *   router.post("/", verifySignatureMiddleware, validate(schema), handler);
 */
export function verifySignatureMiddleware(req, res, next) {
  // Skip GET / HEAD / OPTIONS — only protect mutating requests.
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }

  const extracted = extractHeaders(req);

  if (extracted.error) {
    const { status, code, message } = extracted.error;
    logger.warn("Signature verification failed: missing or malformed headers", {
      event: "signature_verification_failed",
      reason: code,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
    });

    if (!isEnforcementEnabled()) {
      logger.warn("Signature enforcement is disabled — allowing request through", {
        event: "signature_enforcement_disabled",
        path: req.originalUrl,
      });
      return next();
    }

    return sendError(res, status, code, message);
  }

  const { signature, signedBy, nonce, timestamp, tsNum } = extracted;

  const result = verifyRequestSignature({
    method: req.method,
    path: req.originalUrl,
    signedBy,
    signature,
    nonce,
    timestamp,
    tsNum,
    rawBody: req.rawBody,
  });

  if (!result.ok) {
    logger.warn("Signature verification failed", {
      event: "signature_verification_failed",
      reason: result.code,
      method: req.method,
      path: req.originalUrl,
      signedBy,
      ip: req.ip,
    });

    if (!isEnforcementEnabled()) {
      logger.warn("Signature enforcement is disabled — allowing request through", {
        event: "signature_enforcement_disabled",
        path: req.originalUrl,
      });
      return next();
    }

    return sendError(res, result.status, result.code, result.message);
  }

  logger.debug("Signature verified", {
    event: "signature_verified",
    method: req.method,
    path: req.originalUrl,
    signedBy,
  });

  // Attach verified signer to request so route handlers can use it.
  req.verifiedSigner = signedBy;

  next();
}
