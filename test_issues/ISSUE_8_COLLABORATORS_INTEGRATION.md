# Test Failure: collaborators.test.js & collaborators.integration.test.js - Stellar mock incomplete

## Problem

Collaborator tests are failing because the stellar.js mock is missing required exports for contract simulation and transaction operations.

**Error:**

```
SyntaxError: The requested module './stellar.js' does not provide an export named 'pollHorizonTransaction'
OR
Expected: 200 with collaborators list
Received: Error during contract simulation
```

**Test files:**

- `backend/tests/collaborators.test.js`
- `backend/tests/collaborators.integration.test.js`

## Root Cause

Collaborator endpoints need to:

1. Simulate contract calls to fetch collaborators
2. Handle transaction polling after writes
3. Manage caching of collaborator data

Missing stellar.js exports break the chain.

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="collaborators.test" 2>&1 | head -30
npm test -- --testPathPattern="collaborators.integration" 2>&1 | head -30
```

## What to Check

1. Open `backend/tests/collaborators.test.js` around line 40-80
2. Find stellar.js mock - verify exports:
   - `retryBuildTx`
   - `buildTx`
   - `pollHorizonTransaction` (likely missing)
   - `isContractInitialized`
   - `addressToScVal`
   - `u32ToScVal`
   - `vecToScVal`
3. Check `backend/tests/collaborators.integration.test.js` for cache mocking:
   - `clearCache` function
   - Cache configuration
4. Verify app.js has proper stellar mock

## Likely Solution

Add missing stellar.js exports:

```javascript
await jest.unstable_mockModule("../src/stellar.js", () => ({
  server: { simulateTransaction: mockSimulate },
  networkPassphrase: "Test SDF Network ; September 2015",
  addressToScVal: jest.fn((a) => a),
  retryBuildTx: jest.fn(),
  buildTx: jest.fn(), // <-- Add
  pollHorizonTransaction: jest.fn(), // <-- Add
  isContractInitialized: jest.fn(),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
}));
```

## Test Cases Involved

- GET /api/v1/collaborators/:contractId - fetch collaborators
- Caching: repeated calls should use cache
- Error handling: invalid contract returns 400
- Transaction polling after updates

## Files to Review

- `backend/tests/collaborators.test.js` (mock setup around line 40-60)
- `backend/tests/collaborators.integration.test.js` (integration + caching)
- `backend/src/routes/collaborators.js` (implementation)
- `backend/src/stellar.js` (actual exports)

## Acceptance Criteria

- [ ] No SyntaxError on stellar.js imports
- [ ] GET collaborators returns 200 with list of addresses/basis points
- [ ] Caching works: repeated calls use cached data
- [ ] Invalid contract returns 400
- [ ] Test passes: `npm test -- --testPathPattern="collaborators.test"`
- [ ] Integration test passes: `npm test -- --testPathPattern="collaborators.integration"`

## Notes

- Part of contract management system
- Caching behavior is critical for performance
- Related to: `distribute.test.js` - same stellar mock pattern

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: hard`, `area: contract-management`, `area: caching`
