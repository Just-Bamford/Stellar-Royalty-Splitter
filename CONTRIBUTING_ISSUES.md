# Open Source Contribution Issues

Welcome to **Stellar Royalty Splitter**! Below are well-scoped issues for contributors of all experience levels. Each issue includes full context, a step-by-step guide, expectations, and a clear definition of done.

---

## Issue #1 — Add Transaction Submission & Confirmation Polling

**Labels:** `enhancement` `good first issue` `frontend` `backend`
**Difficulty:** Intermediate

### Details

Currently the backend builds an unsigned XDR transaction and returns it to the frontend. The frontend signs it with Freighter but never actually submits it to the Stellar network. Transaction status stays `pending` forever because there is no confirmation loop.

### Guide

1. In `frontend/src/stellar.ts`, locate the Freighter signing helper.
2. After signing, call `SorobanRpc.Server.sendTransaction(signedTx)` to submit.
3. Poll `SorobanRpc.Server.getTransaction(hash)` every 2–3 seconds until status is `SUCCESS` or `FAILED` (max ~30 s).
4. Once confirmed, call `api.confirmTransaction(txHash, { status, blockTime })` so the backend updates the database record.
5. Surface loading/error states in the relevant React components (`DistributeForm`, `InitializeForm`, etc.).

### Expectations

- No private keys leave the browser.
- Polling must be cancelled on component unmount to avoid memory leaks.
- Both success and failure paths update the UI and the backend.

### Implementation Guide

```ts
// frontend/src/stellar.ts  (sketch)
export async function signAndSubmit(xdr: string): Promise<string> {
  const signed = await signTransaction(xdr, { network: "TESTNET" }); // Freighter
  const result = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed, Networks.TESTNET),
  );
  return result.hash;
}

export async function pollConfirmation(
  hash: string,
  onConfirmed: (status: "confirmed" | "failed") => void,
) {
  const interval = setInterval(async () => {
    const tx = await server.getTransaction(hash);
    if (tx.status === "SUCCESS") {
      clearInterval(interval);
      onConfirmed("confirmed");
    } else if (tx.status === "FAILED") {
      clearInterval(interval);
      onConfirmed("failed");
    }
  }, 3000);
  return () => clearInterval(interval); // cleanup
}
```

### Definition of Done

- [ ] Signed transactions are submitted to the Stellar testnet.
- [ ] Transaction status updates to `confirmed` or `failed` in the database.
- [ ] UI shows a spinner while pending and a success/error message on completion.
- [ ] No console errors or memory leaks during the polling lifecycle.

---

## Issue #2 — Expose Current Royalty Rate via API & Sync Frontend State

**Labels:** `enhancement` `good first issue` `backend` `frontend`
**Difficulty:** Beginner

### Details

`App.tsx` contains this comment:

```ts
// For now, keep using the local state. In a future enhancement,
// add an API endpoint to fetch the current royalty rate from the contract.
```

The royalty rate is hardcoded to `500` bp (5%) on page load. If someone sets a different rate, refreshing the page resets it. The rate should be fetched from the contract on load.

### Guide

1. Add a backend route `GET /api/secondary-royalty/rate/:contractId` in `backend/src/routes/secondary-royalty.js`.
2. In `backend/src/stellar.js`, call the contract's `get_royalty_rate` view function using `buildTx` or a read-only simulation.
3. Add `getRoyaltyRate(contractId: string)` to `frontend/src/api.ts`.
4. In `App.tsx`, replace the empty `useEffect` with a call to `getRoyaltyRate` whenever `contractId` changes.

### Expectations

- The endpoint should be read-only (no transaction needed — use `simulateTransaction`).
- Handle the case where the contract is not yet initialized (return `0` or a clear error).
- The frontend should not flash the wrong rate while loading.

### Implementation Guide

```js
// backend/src/routes/secondary-royalty.js
router.get("/rate/:contractId", async (req, res, next) => {
  try {
    const { contractId } = req.params;
    // Use server.simulateTransaction to call get_royalty_rate
    const rate = await getRoyaltyRateFromContract(contractId);
    res.json({ royaltyRate: rate });
  } catch (err) {
    next(err);
  }
});
```

