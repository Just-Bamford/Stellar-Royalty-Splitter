# Test Failure: health-detailed.test.js - Health detailed endpoint mock incomplete

## Problem

The `health-detailed.test.js` test fails because health-detailed endpoint mocks are missing required database exports.

**Error:**

```
SyntaxError: The requested module '../database/index.js' does not provide an export named 'getHealthHistory'
```

**Test file:** `backend/tests/health-detailed.test.js`

## Root Cause

The test mocks `database/index.js` but is missing `getHealthHistory` export which the health detailed endpoint needs to retrieve historical health snapshots.

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="health-detailed" 2>&1 | head -20
```

## What to Check

1. Open `backend/tests/health-detailed.test.js` around line 28-35
2. Find the mock for `../src/database/index.js`
3. Verify it includes:
   - `checkDatabase`
   - `getHealthHistory` (missing!)
   - `startHealthMonitor`
   - `stopHealthMonitor`
4. Also check `database/health-monitor.js` mock for:
   - `startHealthMonitor`
   - `stopHealthMonitor`
   - `resetHealthMonitorState`

## Likely Solution

Add missing exports to the database mock:

```javascript
await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 7),
  checkDatabase,
  getHealthHistory: jest.fn(() => []), // <-- Add this
  startHealthMonitor: jest.fn(),
  stopHealthMonitor: jest.fn(),
}));

// And ensure health-monitor mock has:
await jest.unstable_mockModule("../src/database/health-monitor.js", () => ({
  checkConnectionHealthAsync,
  getHealthStatus: jest.fn(),
  getHealthMetrics,
  startHealthMonitor: jest.fn(),
  stopHealthMonitor: jest.fn(),
  resetHealthMonitorState: jest.fn(),
}));
```

## Files to Review

- `backend/tests/health-detailed.test.js` (mock setup around line 28-50)
- `backend/src/routes/health.js` (what it imports for detailed endpoint)
- `backend/src/database/index.js` (actual exports)

## Acceptance Criteria

- [ ] Mock includes `getHealthHistory` export
- [ ] No SyntaxError on module import
- [ ] Test passes: `npm test -- --testPathPattern="health-detailed"`
- [ ] Detailed health endpoint works with mock data

## Notes

- Part of detailed health monitoring (#496)
- Similar to `health.test.js` but focused on detailed endpoint
- History retrieval is needed for SLA calculations

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: easy`, `area: health-monitoring`
