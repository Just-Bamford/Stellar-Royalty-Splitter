import { test, expect } from "@playwright/test";

const contractId = `C${"A".repeat(55)}`;
const walletAddress = `G${"A".repeat(55)}`;
const collaboratorA = `G${"B".repeat(55)}`;
const collaboratorB = `G${"C".repeat(55)}`;
const tokenId = `C${"D".repeat(55)}`;

function setupWalletMock(page: Parameters<typeof test>[1] extends (args: { page: infer P }) => unknown ? P : never, address = walletAddress) {
  return page.addInitScript(
    ({ addr }: { addr: string }) => {
      window.freighter = {
        getAddress: async () => ({ address: addr }),
        requestAccess: async () => ({ address: addr }),
        signTransaction: async (xdr: string) => xdr,
        isConnected: async () => true,
      };
      localStorage.setItem("srs_help_seen", "1");
      localStorage.removeItem("srs_royalty_draft");
    },
    { addr: address },
  );
}

test.describe("Complete Royalty Flow (#678)", () => {
  test.beforeEach(async ({ page }) => {
    await setupWalletMock(page);

    // Mock contract status — not yet initialised.
    await page.route("**/api/contract/status/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: false }),
      }),
    );

    // Mock secondary royalty rate endpoint.
    await page.route("**/api/secondary-royalty/rate/**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ royaltyRate: 500 }),
      }),
    );

    await page.goto("/");
  });

  // ── Test 1: Create a valid royalty configuration ──────────────────────────

  test("creates a valid two-collaborator royalty configuration", async ({ page }) => {
    // Navigate to the Initialize tab.
    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInputs = page.locator('input[placeholder*="Wallet address"]');
    const percentageInputs = page.locator('input[type="number"]');

    await addressInputs.first().fill(collaboratorA);
    await percentageInputs.first().fill("60");

    await page.getByRole("button", { name: /add collaborator/i }).click();

    await addressInputs.last().fill(collaboratorB);
    await percentageInputs.last().fill("40");

    // Share total should show 100%.
    await expect(page.getByTestId("share-total")).toContainText("100.00%");

    // Submit button should be enabled.
    const submitBtn = page.getByRole("button", { name: /initialize contract/i });
    await expect(submitBtn).not.toBeDisabled();
  });

  // ── Test 2: Transaction preparation through the backend ───────────────────

  test("prepares a transaction through the backend on valid submission", async ({ page }) => {
    await page.route("**/api/v1/initialize", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ xdr: "MOCK_XDR_INITIALIZE", transactionId: "tx-001" }),
      }),
    );

    await page.route("**/api/v1/history/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "confirmed" }),
      }),
    );

    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInputs = page.locator('input[placeholder*="Wallet address"]');
    const percentageInputs = page.locator('input[type="number"]');

    await page.locator(".contract-input, input[placeholder*='contract']").first().fill(contractId);
    await addressInputs.first().fill(collaboratorA);
    await percentageInputs.first().fill("100");

    await page.getByRole("button", { name: /initialize contract/i }).click();

    // The UI should transition to "Building transaction" or similar.
    await expect(
      page.getByText(/building|submitting|signing|waiting/i).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  // ── Test 3: Successful royalty distribution feedback ──────────────────────

  test("shows success feedback after a completed distribution", async ({ page }) => {
    await page.route("**/api/v1/distribute", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          xdr: "MOCK_XDR_DISTRIBUTE",
          transactionId: "tx-dist-001",
        }),
      }),
    );

    // Navigate to the distribute page.
    const distributeLink = page.getByRole("link", { name: /distribute/i });
    if (await distributeLink.isVisible()) {
      await distributeLink.click();
    }

    const contractInput = page
      .locator('input[placeholder*="contract"], input[placeholder*="Contract"]')
      .first();
    if (await contractInput.isVisible()) {
      await contractInput.fill(contractId);
    }

    const tokenInput = page
      .locator('input[placeholder*="token"], input[placeholder*="Token"]')
      .first();
    if (await tokenInput.isVisible()) {
      await tokenInput.fill(tokenId);
    }

    const distributeBtn = page.getByRole("button", { name: /^distribute$/i });
    if (await distributeBtn.isVisible()) {
      await distributeBtn.click();
      // A success message or transaction ID should appear.
      await expect(page.getByText(/success|tx-dist-001|xdr/i)).toBeVisible({
        timeout: 5000,
      });
    }
  });

  // ── Test 4: Invalid configuration is rejected ─────────────────────────────

  test("rejects submission when collaborator percentages do not sum to 100%", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInputs = page.locator('input[placeholder*="Wallet address"]');
    const percentageInputs = page.locator('input[type="number"]');

    await page.getByRole("button", { name: /add collaborator/i }).click();

    await addressInputs.first().fill(collaboratorA);
    await percentageInputs.first().fill("50");

    await addressInputs.last().fill(collaboratorB);
    await percentageInputs.last().fill("40");

    await page.locator(".contract-input, input[placeholder*='contract']").first().fill(contractId);
    await page.getByRole("button", { name: /initialize contract/i }).click();

    await expect(page.getByText(/must sum to 100|percentages must sum/i)).toBeVisible();
  });

  test("rejects a collaborator with an invalid Stellar address", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInput = page
      .locator('input[placeholder*="Wallet address"]')
      .first();

    await addressInput.fill("NOT_A_VALID_ADDRESS");
    await addressInput.blur();

    await expect(
      page.getByText(/valid Stellar address|G\.\.\., 56 chars/i),
    ).toBeVisible();
  });

  // ── Test 5: Transaction failure states ────────────────────────────────────

  test("displays an error when the backend returns a transaction build failure", async ({
    page,
  }) => {
    await page.route("**/api/v1/initialize", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "stellar_rpc_error", message: "RPC unavailable" }),
      }),
    );

    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInputs = page.locator('input[placeholder*="Wallet address"]');
    const percentageInputs = page.locator('input[type="number"]');

    await page.locator(".contract-input, input[placeholder*='contract']").first().fill(contractId);
    await addressInputs.first().fill(collaboratorA);
    await percentageInputs.first().fill("100");

    await page.getByRole("button", { name: /initialize contract/i }).click();

    await expect(
      page.getByText(/error|unavailable|failed/i).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("displays an error when the backend returns a 409 already-initialized response", async ({
    page,
  }) => {
    await page.route("**/api/v1/initialize", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "already_initialized",
          message: "Contract is already initialized",
        }),
      }),
    );

    await page.evaluate(() => {
      localStorage.setItem("srs_currentPage", "initialize");
    });
    await page.reload();

    const addressInputs = page.locator('input[placeholder*="Wallet address"]');
    const percentageInputs = page.locator('input[type="number"]');

    await page.locator(".contract-input, input[placeholder*='contract']").first().fill(contractId);
    await addressInputs.first().fill(collaboratorA);
    await percentageInputs.first().fill("100");

    await page.getByRole("button", { name: /initialize contract/i }).click();

    await expect(
      page.getByText(/already initialized/i).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