```ts
// frontend/src/App.tsx
useEffect(() => {
  if (!contractId) return;
  api
    .getRoyaltyRate(contractId)
    .then(({ royaltyRate }) => setRoyaltyRate(royaltyRate))
    .catch(() => setRoyaltyRate(500)); // fallback
}, [contractId]);
```

### Definition of Done

- [ ] `GET /api/secondary-royalty/rate/:contractId` returns the on-chain rate.
- [ ] `api.getRoyaltyRate` is typed and exported from `api.ts`.
- [ ] `App.tsx` fetches the rate on contract ID change.
- [ ] Loading state prevents stale rate from being used in `RecordSecondarySale`.

---

## Issue #3 — Add Input Validation to Backend Routes

**Labels:** `bug` `security` `backend` `good first issue`
**Difficulty:** Beginner

### Details

Backend routes accept user-supplied data (wallet addresses, amounts, contract IDs) without validation. Malformed input can cause unhandled exceptions or corrupt the database.

Key routes to harden:

- `POST /api/initialize`
- `POST /api/distribute`
- `POST /api/secondary-royalty`
- `POST /api/secondary-royalty/set-rate`

### Guide

1. Install `zod` in the backend: `npm install zod`.
2. Define a schema for each route's request body.
3. Add a small `validate` middleware that parses the body and returns `400` on failure.
4. Apply the middleware to each route.

### Expectations

- Stellar addresses must match the pattern `G[A-Z2-7]{55}`.
- Contract IDs must match `C[A-Z2-7]{55}`.
- Amounts and basis points must be positive integers within valid ranges.
- Validation errors should return `{ error: "...", details: [...] }` with HTTP 400.

### Implementation Guide

```js
// backend/src/validation.js
import { z } from "zod";

const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");
const contractId = z.string().regex(/^C[A-Z2-7]{55}$/, "Invalid contract ID");

export const initializeSchema = z.object({
  contractId,
  walletAddress: stellarAddress,
  collaborators: z.array(stellarAddress).min(1).max(20),
  shares: z.array(z.number().int().positive()).min(1).max(20),
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: "Validation failed", details: result.error.errors });
    }
    req.body = result.data;
    next();
  };
}
```

### Definition of Done

- [ ] `zod` is installed and schemas cover all four routes.
- [ ] Invalid requests return HTTP 400 with a descriptive error.
- [ ] Valid requests pass through unchanged.
- [ ] No existing tests are broken.

---

## Issue #4 — Add API Rate Limiting

**Labels:** `security` `backend`
**Difficulty:** Beginner

### Details

The Express API has no rate limiting. A single client can flood the server with requests, causing denial of service or excessive Stellar RPC calls.

### Guide

1. Install `express-rate-limit`: `npm install express-rate-limit`.
2. Create a general limiter (e.g., 100 req/15 min per IP) applied globally.
3. Create a stricter limiter for write endpoints (e.g., 10 req/min per IP) applied to `POST` routes.
4. Return HTTP 429 with a `Retry-After` header when the limit is exceeded.

### Expectations

- Rate limits should be configurable via environment variables (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`).
- The `/api/health` endpoint should be exempt.
- Limits should be documented in `.env.example`.

### Implementation Guide

```js
// backend/src/index.js
import rateLimit from "express-rate-limit";

const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000"),
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "100"),
  standardHeaders: true,
  legacyHeaders: false,
});

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_WRITE_MAX ?? "10"),
});

