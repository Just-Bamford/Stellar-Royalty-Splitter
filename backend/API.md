# Stellar Royalty Splitter — HTTP API

Base URL: `http://localhost:3001` (default)

All JSON POST bodies must use `Content-Type: application/json`.
JSON request bodies are limited to `10kb`; oversized requests return `413 Payload Too Large`.
Mutating JSON requests (`POST`, `PUT`, and `PATCH`) are subject to a **Request Complexity Budget** (default limit: `1000`, configured via `REQUEST_COMPLEXITY_LIMIT`). Requests exceeding this limit return `400 Bad Request` (`code: request_too_complex`).

## Error responses

Every error response — validation failures, contract/RPC errors, rate limiting,
and internal errors — uses the same JSON shape and is built by
`backend/src/error-response.js`:

```json
{
  "status": 400,
  "code": "validation_failed",
  "message": "Collaborators array must be non-empty",
  "error": "Collaborators array must be non-empty",
  "retryable": false,
  "retryAfter": null,
  "details_url": "docs/errors#validation_failed",
  "details": [{ "field": "collaborators", "message": "Collaborators array must be non-empty" }]
}
```

| Field | Description |
| ----- | ----------- |
| `status` | HTTP status code, duplicated in the body for clients that only inspect JSON |
| `code` | Stable, machine-readable error code — safe to branch on in frontend/integration code. Never changes across releases for the same failure class. |
| `message` | Human-readable message. Safe to display to end users. |
| `error` | Same value as `message` — kept for backward compatibility with older clients that read `.error` |
| `retryable` | Boolean indicating whether the request can be retried |
| `retryAfter` | Suggested retry delay in seconds (null if not retryable) |
| `details_url` | Link to error documentation in the error catalog |
| `details` | Present only on validation errors; an array of `{ field, message }` issues |
| `complexity_score` | Present on `request_too_complex` errors; computed complexity score |
| `limit` | Present on `request_too_complex` errors; maximum allowed complexity score |

Stack traces and other internal details are never included in a response —
they're written to the server-side logger (`backend/src/logger.js`) instead,
keyed by request path/method so they can be correlated with the request log
line.

**Stable error codes**

| Code | Typical status | Meaning |
| ---- | ---- | ---- |
| `validation_failed` | 400 | Request body/query failed schema or manual validation |
| `bad_request` | 400 | Generic malformed request (fallback for unlisted 400s) |
| `request_too_complex` | 400 | Request body exceeds configured complexity limit (#892) |
| `invalid_contract_id` | 400 | `contractId` is not a valid `C...` Soroban contract address |
| `invalid_stellar_address` | 400 | A wallet address is not a valid `G...` Stellar address |
| `invalid_query_parameter` | 400 | A query param (e.g. `limit`/`offset`) failed validation |
| `unauthorized` | 401 | Missing or invalid authentication |
| `forbidden` | 403 | Authenticated but not permitted (RBAC) |
| `not_found` | 404 | Resource does not exist |
| `already_initialized` | 409 | `initialize` called on a contract that's already initialized |
| `conflict` | 409 | Generic conflict (fallback for unlisted 409s) |
| `payload_too_large` | 413 | Request body (or a specific field) exceeds its size limit |
| `unsupported_media_type` | 415 | POST without `Content-Type: application/json` |
| `contract_simulation_failed` | 400 | Soroban simulation of a contract read/call failed |
| `too_many_requests` | 429 | Rate limit exceeded (general, write, or admin limiter) |
| `internal_server_error` | 500 | Unexpected server-side failure |
| `service_unavailable` / `request_timeout` | 503 | Downstream (RPC) unavailable, or the request exceeded `REQUEST_TIMEOUT_MS` |

Any status without a listed code above falls back to `error` via
`normalizeErrorCode()` (`backend/src/error-response.js`) — this only happens
for statuses not yet given a specific code and should be treated as a gap to
fill, not a stable code to depend on.

## Request Complexity Budgeting (#892)

To prevent resource exhaustion from deeply nested structures, giant arrays, or excessive key-value pairs that remain below raw byte-size limits, incoming request bodies are scored using a deterministic complexity algorithm before expensive downstream parsing, schema validations, or cryptographic verification occur.
By default, the middleware applies to `POST`, `PUT`, and `PATCH` requests.

### Scoring Rules

| Component | Weight / Formula | Rationale |
| :--- | :--- | :--- |
| **Base Payload** | `+1` | Fixed base overhead for any parsed payload |
| **Object Key (Field Count)** | `+1` per key | Proportional to key parsing, hashing, and schema traversal |
| **Array Element** | `+1` per element | Proportional to array iteration, allocation, and item validation |
| **Nested Structure** | `+2` per object/array | Overhead of initializing nested scopes and sub-validators |
| **Nesting Depth** | `+(depth * 3)` | Multiplier penalizing deep recursive hierarchies |
| **String Volume** | `+Math.floor(length / 256)` | Additional score for large text fields within nested structures |

### Configuration

Deployments can configure or override the complexity budget via environment variable:

```env
REQUEST_COMPLEXITY_LIMIT=1000
```

### Error Response Example (HTTP 400)

When a request exceeds the limit, it is rejected immediately with HTTP 400:

```json
{
  "status": 400,
  "code": "request_too_complex",
  "message": "Request exceeds maximum complexity limit of 1000 (calculated score: 1052)",
  "error": "Request exceeds maximum complexity limit of 1000 (calculated score: 1052)",
  "retryable": false,
  "retryAfter": null,
  "details_url": "docs/errors#request_too_complex",
  "complexity_score": 1052,
  "limit": 1000
}
```


## Health

### `GET /health`

Liveness probe — confirms the API process is running. Does not touch the
database or Horizon, so it's safe to poll frequently (deployment platforms,
uptime monitors). Always returns `200` if the process can respond at all.

