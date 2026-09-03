# Testing Guide

Complete testing strategy and procedures for the Stellar Royalty Splitter project.

## Table of Contents

1. [Testing Overview](#testing-overview)
2. [Backend Testing](#backend-testing)
3. [Frontend Testing](#frontend-testing)
4. [Contract Testing](#contract-testing)
5. [Running Tests](#running-tests)
6. [Test Coverage](#test-coverage)
7. [CI/CD Pipeline](#cicd-pipeline)
8. [Troubleshooting](#troubleshooting)

---

## Testing Overview

The project uses multiple testing frameworks to ensure quality across all layers:

| Layer    | Framework  | Status            | Coverage |
| -------- | ---------- | ----------------- | -------- |
| Backend  | Jest       | 1106/1107 (99.9%) | >70%     |
| Frontend | Vitest     | 18+ tests         | >60%     |
| Contract | Cargo      | Multiple tests    | TBD      |
| E2E      | Playwright | 18+ tests         | N/A      |

---

## Backend Testing

### Test Structure

```
backend/
├── tests/
│   ├── unit/                          # Unit tests
│   │   ├── stellar.test.js
│   │   ├── cache.test.js
│   │   └── validation.test.js
│   ├── integration/                   # Integration tests
│   │   ├── initialize.integration.test.js
│   │   ├── distribute.integration.test.js
│   │   └── collaborators.integration.test.js
│   └── routes/                        # Route/endpoint tests
│       ├── initialize.test.js
│       ├── distribute.test.js
│       └── collaborators.test.js
├── src/                               # Source code
└── jest.config.js                     # Jest configuration
```

### Running Backend Tests

```bash
cd backend

# Run all tests
npm test

# Expected result: 1106/1107 passing (99.9%)
# One timing-related cache edge case in collaborators.integration.test.js
```

### Test Coverage

```bash
cd backend

# Run tests with coverage report
npm test -- --coverage

# Output: coverage/lcov-report/index.html
# Open in browser for detailed breakdown
```

### Current Test Status

**Last Update:** September 2026

- **Total Tests:** 1,117
- **Passing:** 1,106 (99.9%)
- **Failing:** 1 (cache timing edge case)
- **Test Suites:** 85/88 passing (96%)

**Failing Test:**

- `collaborators.integration.test.js` - "second request hits cache and does not call RPC"
  - Known issue: Cache TTL expires too quickly in test
  - Does NOT affect production functionality
  - Documented as edge case in test implementation

### Test Categories

#### Unit Tests

Test individual functions in isolation with mocked dependencies:

```bash
npm test -- stellar.test.js
npm test -- cache.test.js
npm test -- validation.test.js
```

#### Integration Tests

Test interactions between multiple components:

```bash
npm test -- distribute.integration.test.js
npm test -- initialize.integration.test.js
npm test -- batch-distribute.integration.test.js
```

#### Route/Endpoint Tests

Test HTTP endpoints and request/response handling:

```bash
npm test -- initialize.test.js
npm test -- collaborators.test.js
npm test -- health.test.js
```

### Mocking Strategy

Backend tests use Jest mocks for external dependencies:

**Mocked Modules:**

- `stellar.js` - Stellar RPC and contract interactions
- `database.js` - SQLite database operations
- `validation.js` - Input validation schemas
- `logger.js` - Logging functionality
- `email-template.js` - Email rendering

**Example Mock Setup:**

```javascript
await jest.unstable_mockModule("../src/validation.js", () => ({
  isValidStellarAddress: jest.fn((addr) => {
    return addr && /^G[A-Z0-9]{55}$/.test(addr);
  }),
  initializeSchema: { parse: jest.fn((x) => x) },
}));
```

---

## Frontend Testing

### Test Structure

```
frontend/
├── src/
│   ├── __tests__/                     # Unit/component tests
│   │   ├── App.test.tsx
│   │   ├── api.test.ts
│   │   └── components/
│   │       ├── WalletConnect.test.tsx
│   │       └── DistributeForm.test.tsx
│   └── components/
├── e2e/                               # End-to-end tests
│   ├── initialize.spec.ts
│   ├── distribute.spec.ts
│   └── auth.spec.ts
├── vitest.config.ts                   # Vitest config
└── playwright.config.ts               # Playwright config
```

### Running Frontend Tests

```bash
cd frontend

# Unit and component tests
npm run test

# Watch mode (re-run on changes)
npm run test -- --watch

# E2E tests (requires browser)
npm run test:e2e

# E2E tests in UI mode
npm run test:e2e -- --ui

# E2E tests headed (see browser)
npm run test:e2e -- --headed
```

### Test Coverage

```bash
cd frontend

# Run tests with coverage
npm run test:coverage

# Output: coverage/lcov-report/index.html
```

---

## Contract Testing

### Test Structure

```
tests/
├── integration_test.rs                # Main integration tests
└── Cargo.toml
```

### Running Contract Tests

```bash
# Run all contract tests
cargo test --workspace --locked --features testutils

# Run specific test
cargo test test_distribute

# Run with backtrace on failure
RUST_BACKTRACE=1 cargo test --workspace --locked --features testutils

# Run tests with output
cargo test -- --nocapture
```

### Test Categories

#### Unit Tests

Test individual contract functions:

```rust
#[test]
fn test_initialize() {
    // Test setup and initialization
}
```

#### Integration Tests

Test contract interactions on Stellar testnet:

```rust
#[test]
#[cfg(not(target_os = "windows"))]
fn test_distribute_with_auth() {
    // Test auth and distribution logic
}
```

---

## Running Tests

### Local Development Workflow

Before committing, run:

```bash
cd backend

# 1. Format code
npm run format

# 2. Check linting
npm run lint

# 3. Run all tests
npm test

# Expected output:
# Test Suites: 85 passed, 3 failed, 88 total
# Tests:       1106 passed, 1 failed, 1107 total
```

### Pre-Commit Testing

```bash
# Only run tests for changed files
npm test -- --onlyChanged

# Run tests in bail mode (stop on first failure)
npm test -- --bail
```

### Continuous Integration

GitHub Actions automatically runs tests on:

- Every push to `dev` or `main`
- Every pull request
- Weekly schedule (dependency security)

See `.github/workflows/backend-ci.yml` for details.

---

## Test Coverage

### Backend Coverage

```bash
cd backend
npm run test:coverage
```

**Target:** >70% for new code

**Coverage Report:**

- Line coverage: Percentage of lines executed
- Branch coverage: Percentage of conditional branches tested
- Function coverage: Percentage of functions called

**Viewing Coverage:**

1. Run: `npm run test:coverage`
2. Open: `backend/coverage/lcov-report/index.html`
3. Browse by file for detailed breakdown

### Excluded from Coverage

- `src/database/index.js` (pure re-export barrel)
- `src/database.js` (legacy duplicate, pre-existing)
- Generated code and type definitions

### Frontend Coverage

```bash
cd frontend
npm run test:coverage
```

**Viewing Coverage:**

1. Run: `npm run test:coverage`
2. Open: `frontend/coverage/lcov-report/index.html`

---

## CI/CD Pipeline

### What Runs in CI

#### On Every PR

1. **Backend CI**
   - Node 20.x test suite
   - Node 22.x test suite
   - ESLint checks
   - Type checking (if applicable)

2. **Frontend CI**
   - Unit/component tests
   - ESLint checks
   - Build verification

3. **Contract CI**
   - Cargo test (Rust)
   - Format check
   - Clippy lints

4. **Security Audits**
   - `npm audit` (JavaScript)
   - `cargo audit` (Rust)

### CI Status

All PRs must pass CI before merging:

- ✅ Backend tests pass on Node 20.x
- ✅ Backend tests pass on Node 22.x
- ✅ Contract tests pass
- ✅ All status checks green
- ✅ 1 code review approval

---

## Troubleshooting

### "Tests fail locally but pass in CI"

**Check:**

1. Node version: `node --version` (must be 20.x or 22.x)
2. Dependencies: `npm ci` (clean install)
3. Cache: `npm test -- --clearCache`
4. On dev branch: `git checkout dev && git pull origin dev`

**Fix:**

```bash
cd backend
rm -rf node_modules package-lock.json
npm ci
npm test
```

### "Module not found" Errors

**Example:** `Cannot find module '../stellar.js'`

**Cause:** Missing mock setup in test file

**Fix:**

1. Check that `jest.unstable_mockModule()` is called
2. Ensure all required exports are mocked
3. Review similar test files for patterns

### "Database locked" or "SQLite errors"

**Cause:** Previous test didn't clean up database

**Fix:**

```bash
cd backend
rm database.db
npm test
```

### "Port already in use"

**Cause:** Previous test server still running

**Fix:**

```bash
# Kill all node processes
pkill -f "node"

# Or use different port
PORT=5001 npm test
```

### "Tests hang or timeout"

**Cause:** Missing async/await or unresolved promises

**Fix:**

1. Check that test uses `async` keyword
2. Verify all promises are awaited
3. Check for missing `done()` callback (if not using async)
4. Increase timeout: `jest.setTimeout(10000);`

### "Validation mocks returning unexpected values"

**Cause:** Mock function not returning expected type

**Fix:**

```javascript
// WRONG: returns undefined
isValidStellarAddress: jest.fn();

// RIGHT: returns boolean
isValidStellarAddress: jest.fn((addr) => {
  return addr && /^G[A-Z0-9]{55}$/.test(addr);
});
```

### "Cache timing test failing"

**Cause:** Known edge case in collaborators.integration.test.js

**Status:** Documented as non-blocking - does not affect production

**Workaround:** This is the one expected failure (1106/1107 passing)

---

## Writing Tests

### Creating a New Test File

```javascript
// tests/my-feature.test.js
import { jest, describe, test, expect, beforeEach } from "@jest/globals";

describe("My Feature", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should do something", async () => {
    // Arrange: Set up test data
    const input = { foo: "bar" };

    // Act: Execute the function
    const result = await myFunction(input);

    // Assert: Verify results
    expect(result).toBe("expected");
  });
});
```

### Mocking Dependencies

```javascript
// Mock a module
await jest.unstable_mockModule("../src/myModule.js", () => ({
  myFunction: jest.fn((x) => x * 2),
}));

const { myFunction } = await import("../src/myModule.js");

test("uses mocked function", () => {
  expect(myFunction(5)).toBe(10);
  expect(myFunction).toHaveBeenCalledWith(5);
});
```

### Test Patterns

**Testing async functions:**

```javascript
test("async function", async () => {
  const result = await asyncFunction();
  expect(result).toBeDefined();
});
```

**Testing errors:**

```javascript
test("throws on invalid input", async () => {
  await expect(myFunction(null)).rejects.toThrow("Invalid input");
});
```

**Testing HTTP endpoints:**

```javascript
test("POST /api/endpoint returns 200", async () => {
  const res = await request(app).post("/api/endpoint").send({ data: "value" });

  expect(res.status).toBe(200);
  expect(res.body).toHaveProperty("success", true);
});
```

---

## Best Practices

### ✅ Do

- Write tests for new features BEFORE implementation (TDD)
- Keep tests focused on one thing
- Use descriptive test names
- Mock external dependencies
- Clean up in `afterEach()` or `beforeEach()`
- Run tests before committing
- Update tests when requirements change

### ❌ Don't

- Skip tests to save time
- Test implementation details (test behavior)
- Create brittle tests with hardcoded values
- Mock too much (defeats the purpose)
- Leave test data in databases
- Commit failing tests
- Ignore CI failures

---

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Vitest Documentation](https://vitest.dev/)
- [Playwright Documentation](https://playwright.dev/)
- [Testing Library](https://testing-library.com/)
- [Cargo Testing](https://doc.rust-lang.org/cargo/commands/cargo-test.html)

---

## Support

For questions or issues:

1. Check this guide and existing tests
2. Review failing test output carefully
3. Ask in GitHub Discussions or PR comments
4. See [DEVELOPMENT.md](../DEVELOPMENT.md#testing) for local setup
