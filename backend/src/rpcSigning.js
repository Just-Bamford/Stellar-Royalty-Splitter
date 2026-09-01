/**
 * Optional Soroban RPC request signing (#764).
 *
 * When SOROBAN_RPC_SIGNING_ENABLED=true and SERVER_SECRET_KEY is set, each
 * outbound RPC request is signed with the server's Ed25519 private key.
 * The signature is included in the `X-Stellar-Signature` header so that
 * self-hosted Soroban RPC endpoints can verify authenticity.
 *
 * This is disabled by default so existing integrations are unaffected.
 * Enable by setting:
 *   SOROBAN_RPC_SIGNING_ENABLED=true
 *   SERVER_SECRET_KEY=S...  (Stellar keypair secret)
 *
 * Signature format:
 *   base64(Ed25519_sign(privateKey, sha256(timestamp + ":" + body)))
 *
 * The timestamp (Unix seconds, as string) is also sent in `X-Stellar-Timestamp`
 * so the verifier can reject replayed requests older than 30 seconds.
 */

import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import logger from "./logger.js";

const SIGNING_ENABLED =
  process.env.SOROBAN_RPC_SIGNING_ENABLED === "true";

const REPLAY_WINDOW_SECS = parseInt(
  process.env.SOROBAN_RPC_REPLAY_WINDOW_SECS ?? "30",
  10,
);

let _keypair = null;

function getKeypair() {
  if (_keypair) return _keypair;
  const secret = process.env.SERVER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "SERVER_SECRET_KEY is required when SOROBAN_RPC_SIGNING_ENABLED=true",
    );
  }
  _keypair = Keypair.fromSecret(secret);
  return _keypair;
}

/**
 * Returns true when request signing is active.
 */
export function isSigningEnabled() {
  return SIGNING_ENABLED;
}

/**
 * Produce signing headers for an outbound RPC request body.
 *
 * @param {string|object} body - The request body (will be JSON-stringified if object).
 * @returns {{ "X-Stellar-Signature": string, "X-Stellar-Timestamp": string }}
 */
export function buildSigningHeaders(body) {
  if (!SIGNING_ENABLED) return {};

  const kp = getKeypair();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  const message = `${timestamp}:${bodyStr}`;
  const digest = crypto.createHash("sha256").update(message).digest();

  // Stellar SDK Keypair.sign() takes a raw Buffer/Uint8Array
  const signature = kp.sign(digest);
  const sigBase64 = Buffer.from(signature).toString("base64");

  return {
    "X-Stellar-Signature": sigBase64,
    "X-Stellar-Timestamp": timestamp,
    "X-Stellar-Public-Key": kp.publicKey(),
  };
}

/**
 * Verify a Soroban RPC response signature (when the server returns one).
 *
 * @param {string} sigBase64 - Value of X-Stellar-Signature response header.
 * @param {string} timestampStr - Value of X-Stellar-Timestamp response header.
 * @param {string|object} responseBody - Raw response body string or object.
 * @param {string} publicKey - Stellar public key (G...) to verify against.
 * @returns {boolean}
 */
export function verifyResponseSignature(sigBase64, timestampStr, responseBody, publicKey) {
  if (!SIGNING_ENABLED) return true;

  try {
    const timestamp = parseInt(timestampStr, 10);
    const now = Math.floor(Date.now() / 1000);

    if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECS) {
      logger.warn({ timestamp, now }, "RPC response signature rejected: timestamp outside replay window");
      return false;
    }

    const bodyStr =
      typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody);
    const message = `${timestampStr}:${bodyStr}`;
    const digest = crypto.createHash("sha256").update(message).digest();
    const sigBuf = Buffer.from(sigBase64, "base64");

    const kp = Keypair.fromPublicKey(publicKey);
    return kp.verify(digest, sigBuf);
  } catch (err) {
    logger.error({ err }, "RPC response signature verification error");
    return false;
  }
}

/**
 * Wraps a `fetch` call with optional signing headers injected.
 * Drop-in replacement for fetch in stellar.js RPC calls.
 *
 * @param {string} url
 * @param {RequestInit} options
 */
export async function signedFetch(url, options = {}) {
  if (!SIGNING_ENABLED) return fetch(url, options);

  const bodyStr =
    options.body != null
      ? typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body)
      : "";

  const sigHeaders = buildSigningHeaders(bodyStr);

  const mergedOptions = {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...sigHeaders,
    },
  };

  return fetch(url, mergedOptions);
}
