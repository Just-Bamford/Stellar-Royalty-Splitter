/**
 * Client-side HTTP request signing (issue #392).
 * Signs write requests with the connected wallet via Freighter or SDK Keypair.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

const SIGNING_PATH_PREFIX = "/api/v1";

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64Encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function buildCanonicalMessage({
  method,
  path,
  timestamp,
  nonce,
  bodyHash,
}: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export async function hashRequestBody(body: unknown): Promise<string> {
  const serialized =
    body === undefined || body === null ? "" : JSON.stringify(body);
  return sha256Hex(serialized);
}

/**
 * Sign a request payload. Uses Freighter signMessage when available;
 * falls back to throwing if no signing method is available.
 */
export async function signWriteRequest({
  method,
  path,
  body,
  walletAddress,
}: {
  method: string;
  path: string;
  body: unknown;
  walletAddress: string;
}): Promise<Record<string, string>> {
  const apiPath = path.startsWith(SIGNING_PATH_PREFIX)
    ? path
    : `${SIGNING_PATH_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyHash = await hashRequestBody(body);
  const message = buildCanonicalMessage({
    method,
    path: apiPath,
    timestamp,
    nonce,
    bodyHash,
  });

  let signature: string;

  // @ts-expect-error Freighter global
  if (typeof window !== "undefined" && window.freighter?.signMessage) {
    // @ts-expect-error Freighter global
    const signed = await window.freighter.signMessage(message, {
      address: walletAddress,
    });
    signature =
      typeof signed === "string"
        ? signed
        : (signed?.signedMessage ?? signed?.signature ?? "");
    if (!signature) {
      throw new Error("Freighter did not return a signature");
    }
  } else {
    throw new Error(
      "Wallet message signing is required. Connect Freighter with signMessage support.",
    );
  }

  return {
    "X-Wallet-Address": walletAddress,
    "X-Timestamp": String(timestamp),
    "X-Nonce": nonce,
    "X-Signature": signature,
  };
}

/** Test helper — sign with a known secret key. */
export async function signWriteRequestWithSecret({
  method,
  path,
  body,
  walletSecret,
}: {
  method: string;
  path: string;
  body: unknown;
  walletSecret: string;
}): Promise<Record<string, string>> {
  const apiPath = path.startsWith(SIGNING_PATH_PREFIX)
    ? path
    : `${SIGNING_PATH_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
  const keypair = Keypair.fromSecret(walletSecret);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const bodyHash = await hashRequestBody(body);
  const message = buildCanonicalMessage({
    method,
    path: apiPath,
    timestamp,
    nonce,
    bodyHash,
  });
  const sig = keypair.sign(new TextEncoder().encode(message));
  return {
    "X-Wallet-Address": keypair.publicKey(),
    "X-Timestamp": String(timestamp),
    "X-Nonce": nonce,
    "X-Signature": base64Encode(sig),
  };
}