**Response**

```json
{ "status": "ok", "network": "Testnet", "uptime": 1234.5 }
```

### `GET /ready`

Readiness probe — confirms the dependencies required to serve traffic
(local SQLite database, Stellar Horizon) are reachable. Returns `503` when
any dependency is down so orchestrators can hold traffic until the service
recovers. Never runs contract transactions or expensive RPC calls.

**Response**

```json
{
  "status": "ready",
  "dependencies": { "database": true, "horizon": true }
}
```

`status` is `"not_ready"` and the HTTP status is `503` when any dependency
in `dependencies` is `false`.

### `GET /api/v1/health`

Operator health check for the backend and Stellar connectivity — richer
than `/health`, includes contract deployment status and DB metrics.

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

## Initialize

### `POST /api/v1/initialize`

Build an unsigned `initialize` transaction XDR.

**Body:** `{ contractId, walletAddress, collaborators, shares }`

**Response:** `{ xdr, transactionId }`

Initialize requests are rejected before contract processing when the request body is too large or when the serialized `collaborators` array exceeds the initialize payload guard.

**Oversized payload response:** `413 Payload Too Large`

```json
{
  "status": 413,
  "code": "payload_too_large",
  "message": "Payload too large",
  "error": "Payload too large"
}
```

Collaborator-specific payload limit responses use:

