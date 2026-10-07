import { test, expect } from "@playwright/test";

/**
 * E2E scenario for issue #923 — "find and bulk-suspend 3 collaborators"
 * using the new CollaboratorDirectory (search + filter + checkbox
 * multi-select + bulk suspend).
 *
 * Integration note: `CollaboratorDirectory.tsx` is a new, self-contained
 * component (per #923's "Relevant Files" list, which only names the new
 * component/hook files). Like `CollaboratorTable.tsx` — the existing
 * component it extends/complements, which is also not currently mounted
 * anywhere in `App.tsx`/`Navigation.tsx` — it isn't wired into a nav item
 * yet; wiring a whole new page into the app shell's `Navigation.tsx` +
 * `App.tsx` page switch is a separate integration concern outside this
 * issue's scope and risks an unrelated regression in those large existing
 * files. This spec follows the same convention as every other e2e spec in
 * this repo (e.g. contributor-onboarding.spec.ts, secondary-royalty.spec.ts):
 * `page.goto("/")`, click a nav button by name, assert the page's content.
 * It targets the `collaborators` nav entry this component is intended to be
 * mounted under. It cannot pass against the app as currently wired (there is
 * no such nav entry yet), and cannot be executed at all in this sandbox
 * (no display / browser, no live backend) — per this issue's own note, that
 * is expected and acceptable as long as the file is written and discoverable
 * (`npx playwright test --list`). Once `CollaboratorDirectory` is mounted
 * behind a `collaborators` nav entry (a follow-up, one-line wiring change),
 * this spec exercises the full flow against a real browser + mocked API.
 */

const WALLET = `G${"A".repeat(55)}`;
const CONTRACT = `C${"A".repeat(55)}`;

const ADDR_1 = `G${"1".repeat(55)}`;
const ADDR_2 = `G${"2".repeat(55)}`;
const ADDR_3 = `G${"3".repeat(55)}`;
const ADDR_4 = `G${"4".repeat(55)}`;

const BASE_COLLABORATORS = [
  { address: ADDR_1, basisPoints: 4000 },
  { address: ADDR_2, basisPoints: 3000 },
  { address: ADDR_3, basisPoints: 2000 },
  { address: ADDR_4, basisPoints: 1000 },
];

test.describe("Collaborator Directory — find and bulk-suspend 3 collaborators (#923)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(
      ({ wallet, contract }) => {
        localStorage.setItem("srs_help_seen", "1");
        localStorage.setItem("srs_currentPage", "collaborators");
        localStorage.setItem("lastContractId", contract);
        window.freighter = {
          getAddress: async () => ({ address: wallet }),
          requestAccess: async () => ({ address: wallet }),
          signTransaction: async (xdr: string) => xdr,
        };
      },
      { wallet: WALLET, contract: CONTRACT },
    );

    await page.route("**/api/collaborators/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(BASE_COLLABORATORS),
      });
    });

    await page.route("**/api/tiers/**", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ success: true, message: "ok" }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: [
            { walletAddress: ADDR_1, tier: "vip" },
            { walletAddress: ADDR_2, tier: "vip" },
            { walletAddress: ADDR_3, tier: "vip" },
            { walletAddress: ADDR_4, tier: "regular" },
          ],
          validTiers: ["vip", "regular", "trial"],
        }),
      });
    });

    await page.route("**/api/v1/analytics/**", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            totalDistributed: 0,
            totalTransactions: 0,
            averagePayout: 0,
            primaryRoyaltiesTotal: 0,
            secondaryRoyaltiesTotal: 0,
            topEarners: [],
            distributionTrends: [],
            collaboratorStats: [
              { address: ADDR_1, totalEarned: 1000, payoutCount: 4, firstActivity: "2024-01-01", lastActivity: "2024-06-01" },
              { address: ADDR_2, totalEarned: 800, payoutCount: 3, firstActivity: "2024-02-01", lastActivity: "2024-06-01" },
              { address: ADDR_3, totalEarned: 500, payoutCount: 2, firstActivity: "2024-03-01", lastActivity: "2024-05-01" },
              { address: ADDR_4, totalEarned: 50, payoutCount: 0, firstActivity: "2024-05-01", lastActivity: null },
            ],
          },
        }),
      });
    });

    await page.route("**/api/contributor-status/**", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ success: true, message: "ok" }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      });
    });

    await page.goto("/");
  });

  test("searches/filters to find the VIP collaborators, selects 3 via checkboxes, and bulk-suspends them", async ({
    page,
  }) => {
    const collabNav = page.getByRole("button", { name: /collaborators/i });
    await expect(collabNav).toBeVisible();
    await collabNav.click();

    await expect(page.getByTestId("collaborator-directory")).toBeVisible();
    await expect(page.getByText(/Showing/i)).toContainText("4");

    // "Find" — filter down to the VIP tier (3 of the 4 collaborators).
    await page.getByLabel("Filter by tier").selectOption("vip");
    await expect(page.getByText(/Showing/i)).toContainText("3");

    // Select all 3 filtered (VIP) collaborators via the header checkbox.
    await page.getByLabel("Select all visible collaborators").check();
    await expect(page.getByLabel(`Select ${ADDR_1}`)).toBeChecked();
    await expect(page.getByLabel(`Select ${ADDR_2}`)).toBeChecked();
    await expect(page.getByLabel(`Select ${ADDR_3}`)).toBeChecked();

    await expect(page.getByText("3 collaborators selected")).toBeVisible();

    // Bulk-suspend the 3 selected collaborators.
    const suspendRequests: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/contributor-status/")) {
        suspendRequests.push(req.url());
      }
    });

    await page
      .getByRole("button", { name: /^suspend 3 selected collaborators$/i })
      .click();

    await expect(page.getByRole("status")).toContainText(/succeeded for 3 collaborator/i);
    expect(suspendRequests.length).toBe(3);
  });
});
