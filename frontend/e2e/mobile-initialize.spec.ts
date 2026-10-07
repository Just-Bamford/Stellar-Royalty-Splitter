import { test, expect } from "@playwright/test";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

/**
 * #920 — Mobile E2E: contract initialization flow on a phone viewport.
 *
 * Verifies the acceptance criteria for mobile usability at 320px width
 * (iPhone SE / small Android):
 *  - the initialization form is reachable and usable on a small screen,
 *  - form fields stack vertically (no horizontal page scroll),
 *  - touch targets are at least 48px,
 *  - the full happy-path flow (fill form → commit → reveal) can be driven
 *    from a mobile device with mocked API, wallet, and Soroban RPC.
 */

const API_BASE = "**/api";
const RPC_PATTERN = "**/soroban-testnet.stellar.org/**";

// Real (CRC-valid) keypairs — the Stellar SDK's Account/TransactionBuilder
// reject synthetic all-zero addresses, which would make the XDR builder
// throw inside the route handler.
const walletAddress = Keypair.random().publicKey();
const collaboratorOne = Keypair.random().publicKey();
const collaboratorTwo = Keypair.random().publicKey();
const contractId = `C${"A".repeat(55)}`;

const MOCK_TX_HASH = "a".repeat(64);

// Hand-encoded XDR constants (validated against the SDK's parsers):
//  - resultXdr: TransactionResult { feeCharged: 100, txSUCCESS([]) }
//  - resultMetaXdr: TransactionMeta v2 with empty change vectors
const MOCK_RESULT_XDR = "AAAAAAAAAGQAAAAAAAAAAAAAAAA=";
const MOCK_RESULT_META_XDR = "AAAAAgAAAAAAAAAAAAAAAA==";

/** Build a genuinely valid testnet transaction XDR for the signing flow. */
function buildMockXdr(sequence: string): string {
  const account = new Account(walletAddress, sequence);
  return new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: walletAddress,
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .setTimeout(30)
    .build()
    .toXDR();
}

