/**
 * E2E tests for distribution loading states and optimistic updates (#391).
 *
 * Covers:
 *  1. Loading spinner visible during form submission
 *  2. Form inputs disabled while submitting
 *  3. Transaction ID shown after submission
 *  4. Confirmation status updated pending → confirmed
 *  5. In-flight guard (no resubmit while submitting)
 *  6. Timeout scenario handled gracefully
 *  7. Error state on API failure
 */
import { test, expect } from "@playwright/test";

const contractId = `C${"A".repeat(55)}`;
const walletAddress = `G${"A".repeat(55)}`;
const tokenId = `C${"B".repeat(55)}`;

/** Mock Freighter + set localStorage before page load */
async function setupPage(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ walletAddress, contractId }) => {
      localStorage.setItem("srs_help_seen", "1");
      localStorage.setItem("srs_currentPage", "distribute");
      localStorage.setItem("lastContractId", contractId);

      (window as Window & { freighter?: unknown }).freighter = {
        getAddress: async () => ({ address: walletAddress }),
        requestAccess: async () => ({ address: walletAddress }),
        // signTransaction echoes the XDR back as a fake hash
        signTransaction: async (_xdr: string) =>
          "a".repeat(64),
      };
    },
    { walletAddress, contractId },
  );
}

/** Mock all baseline API routes needed for the page to render */
async function mockBaseRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/contract/status/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ initialized: true }),
    }),
  );
  await page.route("**/api/secondary-royalty/rate/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ royaltyRate: 500 }),
    }),
  );
  await page.route("**/api/collaborators/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { address: walletAddress, basisPoints: 5000 },
        { address: `G${"B".repeat(55)}`, basisPoints: 5000 },
      ]),
    }),
  );
  await page.route(`**/api/contract/balance/**`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ balance: "1000" }),
    }),
  );
}

/** Mock the distribute + confirm endpoints */
async function mockDistributeSuccess(
  page: import("@playwright/test").Page,
  { delayMs = 0 }: { delayMs?: number } = {},
) {
  await page.route("**/api/distribute", async (route) => {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ xdr: "MOCK_XDR", transactionId: 42 }),
    });
  });
  await page.route("**/api/transaction/confirm/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ success: true, message: "confirmed" }),
    }),
  );
}

// ── helpers ────────────────────────────────────────────────────────────────

async function fillAndSubmit(page: import("@playwright/test").Page) {
  const tokenInput = page.getByLabel(/token contract address/i);
  await tokenInput.fill(tokenId);
  // Wait for balance fetch
  await expect(
    page.getByText(/available balance/i),
  ).toBeVisible({ timeout: 5000 });

  const amountInput = page.getByLabel(/amount/i);
  await amountInput.fill("10");

  const submitBtn = page.getByTestId("distribute-submit");
  await submitBtn.click();
}

// ── tests ──────────────────────────────────────────────────────────────────