```json
{
  "status": 413,
  "code": "payload_too_large",
  "message": "Collaborators payload too large",
  "error": "Collaborators payload too large"
}
```

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
  "contractError": null,
  "feeBreakdown": {
    "base_fee": 100,
    "priority_fee": 0,
    "resource_fee": 0,
    "total": 100
  },
  "perRecipientEffectiveFee": 50,
  "feeScalingComparison": [
    { "collaborators": 2, "estimated_total_fee": 110 },
    { "collaborators": 5, "estimated_total_fee": 140 },
    { "collaborators": 10, "estimated_total_fee": 190 },
    { "collaborators": 20, "estimated_total_fee": 290 }
  ]
}
```

- `fee`: The expected Soroban resource fee returned by simulation
- `recipientAmounts`: Array of `{ address, amount }` entries decoded from simulated `dist` events. Amounts are strings to preserve integer precision. The array is empty if simulation fails before payouts are emitted.
- `contractError`: Error message if simulation failed, otherwise `null`
- `feeBreakdown`: Object containing fee components:
  - `base_fee`: Stellar base fee (100 stroops)
  - `priority_fee`: Additional fee for priority processing
  - `resource_fee`: Soroban resource fee
  - `total`: Sum of all fee components
- `perRecipientEffectiveFee`: Total fee divided by number of recipients
- `feeScalingComparison`: Array showing estimated fee growth for 2, 5, 10, and 20 collaborators

The endpoint only calls Soroban RPC simulation. It does not submit the transaction, record a transaction row, or modify contract state.

## Collaborators

### `GET /api/v1/collaborators/:contractId`

Returns on-chain collaborator addresses and shares.

## Contract

### `GET /api/v1/contract/state`

Returns the configured contract's current state for frontend displays: admin address, royalty rate, recipient shares, token balance, and network details. Responses are cached for 30 seconds to reduce Soroban RPC calls.

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

### `GET /api/v1/secondary-royalty/sales/:contractId`

Returns paginated secondary sale records for a contract with optional filtering.

**Query params:**

| Param | Type | Default | Min | Max | Description |
| ----- | ---- | ------- | --- | --- | ----------- |
| `limit` | integer | `50` | `1` | `100` | Number of sales to return |
| `offset` | integer | `0` | `0` | — | Pagination offset |
| `nftId` | string | — | — | — | Filter to a specific NFT ID |
| `startDate` | ISO 8601 | — | — | — | Filter sales on or after this date |
| `endDate` | ISO 8601 | — | — | — | Filter sales on or before this date |

Returns `400` if `startDate` is after `endDate`, or if either date is not a valid ISO 8601 string.

### `GET /api/v1/secondary-royalty/distributions/:contractId`

Returns paginated secondary royalty distribution records for a contract.

**Query params:**

| Param | Type | Default | Min | Max | Description |
| ----- | ---- | ------- | --- | --- | ----------- |
| `limit` | integer | `10` | `1` | `100` | Number of distributions to return |
| `offset` | integer | `0` | `0` | — | Pagination offset |

**Response:**

```json
{
  "distributions": [ /* distribution objects */ ],
  "pagination": { "limit": 10, "offset": 0 }
}
```

**Example:**

```bash
curl "http://localhost:3001/api/v1/secondary-royalty/distributions/C...?limit=20&offset=40"
```

See route module `src/routes/secondary-royalty.js` for pool, stats, and set-rate endpoints.

## History & analytics

- `GET /api/v1/history/:contractId`
- `GET /api/v1/archive/:contractId`
- `GET /api/v1/archive/policy`
- `POST /api/v1/archive/policy`
- `POST /api/v1/archive/run`
- `GET /api/v1/analytics/:contractId`

All paginated read endpoints (`history`, `archive`, `audit`) share a common constraint model: `limit` is an integer between 1 and the endpoint-specific maximum; `offset` must be a non-negative integer. Invalid values return `400 Bad Request`.

These endpoints are subject to a dedicated read rate limiter (default 30 req/min per IP, configurable via `RATE_LIMIT_READ_MAX`) in addition to the global limiter.

Contract event archival moves `transactions` rows older than the configured retention period into `contract_event_archive`.
The default policy is enabled with a 90 day retention period.

### `GET /api/v1/history/:contractId`

Returns paginated transaction history for a contract.

**Query params:**

| Param | Type | Default | Min | Max | Description |
| ----- | ---- | ------- | --- | --- | ----------- |
| `limit` | integer | `50` | `1` | `100` | Number of transactions to return |
| `offset` | integer | `0` | `0` | — | Number of rows to skip (pagination offset) |

**Response:**

```json
{
  "success": true,
  "data": [ /* transaction objects */ ],
  "pagination": { "limit": 50, "offset": 0, "total": 142 }
}
```

**Example — page 2 with 20 results per page:**

```bash
curl "http://localhost:3001/api/v1/history/C...?limit=20&offset=20"
```

**Invalid pagination returns 400:**

```bash
curl "http://localhost:3001/api/v1/history/C...?limit=abc"
# → 400 { "code": "invalid_query_parameter", "message": "limit must be a number" }