// #920 — 320×568 (iPhone SE-class) portrait viewport. Defined explicitly
// (rather than via devices["iPhone SE"]) so the spec runs under the
// chromium project configured in playwright.config.ts.
//
// serviceWorkers: 'block' — the offline-queue service worker proxies /api
// fetches itself, which would bypass Playwright's route interception and
// let requests fall through to the (unmocked) dev-server proxy.
test.use({
  viewport: { width: 320, height: 568 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
});

test.describe("Mobile initialization flow (#920)", () => {
  test.beforeEach(async ({ page }) => {
    // ── Backend API mocks ────────────────────────────────────────────────
    await page.route(`${API_BASE}/contract/status/**`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ initialized: false }),
      });
    });
    await page.route(`${API_BASE}/secondary-royalty/rate/**`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ royaltyRate: 500 }),
      });
    });
    await page.route(`${API_BASE}/templates**`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: [] }),
      });
    });
    await page.route(`${API_BASE}/initialize/commit`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ xdr: buildMockXdr("1"), transactionId: 1 }),
      });
    });
    await page.route(`${API_BASE}/initialize/reveal`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ xdr: buildMockXdr("2"), transactionId: 2 }),
      });
    });
    await page.route(`${API_BASE}/transaction/confirm/**`, async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ success: true, message: "confirmed" }),
      });
    });

    // ── Soroban RPC mocks (sendTransaction + confirmation polling) ───────
    await page.route(RPC_PATTERN, async (route) => {
      const request = route.request();
      let method = "";
      let rpcId: unknown = 1;
      try {
        const body = request.postDataJSON();
        method = body?.method ?? "";
        rpcId = body?.id ?? 1;
      } catch {
        method = "";
      }

      let result: Record<string, unknown> = {};
      if (method === "sendTransaction") {
        result = {
          status: "PENDING",
          hash: MOCK_TX_HASH,
          latestLedger: 2,
          latestLedgerCloseTime: 1,
        };
      } else if (method === "getTransaction") {
        result = {
          status: "SUCCESS",
          txHash: MOCK_TX_HASH,
          latestLedger: 3,
          latestLedgerCloseTime: 2,
          oldestLedger: 1,
          createdAt: 2,
          applicationOrder: 1,
          feeBump: false,
          envelopeXdr: buildMockXdr("1"),
          resultXdr: MOCK_RESULT_XDR,
          resultMetaXdr: MOCK_RESULT_META_XDR,
          ledger: 2,
        };
      } else if (method === "getHealth") {
        result = { status: "healthy", latestLedger: 3, oldestLedger: 1 };
      }

      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }),
      });
    });

    // ── Freighter wallet mock + seeded app state ─────────────────────────
    await page.addInitScript(
      ({ contractId, walletAddress }) => {
        localStorage.setItem("srs_help_seen", "1");
        localStorage.setItem("srs_currentPage", "initialize");
        localStorage.setItem("lastContractId", contractId);
        // Skip the onboarding overlay so it cannot intercept pointer events.
        localStorage.setItem("srs_onboarding_completed", "true");

        window.freighter = {
          getAddress: async () => ({ address: walletAddress }),
          requestAccess: async () => ({ address: walletAddress }),
          // Echo the transaction back "signed" — valid XDR in, same XDR out.
          signTransaction: async (xdr: string) => xdr,
        };
      },
      { contractId, walletAddress },
    );

    await page.goto("/");
  });

  test("initialization flow is usable on a 320px phone viewport", async ({
    page,
  }) => {
    // ── Form renders on mobile ──────────────────────────────────────────
    // Scope to main: the (hidden) mobile drawer also contains the label.
    await expect(page.locator("main").getByText("Initialize").first()).toBeVisible();
    const addBtn = page.getByRole("button", { name: /add collaborator/i });
    await expect(addBtn).toBeVisible();

    // ── Acceptance: no horizontal scroll at 320px ───────────────────────
    const noHorizontalScroll = await page.evaluate(() => {
      const doc = document.documentElement;
      return doc.scrollWidth <= doc.clientWidth + 1;
    });
    expect(noHorizontalScroll).toBe(true);

    // ── Acceptance: collaborator fields stack vertically on mobile ──────
    const addressInput = page
      .locator('input[placeholder*="Wallet address"]')
      .first();
    const percentageInput = page.getByLabel("Collaborator 1 percentage");
    await expect(addressInput).toBeVisible();
    await expect(percentageInput).toBeVisible();

    const stacking = await page.evaluate(() => {
      const row = document.querySelector(".collaborator-row");
      if (!row) return { stacked: false, direction: "" };
      const style = getComputedStyle(row);
      return {
        stacked: style.flexDirection === "column",
        direction: style.flexDirection,
      };
    });
    expect(stacking.stacked).toBe(true);

    // ── Acceptance: touch targets ≥ 48px ────────────────────────────────
    const addBtnBox = await addBtn.boundingBox();
    expect(addBtnBox?.height ?? 0).toBeGreaterThanOrEqual(48);

    // ── Acceptance: mobile drawer navigation opens/closes ───────────────
    const menuBtn = page.getByRole("button", { name: "Toggle menu" });
    await expect(menuBtn).toBeVisible();

    await menuBtn.click();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "true");
    const drawer = page.locator("#mobile-nav-links");
    await expect(drawer).toBeVisible();

    // Tapping a nav item navigates and closes the drawer.
    await drawer.getByRole("button", { name: "📊 Dashboard" }).click();
    await expect(menuBtn).toHaveAttribute("aria-expanded", "false");
  });

  test("happy path: fill, commit and reveal on mobile", async ({ page }) => {
    const addressInputs = page.locator('input[placeholder*="Wallet address"]');

    await addressInputs.first().fill(collaboratorOne);
    await page.getByLabel("Collaborator 1 percentage").fill("50");

    await page.getByRole("button", { name: /add collaborator/i }).click();

    await addressInputs.nth(1).fill(collaboratorTwo);
    await page.getByLabel("Collaborator 2 percentage").fill("50");

    // Commit (status text renders in both the live region and the status
    // banner, hence .first())
    await page.getByRole("button", { name: /initialize contract/i }).click();
    await expect(page.getByText(/Commitment confirmed/i).first()).toBeVisible({
      timeout: 20_000,
    });

    // Reveal (button label changes once a commit is pending)
    await page.getByRole("button", { name: /reveal initialization/i }).click();
    await expect(page.getByText(/Initialized\. Tx:/i).first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
