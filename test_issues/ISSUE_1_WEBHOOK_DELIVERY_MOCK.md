# Test Failure: webhook-delivery.test.js - Mock exports incomplete

## Problem

The `webhook-delivery.test.js` test is failing because the mock for webhook retry state management is not being called as expected.

**Error:**

```
expect(jest.fn()).toHaveBeenCalledTimes(expected)
Expected number of calls: 1
Received number of calls: 0
expect(resetWebhookRetryCount).toHaveBeenCalledTimes(1);
```

**Test file:** `backend/tests/webhook-delivery.test.js`

## Root Cause

The `deliverDistributeWebhooks` function in `src/webhook-delivery.js` calls `resetWebhookRetryCount()` after a successful webhook delivery, but:

1. The mock for `webhook-delivery.js` may not be exporting all required functions
2. The mock for database webhooks functions may be incomplete
3. The test setup may not be mocking the right modules

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="webhook-delivery.test" 2>&1 | grep -A 5 "resetWebhookRetryCount"
```

## What to Check

1. Open `backend/tests/webhook-delivery.test.js` around line 87 and 164
2. Check what modules are mocked at the top of the file
3. Verify `database/webhooks.js` exports:
   - `listWebhooks`
   - `updateWebhookRetryStateWithPayload`
   - `resetWebhookRetryCount`
4. Check `src/webhook-delivery.js` to see what functions it calls after successful delivery

## Likely Solution

Add missing mock exports or ensure the database webhook functions are properly mocked. The test expects `resetWebhookRetryCount` to be called once after a successful webhook POST.

## Files to Review

- `backend/tests/webhook-delivery.test.js` (test setup)
- `backend/src/webhook-delivery.js` (implementation)
- `backend/src/database/webhooks.js` (actual exports)

## Acceptance Criteria

- [ ] Test passes: `npm test -- --testPathPattern="webhook-delivery.test"`
- [ ] Mock properly calls `resetWebhookRetryCount` on successful delivery
- [ ] All 3 test cases pass (POSTs to webhooks, stores/schedules retry on failure, resets retry after success)

## Notes

- This is part of webhook delivery system (#295)
- All webhook tests need consistent mock setup
- Related to: `retry-failed-webhooks.test.js`

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: medium`, `area: webhooks`