curl "http://localhost:3001/api/v1/history/C...?limit=0"
# → 400 { "code": "invalid_query_parameter", "message": "limit must be a number" }

curl "http://localhost:3001/api/v1/history/C...?limit=101"
# → limit is clamped to 100 (parsePagination clamps silently)

curl "http://localhost:3001/api/v1/history/C...?offset=-1"
# → offset is clamped to 0 (parsePagination clamps silently)
```

### `GET /api/v1/analytics/:contractId`

Returns aggregated distribution analytics for a contract over a configurable date range.

**Query params:**

| Param | Type | Default | Constraints | Description |
| ----- | ---- | ------- | ----------- | ----------- |
| `start` | ISO 8601 string | 90 days ago | Valid date, must be ≤ `end` | Range start (inclusive) |
| `end` | ISO 8601 string | now | Valid date, must be ≥ `start` | Range end (inclusive) |
| `topLimit` | integer | `10` | 1–100 | Number of top earners to return |

Invalid date formats or a `start` after `end` return `400 Bad Request`. Results are cached for 60 seconds per `contractId + start + end + topLimit` combination.

**Example:**

```bash
# Default — last 90 days, top 10 earners
curl "http://localhost:3001/api/v1/analytics/C..."

# Custom range with 25 top earners
curl "http://localhost:3001/api/v1/analytics/C...?start=2024-01-01&end=2024-06-30&topLimit=25"
```

**Invalid query returns 400:**

```bash
curl "http://localhost:3001/api/v1/analytics/C...?start=not-a-date"
# → 400 { "code": "validation_failed", "message": "Invalid start date. Use ISO 8601 format." }

curl "http://localhost:3001/api/v1/analytics/C...?start=2024-12-31&end=2024-01-01"
# → 400 { "code": "validation_failed", "message": "start date must be before end date." }

curl "http://localhost:3001/api/v1/analytics/C...?topLimit=0"
# → 400 { "code": "validation_failed", "message": "topLimit must be at least 1" }
```

### `GET /api/v1/archive/:contractId`

Query archived contract events for a contract.

**Query params:**

| Param | Type | Default | Min | Max | Description |
| ----- | ---- | ------- | --- | --- | ----------- |
| `limit` | integer | `50` | `1` | `200` | Number of archived events to return |
| `offset` | integer | `0` | `0` | — | Pagination offset |

### `GET /api/v1/archive/policy`

Returns the current archive policy:

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "retentionDays": 90,
    "updatedAt": "2026-06-30 12:00:00"
  }
}
```

### `POST /api/v1/archive/policy`

Update archive retention configuration.

**Body:** `{ "enabled": true, "retentionDays": 90 }`

### `POST /api/v1/archive/run`

Runs one bounded archival batch. Events with `COALESCE(blockTime, timestamp)` older than the policy cutoff are copied into `contract_event_archive` with payout details and then removed from active `transactions`.

**Body (optional):** `{ "batchSize": 500 }`

**Response:** `{ "success": true, "data": { "archived": 12, "enabled": true, "retentionDays": 90, "cutoff": "2026-04-01T00:00:00.000Z", "durationMs": 8 } }`

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
| `RATE_LIMIT_MAX` | `100` | Max requests per window for unauthenticated (public) endpoints. |
| `RATE_LIMIT_AUTH_MAX` | `1000` | Max requests per window for authenticated (`x-api-key`) requests. |
| `RATE_LIMIT_WRITE_MAX` | `10` | Max requests per window for write/mutation endpoints (`initialize`, `distribute`, `secondary-royalty`, `webhooks`). |
| `RATE_LIMIT_READ_MAX` | `30` | Max requests per window for read-heavy query endpoints (`analytics`, `history`, `archive`, `audit`) per IP or API key (#394). |
| `RATE_LIMIT_ADMIN_MAX` | `5` | Max requests per window for admin routes (`/admin/*`). |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Sliding window duration for all rate limiters in milliseconds. |

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
