# Test Failure: simulate.test.js, archival.test.js, batch-distribute.test.js, audit-creation.test.js - Complex integration scenarios

## Problem

These four integration test files are failing due to incomplete mocks or missing stellar.js exports. Each tests a different complex scenario.

**Error patterns:**

```
SyntaxError: The requested module './stellar.js' does not provide an export named 'pollHorizonTransaction'
OR
Expected: 200/specific response
Received: 400/mock incomplete
```

**Test files:**

- `backend/tests/simulate.test.js` - contract simulation
- `backend/tests/archival.test.js` - event archival
- `backend/tests/batch-distribute.integration.test.js` - batch distribution
- `backend/tests/audit-creation.test.js` - audit logging

## Root Cause

Each test needs different mocks and exports:

### simulate.test.js

- Needs: `buildTx`, `pollHorizonTransaction`, `server.simulateTransaction`
- Tests: Contract simulation endpoint

### archival.test.js

- Needs: Cache mocks, history router setup
- Tests: Event archival and cleanup

### batch-distribute.integration.test.js

- Needs: `pollHorizonTransaction`, `buildTx`, batch operation handling
- Tests: Batch distribution of tokens

### audit-creation.test.js

- Needs: Stellar mocks for contract operations
- Tests: Audit log creation during operations

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="simulate.test" 2>&1 | head -20
npm test -- --testPathPattern="archival.test" 2>&1 | head -20
npm test -- --testPathPattern="batch-distribute" 2>&1 | head -20
npm test -- --testPathPattern="audit-creation" 2>&1 | head -20
```

## What to Check for Each

### simulate.test.js (line 75-90)

- stellar.js mock includes `buildTx`, `pollHorizonTransaction`
- Database mock includes transaction functions
- Validation of simulation results

### archival.test.js (line 160-180)

- Cache mocks properly set up
- History router mocks complete
- Database archival functions mocked

### batch-distribute.integration.test.js (line 50-70)

- Stellar mocks for batch operations
- Database mocks for batch transaction recording
- Error handling for partial failures

### audit-creation.test.js (line 60-80)

- Database mocks for audit logging
- Stellar mocks for contract operations
- Proper audit entry structure

## Likely Solutions

### For simulate.test.js

```javascript
await jest.unstable_mockModule("../src/stellar.js", () => ({
  // ... existing mocks
  buildTx: jest.fn(),
  pollHorizonTransaction: jest.fn(),
}));
```

### For archival.test.js

```javascript
// Ensure cache.js mock is present
await jest.unstable_mockModule("../src/cache.js", () => ({
  cacheSet: jest.fn(),
  cacheGet: jest.fn(),
  cacheKey: jest.fn(),
  TTL: { history: 60000 },
}));
```

### For batch-distribute.integration.test.js

```javascript
// Add buildTx, pollHorizonTransaction to stellar.js mock
```

### For audit-creation.test.js

```javascript
// Verify database audit functions are mocked
```

## Files to Review

- `backend/tests/simulate.test.js` (mock setup)
- `backend/tests/archival.test.js` (mock setup + cache)
- `backend/tests/batch-distribute.integration.test.js` (mock setup)
- `backend/tests/audit-creation.test.js` (mock setup)
- `backend/src/stellar.js` (actual exports)
- `backend/tests/app.js` (shared mock setup)

## Acceptance Criteria

- [ ] No SyntaxError on any module imports
- [ ] simulate.test: POST /simulate returns 200 with simulation results
- [ ] archival.test: Event archival works correctly
- [ ] batch-distribute: Batch distribution processes multiple recipients
- [ ] audit-creation: Audit logs created for all operations
- [ ] All 4 test files pass

## Notes

- These are complex integration scenarios
- Multiple subsystems interact (Stellar, database, validation)
- Each test is relatively independent but uses common mock patterns
- Fix pattern: ensure stellar.js has `buildTx` and `pollHorizonTransaction` in all tests

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: very-hard`, `area: integration-testing`
