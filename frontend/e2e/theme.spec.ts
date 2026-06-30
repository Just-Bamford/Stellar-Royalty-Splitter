import { test, expect } from "@playwright/test";

test.describe("Theme toggle (#390)", () => {
  test("toggles dark mode and persists to localStorage", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => localStorage.removeItem("theme"));

    await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/);

    const toggle = page.getByRole("button", { name: "Toggle theme" });
    await expect(toggle).toBeVisible();

    const before = await page.locator("html").getAttribute("data-theme");
    await toggle.click();
    const after = await page.locator("html").getAttribute("data-theme");
    expect(after).not.toBe(before);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", after!);

    const stored = await page.evaluate(() => localStorage.getItem("theme"));
    expect(stored).toBe(after);
  });
});
