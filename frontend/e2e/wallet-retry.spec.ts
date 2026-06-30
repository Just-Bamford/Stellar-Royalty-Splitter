import { test, expect } from "@playwright/test";

/**
 * E2E for the wallet connection retry flow (#412).
 *
 * Freighter is mocked so its first access attempt fails (simulating an RPC
 * timeout) and a later attempt succeeds. The UI should surface a
 * "Reconnecting…" state and then reach the connected state without the user
 * having to click again.
 */
test.describe("Wallet Connection Retry", () => {
  test("retries a failed connection and eventually connects", async ({ page }) => {
    await page.goto("/");

    // Mock Freighter: fail the first requestAccess, then succeed.
    await page.evaluate(() => {
      let calls = 0;
      (window as any).freighter = {
        requestAccess: async () => {
          calls += 1;
          if (calls < 2) {
            throw new Error("rpc timeout");
          }
          return { address: "GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ" };
        },
      };
    });

    await page.getByRole("button", { name: /connect/i }).click();

    // Reconnecting feedback shows during the backoff window.
    await expect(page.getByText(/reconnecting/i)).toBeVisible();

    // After the retry succeeds the connected address is displayed.
    await expect(page.getByText(/GTEST/i)).toBeVisible({ timeout: 10_000 });
  });

  test("surfaces an error after retries are exhausted", async ({ page }) => {
    await page.goto("/");

    await page.evaluate(() => {
      (window as any).freighter = {
        requestAccess: async () => {
          throw new Error("rpc timeout");
        },
      };
    });

    await page.getByRole("button", { name: /connect/i }).click();

    await expect(page.getByText(/could not connect/i)).toBeVisible({
      timeout: 15_000,
    });
  });
});
