import { Keypair } from "@stellar/stellar-sdk";

export const REQUEST_SIGNING_SECRET_STORAGE_KEY = "srs_request_signing_secret";

export interface SignedRequestHeaders {
  "x-srs-public-key": string;
  "x-srs-signature": string;
  "x-srs-timestamp": string;
  "x-srs-nonce": string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

export function buildSignedRequestPayload(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: unknown;
}): string {
  return canonicalize({
    method: input.method.toUpperCase(),
    path: input.path,
    timestamp: input.timestamp,
    nonce: input.nonce,
    body: input.body ?? null,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function getConfiguredSigningSecret(): string | null {
  const sessionSecret = sessionStorage.getItem(REQUEST_SIGNING_SECRET_STORAGE_KEY);
  if (sessionSecret) return sessionSecret;
  return import.meta.env.VITE_REQUEST_SIGNING_SECRET ?? null;
}

export function setRequestSigningSecret(secret: string | null): void {
  if (secret) {
    sessionStorage.setItem(REQUEST_SIGNING_SECRET_STORAGE_KEY, secret);
  } else {
    sessionStorage.removeItem(REQUEST_SIGNING_SECRET_STORAGE_KEY);
  }
}

export function createSignedRequestHeaders(input: {
  method: string;
  path: string;
  body: unknown;
}): SignedRequestHeaders {
  const secret = getConfiguredSigningSecret();
  if (!secret) {
    throw new Error(
      "Missing request signing secret. Set VITE_REQUEST_SIGNING_SECRET or call setRequestSigningSecret().",
    );
  }

  const keypair = Keypair.fromSecret(secret);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const payload = buildSignedRequestPayload({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    body: input.body,
  });
  const signature = keypair.sign(new TextEncoder().encode(payload));

  return {
    "x-srs-public-key": keypair.publicKey(),
    "x-srs-signature": bytesToBase64(signature),
    "x-srs-timestamp": timestamp,
    "x-srs-nonce": nonce,
  };
}
