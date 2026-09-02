# Add In-Flight Request Deduplication for Idempotent Operations

## Problem

Duplicate requests arriving while the original operation is still running execute independently instead of reusing the in-flight result. This wastes computation on expensive operations (contract simulation, RPC calls, distribution prep).

**Files:** `backend/src/idempotency.js`, `backend/src/routes/distribute.js`

## Solution

Extend idempotency to detect in-flight requests. When an identical request is already executing, wait for its result instead of executing again.

### Implementation

- Generate a deterministic deduplication key (hash of operation + idempotency key)
- Store in-flight requests in memory with a 10 second timeout
- Concurrent identical requests share the same in-flight promise
- Remove entries after completion or timeout

## Acceptance Criteria

- [ ] Idempotent routes use deduplication middleware
- [ ] In-flight requests identified by deterministic key
- [ ] Concurrent identical requests execute once
- [ ] Duplicate callers receive original result
- [ ] In-flight entries cleaned up after completion/failure
- [ ] Entries expire after 10s (configurable via `IDEMPOTENCY_DEDUP_WINDOW_MS`)
- [ ] Tests verify concurrent execution, race conditions
- [ ] Metrics track dedup hits/misses
- [ ] Persistent idempotency caching unchanged

## Note for Contributors

Run these locally before pushing:

```bash
cd backend && npm run lint        # Must have 0 errors
cd backend && npm test            # All tests must pass
```

**Create PR against `dev` branch, not main.**

Add tests proving:

- 2+ identical concurrent requests execute once
- Duplicate callers wait for original result
- Stale entries are cleaned up
- Race conditions handled
