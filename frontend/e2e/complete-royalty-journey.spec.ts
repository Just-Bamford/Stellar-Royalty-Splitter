import { test, expect } from "@playwright/test";

const WALLET = `G${"A".repeat(55)}`;
const COLLABORATOR = `G${"B".repeat(55)}`;
const CONTRACT = `C${"A".repeat(55)}`;
const TOKEN = `C${"D".repeat(55)}`;

/**
 * Contract-facing calls are mocked at the browser boundary. The test still
 * exercises the same visible user journey and makes each state transition
 * explicit, so it is safe to run in CI without a funded Stellar account.
 */
test.describe("complete royalty splitter journey", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(({ wallet }) => {
      localStorage.setItem("srs_help_seen", "1");
      localStorage.setItem("srs_currentPage", "initialize");
      window.freighter = {
        getAddress: async () => ({ address: wallet }),
        requestAccess: async () => ({ address: wallet }),
        signTransaction: async (xdr: string) => xdr,
      };
    }, { wallet: WALLET });

    await page.route("**/api/contract/status/**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ initialized: false }) });
    });
    await page.route("**/api/v1/initialize", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, xdr: "mock-init-xdr", transactionId: "init-1" }) });
    });
    await page.route("**/api/v1/distribute", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, xdr: "mock-distribute-xdr", transactionId: "dist-1" }) });
    });
    await page.route("**/api/v1/transaction/confirm/**", async (route) => {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, status: "confirmed", transactionId: "tx-1" }) });
    });
  });

  test("connects, initializes, funds, and distributes", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /connect freighter/i }).click();
    await expect(page.getByText(WALLET.slice(0, 8))).toBeVisible();

    await page.locator(".contract-input").fill(CONTRACT);
    await page.getByRole("button", { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="Wallet address"]').first().fill(WALLET);
    await page.locator('input[placeholder*="Wallet address"]').last().fill(COLLABORATOR);
    await page.getByLabel("Royalty percentage for collaborator 1").fill("60");
    await page.getByLabel("Royalty percentage for collaborator 2").fill("40");
    await page.getByRole("button", { name: /initialize contract/i }).click();
    await expect(page.getByText(/initializ(ed|ation)/i).first()).toBeVisible();

    await page.evaluate((token) => localStorage.setItem("srs_funding_token", token), TOKEN);
    await page.getByText(/distribute/i).first().click();
    await expect(page.getByRole("heading", { name: /distribute/i }).first()).toBeVisible();
    await page.getByLabel(/token address/i).fill(TOKEN);
    await page.getByLabel(/amount/i).fill("1000");
    await page.getByRole("button", { name: /distribute funds/i }).click();
    await expect(page.getByText(/transaction|submitted|confirmed/i).first()).toBeVisible();
  });
});
