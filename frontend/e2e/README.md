# E2E Tests

End-to-end tests for the Stellar Royalty Splitter frontend using Playwright.

## Running Tests

```bash
# Run all E2E tests
npm run test:e2e

# Run tests in UI mode (interactive)
npm run test:e2e:ui

# Run specific test file
npx playwright test e2e/wallet-connect.spec.ts
```

## Test Coverage

### 1. Wallet Connect Flow (`wallet-connect.spec.ts`)
- Display wallet connect button
- Handle Freighter not installed
- Mock wallet connection

### 2. Navigation (`navigation.spec.ts`)
- Load homepage
- Navigate between sections
- Error boundary handling

### 3. Contract Initialization (`contract-initialize.spec.ts`)
- Display initialize form
- Validate shares sum to 10,000
- Successfully initialize contract

### 4. Distribution Flow (`distribution.spec.ts`)
- Display distribute form
- Validate required fields
- Successfully distribute funds

### 5. Secondary Royalty Flow (`secondary-royalty.spec.ts`)
- Display secondary royalty section
- Record secondary sale
- Distribute secondary royalties

## Mocking

Tests mock:
- Freighter wallet API
- Stellar RPC responses
- Backend API endpoints

This allows tests to run without actual blockchain interaction or wallet installation.

## CI/CD

Tests are configured to run in CI with:
- Retries on failure
- HTML report generation
- Automatic dev server startup
