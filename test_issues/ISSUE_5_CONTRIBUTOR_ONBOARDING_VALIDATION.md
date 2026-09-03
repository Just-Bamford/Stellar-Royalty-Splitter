# Test Failure: contributor-onboarding.test.js - Validation too strict, getting 400 errors

## Problem

The `contributor-onboarding.test.js` test expects 200 OK responses but is getting 400 Bad Request. The validation is rejecting valid test data.

**Error:**

```
expect(received).toBe(expected) // Object.is equality
Expected: 200
Received: 400

Expected error message: "Invalid email address format"
Received error message: "Invalid Stellar wallet address format"
```

**Test file:** `backend/tests/contributor-onboarding.test.js`

## Root Cause

The test is sending valid test payloads to the onboarding endpoints, but the validation middleware is:

1. Incorrectly validating email fields as Stellar addresses
2. Too strict validation order (checking Stellar address before email)
3. Mock database not returning expected data structure

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="contributor-onboarding" 2>&1 | grep -E "Expected|Received" | head -20
```

## What to Check

1. Open `backend/tests/contributor-onboarding.test.js` around line 40-70
2. Check what test data is being sent in each request
3. Look at `backend/src/routes/onboarding.js` to see the validation chain
4. Check `backend/src/validation.js` for the onboarding schema
5. Verify test mocks for:
   - Database functions for onboarding
   - Email validation vs Stellar validation order

## Likely Issues & Solutions

### Issue A: Email validation in wrong field

The test sends `email: "contributor@example.com"` but validation might be treating it as a Stellar address.

- **Solution:** Ensure email fields use email validation, not `stellarAddress` validator

### Issue B: Validation order

Stellar address validation running before email validation

- **Solution:** Reorder validation in the route or schema to check email first

### Issue C: Mock incomplete

Database mock not returning required data

- **Solution:** Add mock return values for onboarding queries

## Test Cases Involved

- Line 66: GET checklist status
- Line 96: POST update checklist
- Line 115: POST complete checklist
- Line 134-135: Invalid email should return specific error message
- Line 145: Send reminder email

## Files to Review

- `backend/tests/contributor-onboarding.test.js` (test setup and assertions)
- `backend/src/routes/onboarding.js` (route implementation)
- `backend/src/validation.js` (validation schemas for onboarding)
- `backend/src/database/index.js` (mock setup in test)

## Acceptance Criteria

- [ ] GET /api/v1/onboarding/:walletAddress returns 200 with checklist
- [ ] POST /api/v1/onboarding/:walletAddress/update returns 200 with summary
- [ ] POST /api/v1/onboarding/:walletAddress/complete returns 200
- [ ] Invalid email returns 400 with "Invalid email address format" message
- [ ] Test passes: `npm test -- --testPathPattern="contributor-onboarding"`

## Notes

- Part of contributor onboarding system (#593)
- Email validation should be distinct from Stellar address validation
- Database mock needs to return complete onboarding state

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: medium`, `area: contributor-management`
