import { expect, Page } from "@playwright/test";

export const VISUAL_PAGES = [
  "home", "initialize", "distribute", "secondary-royalty", "earnings",
  "history", "analytics", "collaborators", "settings", "help",
] as const;

export const PERFORMANCE_BUDGETS = Object.freeze({
  pageLoadMs: 2500,
  interactionMs: 500,
});

/**
 * Capture a stable visual artifact for every major page. CI stores the
 * artifacts with the Playwright report; UPDATE_VISUAL_BASELINES can be used
 * by maintainers when an intentional UI change is reviewed.
 */
export async function captureVisualBaseline(page: Page, name: string) {
  const screenshot = await page.screenshot({ animations: "disabled", fullPage: true });
  expect(screenshot.byteLength, `${name} should render a non-empty screenshot`).toBeGreaterThan(1000);
  return screenshot;
}
