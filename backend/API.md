# Stellar Royalty Splitter — HTTP API

Base URL: `http://localhost:3001` (default)

All JSON POST bodies must use `Content-Type: application/json`.
JSON request bodies are limited to `10kb`; oversized requests return `413 Payload Too Large`.

## Health

### `GET /api/v1/health`

Operator health check for the backend and Stellar connectivity.

**Response**

```json
{
  "ok": true,
  "dbVersion": 2,
  "network": "Testnet",
  "horizon": {
    "connected": true,
    "url": "https://horizon-testnet.stellar.org"
  },
  "contract": {
    "configured": true,
    "contractId": "C...",
    "deployed": true,
    "initialized": true,
    "status": "initialized"
  }
}
```

| Field | Description |
| ----- | ----------- |
| `ok` | `true` when Horizon is reachable and any configured contract is healthy |
| `dbVersion` | SQLite schema migration version |
| `network` | `Testnet` or `Mainnet` (from `STELLAR_NETWORK`) |
| `horizon.connected` | Whether Horizon responded successfully |
| `horizon.url` | Configured `HORIZON_URL` |
| `contract.status` | `not_configured`, `deployed`, `initialized`, `unreachable`, or `error` |

Configure the default contract with `ROYALTY_CONTRACT_ID` or `CONTRACT_ID`. Responses are cached for `HEALTH_CACHE_TTL_MS` (default 30s).

Legacy `/api/*` paths redirect to `/api/v1/*`.

## Request signing (#392)

Write operations (`POST`, `PUT`, `DELETE`) may require Ed25519 request signatures when `REQUEST_SIGNING_REQUIRED=true`.

**Headers:**

| Header | Description |
| ------ | ----------- |
| `X-Wallet-Address` | Stellar `G...` address of the signer |
| `X-Timestamp` | Unix epoch seconds (max age 5 minutes) |
| `X-Nonce` | Unique UUID per request (replay protection) |
| `X-Signature` | Base64 Ed25519 signature |

**Canonical message:**

```
METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256_HEX(body)
```

Example path: `/api/v1/initialize`. Unsigned requests are allowed when signing is not required (default in development).

Invalid or missing signatures return `401`.

## Initialize

### `POST /api/v1/initialize`

Build an unsigned `initialize` transaction XDR.

**Body:** `{ contractId, walletAddress, collaborators, shares, nonce? }`

