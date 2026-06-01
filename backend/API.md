# Stellar Royalty Splitter — HTTP API

Base URL: `http://localhost:3001` (default)

All JSON POST bodies must use `Content-Type: application/json`.

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

## Initialize

### `POST /api/v1/initialize`

Build an unsigned `initialize` transaction XDR.

**Body:** `{ contractId, walletAddress, collaborators, shares }`

**Response:** `{ xdr, transactionId }`

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

## Contract

### `GET /api/v1/contract/status/:contractId`

**Response:** `{ initialized: boolean }`

### `GET /api/v1/contract/balance/:contractId?tokenId=...`

**Response:** `{ balance: string }`

### `GET /api/v1/contract/collaborator-count/:contractId`

**Response:** `{ contractId, count }`

### `GET /api/v1/contract/shares-total/:contractId`

**Response:** `{ contractId, totalShares }`

## Secondary royalty

See route module `src/routes/secondary-royalty.js` for pool, sales, and distribution endpoints.

## History & analytics

- `GET /api/v1/history/:contractId`
- `GET /api/v1/analytics/:contractId`

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