app.use(generalLimiter);
app.use("/api/initialize", writeLimiter);
app.use("/api/distribute", writeLimiter);
app.use("/api/secondary-royalty", writeLimiter);
```

### Definition of Done

- [ ] General limiter applied to all routes.
- [ ] Stricter limiter applied to all `POST` routes.
- [ ] `/api/health` is exempt.
- [ ] Limits are configurable via `.env` and documented in `.env.example`.
- [ ] Exceeding the limit returns HTTP 429.

---

## Issue #5 — Integrate Secondary Royalty UI into Main Navigation

**Labels:** `enhancement` `frontend` `good first issue`
**Difficulty:** Beginner

### Details

The secondary royalty components (`SecondaryRoyaltyConfig`, `RecordSecondarySale`, `DistributeSecondaryRoyalties`, `ResaleHistory`) are rendered under a `hidden-secondary` page key that is never reachable from the navigation. Users cannot access these features through the UI.

### Guide

1. In `frontend/src/components/Navigation.tsx`, add a `"secondary"` nav item (e.g., "Secondary Royalties").
2. In `App.tsx`, add a `case "secondary":` to `renderPage()` that renders the four secondary royalty components inside a `<div className="page-section">`.
3. Move the secondary royalty JSX from the `currentPage === "hidden-secondary"` block into the new case.
4. Remove the now-unused `hidden-secondary` block.
5. Add the nav item to the Quick Actions sidebar when a wallet is connected.

### Expectations

- The new page should only render when both `contractId` and `walletAddress` are set (show a prompt otherwise).
- Styling should match the existing page sections.
- No new CSS files are needed — reuse existing classes.

### Implementation Guide

```tsx
// App.tsx — add to renderPage()
case "secondary":
  return walletAddress && contractId ? (
    <div className="page-section">
      <SecondaryRoyaltyConfig ... />
      <RecordSecondarySale ... />
      <DistributeSecondaryRoyalties ... />
      <ResaleHistory contractId={contractId} />
    </div>
  ) : (
    <div className="page-empty">
      <p>Please connect your wallet and select a contract first</p>
    </div>
  );
```

### Definition of Done

- [ ] "Secondary Royalties" appears in the navigation bar.
- [ ] Clicking it renders all four secondary royalty components.
- [ ] The `hidden-secondary` dead code is removed.
- [ ] The page shows a helpful message when wallet or contract is missing.

---

## Issue #6 — Add Frontend Input Validation & Error Messages

**Labels:** `enhancement` `frontend` `ux`
**Difficulty:** Intermediate

### Details

Forms like `InitializeForm` and `RecordSecondarySale` submit data to the backend without client-side validation. Users get cryptic backend errors instead of inline form feedback.

### Guide

1. For each form component, add validation logic before calling the API.
2. Display inline error messages below each field using a consistent pattern.
3. Disable the submit button while the form is invalid or a request is in-flight.
4. Key validations to add:
   - Stellar address format (`G...`, 56 chars)
   - Contract ID format (`C...`, 56 chars)
   - Shares must sum to 10,000 bp
   - Sale price and royalty rate must be positive numbers
   - At least one collaborator required

### Expectations

- Validation runs on blur (when leaving a field) and on submit.
- Error messages are clear and actionable (e.g., "Address must start with G and be 56 characters").
- No external form library is required — plain React state is fine.

### Implementation Guide

```tsx
// Example pattern for address validation
const [addressError, setAddressError] = useState("");

function validateAddress(value: string) {
  if (!/^G[A-Z2-7]{55}$/.test(value)) {
    setAddressError("Must be a valid Stellar address (starts with G, 56 chars)");
    return false;
  }
  setAddressError("");
  return true;
}

// In JSX
<input onBlur={(e) => validateAddress(e.target.value)} ... />
{addressError && <span className="field-error">{addressError}</span>}
```

### Definition of Done

- [ ] `InitializeForm` validates addresses and share totals.
- [ ] `RecordSecondarySale` validates price, rate, and address fields.
- [ ] `DistributeForm` validates contract ID and token address.
- [ ] Submit buttons are disabled when the form is invalid.
- [ ] Error messages are visible and descriptive.

---

## Issue #7 — Add Pagination UI for Transaction History

**Labels:** `enhancement` `frontend`
**Difficulty:** Intermediate

### Details

The backend supports `limit` and `offset` pagination for transaction history and secondary sales, but the frontend fetches a fixed 50 records and has no pagination controls. For contracts with many transactions, older records are inaccessible.

### Guide

1. Create a reusable `<Pagination>` component that accepts `total`, `limit`, `offset`, and `onPageChange` props.
2. Integrate it into `TransactionHistory.tsx` and `ResaleHistory.tsx`.
3. Update the API calls in those components to pass the current `offset` when the page changes.
4. The backend already returns a `total` count — use it to calculate the number of pages.

### Expectations

- Show "Previous" / "Next" buttons and the current page indicator.
- Disable "Previous" on the first page and "Next" on the last page.
- Page size should default to 20 (not 50) for better readability.
- Changing the page should scroll to the top of the table.

### Implementation Guide

```tsx
// frontend/src/components/Pagination.tsx
interface PaginationProps {
  total: number;
  limit: number;
  offset: number;
  onPageChange: (newOffset: number) => void;
}

