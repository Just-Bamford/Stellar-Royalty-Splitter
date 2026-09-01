import { test, expect } from "@playwright/test";

test.describe("Contributor Onboarding Checklist (#567)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Click on Onboarding tab in navigation
    const onboardingBtn = page.getByRole("button", { name: /onboarding/i });
    await expect(onboardingBtn).toBeVisible();
    await onboardingBtn.click();
  });

  test("should display contributor onboarding checklist component with progress bar", async ({
    page,
  }) => {
    await expect(
      page.getByRole("heading", { name: /contributor onboarding checklist/i }),
    ).toBeVisible();

    await expect(page.getByText(/overall completion/i)).toBeVisible();
    await expect(page.getByRole("progressbar")).toBeVisible();
  });

  test("should display checklist items and test states (0%, 50%, 100%)", async ({
    page,
  }) => {
    // Check checklist items are rendered
    await expect(page.getByText("Wallet connected")).toBeVisible();
    await expect(page.getByText("KYC verified")).toBeVisible();
    await expect(page.getByText("Payment preferences set")).toBeVisible();
    await expect(page.getByText("Tax info submitted")).toBeVisible();
    await expect(page.getByText("First distribution received")).toBeVisible();

    // Test 0% state
    await page.getByRole("button", { name: "0%" }).click();
    await expect(page.getByText("0%")).toBeVisible();
    await expect(page.getByText("Restricted Actions Locked")).toBeVisible();
    await expect(page.getByText("👉 Next Required Step: Connect Wallet")).toBeVisible();

    // Test 50% state
    await page.getByRole("button", { name: "50%" }).click();
    await expect(page.getByText("40%")).toBeVisible();
    await expect(page.getByText("Restricted Actions Locked")).toBeVisible();

    // Test 100% state
    await page.getByRole("button", { name: "100%" }).click();
    await expect(page.getByText("100%")).toBeVisible();
    await expect(
      page.getByText("All Required Steps Complete! Payout Actions Unlocked"),
    ).toBeVisible();
  });

  test("should submit email reminder and display success toast", async ({
    page,
  }) => {
    const emailInput = page.getByPlaceholder("contributor@example.com");
    await expect(emailInput).toBeVisible();

    await emailInput.fill("testcontributor@example.com");
    await page.getByRole("button", { name: /send reminder email/i }).click();

    await expect(page.getByText(/successfully sent to testcontributor@example.com/i)).toBeVisible();
  });
});
