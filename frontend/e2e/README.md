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

### 6. Complete Royalty Flow (`royalty-flow.spec.ts`, #678/#756)
Full user workflow covering initialize → build transaction → distribute,
plus failure scenarios:
- Create a valid multi-collaborator royalty configuration
- Prepare a transaction through the backend on valid submission
- Show success feedback after a completed distribution
- Reject submission when collaborator percentages don't sum to 100%
- Reject a collaborator with an invalid Stellar address
- Display an error on a backend transaction-build failure (500)
- Display an error on a 409 already-initialized response

### 7. Transaction Detail (`transaction-detail.spec.ts`)
- Open and inspect a transaction's detail view

## Running locally

1. From `frontend/`, install dependencies (`npm install`) and Playwright's
   browser binary once: `npx playwright install chromium`.
2. Run `npm run test:e2e`. Playwright's `webServer` config starts the Vite
   dev server on `http://localhost:5173` automatically — you don't need to
   start it yourself first.
3. Use `npm run test:e2e:ui` for the interactive UI mode when debugging a
   failing spec, or `npx playwright test e2e/<file>.spec.ts` to run one file.

No live backend, Soroban RPC, or Freighter extension is required: every
spec mocks the wallet (`window.freighter`) via `addInitScript` and mocks
backend responses via `page.route(...)`, so these tests exercise real
frontend behavior (rendering, validation, request wiring) against
synthetic responses rather than a live testnet contract.

## Mocking

Tests mock:
- Freighter wallet API
- Stellar RPC responses
- Backend API endpoints

This allows tests to run without actual blockchain interaction or wallet installation.

## CI/CD

E2E tests run as the `E2E Tests (Playwright)` job in
`.github/workflows/frontend-ci.yml`, on every PR/push touching `frontend/**`.
The job installs Chromium via `npx playwright install --with-deps chromium`,
runs `npm run test:e2e`, and uploads the HTML report as a build artifact
(`playwright-report`, kept 14 days) whether the run passes or fails.

Configured with:
- Retries on failure (2 retries in CI, via `playwright.config.ts`)
- HTML report generation
- Automatic dev server startup
