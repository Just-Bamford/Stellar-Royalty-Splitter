/**
 * Ed25519 request signing utility (#392).
 *
 * Signs outgoing POST/PUT/DELETE requests so the backend can verify they
 * originated from the authenticated wallet holder and have not been tampered
 * with in transit.
 *
 * Canonical signed string
 * -----------------------
 * The signature covers the UTF-8 encoding of:
 *
 *   <METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<BODY_SHA256_HEX>
 *
 * where BODY_SHA256_HEX is the lowercase hex SHA-256 of the raw JSON body
 * bytes sent in the request (SHA-256 of empty bytes when there is no body).
 *
 * This format is mirrored exactly by buildSignedString() in the backend's
 * verify-signature.js so both sides always agree on what was signed.
 *
 * Usage
 * -----
 *   import { signRequest } from "./utils/sign-request";
 *
 *   const headers = await signRequest(keypair, "POST", "/api/v1/distribute", bodyJson);
 *   // Spread `headers` into fetch() options alongside Content-Type.
 */

import { Keypair } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a string to UTF-8 bytes. */
function toUtf8Bytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * SHA-256 of a Uint8Array via the Web Crypto API.
 * Returns a lowercase hex string.
 */
async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generate a cryptographically random nonce (URL-safe base64, 24 chars).
 * Uses crypto.getRandomValues which is available in all modern browsers
 * and Node ≥ 15.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(18); // 18 bytes → 24 base64 chars
  crypto.getRandomValues(bytes);
  // base64url without padding
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ---------------------------------------------------------------------------
// Canonical signed-string builder
// ---------------------------------------------------------------------------

/**
 * Build the UTF-8 bytes the Stellar keypair should sign.
 *
 * @param method    - Uppercase HTTP method, e.g. "POST"
 * @param path      - Absolute path + query string, e.g. "/api/v1/distribute"
 * @param timestamp - Millisecond epoch as a string
 * @param nonce     - Random nonce string
 * @param bodyBytes - Raw UTF-8 bytes of the JSON body (empty Uint8Array if none)
 */
export async function buildSignedString(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyBytes: Uint8Array,
): Promise<Uint8Array> {
  const bodyHash = await sha256Hex(bodyBytes);
  const canonical = `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  return toUtf8Bytes(canonical);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignatureHeaders {
  "X-Signature": string;
  "X-Signed-By": string;
  "X-Nonce": string;
  "X-Timestamp": string;
}

/**
 * Sign a request and return the four signature headers to attach.
 *
 * @param keypair   - Stellar Keypair that has a secret key (from Freighter or
 *                    a locally-held key). Must expose `.sign(Buffer): Buffer`.
 * @param method    - HTTP method ("POST", "PUT", "DELETE")
 * @param path      - The absolute URL path + query string, e.g. "/api/v1/distribute"
 * @param body      - The request body object that will be JSON-serialised and
 *                    sent. Pass `null` or `undefined` for bodyless requests.
 * @returns         Four headers ready to spread into a fetch() `headers` object.
 *
 * @example
 * ```ts
 * const headers = await signRequest(keypair, "POST", "/api/v1/distribute", body);
 * await fetch("/api/v1/distribute", {
 *   method: "POST",
 *   headers: { "Content-Type": "application/json", ...headers },
 *   body: JSON.stringify(body),
 * });
 * ```
 */
export async function signRequest(
  keypair: Keypair,
  method: string,
  path: string,
  body: unknown,
): Promise<SignatureHeaders> {
  const timestamp = String(Date.now());
  const nonce = generateNonce();

  const bodyString = body !== null && body !== undefined ? JSON.stringify(body) : "";
  const bodyBytes = toUtf8Bytes(bodyString);

  const signedStringBytes = await buildSignedString(method, path, timestamp, nonce, bodyBytes);

  // Keypair.sign() expects a Buffer in stellar-sdk v12
  const signedBuffer = Buffer.from(signedStringBytes);
  const signature = keypair.sign(signedBuffer);
  const signatureHex = Buffer.from(signature).toString("hex");

  return {
    "X-Signature": signatureHex,
    "X-Signed-By": keypair.publicKey(),
    "X-Nonce": nonce,
    "X-Timestamp": timestamp,
  };
}

/**
 * Convenience wrapper: signs the request using a Stellar secret key string.
 * Use this when the key is directly available (e.g. in server-side utilities
 * or integration tests).
 *
 * For browser/Freighter contexts where the raw secret is never exposed, build
 * a Keypair from the secret obtained via secure storage and use `signRequest`.
 */
export async function signRequestWithSecret(
  secretKey: string,
  method: string,
  path: string,
  body: unknown,
): Promise<SignatureHeaders> {
  const keypair = Keypair.fromSecret(secretKey);
  return signRequest(keypair, method, path, body);
}
