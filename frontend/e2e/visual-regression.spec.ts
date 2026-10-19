import { test } from "@playwright/test";
import { VISUAL_PAGES, captureVisualBaseline } from "./config";

for (const pageName of VISUAL_PAGES) {
  test(`visual baseline: ${pageName}`, async ({ page }) => {
    await page.addInitScript((name) => {
      localStorage.setItem("srs_help_seen", "1");
      localStorage.setItem("srs_currentPage", name === "home" ? "home" : name);
    }, pageName);
    await page.goto("/");
    await captureVisualBaseline(page, pageName);
  });
}
