import { expect, test } from "@playwright/test";
import { PERFORMANCE_BUDGETS } from "./config";

test.describe("royalty splitter performance budgets (#964)", () => {
  test("homepage loads within the monitored budget", async ({ page }) => {
    const started = Date.now();
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    const elapsed = Date.now() - started;
    expect(elapsed, `page load took ${elapsed}ms`).toBeLessThan(PERFORMANCE_BUDGETS.pageLoadMs);
  });

  test("primary navigation responds within the interaction budget", async ({ page }) => {
    await page.goto("/");
    const started = Date.now();
    const button = page.getByRole("button").first();
    if (await button.isVisible().catch(() => false)) await button.click();
    const elapsed = Date.now() - started;
    expect(elapsed, `interaction took ${elapsed}ms`).toBeLessThan(PERFORMANCE_BUDGETS.interactionMs);
  });
});