| Field | Type | Description |
| ----- | ---- | ----------- |
| `nonce` | string (optional) | UUID v4. When provided, permanently deduplicates this request per contract (#421) — see below. |

**Response:** `{ xdr, transactionId }`

Initialize requests are rejected before contract processing when the request body is too large or when the serialized `collaborators` array exceeds the initialize payload guard.

**Request deduplication by nonce (#421):**

`nonce` is distinct from the `Idempotency-Key` header used on `/distribute`:

- **`Idempotency-Key`** (see Distribute below) caches the *response* for a TTL window (default 24h) and *replays* it on a repeated request with the same key.
- **`nonce`** is *permanently* recorded per `(contractId, nonce)` pair. A second request reusing the same nonce for the same contract is rejected outright — it is never re-processed and the original response is never replayed. This lets a client distinguish an intentional retry (reuse a nonce on purpose to confirm rejection) from an accidental duplicate submission, without relying on a cache TTL.

If `(contractId, nonce)` has already been seen, the request is rejected before any transaction is built or recorded:

**Response:** `409 Conflict`

```json
{ "error": "A request with this nonce has already been processed for this contract." }
```

The same `nonce` value may be reused across *different* contracts — the uniqueness constraint is scoped to `(contractId, nonce)`, not `nonce` alone. Generate a nonce on the frontend with `crypto.randomUUID()` (see `frontend/src/lib/request-nonce.ts`).

**Oversized payload response:** `413 Payload Too Large`

```json
{
  "error": "Payload too large"
}
```

Collaborator-specific payload limit responses use:

```json
{
  "error": "Collaborators payload too large"
}
```

### `POST /api/v1/initialize/commit` (#403)

Commit-reveal phase 1 — stores hashed collaborator/share data on-chain.

**Body:** `{ contractId, walletAddress, collaboratorsHash, sharesHash, nonce }` (64-char hex strings)

**Response:** `{ xdr, transactionId, phase: "commit" }`

### `POST /api/v1/initialize/reveal` (#403)

Commit-reveal phase 2 — reveals collaborators and initializes after ≥1 ledger delay.

**Body:** `{ contractId, walletAddress, collaborators, shares, salt }`

**Response:** `{ xdr, transactionId, phase: "reveal" }`

## Distribute

### `POST /api/v1/distribute`

Build an unsigned `distribute` transaction XDR.

**Body:** `{ contractId, walletAddress, tokenId }`

**Headers (optional):**
- `Idempotency-Key`: String (1-255 alphanumeric characters, hyphens, or underscores). When provided, prevents duplicate transaction submissions within a 24-hour window. If the same key is used within the window, returns the cached response instead of creating a new transaction.

**Response:** `{ xdr, transactionId }`

**Idempotency:**

The distribute endpoint supports idempotency to prevent duplicate transaction submissions caused by network timeouts or client retries. When an `Idempotency-Key` header is provided:

1. The first request with a given key processes normally and caches the response
2. Subsequent requests with the same key within 24 hours return the cached response
3. Cached responses are automatically expired after 24 hours
4. Only successful responses (2xx status codes) are cached

**Cache key format:**

The cache key is a composite of the user's wallet address and a SHA-256 hash of the full request body, not the raw `Idempotency-Key` header value. This prevents collisions between different legitimate requests whose clients happen to derive their keys from overlapping fields (e.g. just `contractId` + `amount`).

```
{walletAddress}:{sha256-hex-of-stable-json-body}
```

Components:
- **walletAddress** — Per-user scope extracted from `req.body.walletAddress`. Falls back to `"unknown"` when not present.
- **sha256** — SHA-256 hex digest of the full request body serialized with stable (sorted-key) JSON. Object keys are sorted lexicographically so the same logical object always produces the same hash.

**Prevents these collision scenarios:**
- Two requests with the same `contractId` + `amount` but different `tokenId` or other body fields produce different cache keys (body hash differs).
- Two identical requests from different wallet addresses produce different cache keys (wallet prefix differs).

**Example:**

```bash
curl -X POST http://localhost:3001/api/v1/distribute \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: dist-abc-123" \
  -d '{"contractId":"C...","walletAddress":"G...","tokenId":"C..."}'
```

If the request times out and is retried with the same `Idempotency-Key`, the second request will return the same `xdr` and `transactionId` without creating a duplicate transaction.

**Configuration:**

| Variable | Default | Purpose |
|---|---|---|
| `IDEMPOTENCY_CACHE_TTL_MS` | `86400000` (24 hours) | How long to cache idempotent responses |
| `IDEMPOTENCY_MAX_ENTRIES` | `10000` | Maximum number of cached responses before eviction |

## Simulate Distribution

### `POST /api/v1/simulate`

Dry-run the `distribute` call via Soroban simulation. Returns the expected fee, recipient amounts, and any contract errors without broadcasting or modifying state.

**Body:** `{ contractId, walletAddress, tokenId }`

**Response:**
```json
{
  "fee": 100,
  "recipientAmounts": [
    { "address": "G...", "amount": "500" },
    { "address": "G...", "amount": "500" }
  ],
  "contractError": null
}
```

- `fee`: The expected Soroban resource fee returned by simulation
- `recipientAmounts`: Array of `{ address, amount }` entries decoded from simulated `dist` events. Amounts are strings to preserve integer precision. The array is empty if simulation fails before payouts are emitted.
- `contractError`: Error message if simulation failed, otherwise `null`

The endpoint only calls Soroban RPC simulation. It does not submit the transaction, record a transaction row, or modify contract state.

## Collaborators

### `GET /api/v1/collaborators/:contractId`

Returns on-chain collaborator addresses and shares.

Cached in memory for 5 minutes (#422) — far longer than the 30s contract-state cache, since collaborator shares are effectively immutable once a contract is initialized. Cache key format: `contract:{network}:{contractId}:collaborators`. The cache is invalidated immediately whenever `/api/v1/initialize` or `/api/v1/initialize/reveal` successfully builds a transaction for that contract, rather than relying solely on the 5-minute TTL to pick up the new collaborator list.

## Caching strategy (#422)

| Cache | TTL | Key format | Invalidation |
| ----- | --- | ---------- | ------------- |
| Contract state (`GET /contract/state`) | 30s | `contract:{network}:{contractId}:state:{tokenId}` | TTL only — state (balance, royalty rate) can change at any time, so a short TTL is the primary defense. |
| Collaborator list (`GET /collaborators/:contractId`) | 5min | `contract:{network}:{contractId}:collaborators` | TTL, plus explicit invalidation on successful initialize/reveal for that contract. |

Both caches are in-memory `Map`s local to a single backend process (no Redis/shared cache layer). Cache hit/miss counts are exposed on the `/metrics` endpoint as `stellar_cache_hits_total{cache="..."}` / `stellar_cache_misses_total{cache="..."}` with `cache` values `contract_state` and `collaborators`.

## Contract

### `GET /api/v1/contract/state`

Returns the configured contract's current state for frontend displays: admin address, royalty rate, recipient shares, token balance, and network details. Responses are cached in memory for 30 seconds to reduce Soroban RPC calls.

Cache key format: `contract:{network}:{contractId}:state:{tokenId}` (#422). The network segment is included because the same `contractId` string can be queried against both testnet and mainnet; without it, those two distinct on-chain states would alias to the same cache entry.

Uses `ROYALTY_CONTRACT_ID` or `CONTRACT_ID` by default. Pass `contractId` to override. Uses `ROYALTY_TOKEN_ID`, `TOKEN_CONTRACT_ID`, or `TOKEN_ID` by default for the balance token. Pass `tokenId` to override.

**Response:**

```json
{
  "contractId": "C...",
  "adminAddress": "G...",
  "royaltyRate": 500,
  "recipients": [
    { "address": "G...", "basisPoints": 5000 },
    { "address": "G...", "basisPoints": 5000 }
  ],
  "balance": "10000000",
  "tokenId": "C...",
  "network": "Testnet",
  "networkPassphrase": "Test SDF Network ; September 2015"
}
```

### `GET /api/v1/contract/info`

Returns the configured contract's current on-chain state for frontend initialization and operator dashboards. This legacy endpoint is not cached.

Uses `ROYALTY_CONTRACT_ID` or `CONTRACT_ID` by default. Pass `contractId` to override. Uses `ROYALTY_TOKEN_ID`, `TOKEN_CONTRACT_ID`, or `TOKEN_ID` by default for the balance token. Pass `tokenId` to override.

**Response:**

```json
{
  "contractId": "C...",
  "adminAddress": "G...",
  "royaltyRate": 500,
  "recipients": [
    { "address": "G...", "basisPoints": 5000 },
    { "address": "G...", "basisPoints": 5000 }
  ],
  "balance": "10000000",
  "tokenId": "C...",
  "network": "Testnet"
}
```

### `GET /api/v1/contract/status/:contractId`

**Response:** `{ initialized: boolean }`

### `GET /api/v1/contract/balance/:contractId?tokenId=...`

**Response:** `{ balance: string }`

### `GET /api/v1/contract/collaborator-count/:contractId`

**Response:** `{ contractId, count }`

### `GET /api/v1/contract/shares-total/:contractId`

**Response:** `{ contractId, totalShares }`

## Metrics

### `GET /metrics`

Prometheus scrape endpoint. Also available at `GET /api/v1/metrics`.

Exposes:

- `stellar_distribute_calls_total`
- `stellar_transactions_successful_total`
- `stellar_transactions_failed_total`
- `stellar_horizon_response_time_average_ms`
- `stellar_horizon_response_time_count`
- `stellar_cache_hits_total{cache="..."}` (#422)
- `stellar_cache_misses_total{cache="..."}` (#422)

## Local Seed

### `scripts/seed.ts`

Deploys the contract to Testnet, initializes recipients, sets a royalty rate, funds the contract with a configured token, and writes `.contract-id` plus backend environment values.

Run with:

```bash
npx tsx scripts/seed.ts
```

Required environment:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `SEED_TOKEN_ID` | — | Testnet token contract used to fund the royalty contract |
| `STELLAR_NETWORK` | `testnet` | Must be `testnet` for the seed script |
| `STELLAR_IDENTITY` | `deployer` | Stellar CLI identity used to deploy and sign |
| `SEED_COLLABORATORS` | admin address | JSON array or comma-separated recipient addresses |
| `SEED_SHARES` | `10000` | JSON array or comma-separated basis-point shares; must sum to 10000 |
| `SEED_ROYALTY_RATE_BPS` | `500` | Royalty rate to set after initialization |
| `SEED_FUND_AMOUNT` | `10000000` | Token amount transferred to the contract |

## Secondary royalty

### `POST /api/secondary-royalty`

Record a secondary (resale) NFT sale and build an unsigned `record_secondary_royalty` transaction XDR.

**Body:** `{ contractId, walletAddress, nftId, previousOwner, newOwner, salePrice, saleToken, royaltyRate }`

**Response:** `{ xdr, transactionId, royaltyAmount, royaltyRateUsed }`

Returns `409 Conflict` if the sale has already been recorded (SQLite unique constraint).

### `POST /api/secondary-royalty/distribute`

Build an unsigned `distribute_secondary_royalties` transaction XDR and mark pending sales as distributed.

**Body:** `{ contractId, walletAddress, tokenId, collaborators? }`

Optionally pass `collaborators` (array of `{ address, basisPoints }` summing to 10000) to split using the largest-remainder algorithm (#427).

**Response:** `{ xdr, transactionId, numberOfSales, totalRoyalties, dustAllocated, allocations? }`

### `POST /api/secondary-royalty/set-rate`

Build an unsigned `set_royalty_rate` transaction XDR.

**Body:** `{ contractId, walletAddress, royaltyRate }` (`royaltyRate` in basis points, 0–10000)

**Response:** `{ xdr, transactionId }`

### `GET /api/secondary-royalty/rate/:contractId`

Returns the current on-chain royalty rate.

**Response:** `{ contractId, royaltyRate }`

### `GET /api/secondary-royalty/pool/:contractId`

Returns the current secondary royalty pool balance.

**Response:** `{ poolBalance }`

### `GET /api/secondary-royalty/stats/:contractId`

Returns aggregated royalty statistics. Results are cached in-memory for 60 seconds.

**Response:** `{ totalSecondarySales, totalRoyaltiesGenerated, totalVolume, pendingRoyaltyPool, lastDistribution }`

### `GET /api/secondary-royalty/sales/:contractId`

Paginated list of secondary sales with optional date-range and NFT filtering.

**Query parameters:**

| Param | Type | Default | Constraints |
| ----- | ---- | ------- | ----------- |
| `limit` | integer | `10` | `1`–`100` |
| `offset` | integer | `0` | `0`–`1000000` |
| `nftId` | string | — | Optional NFT identifier filter |
| `startDate` | ISO 8601 string | — | Optional lower bound on `timestamp` |
| `endDate` | ISO 8601 string | — | Optional upper bound on `timestamp`; must be ≥ `startDate` |

Invalid `limit` or `offset` values return `400` with validation details. Invalid date strings or `startDate > endDate` also return `400`.

**Response:** `{ sales: [...], total: number }`

### `GET /api/secondary-royalty/distributions/:contractId`

Paginated list of secondary royalty distribution records.

**Query parameters:**

| Param | Type | Default | Constraints |
| ----- | ---- | ------- | ----------- |
| `limit` | integer | `10` | `1`–`100` |
| `offset` | integer | `0` | `0`–`1000000` |

**Response:** `{ distributions: [...], pagination: { limit, offset } }`

## History & analytics

### `GET /api/v1/history/:contractId`

Paginated transaction history for a contract.

**Query parameters:**

| Param | Type | Default | Constraints |
| ----- | ---- | ------- | ----------- |
| `limit` | integer | `10` | `1`–`100` |
| `offset` | integer | `0` | `0`–`1000000` |

Invalid pagination returns `400` with validation details.

**Example:**

```bash
curl "http://localhost:3001/api/v1/history/C...?limit=10&offset=0"
```

**Response:**

```json
{
  "success": true,
  "data": [],
  "pagination": { "limit": 10, "offset": 0, "total": 0 }
}
```

### `GET /api/v1/audit/:contractId`

Paginated audit log. Same `limit` / `offset` constraints as history.

### `GET /api/v1/analytics/:contractId`

Aggregated analytics for a contract.

**Query parameters:**

| Param | Type | Default | Constraints |
| ----- | ---- | ------- | ----------- |
| `start` | ISO date | 90 days ago | Valid date string |
| `end` | ISO date | now | Valid date string |
| `collaboratorLimit` | integer | `10` | `1`–`100` — caps `collaboratorStats` rows |

**Rate limiting:** History, audit, and analytics endpoints share a dedicated limiter (default 30 req/min per IP) in addition to the general API limiter.

## Transaction confirmation

### `POST /api/v1/transaction/confirm/:txHash`

Poll Horizon until the transaction is confirmed in a ledger (#297), update the database, and fire distribute-completion webhooks (#295).

**Body (optional):**

```json
{
  "transactionId": 42,
  "blockTime": "2026-05-31T12:00:00.000Z",
  "errorMessage": null
}
```

| Field | Description |
| ----- | ----------- |
| `transactionId` | Links the on-chain hash to a pending row created by `/distribute` when the DB row has no `txHash` yet |
| `blockTime` | Optional ISO timestamp; defaults to Horizon `created_at` when omitted |

**Response:**

```json
{
  "success": true,
  "status": "confirmed",
  "ledger": 123456,
  "message": "Transaction abc12345... marked as confirmed"
}
```

| Status | Meaning |
| ------ | ------- |
| `200` | Transaction confirmed (or failed) on-chain and DB updated |
| `400` | Invalid hash or `transactionId` |
| `404` | Transaction not found |
| `409` | Transaction already settled or hash mismatch |
| `504` | Horizon polling timed out (`TRANSACTION_POLL_TIMEOUT_MS`) |

When a distribute transaction is confirmed, registered webhooks receive a POST payload (see Webhooks below).

## Webhooks

Operators can register HTTPS webhook URLs that receive a POST payload when a distribute transaction is confirmed on-chain (#295).

### `POST /api/v1/webhooks/:contractId`

Register a webhook URL.

**Body:** `{ "url": "https://example.com/webhooks/distribute" }`

**Response:** `{ "success": true, "webhookId": 1, "url": "...", "message": "Webhook registered" }`

### `GET /api/v1/webhooks/:contractId`

List active webhooks for a contract.

**Response:** `{ "success": true, "data": [{ "id": 1, "contractId": "C...", "url": "...", "enabled": 1, "createdAt": "..." }] }`

### `DELETE /api/v1/webhooks/:contractId/:webhookId`

Disable a registered webhook.

**Response:** `{ "success": true, "message": "Webhook removed" }`

### Webhook payload

When a distribute transaction is confirmed, each registered webhook receives:

```json
{
  "event": "distribute.confirmed",
  "transactionHash": "abc...",
  "contractId": "C...",
  "tokenId": "C...",
  "requestedAmount": "1000",
  "status": "confirmed",
  "recipients": [
    { "address": "G...", "amount": "500" }
  ],
  "timestamp": "2026-05-31T12:00:00.000Z"
}
```

Failed deliveries are retried with exponential backoff (`WEBHOOK_MAX_RETRIES`, default 3).

## Operational configuration

The Soroban RPC and Horizon clients are configurable via the following
environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon endpoint (used for fee stats and connectivity probes) |
| `STELLAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `SOROBAN_RPC_TIMEOUT_MS` | `10000` | Per-call timeout for Soroban RPC (#273). On timeout the route returns HTTP 504 with `Soroban RPC timed out after Nms`. |
| `HORIZON_TIMEOUT_MS` | `10000` | Per-call timeout for Horizon (fee fetch + health probe). |
| `HORIZON_FEE_CACHE_MS` | `30000` | How long the recommended fee (#274) is cached before re-fetching. |
| `HEALTH_CHECK_TIMEOUT_MS` | `5000` | Timeout for the `/health` Horizon connectivity probe. |
| `TRANSACTION_POLL_TIMEOUT_MS` | `60000` | Max time to poll Horizon for transaction confirmation (#297). |
| `TRANSACTION_POLL_INTERVAL_MS` | `2000` | Delay between Horizon poll attempts (#297). |
| `WEBHOOK_MAX_RETRIES` | `3` | Max delivery attempts per webhook (#295). |
| `WEBHOOK_RETRY_BASE_MS` | `1000` | Base backoff for webhook retries (#295). |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per-request timeout for webhook POST calls (#295). |

When the fee fetch fails the backend falls back to `BASE_FEE` (`100` stroops) so transaction submission keeps working.

Transactions built via `retryBuildTx` refresh the account sequence (#275) on every attempt; retries never reuse a stale sequence. Concurrent builds for the same wallet address are serialized with a per-address lock (#294) so simultaneous requests never fetch the same sequence number and fail with `tx_bad_seq`.

## Admin — signing key rotation

### `POST /admin/rotate-key`

Hot-reload the server signing key without redeploying the backend (#293). The in-memory key is used for server-side operations that require a keypair (for example read-only simulations). User-facing transaction routes still return unsigned XDR for client-side signing.

**Authentication:** `Authorization: Bearer <ADMIN_ROTATE_TOKEN>`

**Body (JSON):** provide one of:

| Field | Type | Description |
| ----- | ---- | ----------- |
| `secretKey` | string | New Stellar secret key (`S...`) to load immediately |
| `reloadFromFile` | boolean | When `true`, re-read `SIGNING_KEY_FILE` from disk |

**Response:**

```json
{
  "publicKey": "G...",
  "rotatedAt": "2026-05-30T12:00:00.000Z",
  "source": "api"
}
```

| Status | Meaning |
| ------ | ------- |
| `200` | Key rotated successfully |
| `400` | Validation error (missing body fields or invalid secret) |
| `401` | Missing or invalid admin token |
| `503` | `ADMIN_ROTATE_TOKEN` is not configured on the server |

**Configuration**

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `SERVER_SECRET_KEY` | — | Initial signing secret from environment |
| `SIGNING_KEY_FILE` | — | Path to a secrets-manager file; takes precedence on startup and when `reloadFromFile` is true |
| `ADMIN_ROTATE_TOKEN` | — | Bearer token required to call `/admin/rotate-key` |
| `RATE_LIMIT_ADMIN_MAX` | `5` | Per-IP rate limit for admin routes (per minute) |

Key rotation events are written to structured logs (`signing_key_rotated`) with previous and new **public** keys only — secret material is never logged.

## Admin — API keys & per-key rate limiting (#420)

Per-IP rate limiting (`generalLimiter`, `writeLimiter`, etc. — see Operational configuration) is shared across every client behind the same IP, so a single bad actor can exhaust another tenant's quota, and there's no way to give a programmatic/API-key client its own independent quota. API keys solve this: each key gets its own sliding-window rate limit, tracked separately from the IP-based limiters (both apply — the API-key limit is additive, not a replacement).

### `POST /admin/generate-key`

Issue a new API key. **The raw key is only ever returned in this response** — only its SHA-256 hash is persisted, so it can never be retrieved again. If it's lost, revoke it and generate a new one.

**Authentication:** `Authorization: Bearer <ADMIN_ROTATE_TOKEN>` (same token as `/admin/rotate-key`)

**Body (JSON):** `{ "label"?: string }` (max 100 characters)

**Response:**

```json
{
  "id": 1,
  "apiKey": "srs_9f2c...",
  "label": "ci-bot",
  "createdAt": "2026-05-30T12:00:00.000Z"
}
```

### `GET /admin/keys`

List all API keys. Never includes the raw key or its hash.

**Authentication:** `Authorization: Bearer <ADMIN_ROTATE_TOKEN>`

**Response:**

```json
{
  "keys": [
    { "id": 1, "label": "ci-bot", "createdAt": "2026-05-30T12:00:00.000Z", "revokedAt": null, "lastUsedAt": "2026-05-30T12:05:00.000Z" }
  ]
}
```

### `POST /admin/keys/:id/revoke`

Revoke a key by id. Revoked keys are rejected immediately on their next request.

**Authentication:** `Authorization: Bearer <ADMIN_ROTATE_TOKEN>`

**Response:** `{ "success": true, "id": 1 }`, or `404` if the id doesn't exist or is already revoked.

### Using an API key

Send the raw key on the `X-API-Key` request header on any `/api/v1/*` call. Every response (success, 401, or 429) includes:

| Header | Meaning |
| ------ | ------- |
| `X-RateLimit-Limit` | Max requests allowed per window for this key (`API_KEY_RATE_LIMIT_MAX`) |
| `X-RateLimit-Remaining` | Requests remaining in the current sliding window |
| `X-RateLimit-Reset` | Unix seconds when the oldest counted request falls out of the window |

An unknown or revoked key returns `401 invalid_api_key`. Exceeding the limit returns `429 too_many_requests` (still with the three headers above, `X-RateLimit-Remaining: 0`). Requests with no `X-API-Key` header are unaffected — they continue to be limited only by the per-IP limiters.

The limiter uses a true sliding window (a per-key timestamp log, not a fixed-window approximation): the oldest entries are dropped as the window moves rather than the count resetting all at once at a fixed boundary.

**Configuration:**

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `API_KEY_RATE_LIMIT_WINDOW_MS` | `60000` (1 minute) | Sliding window size |
| `API_KEY_RATE_LIMIT_MAX` | `60` | Max requests per key per window |
