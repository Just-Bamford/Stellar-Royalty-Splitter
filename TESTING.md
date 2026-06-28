# Testing Guide

This document describes the testing infrastructure for the Stellar Royalty Splitter project across backend, frontend, and Rust contract components.

## Table of Contents

- [Backend Tests (Node.js)](#backend-tests-nodejs)
- [Frontend E2E Tests](#frontend-e2e-tests)
- [Rust Contract Tests](#rust-contract-tests)
- [Running All Tests](#running-all-tests)
- [CI/CD Pipeline](#cicd-pipeline)
- [Troubleshooting](#troubleshooting)

---

## Backend Tests (Node.js)

### Overview

The backend uses **Jest** as the test runner with **supertest** for HTTP assertions and **better-sqlite3** for database integration.

**Current Status:** ✅ **152/152 tests passing (100%)**

### Test Suites

| Suite                  | File                             | Tests | Status  |
| ---------------------- | -------------------------------- | ----- | ------- |
| Idempotency            | `idempotency.test.js`            | 4     | ✅ PASS |
| Secrets Manager        | `secrets-manager.test.js`        | 5     | ✅ PASS |
| Validation             | `validation.test.js`             | 9     | ✅ PASS |
| Contract Info          | `contract-info.test.js`          | 7     | ✅ PASS |
| Initialize             | `initialize.test.js`             | 8     | ✅ PASS |
| Transaction Confirm    | `transaction-confirm.test.js`    | 5     | ✅ PASS |
| Collaborators          | `collaborators.test.js`          | 3     | ✅ PASS |
| Simulate               | `simulate.test.js`               | 8     | ✅ PASS |
| Webhook Delivery       | `webhook-delivery.test.js`       | 6     | ✅ PASS |
| Metrics                | `metrics.test.js`                | 3     | ✅ PASS |
| Health                 | `health.test.js`                 | 2     | ✅ PASS |
| CORS Config            | `cors-config.test.js`            | 6     | ✅ PASS |
| Shutdown               | `shutdown.test.js`               | 3     | ✅ PASS |
| Logger                 | `logger.test.js`                 | 2     | ✅ PASS |
| Webhooks               | `webhooks.test.js`               | 4     | ✅ PASS |
| Signing Key            | `signing-key.test.js`            | 8     | ✅ PASS |
| Distribute Idempotency | `distribute-idempotency.test.js` | 14    | ✅ PASS |
| Admin                  | `admin.test.js`                  | 8     | ✅ PASS |
| Stellar                | `stellar.test.js`                | 18    | ✅ PASS |
| Distribute             | `distribute.test.js`             | 8     | ✅ PASS |
| Distribute Integration | `distribute.integration.test.js` | 6     | ✅ PASS |

### Running Backend Tests

```bash
cd backend

# Install dependencies
npm install --ignore-scripts

# Run all tests
npm test

# Run a specific test file
npm test -- tests/initialize.test.js

# Run with coverage
npm test -- --coverage
```

### Key Test Areas

#### Initialization (`initialize.test.js`)

- Validating collaborator arrays
- Share sum validation (must equal 10,000 basis points)
- Payload size constraints
- Authorization checks

#### Distribution (`distribute.test.js`, `distribute.integration.test.js`)

- Fund distribution with proper rounding
- Idempotency key handling
- Transaction simulation
- Error handling for invalid inputs

#### Validation (`validation.test.js`)

- Stellar address format validation
- Contract ID format validation
- Basis points range validation
- Array length constraints

#### Admin Functions (`admin.test.js`)

- Admin authorization
- Key rotation
- Access control

#### Error Handling

- 400 Bad Request for invalid inputs
- 401 Unauthorized for missing auth
- 500 Server Error with proper logging

### Recent Fixes (June 8, 2026)

1. **Validation Error Messages**: Updated Zod schemas to provide specific error messages instead of generic "Validation failed"
   - Added custom messages for empty collaborators array
   - Added custom messages for invalid Stellar/contract addresses

2. **Error Response Structure**: Modified `sendValidationError()` to include the first issue's message in the main `error` field for better client-side handling

### Dependencies

- **jest**: Test runner
- **supertest**: HTTP assertions
- **better-sqlite3**: SQLite database
- **winston**: Logging
- **zod**: Input validation

---

## Frontend E2E Tests

### Overview

The frontend uses **Playwright** for end-to-end testing across all major user flows.

**Current Status:** 📋 18 tests configured, Playwright browsers installing

### Test Files

| File                          | Scenarios | Status     |
| ----------------------------- | --------- | ---------- |
| `contract-initialize.spec.ts` | 6         | Configured |
| `distribution.spec.ts`        | 3         | Configured |
| `navigation.spec.ts`          | 3         | Configured |
| `secondary-royalty.spec.ts`   | 3         | Configured |
| `wallet-connect.spec.ts`      | 3         | Configured |

### Test Scenarios

#### Contract Initialization

- Display initialize form
- Configure percentage input constraints
- Prevent invalid keyboard characters
- Show inline validation feedback
- Accept valid percentage values
- Validate collaborator percentages sum to 100%

#### Distribution Flow

- Display distribute form
- Validate required fields
- Successfully distribute funds

#### Navigation & UI

- Load homepage
- Navigate between sections
- Display error boundary on errors

#### Secondary Royalties

- Display secondary royalty section
- Record secondary sale
- Distribute secondary royalties

#### Wallet Connection

- Display wallet connect button
- Show error when Freighter is not installed
- Handle wallet connection with mocked Freighter

### Running Frontend E2E Tests

```bash
cd frontend

# Install dependencies
npm install

# Run Playwright tests
npm run test:e2e

# Run in headed mode (see browser)
npx playwright test --headed

# Run specific test file
npx playwright test e2e/contract-initialize.spec.ts

# Debug mode
npx playwright test --debug
```

### Playwright Configuration

**Config file:** `frontend/playwright.config.ts`

- **Browsers**: Chrome, Firefox, WebKit
- **Base URL**: `http://localhost:5173` (Vite dev server)
- **Timeout**: 30 seconds per test
- **Retries**: 2 (CI) / 0 (local)
- **Workers**: 6 parallel workers

### Recent Fixes (June 8, 2026)

1. **Duplicate Function Declarations**: Fixed duplicate `get<T>()` function in `src/api.ts`
2. **Duplicate Method Names**: Removed duplicate `getContractVersion()` methods
3. **Build Errors**: Resolved TypeScript compilation errors preventing test startup

### Dependencies

- **@playwright/test**: E2E testing framework
- **vite**: Development server and build tool
- **@vitejs/plugin-react**: React integration

---

## Rust Contract Tests

### Overview

The Rust contract uses **cargo test** with the Soroban SDK test framework for unit and integration testing.

**Current Status:** ❓ Setup required (Rust toolchain needed)

### Test Categories

#### Unit Tests

- Individual function logic
- Share calculations
- Rounding behavior

#### Integration Tests

- Full contract lifecycle (init → distribute)
- Multi-signature scenarios
- Edge cases and error conditions

### Running Rust Tests

```bash
# Install Rust (if not already installed)
rustup install stable
rustup target add wasm32-unknown-unknown

# Run all tests
cargo test

# Run specific test
cargo test test_initialize

# Run with backtrace
RUST_BACKTRACE=1 cargo test

# Run tests and print output
cargo test -- --nocapture
```

### Test Snapshots

Located in `test_snapshots/` directory. These capture contract state and events for regression testing:

- Admin authorization snapshots
- Distribution event snapshots
- Storage state snapshots

---

## Running All Tests

### Sequential Run (Complete Test Suite)

```bash
#!/bin/bash

# Backend tests
cd backend
npm install --ignore-scripts
npm test
BACKEND_STATUS=$?

# Frontend E2E tests (requires running dev server)
cd ../frontend
npm install
npm run build  # Build for production
npm run test:e2e
FRONTEND_STATUS=$?

# Rust contract tests
cd ..
cargo test
RUST_STATUS=$?

# Summary
echo "=== Test Results ==="
echo "Backend: $([ $BACKEND_STATUS -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Frontend: $([ $FRONTEND_STATUS -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
echo "Rust: $([ $RUST_STATUS -eq 0 ] && echo '✅ PASS' || echo '❌ FAIL')"
```

### GitHub Actions Pipeline

The `.github/workflows/` directory contains CI/CD configurations:

- **`backend-ci.yml`**: Runs backend tests on every push
- **`contract-ci.yml`**: Runs Rust contract tests on every push

Tests run automatically on pull requests. All must pass before merging.

---

## Troubleshooting

### Backend Tests

#### Issue: Python not found (better-sqlite3 compilation)

```
gyp ERR! Could not find any Python installation to use
```

**Solution:**

```bash
# Install Python 3.8+
# Windows: winget install Python.Python.3.11
# macOS: brew install python3
# Linux: sudo apt install python3

# Then reinstall
npm install
```

#### Issue: Visual Studio Build Tools not found

```
gyp ERR! find VS Could not find any Visual Studio installation to use
```

**Solution:**

```bash
# Windows: Install Visual Studio Build Tools with C++ workload
# macOS/Linux: Already have build tools via Xcode/gcc

# Then reinstall
npm install
```

#### Issue: Tests hang or timeout

```
Tests are taking longer than expected
```

**Solution:**

```bash
# Run with verbose logging
npm test -- --verbose

# Check for open database connections
# Ensure database cleanup in test teardown
```

### Frontend E2E Tests

#### Issue: Playwright browsers not installed

```
browserType.launch: Executable doesn't exist
```

**Solution:**

```bash
# Install browsers
npx playwright install

# Or install specific browser
npx playwright install chromium
```

#### Issue: Tests can't connect to dev server

```
Error: connect ECONNREFUSED 127.0.0.1:5173
```

**Solution:**

```bash
# Start dev server in another terminal
npm run dev

# Then run tests in another terminal
npm run test:e2e
```

### Rust Contract Tests

#### Issue: wasm32 target not installed

```
error[E0463]: can't find crate for `std`
```

**Solution:**

```bash
rustup target add wasm32-unknown-unknown
cargo test
```

#### Issue: Soroban SDK version mismatch

```
error: version requirements cannot be satisfied
```

**Solution:**

```bash
# Update dependencies
cargo update

# Or use exact version from Cargo.lock
cargo build
```

---

## Best Practices

### Writing Tests

1. **Use descriptive test names**: `should return 400 when collaborators array is empty`
2. **Follow AAA pattern**: Arrange, Act, Assert
3. **Mock external dependencies**: Stellar RPC calls, database operations
4. **Test error cases**: Invalid inputs, authorization failures
5. **Use fixtures**: Reusable test data and setup

### Debugging Tests

```bash
# Backend
npm test -- --verbose tests/initialize.test.js

# Frontend
npx playwright test --headed --debug e2e/contract-initialize.spec.ts

# Rust
RUST_BACKTRACE=full cargo test test_name -- --nocapture
```

### Performance Optimization

- Run tests in parallel (Jest/Playwright do this by default)
- Cache dependencies in CI/CD
- Use test timeouts to catch hanging tests
- Profile slow tests regularly

---

## Contributing

When adding new features:

1. ✅ Write tests first (TDD approach)
2. ✅ Ensure all existing tests pass
3. ✅ Add tests for edge cases and error conditions
4. ✅ Update this document with new test files/scenarios
5. ✅ Ensure CI/CD pipeline passes before submitting PR

---

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Playwright Documentation](https://playwright.dev/)
- [Soroban Testing](https://developers.stellar.org/docs/build/smart-contracts)
- [Supertest Guide](https://github.com/visionmedia/supertest)
