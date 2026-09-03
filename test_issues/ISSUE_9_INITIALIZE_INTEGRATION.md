# Test Failure: initialize.test.js & initialize.integration.test.js - Stellar mock incomplete

## Problem

Initialize contract tests are failing because the stellar.js mock is missing `buildTx` and `pollHorizonTransaction` exports needed for contract initialization transactions.

**Error:**

```
SyntaxError: The requested module './stellar.js' does not provide an export named 'pollHorizonTransaction'
OR
Expected: 200 contract initialized
Received: Transaction building failed
```

**Test files:**

- `backend/tests/initialize.test.js`
- `backend/tests/initialize.integration.test.js`

## Root Cause

Contract initialization requires:

1. Building initialization transaction with `buildTx`
2. Polling Horizon to confirm transaction landed with `pollHorizonTransaction`
3. Recording initialization in database

Missing stellar.js exports prevent transaction operations.

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="initialize.test" 2>&1 | head -30
npm test -- --testPathPattern="initialize.integration" 2>&1 | head -30
```

## What to Check

1. Open `backend/tests/initialize.test.js` around line 10-40
2. Find stellar.js mock - verify it includes:
   - `retryBuildTx` ✓ (likely present)
   - `buildTx` ✗ (likely missing)
   - `pollHorizonTransaction` ✗ (likely missing)
   - `isContractInitialized`
   - `addressToScVal`
3. Check payload validation:
   - `contractId` format
   - `walletAddress` format
   - `collaborators` list
   - `shares` sum to 10000
4. Verify database mock for:
   - `recordTransaction`
   - `addAuditLog`

## Likely Solution

Add missing stellar.js exports:

```javascript
await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  buildTx: jest.fn(), // <-- Add
  pollHorizonTransaction: jest.fn(), // <-- Add
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));
```

## Test Cases Involved

- POST /api/v1/initialize - initialize contract with collaborators
- Validate collaborators list (1-10 collaborators)
- Validate shares sum to 10000 basis points
- Record initialization to database
- Audit logging

## Files to Review

- `backend/tests/initialize.test.js` (mock setup around line 10-40)
- `backend/tests/initialize.integration.test.js` (integration test)
- `backend/src/routes/initialize.js` (implementation)
- `backend/src/stellar.js` (actual exports)
- `backend/src/validation.js` (input validation)

## Acceptance Criteria

- [ ] No SyntaxError on stellar.js imports
- [ ] POST /api/v1/initialize with valid payload returns 200
- [ ] Transaction is built and recorded
- [ ] Collaborators are stored with correct shares
- [ ] Audit log entry created
- [ ] Test passes: `npm test -- --testPathPattern="initialize.test"`
- [ ] Integration test passes: `npm test -- --testPathPattern="initialize.integration"`

## Notes

- Core feature: initializing contracts with royalty splits
- Depends on Stellar transaction building and polling
- Related to: `distribute.test.js`, `collaborators.test.js` - same stellar mock pattern

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: hard`, `area: contract-initialization`
