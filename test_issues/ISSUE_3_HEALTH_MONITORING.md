# Test Failure: health.test.js - Health monitoring mock incomplete

## Problem

The `health.test.js` test fails because the health monitoring infrastructure is not fully mocked, causing health snapshot recording to fail.

**Error:**

```
console.error Failed to record health snapshot Error: DB write failed
expect(received).toMatchObject(expected)
Expected: 200 status with health data
Received: 400 or incomplete response
```

**Test file:** `backend/tests/health.test.js`

## Root Cause

The health monitoring system tries to record snapshots to the database, but:

1. Mock for `database/health-monitor.js` may be missing `startHealthMonitor`, `stopHealthMonitor`, or `resetHealthMonitorState`
2. Mock for `database/index.js` may be missing `recordHealthSnapshot` or `pruneHealthHistory`
3. Health monitor initialization may not be properly stubbed out

## Reproduction Steps

```bash
cd backend
npm test -- --testPathPattern="health.test" 2>&1 | grep -E "(Failed|expect|Error)" | head -10
```

## What to Check

1. Open `backend/tests/health.test.js` around line 25-65
2. Find mocks for:
   - `../src/database/index.js`
   - `../src/database/health-monitor.js`
3. Verify database/index.js mock includes:
   - `recordHealthSnapshot`
   - `pruneHealthHistory`
   - `startHealthMonitor`
   - `stopHealthMonitor`
4. Verify database/health-monitor.js mock includes:
   - `checkConnectionHealthAsync`
   - `getHealthStatus`
   - `getHealthMetrics`
   - `startHealthMonitor`
   - `stopHealthMonitor`
   - `resetHealthMonitorState`

## Likely Solution

Add missing exports to both database mocks. The health monitoring system expects these functions to exist and be callable. Mock them as `jest.fn()`:

```javascript
// In database/index.js mock
startHealthMonitor: jest.fn(),
stopHealthMonitor: jest.fn(),

// In database/health-monitor.js mock
startHealthMonitor: jest.fn(),
stopHealthMonitor: jest.fn(),
resetHealthMonitorState: jest.fn(),
```

## Files to Review

- `backend/tests/health.test.js` (mock setup around line 25-65)
- `backend/src/database/index.js` (what's actually exported)
- `backend/src/database/health-monitor.js` (what's actually exported)
- `backend/src/routes/health.js` (what it imports and calls)

## Acceptance Criteria

- [ ] No "Failed to record health snapshot" errors in console
- [ ] Test passes: `npm test -- --testPathPattern="health.test"`
- [ ] Health endpoint returns 200 with proper data structure
- [ ] All 3-4 health test cases pass

## Notes

- Part of health monitoring system (#496)
- Related to: `health-detailed.test.js`
- Health monitor lifecycle (start/stop) needs to be properly mocked

## How to Contribute

1. Create a new branch from `dev` branch
2. Make your fix following the reproduction steps
3. Run `npm test` to verify the fix works
4. **Create PR against `dev` branch (NOT main)**
5. Add reference to this issue in your PR description

**Labels:** `type: test-fix`, `difficulty: medium`, `area: health-monitoring`
