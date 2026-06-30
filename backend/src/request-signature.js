import StellarSdk from "@stellar/stellar-sdk";

const { Keypair } = StellarSdk;

export const SIGNATURE_HEADERS = {
  publicKey: "x-srs-public-key",
  signature: "x-srs-signature",
  timestamp: "x-srs-timestamp",
  nonce: "x-srs-nonce",
};

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const usedNonces = new Map();

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

export function buildSignedRequestPayload({
  method,
  path,
  timestamp,
  nonce,
  body,
}) {
  return canonicalize({
    method: method.toUpperCase(),
    path,
    timestamp: String(timestamp),
    nonce,
    body: body ?? null,
  });
}

function getMaxAgeMs() {
  const configured = Number.parseInt(
    process.env.REQUEST_SIGNATURE_MAX_AGE_MS ?? "",
    10,
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_AGE_MS;
}

function cleanupNonceCache(now, maxAgeMs) {
  for (const [nonce, timestamp] of usedNonces.entries()) {
    if (now - timestamp > maxAgeMs) {
      usedNonces.delete(nonce);
    }
  }
}

function unauthorized(res, error) {
  return res.status(401).json({ error });
}

export function resetRequestSignatureNonces() {
  usedNonces.clear();
}

export function verifySignedWriteRequest(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }

  const publicKey = req.get(SIGNATURE_HEADERS.publicKey);
  const signature = req.get(SIGNATURE_HEADERS.signature);
  const timestamp = req.get(SIGNATURE_HEADERS.timestamp);
  const nonce = req.get(SIGNATURE_HEADERS.nonce);

  if (!publicKey || !signature || !timestamp || !nonce) {
    return unauthorized(res, "Missing request signature headers.");
  }

  const timestampMs = Number.parseInt(timestamp, 10);
  const now = Date.now();
  const maxAgeMs = getMaxAgeMs();

  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > maxAgeMs) {
    return unauthorized(res, "Request signature timestamp is expired or invalid.");
  }

  cleanupNonceCache(now, maxAgeMs);
  if (usedNonces.has(nonce)) {
    return unauthorized(res, "Request signature nonce has already been used.");
  }

  if (req.body?.walletAddress && req.body.walletAddress !== publicKey) {
    return unauthorized(res, "Request signer does not match walletAddress.");
  }

  let keypair;
  try {
    keypair = Keypair.fromPublicKey(publicKey);
  } catch {
    return unauthorized(res, "Invalid request signer public key.");
  }

  const payload = buildSignedRequestPayload({
    method: req.method,
    path: req.originalUrl,
    timestamp,
    nonce,
    body: req.body,
  });

  let signatureBytes;
  try {
    signatureBytes = Buffer.from(signature, "base64");
  } catch {
    return unauthorized(res, "Invalid request signature encoding.");
  }

  const valid = keypair.verify(Buffer.from(payload, "utf8"), signatureBytes);
  if (!valid) {
    return unauthorized(res, "Invalid request signature.");
  }

  usedNonces.set(nonce, timestampMs);
  return next();
}
