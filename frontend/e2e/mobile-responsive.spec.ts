import { test, expect, Page } from '@playwright/test';

const contractId = `C${'A'.repeat(55)}`;

const sampleHistory = [
  {
    id: 1,
    txHash: 'abc123def456ghi789jkl012mno345pq',
    contractId,
    type: 'initialize',
    initiatorAddress: `G${'B'.repeat(55)}`,
    requestedAmount: '1000',
    tokenId: 'USDC',
    timestamp: '2026-06-24T12:00:00Z',
    blockTime: '2026-06-24T12:00:00Z',
    status: 'confirmed',
    errorMessage: null,
  },
  {
    id: 2,
    txHash: null,
    contractId,
    type: 'distribute',
    initiatorAddress: `G${'C'.repeat(55)}`,
    requestedAmount: '250',
    tokenId: 'XLM',
    timestamp: '2026-06-23T10:00:00Z',
    blockTime: null,
    status: 'pending',
    errorMessage: null,
  },
];

const detailsResponse = {
  success: true,
  data: {
    id: 1,
    txHash: sampleHistory[0].txHash,
    contractId,
    type: 'initialize',
    initiatorAddress: sampleHistory[0].initiatorAddress,
    requestedAmount: '1000',
    tokenId: 'USDC',
    timestamp: sampleHistory[0].timestamp,
    blockTime: sampleHistory[0].blockTime,
    status: 'confirmed',
    errorMessage: null,
    payouts: [
      {
        collaboratorAddress: `G${'D'.repeat(55)}`,
        amountReceived: '500',
      },
    ],
  },
};

async function setupMobileAdminPage(page: Page) {
  await page.route('**/api/history/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: sampleHistory, pagination: { limit: 50, offset: 0, total: 2 } }),
    });
  });

  await page.route('**/api/contract/status/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ initialized: true }),
    });
  });

  await page.route('**/api/secondary-royalty/rate/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ royaltyRate: 500 }),
    });
  });

  await page.route('**/api/contract/version/**', async (route: any) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ contractId, version: '1.0.0' }),
    });
  });

  await page.addInitScript(({ contractId }) => {
    localStorage.setItem('srs_help_seen', '1');
    localStorage.setItem('srs_onboarding_completed', 'true');
    localStorage.setItem('srs_currentPage', 'admin');
    localStorage.setItem('lastContractId', contractId);
  }, { contractId });

  await page.goto('/');
}

async function setupMobileTransactionsPage(page: Page) {
  await page.route('**/api/history/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: sampleHistory, pagination: { limit: 10, offset: 0, total: 2 } }),
    });
  });

  await page.route('**/api/contract/status/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ initialized: true }),
    });
  });

  await page.route('**/api/secondary-royalty/rate/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ royaltyRate: 500 }),
    });
  });

  await page.route('**/api/transaction/**', async (route: any) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(detailsResponse),
    });
  });

  await page.addInitScript(({ contractId }) => {
    localStorage.setItem('srs_help_seen', '1');
    localStorage.setItem('srs_onboarding_completed', 'true');
    localStorage.setItem('srs_currentPage', 'transactions');
    localStorage.setItem('lastContractId', contractId);
  }, { contractId });

  await page.goto('/');
}

test.describe('Mobile responsiveness', () => {
  const viewports = [
    { name: 'iPhone SE', width: 320, height: 640 },
    { name: 'Small phone', width: 480, height: 800 },
    { name: 'Tablet', width: 768, height: 1024 },
  ];

  for (const { name, width, height } of viewports) {
    test(`admin dashboard renders without horizontal scroll at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await setupMobileAdminPage(page);

      await expect(page.getByRole('heading', { name: /admin dashboard/i })).toBeVisible();
      await expect(page.getByText(/contract information/i)).toBeVisible();
      await page.waitForTimeout(100); // allow layout to settle

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(overflow).toBeFalsy();
    });

    test(`transaction history renders without horizontal scroll at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await setupMobileTransactionsPage(page);

      await expect(page.getByRole('heading', { name: /transaction history/i })).toBeVisible();

      const overflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(overflow).toBeFalsy();
    });
  }

  test('admin dashboard buttons meet mobile touch target guidelines', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await setupMobileAdminPage(page);

    const buttonHandles = await page.locator('.contract-actions .action-btn, .info-btn, .refresh-mini-btn').elementHandles();
    for (const button of buttonHandles) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }
  });

  test('transaction history refresh button meets mobile touch target guidelines', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await setupMobileTransactionsPage(page);

    const refreshButton = page.getByRole('button', { name: /refresh/i });
    const box = await refreshButton.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('transaction history row details open properly on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await setupMobileTransactionsPage(page);

    const row = page.locator('.tx-row-clickable').first();
    await expect(row).toBeVisible();
    await row.locator('td').first().click();
    await expect(page.getByRole('dialog', { name: /transaction details/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/payouts/i)).toBeVisible();
  });
});