export function Pagination({
  total,
  limit,
  offset,
  onPageChange,
}: PaginationProps) {
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);

  return (
    <div className="pagination">
      <button
        disabled={offset === 0}
        onClick={() => onPageChange(offset - limit)}
      >
        Previous
      </button>
      <span>
        Page {currentPage} of {totalPages}
      </span>
      <button
        disabled={offset + limit >= total}
        onClick={() => onPageChange(offset + limit)}
      >
        Next
      </button>
    </div>
  );
}
```

### Definition of Done

- [ ] `<Pagination>` component is created and reusable.
- [ ] `TransactionHistory` uses it with correct total/offset wiring.
- [ ] `ResaleHistory` uses it for both the sales and distributions tables.
- [ ] "Previous" / "Next" are correctly disabled at boundaries.
- [ ] Page resets to 0 when `contractId` changes.

---

## Issue #8 — Add Access Control to `set_royalty_rate` in Smart Contract

**Labels:** `security` `smart-contract` `rust`
**Difficulty:** Intermediate

### Details

The `set_royalty_rate` function in `src/lib.rs` can be called by anyone. There is no check that the caller is an authorized admin or the contract deployer. This means any wallet can change the royalty rate at any time.

### Guide

1. Add an `Admin` key to the `DataKey` enum.
2. During `initialize`, store the caller's address as the admin: `env.storage().instance().set(&DataKey::Admin, &caller)`.
3. In `set_royalty_rate`, require the caller to authenticate: `admin.require_auth()`.
4. Update `tests/integration_test.rs` to verify that unauthorized callers are rejected.

### Expectations

- The admin address is set once during `initialize` and cannot be changed (for now).
- `require_auth()` is the correct Soroban pattern — do not implement custom signature verification.
- The change must not break existing tests.

### Implementation Guide

```rust
// src/lib.rs

#[contracttype]
pub enum DataKey {
    // ... existing keys
    Admin, // Address
}

pub fn initialize(env: Env, collaborators: Vec<Address>, shares: Vec<u32>) {
    // ... existing logic
    let admin = collaborators.get(0).unwrap(); // or pass separately
    env.storage().instance().set(&DataKey::Admin, &admin);
}

pub fn set_royalty_rate(env: Env, rate_bp: u32) {
    let admin: Address = env.storage().instance()
        .get(&DataKey::Admin)
        .expect("not initialized");
    admin.require_auth();

    assert!(rate_bp <= 10_000, "royalty rate cannot exceed 100%");
    env.storage().instance().set(&DataKey::RoyaltyRate, &rate_bp);
}
```

### Definition of Done

- [ ] `DataKey::Admin` is added and stored during `initialize`.
- [ ] `set_royalty_rate` calls `admin.require_auth()`.
- [ ] Unauthorized calls panic with a clear message.
- [ ] Integration tests cover both authorized and unauthorized scenarios.
- [ ] `cargo test` passes.

---

## Issue #9 — Add OpenAPI / Swagger Documentation

**Labels:** `documentation` `backend`
**Difficulty:** Beginner

### Details

The backend has 12+ endpoints with no machine-readable documentation. Contributors and integrators have to read source code to understand the API. An OpenAPI spec would enable auto-generated docs and client SDKs.

### Guide

1. Install `swagger-ui-express` and `swagger-jsdoc`: `npm install swagger-ui-express swagger-jsdoc`.
2. Add JSDoc `@swagger` annotations to each route file.
3. Mount the Swagger UI at `GET /api/docs`.
4. Cover all existing endpoints with request/response schemas.

### Expectations

- All endpoints documented with method, path, request body, and response shape.
- Schemas should match the TypeScript interfaces in `frontend/src/api.ts`.
- The `/api/docs` page should be accessible in development without authentication.

### Implementation Guide

```js
// backend/src/index.js
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";