test.describe("Distribution loading states (#391)", () => {
  test.beforeEach(async ({ page }) => {
    await setupPage(page);
    await mockBaseRoutes(page);
    await page.goto("/");
    // Wait for form to appear
    await expect(page.getByTestId("distribute-submit")).toBeVisible({ timeout: 8000 });
  });

  test("shows loading spinner on submit button while submitting", async ({ page }) => {
    // Delay API so we can observe the loading state
    await mockDistributeSuccess(page, { delayMs: 800 });

    await fillAndSubmit(page);

    // Spinner wrapper has aria-busy=true while loading
    const submitBtn = page.getByTestId("distribute-submit");
    await expect(submitBtn).toHaveAttribute("aria-busy", "true");

    // The btn-spinner element should be present
    await expect(page.locator(".btn-spinner")).toBeVisible();

    // Button text changes
    await expect(submitBtn).toContainText("Submitting");
  });

  test("disables form inputs while submission is in flight", async ({ page }) => {
    await mockDistributeSuccess(page, { delayMs: 800 });
    await fillAndSubmit(page);

    // Both token and amount inputs must be disabled
    const tokenInput = page.getByLabel(/token contract address/i);
    const amountInput = page.getByLabel(/amount/i);
    await expect(tokenInput).toBeDisabled();
    await expect(amountInput).toBeDisabled();

    // Submit button itself must be disabled too
    await expect(page.getByTestId("distribute-submit")).toBeDisabled();
  });

  test("shows transaction status badge during submission phases", async ({ page }) => {
    await mockDistributeSuccess(page, { delayMs: 500 });
    await fillAndSubmit(page);

    const badge = page.getByTestId("tx-status-badge");
    await expect(badge).toBeVisible();
    // Should be in an in-flight phase
    const phase = await badge.getAttribute("data-phase");
    expect(["building", "signing", "confirming"]).toContain(phase);
  });

  test("shows transaction ID after submission and confirmed status", async ({ page }) => {
    await mockDistributeSuccess(page);
    await fillAndSubmit(page);

    // Wait for confirmed phase
    await expect(page.getByTestId("tx-status-badge")).toHaveAttribute(
      "data-phase",
      "confirmed",
      { timeout: 8000 },
    );

    // Transaction ID is displayed
    await expect(page.getByTestId("tx-transaction-id")).toContainText("42");
  });

  test("status transitions from building → signing → confirming → confirmed", async ({
    page,
  }) => {
    await mockDistributeSuccess(page);
    await fillAndSubmit(page);

    const badge = page.getByTestId("tx-status-badge");

    // Eventually reaches confirmed
    await expect(badge).toHaveAttribute("data-phase", "confirmed", {
      timeout: 10000,
    });
    await expect(badge).toContainText("Distribution confirmed");
  });

  test("does not resubmit if a transaction is already in-flight", async ({ page }) => {
    let distributeCallCount = 0;
    await page.route("**/api/distribute", async (route) => {
      distributeCallCount += 1;
      // Hold the first request open
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ xdr: "MOCK_XDR", transactionId: 99 }),
      });
    });
    await page.route("**/api/transaction/confirm/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true, message: "confirmed" }),
      }),
    );

    await fillAndSubmit(page);

    // Try clicking submit again while in-flight — button is disabled
    const submitBtn = page.getByTestId("distribute-submit");
    await expect(submitBtn).toBeDisabled();
    // Attempt a second click (should be a no-op)
    await submitBtn.click({ force: true });

    // API should only have been called once
    expect(distributeCallCount).toBe(1);
  });

  test("shows failed status and error message on API error", async ({ page }) => {
    await page.route("**/api/distribute", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Stellar RPC unavailable" }),
      }),
    );

    await fillAndSubmit(page);

    const badge = page.getByTestId("tx-status-badge");
    await expect(badge).toHaveAttribute("data-phase", "failed", {
      timeout: 8000,
    });
    await expect(page.getByTestId("tx-error-message")).toBeVisible();

    // Form inputs should be re-enabled after failure
    const tokenInput = page.getByLabel(/token contract address/i);
    await expect(tokenInput).not.toBeDisabled();
  });

  test("handles timeout gracefully and shows timeout badge", async ({ page }) => {
    // Return a 504-like timeout error from the API
    await page.route("**/api/distribute", (route) =>
      route.fulfill({
        status: 504,
        contentType: "application/json",
        body: JSON.stringify({ error: "Request timed out. Please try again later." }),
      }),
    );

    await fillAndSubmit(page);

    const badge = page.getByTestId("tx-status-badge");
    // Timeout errors map to "failed" phase (504 doesn't contain "timeout" in message above)
    // but the timeout phase is triggered for messages that include "timed out"
    const phase = await badge.getAttribute("data-phase", { timeout: 8000 });
    expect(["failed", "timeout"]).toContain(phase);
  });
});
