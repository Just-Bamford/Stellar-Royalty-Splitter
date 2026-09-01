# RPC Retry Handler Configuration

## Environment Variables

Configure the centralized RPC retry behavior with these environment variables:

### RPC_MAX_RETRIES

Maximum number of retry attempts for transient failures.

- **Type**: Integer
- **Default**: `3`
- **Example**: `RPC_MAX_RETRIES=5`

### RPC_BASE_BACKOFF_MS

Initial backoff delay in milliseconds for the first retry.

- **Type**: Integer (milliseconds)
- **Default**: `1000` (1 second)
- **Example**: `RPC_BASE_BACKOFF_MS=500`

### RPC_MAX_BACKOFF_MS

Maximum backoff delay cap in milliseconds.

- **Type**: Integer (milliseconds)
- **Default**: `30000` (30 seconds)
- **Example**: `RPC_MAX_BACKOFF_MS=60000`

## Transient vs Permanent Errors

The retry handler automatically classifies errors:

### Transient Errors (Retried)

- **HTTP 408**: Request Timeout
- **HTTP 429**: Rate Limit
- **HTTP 503**: Service Unavailable
- **HTTP 504**: Gateway Timeout
- **Network Errors**: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EHOSTUNREACH
- **Timeout Messages**: Any error message containing "timeout"
- **Network Error Messages**: Connection/network related messages

### Permanent Errors (NOT Retried)

- **HTTP 400**: Bad Request
- **HTTP 401**: Unauthorized
- **HTTP 403**: Forbidden
- **HTTP 404**: Not Found
- **Simulation Errors**: Contract execution failures
- **Account Not Found**: Caller account doesn't exist on network
- **Invalid XDR**: Malformed transaction data

## Special Cases

### Transaction Submission

Never automatically retried to prevent duplicate operations:

- `operationType: "submitTransaction"`
- `operationType: "submit"`

Will log a warning if attempted and reject immediately.

## Backoff Strategy

Uses exponential backoff with jitter:

```
Delay = min(baseBackoff * 2^(attempt-1), maxBackoff) * (0.9 to 1.1 random factor)

Attempt 1: ~1000ms (±10%)
Attempt 2: ~2000ms (±10%)
Attempt 3: ~4000ms (±10%)
```

The jitter prevents thundering herd when multiple requests fail simultaneously.

## Usage in Code

### Basic Usage

```javascript
import { withRetry } from "./rpc-retry.js";

const account = await withRetry(() => server.getAccount(address), {
  operationType: "getAccount",
  details: { address: "G..." },
});
```

### Custom Retry Logic

```javascript
const result = await withRetry(operation, {
  operationType: "customOp",
  maxRetries: 5,
  baseBackoffMs: 500,
  shouldRetry: (error, attemptNumber) => {
    // Custom retry predicate
    return error?.response?.status === 503;
  },
  details: { transactionId: "..." },
});
```

### Preventing Retries

```javascript
const result = await withRetry(operation, {
  operationType: "submitTransaction", // Never retried
});
```

## Logging

All retry attempts are logged with safe, non-sensitive information:

```json
{
  "event": "rpc_retry_attempt",
  "operationType": "getAccount",
  "attemptNumber": 1,
  "totalAttempts": 3,
  "errorReason": "rate_limit",
  "errorCategory": "http_429",
  "nextRetryDelayMs": 1234
}
```

Successful retries are logged at INFO level:

```json
{
  "event": "rpc_retry_success",
  "operationType": "getAccount",
  "successfulAttempt": 2
}
```

Exhausted retries are logged at ERROR level:

```json
{
  "event": "rpc_retry_exhausted",
  "operationType": "getAccount",
  "totalAttempts": 3,
  "errorReason": "service_unavailable"
}
```

## Metrics

Track retry behavior via `retryMetrics`:

```javascript
import { retryMetrics } from "./rpc-retry.js";

const metrics = retryMetrics.getMetrics();
// {
//   totalRetryAttempts: 15,
//   successfulRetries: 12,
//   exhaustedRetries: 3,
//   successRate: "80.00"
// }
```

## Integration Points

Currently integrated with:

- `getFreshAccount()` - Account sequence number fetching
- `getRecommendedFee()` - Dynamic fee recommendation

Add to other RPC calls as needed:

```javascript
export async function getTransaction(txHash) {
  return withRetry(() => server.getTransaction(txHash), {
    operationType: "getTransaction",
    details: { txHash: txHash.slice(0, 8) },
  });
}
```

## Examples

### Handle Rate Limiting

```javascript
const account = await withRetry(() => server.getAccount(address), {
  operationType: "getAccount",
  maxRetries: 5, // More aggressive for rate limits
  baseBackoffMs: 2000, // Longer initial backoff
});
```

### Fast Fail for Non-Transient Errors

```javascript
const result = await withRetry(operation, {
  operationType: "prepare",
  shouldRetry: (error) => {
    // Only retry on timeout or rate limit
    return error?.status === 429 || error?.status === 504;
  },
});
```

### Custom Details for Debugging

```javascript
const account = await withRetry(() => server.getAccount(address), {
  operationType: "getAccount",
  details: {
    address: address.slice(0, 8) + "...",
    requestId: req.id,
    userId: user.id,
  },
});
```
