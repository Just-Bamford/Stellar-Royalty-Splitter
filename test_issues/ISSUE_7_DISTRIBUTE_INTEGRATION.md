# Test Failure: distribute.test.js & distribute.integration.test.js - Integration mock incomplete

## Problem

Distribution tests are failing because the stellar.js and database mocks are incomplete or missing required exports needed for transaction building and distribution simulation.

**Error:**

```
SyntaxError: The requested module './stellar.js' does not provide an export named 'pollHorizonTransaction'
OR
Expected: 200
Received: 400/500 (transaction building failed)
```

**Test files:**

- `backend/tests/distribute.test.js`
- `backend/tests/distribute.integration.test.js`

## Root Cause

Distribution endpoints depend on multiple Stellar operations that need proper mocking:

1. `pollHorizonTransaction` - check if transaction landed on network
2. `buildTx` - build Soroban transactions
3. Database mocks for transaction recording
4. Incomplete app.js setup or stellar.js mock

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="distribute.test" 2>&1 | head -30
npm test -- --testPathPattern="distribute.integration" 2>&1 | head -30
```

## What to Check

1. Open `backend/tests/distribute.test.js` around line 30-50
2. Find stellar.js mock - verify it includes:
   - `retryBuildTx`
   - `buildTx` (if missing, add it)
   - `pollHorizonTransaction` (if missing, add it)
   - `isContractInitialized`
   - `addressToScVal`
   - `u32ToScVal`
   - `vecToScVal`
3. Check database/index.js mock for:
   - `recordTransaction`
   - `addAuditLog`
   - `getMigrationVersion`
4. Open `backend/tests/app.js` - verify it imports and mocks all needed modules

## Likely Solution

Add missing stellar.js exports to mock:

```javascript
await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  buildTx: jest.fn(), // <-- Add this
  pollHorizonTransaction: jest.fn(), // <-- Add this
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));
```

## Test Cases Involved

- POST /api/v1/distribute - distribute tokens to recipients
- GET /api/v1/distribute/:id - check distribution status
- Distribution with various payment amounts

## Files to Review

- `backend/tests/distribute.test.js` (mock setup around line 30-50)
- `backend/tests/distribute.integration.test.js` (integration test setup)
- `backend/tests/app.js` (shared test app setup)
- `backend/src/stellar.js` (actual exports needed)
- `backend/src/routes/distribute.js` (implementation)

## Acceptance Criteria

- [ ] No SyntaxError on stellar.js exports
- [ ] Mock includes `buildTx` and `pollHorizonTransaction`
- [ ] Distribution endpoint accepts valid payload and returns 200
- [ ] Transaction is recorded with correct data
- [ ] Test passes: `npm test -- --testPathPattern="distribute"`
- [ ] Integration tests pass: `npm test -- --testPathPattern="distribute.integration"`

## Notes

- Part of distribution system (#1 core feature)
- Depends on: Stellar SDK mocking, transaction building
- Both unit and integration tests need consistent mocks

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: hard`, `area: distribution`
