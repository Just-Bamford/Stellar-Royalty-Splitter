import { test, expect } from "@playwright/test";

test.describe("Transaction Detail View (#577)", () => {
  const mockTxHash = "1111111111111111111111111111111111111111111111111111111111111111";
  const mockContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  test.beforeEach(async ({ page }) => {
    // Intercept backend API calls for transaction history and transaction details
    await page.route("**/api/v1/history/*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            {
              id: 1,
              txHash: mockTxHash,
              contractId: mockContractId,
              type: "distribute",
              initiatorAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
              requestedAmount: "1000",
              tokenId: "XLM",
              timestamp: "2026-07-24T12:00:00.000Z",
              status: "confirmed",
            },
          ],
          pagination: { limit: 10, offset: 0, total: 1 },
        }),
      });
    });

    await page.route(`**/api/v1/transaction/${mockTxHash}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            id: 1,
            txHash: mockTxHash,
            contractId: mockContractId,
            type: "distribute",
            initiatorAddress: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
            requestedAmount: "1000",
            tokenId: "XLM",
            timestamp: "2026-07-24T12:00:00.000Z",
            blockTime: "2026-07-24T12:00:05.000Z",
            status: "confirmed",
            errorMessage: null,
            payouts: [
              {
                collaboratorAddress: "GAAAAAAA111111111111111111111111111111111111111111111111",
                amountReceived: "600",
                sharePercentage: 60,
              },
              {
                collaboratorAddress: "GBBBBBBB222222222222222222222222222222222222222222222222",
                amountReceived: "400",
                sharePercentage: 40,
              },
            ],
            totalPayout: "1000",
            auditHistory: [
              {
                id: 50,
                contractId: mockContractId,
                action: "distribute_payouts",
                user: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
                details: { amount: "1000", recipients: 2 },
                timestamp: "2026-07-24T12:00:00.000Z",
              },
            ],
            contractEvents: [
              {
                id: "evt-1-invoked",
                type: "contract_invocation",
                contractId: mockContractId,
                topics: ["contract_call", "distribute", mockContractId],
                data: {
                  function: "distribute",
                  initiator: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYCZTM6W2XYFORCWA4V",
                  status: "confirmed",
                },
                timestamp: "2026-07-24T12:00:05.000Z",
              },
            ],
          },
        }),
      });
    });
  });

  test("loads transaction detail view via share link query parameter", async ({ page }) => {
    await page.goto(`/?page=transactions&txHash=${mockTxHash}`);

    await expect(page.getByTestId("transaction-detail-view")).toBeVisible();
    await expect(page.locator("h2.tx-detail-title")).toContainText("Transaction Details");
    await expect(page.locator(".tx-status-badge")).toContainText("Confirmed");

    // Verify recipient payouts and share percentage bars
    await expect(page.locator("table.tx-payouts-table")).toBeVisible();
    await expect(page.locator(".tx-share-percent-text").first()).toContainText("60%");
    await expect(page.locator(".tx-share-percent-text").last()).toContainText("40%");

    // Verify audit log timeline
    await expect(page.locator(".tx-audit-action")).toContainText("distribute_payouts");

    // Test raw contract events inspector toggle
    await page.click("button:has-text('Inspect Raw Event Payload')");
    await expect(page.getByTestId("raw-contract-events")).toBeVisible();
    await expect(page.locator(".tx-events-json")).toContainText("contract_invocation");

    // Test Copy Share Link button
    await page.click("button:has-text('Share Link')");
    await expect(page.locator(".tx-toast.success")).toContainText("Shareable URL pre-filled");
  });
});
