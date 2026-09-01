import { test, expect } from "@playwright/test";

const contractId = `C${"A".repeat(55)}`;
const walletAddress = `G${"A".repeat(55)}`;
const collaboratorOne = `G${"B".repeat(55)}`;
const collaboratorTwo = `G${"C".repeat(55)}`;

test.describe("Contract Initialization Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/contract/status/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: false }),
      });
    });
    await page.route("**/api/secondary-royalty/rate/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ royaltyRate: 500 }),
      });
    });

    await page.addInitScript(
      ({ walletAddress }) => {
        localStorage.setItem("srs_help_seen", "1");
        localStorage.setItem("srs_currentPage", "initialize");
        localStorage.removeItem("lastContractId");

        window.freighter = {
          getAddress: async () => ({ address: walletAddress }),
          requestAccess: async () => ({ address: walletAddress }),
          signTransaction: async (xdr: string) => xdr,
        };
      },
      { walletAddress },
    );

    await page.goto("/");
  });

  test("should display initialize form", async ({ page }) => {
    await expect(page.getByText("Initialize").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /add collaborator/i })).toBeVisible();
    await expect(page.getByLabel("Royalty percentage for collaborator 1")).toBeVisible();
  });

  test("should configure percentage input constraints", async ({ page }) => {
    const percentageInput = page.getByLabel("Royalty percentage for collaborator 1");

    await expect(percentageInput).toHaveAttribute("type", "number");
    await expect(percentageInput).toHaveAttribute("min", "0");
    await expect(percentageInput).toHaveAttribute("max", "100");
  });

  test("should prevent invalid percentage keyboard characters", async ({ page }) => {
    const percentageInput = page.getByLabel("Royalty percentage for collaborator 1");

    for (const key of ["e", "E", "+", "-"]) {
      await percentageInput.fill("");
      await percentageInput.press(key);
      await expect(percentageInput).toHaveValue("");
    }
  });

  test("should show inline validation feedback for invalid percentages", async ({ page }) => {
    const percentageInput = page.getByLabel("Royalty percentage for collaborator 1");

    await percentageInput.fill("101");
    await expect(page.getByText("Percentage must be between 0 and 100.")).toBeVisible();
    await expect(percentageInput).toHaveAttribute("aria-invalid", "true");

    await percentageInput.fill("");
    await expect(page.getByText("Percentage is required.")).toBeVisible();

    await percentageInput.fill("-1");
    await expect(page.getByText("Percentage must be between 0 and 100.")).toBeVisible();
  });

  test("should accept valid percentage values", async ({ page }) => {
    const percentageInput = page.getByLabel("Royalty percentage for collaborator 1");

    for (const value of ["0", "50", "100"]) {
      await percentageInput.fill(value);
      await expect(percentageInput).toHaveValue(value);
      await expect(page.getByText(/Percentage (is required|must be)/)).toHaveCount(0);
    }
  });

  test("should validate collaborator percentages sum to 100", async ({ page }) => {
    await page.locator(".contract-input").fill(contractId);

    await page.getByRole("button", { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="Wallet address"]').first().fill(collaboratorOne);
    await page.getByLabel("Royalty percentage for collaborator 1").fill("50");

    await page.locator('input[placeholder*="Wallet address"]').last().fill(collaboratorTwo);
    await page.getByLabel("Royalty percentage for collaborator 2").fill("40");

    await page.getByRole("button", { name: /initialize contract/i }).click();

    await expect(page.getByText(/Percentages must sum to 100%/i)).toBeVisible();
  });
});