const spec = swaggerJsdoc({
  definition: {
    openapi: "3.0.0",
    info: { title: "Stellar Royalty Splitter API", version: "1.0.0" },
  },
  apis: ["./src/routes/*.js"],
});

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(spec));
```

```js
// Example annotation in routes/initialize.js
/**
 * @swagger
 * /api/initialize:
 *   post:
 *     summary: Build an initialize transaction XDR
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contractId, walletAddress, collaborators, shares]
 *             properties:
 *               contractId:
 *                 type: string
 *               walletAddress:
 *                 type: string
 *               collaborators:
 *                 type: array
 *                 items:
 *                   type: string
 *               shares:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Unsigned XDR transaction
 */
```

### Definition of Done

- [ ] All 12+ endpoints have `@swagger` annotations.
- [ ] `GET /api/docs` renders the Swagger UI.
- [ ] Request and response schemas are accurate.
- [ ] `swagger-ui-express` and `swagger-jsdoc` are added to `package.json`.

---

## Issue #10 — Add Frontend Unit Tests for Key Components

**Labels:** `testing` `frontend`
**Difficulty:** Intermediate

### Details

There are no frontend tests. Core components like `CollaboratorTable`, `Dashboard`, and `TransactionHistory` have no coverage. Contributors making changes have no safety net.

### Guide

1. Install Vitest and React Testing Library: `npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom`.
2. Configure Vitest in `vite.config.ts`.
3. Write tests for at least three components:
   - `CollaboratorTable` — renders collaborator rows correctly
   - `TransactionHistory` — shows empty state and populated rows
   - `Dashboard` — renders KPI cards with mocked API data

### Expectations

- Tests should mock `fetch` or the `api` module — no real network calls.
- Each component should have at least one "renders without crashing" test and one behavioral test.
- Tests run with `npm test` (add the script to `package.json`).

### Implementation Guide

```ts
// frontend/src/components/CollaboratorTable.test.tsx
import { render, screen } from "@testing-library/react";
import { CollaboratorTable } from "./CollaboratorTable";

const mockCollaborators = [
  { address: "GABC...XYZ", basisPoints: 6000 },
  { address: "GDEF...UVW", basisPoints: 4000 },
];

test("renders collaborator rows", () => {
  render(<CollaboratorTable collaborators={mockCollaborators} />);
  expect(screen.getByText("GABC...XYZ")).toBeInTheDocument();
  expect(screen.getByText("60%")).toBeInTheDocument();
});

test("shows empty state when no collaborators", () => {
  render(<CollaboratorTable collaborators={[]} />);
  expect(screen.getByText(/no collaborators/i)).toBeInTheDocument();
});
```

```ts
// vite.config.ts — add test config
export default defineConfig({
  // ...existing config
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
```

### Definition of Done

- [ ] Vitest and React Testing Library are installed and configured.
- [ ] Tests exist for `CollaboratorTable`, `TransactionHistory`, and `Dashboard`.
- [ ] Each component has at least 2 tests (render + behavior).
- [ ] `npm test` runs all tests and they pass.
- [ ] No real network calls are made during tests.

---

## Getting Started as a Contributor

1. Fork the repository and clone your fork.
2. Follow the setup instructions in `README.md`.
3. Pick an issue, comment on it to claim it, and open a PR when ready.
4. PRs should target the `main` branch and include a brief description of changes.
5. All PRs must pass `cargo test` (Rust) and `npm test` (frontend, once Issue #10 is merged).

For questions, open a GitHub Discussion or comment on the relevant issue.
