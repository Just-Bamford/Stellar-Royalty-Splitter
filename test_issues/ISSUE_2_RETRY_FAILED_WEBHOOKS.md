# Test Failure: retry-failed-webhooks.test.js - Missing database exports

## Problem

The `retry-failed-webhooks.test.js` test fails to run because the mock for `database/webhooks.js` is missing required exports.

**Error:**

```
SyntaxError: The requested module './database/webhooks.js' does not provide an export named 'listWebhooks'
```

**Test file:** `backend/tests/retry-failed-webhooks.test.js`

## Root Cause

The test mocks `database/webhooks.js` but doesn't include all the functions that `src/jobs/retry-failed-webhooks.js` actually calls. Specifically:

- `listWebhooks` - needed to fetch webhooks due for retry
- `updateWebhookRetryStateWithPayload` - updates retry state with payload
- `resetWebhookRetryCount` - resets retry counter after success

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="retry-failed-webhooks" 2>&1 | head -20
```

## What to Check

1. Open `backend/tests/retry-failed-webhooks.test.js` around line 5-15
2. Find the mock for `../src/database/webhooks.js`
3. Verify it exports all three functions:
   - `getWebhooksDueForRetry`
   - `updateWebhookRetryStateWithPayload`
   - `resetWebhookRetryCount`
   - `listWebhooks` (if called by retry job)
4. Check `backend/src/jobs/retry-failed-webhooks.js` to see what it imports

## Likely Solution

Add `listWebhooks` to the mock exports in the `jest.unstable_mockModule` call for `database/webhooks.js`. The mock should include:

```javascript
await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  getWebhooksDueForRetry: mockGetWebhooksDueForRetry,
  updateWebhookRetryStateWithPayload: mockUpdateWebhookRetryStateWithPayload,
  resetWebhookRetryCount: mockResetWebhookRetryCount,
  listWebhooks: jest.fn(), // <-- Add this
}));
```

## Files to Review

- `backend/tests/retry-failed-webhooks.test.js` (test setup, line ~5-15)
- `backend/src/jobs/retry-failed-webhooks.js` (what it imports)
- `backend/src/database/webhooks.js` (actual exports to match)

## Acceptance Criteria

- [ ] Mock includes all required exports from `database/webhooks.js`
- [ ] Test runs without SyntaxError
- [ ] Test passes: `npm test -- --testPathPattern="retry-failed-webhooks"`

## Notes

- Part of webhook retry system (#743)
- Related to: `webhook-delivery.test.js`, `webhook-dlq.test.js`
- Mock setup should be consistent across all webhook-related tests

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: easy`, `area: webhooks`
