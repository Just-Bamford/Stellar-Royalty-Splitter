# Ed25519 Request Signature Verification

**Issue:** [#392](https://github.com/Just-Bamford/Stellar-Royalty-Splitter/issues/392) — HIGH-2 security finding  
**Status:** Implemented — required on all write endpoints  
**Mainnet blocker:** Must be enabled (`SIGNATURE_VERIFICATION_ENABLED=true`) before mainnet deployment

---

## Overview

All mutating API endpoints (POST/PUT/DELETE) require an Ed25519 request signature. The client signs a canonical representation of each request using their Stellar keypair; the backend verifies the signature before processing the request.

This prevents:
- **CSRF** — a cross-origin page cannot forge a signed request without the user's private key
- **Request tampering** — any modification to the method, path, body, timestamp, or nonce invalidates the signature
- **Replay attacks** — each request includes a unique nonce and a timestamp; the server rejects reused nonces and requests older than 5 minutes

---

## Protected Endpoints

| Endpoint | Method |
|---|---|
| `POST /api/v1/initialize` | Create/initialize a royalty contract |
| `POST /api/v1/distribute` | Trigger a royalty distribution |
| `POST /api/v1/secondary-royalty` | Record a secondary sale |
| `POST /api/v1/secondary-royalty/set-rate` | Set royalty rate |
| `POST /api/v1/secondary-royalty/distribute` | Distribute secondary royalties |

Read-only endpoints (`GET`) are not affected.

---

## Request Headers

Every protected request must include these four headers:

| Header | Format | Description |
|---|---|---|
| `X-Signature` | 128-char lowercase hex | 64-byte Ed25519 signature of the canonical string |
| `X-Signed-By` | `G...` (56 chars) | Stellar public key of the signer |
| `X-Nonce` | 16–128 alphanumeric chars, `-` or `_` | Unique random value; prevents replays |
| `X-Timestamp` | Positive integer string | Unix timestamp in **milliseconds** |

---

## Canonical Signed String

The signature must cover the UTF-8 encoding of:

```
<METHOD>\n<PATH>\n<TIMESTAMP>\n<NONCE>\n<BODY_SHA256_HEX>
```

Where:
- `METHOD` — uppercase HTTP verb, e.g. `POST`
- `PATH` — full URL path including query string, e.g. `/api/v1/distribute`
- `TIMESTAMP` — same ms-epoch string as `X-Timestamp`
- `NONCE` — same value as `X-Nonce`
- `BODY_SHA256_HEX` — lowercase hex SHA-256 of the raw JSON request body bytes; use SHA-256 of zero bytes (`e3b0c44298fc1c149afb...`) when there is no body

---

## Frontend Usage

Use the `signRequest` helper from `frontend/src/utils/sign-request.ts`:

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { signRequest } from "./utils/sign-request";

const keypair = Keypair.fromSecret(mySecretKey);
const body = { contractId, walletAddress, tokenId };

const sigHeaders = await signRequest(keypair, "POST", "/api/v1/distribute", body);

await fetch("/api/v1/distribute", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...sigHeaders,
  },
  body: JSON.stringify(body),
});
```

The `api.ts` methods `initialize`, `distribute`, `recordSecondarySale`, `setRoyaltyRate`, and `distributeSecondaryRoyalties` already call `signedPost` internally — pass the user's `Keypair` as the last argument.

---

## Backend Configuration

Set these environment variables (see `backend/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `SIGNATURE_VERIFICATION_ENABLED` | `true` | Set `false` for log-only mode during rollout |
| `SIGNATURE_MAX_AGE_MS` | `300000` (5 min) | Max age of a valid request timestamp |
| `SIGNATURE_NONCE_TTL_MS` | `600000` (10 min) | How long nonces are remembered |
| `SIGNATURE_NONCE_MAX_ENTRIES` | `50000` | In-memory nonce cache capacity |

### Gradual Rollout

Set `SIGNATURE_VERIFICATION_ENABLED=false` to run in **permissive mode**: invalid or missing signatures are logged as warnings but requests are still allowed through. This lets existing clients continue working while the frontend signing is deployed.

Once all clients are updated, set `SIGNATURE_VERIFICATION_ENABLED=true` to enforce signatures.

---

## Error Responses

| HTTP Status | `code` | Cause |
|---|---|---|
| `401` | `missing_signature` | One or more required headers absent |
| `400` | `invalid_signature_format` | `X-Signature` is not 128 hex chars |
| `400` | `invalid_signer_format` | `X-Signed-By` is not a valid `G...` key |
| `400` | `invalid_nonce_format` | `X-Nonce` fails format validation |
| `400` | `invalid_timestamp_format` | `X-Timestamp` is not a positive integer |
| `401` | `signature_expired` | Timestamp outside ±`SIGNATURE_MAX_AGE_MS` window |
| `401` | `nonce_reused` | Nonce has been seen in a previous request |
| `401` | `invalid_signature` | Ed25519 verification failed (wrong key or tampered body) |

---

## Implementation Notes

- **No new dependencies** — verification uses `Keypair.verify()` from `@stellar/stellar-sdk` (already installed), backed by `tweetnacl`.
- **Raw body capture** — `createBodySizeLimiters({ captureRawBody: true })` is set in `index.js` so `req.rawBody` is available to the middleware before JSON parsing rewrites it.
- **Nonce cache** — bounded in-memory LRU (Map insertion-order). Nonces are evicted after `SIGNATURE_NONCE_TTL_MS`. Capacity is capped at `SIGNATURE_NONCE_MAX_ENTRIES` to bound memory usage.
- **Nonce recorded after verification** — the nonce is only added to the cache on successful signature verification, preventing DoS via nonce-flooding with garbage signatures.

---

## Testing

```bash
cd backend
npm test -- --testPathPattern=verify-signature
```

13 test cases cover: valid signatures, missing headers, malformed header formats, wrong keypair, tampered body, expired timestamp, future timestamp, nonce replay, permissive mode, empty body, deterministic canonical string, and GET pass-through.
