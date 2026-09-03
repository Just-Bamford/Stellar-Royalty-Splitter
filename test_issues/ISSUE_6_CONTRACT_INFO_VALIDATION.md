# Test Failure: contract-info.test.js - Validation returning 400 instead of 200

## Problem

The `contract-info.test.js` test expects 200 OK responses from contract info endpoints but is getting 400 Bad Request errors. Validation is incorrectly rejecting valid payloads.

**Error:**

```
expect(received).toBe(expected) // Object.is equality
Expected: 200
Received: 400

Expected error message: "Invalid email address format"
Received error message: "Invalid Stellar wallet address format"
```

**Test file:** `backend/tests/contract-info.test.js`

## Root Cause

Similar to contributor-onboarding.test.js, the validation is too strict or in wrong order:

1. Email fields being validated as Stellar addresses
2. Validation schema mismatch between test expectations and implementation
3. Mock incomplete or returning wrong data structure

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="contract-info" 2>&1 | grep -E "Expected|Received" | head -15
```

## What to Check

1. Open `backend/tests/contract-info.test.js` around line 40-100
2. Identify which endpoints are failing:
   - Contract info GET
   - Contract state updates
   - Contract configuration endpoints
3. Check `backend/src/routes/contract.js` for validation
4. Check `backend/src/validation.js` for contract info schemas
5. Verify test mocks include:
   - Contract state queries
   - Database contract info functions

## Likely Issues & Solutions

### Issue A: Email in wrong validation schema

Test sends email but route validates as Stellar address

- **Solution:** Fix validation schema to accept email or separate email field

### Issue B: Nested field validation

Response fields being validated when they shouldn't be

- **Solution:** Ensure validation only applies to request body, not response

### Issue C: Mock database state

Mock not returning contract info in expected format

- **Solution:** Ensure mock returns complete contract object

## Test Cases Likely Failing

- Contract info retrieval
- Contract configuration updates
- Contract state queries
- Payment/email related endpoints

## Files to Review

- `backend/tests/contract-info.test.js` (test setup and assertions)
- `backend/src/routes/contract.js` (route implementation)
- `backend/src/validation.js` (validation schemas for contract endpoints)
- `backend/src/database/index.js` (contract-related database functions)

## Acceptance Criteria

- [ ] Contract info endpoints return 200 with correct data
- [ ] Invalid payloads return 400 with clear error messages
- [ ] Email fields distinguished from Stellar address fields
- [ ] Test passes: `npm test -- --testPathPattern="contract-info"`
- [ ] All contract info test cases pass (likely 5-7 tests)

## Notes

- Related to: `contributor-onboarding.test.js` - same validation issue pattern
- May need to verify Zod schema definitions
- Check if validation is applied correctly at middleware level

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: medium`, `area: contract-management`
