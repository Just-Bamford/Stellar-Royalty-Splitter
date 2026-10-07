import { test, expect } from '@playwright/test';

/**
 * E2E Test: Advanced secondary royalty workflow
 * Tests complex secondary sale recording and distribution scenarios
 * Part of Issue #964 - Comprehensive E2E test suite
 */

test.describe('Secondary Royalty Advanced Workflow', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter wallet
    await page.addInitScript(() => {
      window.freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GDIRORW5XBUFBRHZ3YINQXWBZX6XMBVJT7LMYQNGFQVFQVCQBWKRKWW',
        signTransaction: async (xdr: string) => xdr,
      };
    });

    await page.goto('http://localhost:5173');
  });

  test('should record and distribute secondary royalty in complete flow', async ({ page }) => {
    // Mock record secondary sale endpoint
    await page.route('**/api/v1/secondary-royalty/record', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          recordId: 'sec-sale-001',
          saleAmount: 50000000,
          royaltyAmount: 2500000, // 5% royalty
          seller: 'GSELLERADDRESS',
          buyer: 'GBUYERADDRESS',
          timestamp: Date.now(),
        }),
      });
    });

    // Mock distribute secondary royalty endpoint
    await page.route('**/api/v1/secondary-royalty/distribute', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgSECONDARY...',
          transactionId: 'txn-secondary-001',
          fee: 100000,
          distributionBreakdown: [
            { collaborator: 'GCOLLABAA', amount: 1250000, share: 50 },
            { collaborator: 'GCOLLABBB', amount: 750000, share: 30 },
            { collaborator: 'GCOLLABCC', amount: 500000, share: 20 },
          ],
        }),
      });
    });

    await page.route('**/api/v1/transaction/*/confirm', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'confirmed',
          fee: 100000,
        }),
      });
    });

    // Navigate to secondary royalty section
    await page.click('text=Secondary Royalties');

    // Step 1: Record secondary sale
    await page.click('text=Record Sale');
    await page.fill('input[name="sale-amount"]', '50000000');
    await page.fill('input[name="seller-address"]', 'GSELLERADDRESS');
    await page.fill('input[name="buyer-address"]', 'GBUYERADDRESS');
    await page.fill('input[name="royalty-percentage"]', '5');

    await page.click('button:has-text("Record Sale")');

    // Verify recording success
    await expect(page.locator('text=Sale recorded successfully')).toBeVisible();
    await expect(page.locator('text=Royalty Amount: 2,500,000')).toBeVisible();

    // Step 2: Distribute secondary royalties
    await page.click('button:has-text("Distribute Royalties")');

    // Verify distribution breakdown
    await expect(page.locator('text=GCOLLABAA: 1,250,000 (50%)')).toBeVisible();
    await expect(page.locator('text=GCOLLABBB: 750,000 (30%)')).toBeVisible();
    await expect(page.locator('text=GCOLLABCC: 500,000 (20%)')).toBeVisible();

    // Sign and submit
    await page.click('button:has-text("Sign & Submit")');

    // Wait for confirmation
    await expect(page.locator('text=Secondary royalties distributed successfully')).toBeVisible({
      timeout: 10000,
    });
  });

  test('should handle multiple secondary sales batch distribution', async ({ page }) => {
    // Mock endpoint for batch secondary distribution
    await page.route('**/api/v1/secondary-royalty/batch-distribute', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgBATCHSEC...',
          transactionId: 'txn-batch-sec-001',
          totalRoyalties: 10000000,
          salesProcessed: 5,
          totalFee: 200000,
          breakdown: [
            { recordId: 'sec-sale-001', amount: 2000000 },
            { recordId: 'sec-sale-002', amount: 2500000 },
            { recordId: 'sec-sale-003', amount: 1500000 },
            { recordId: 'sec-sale-004', amount: 3000000 },
            { recordId: 'sec-sale-005', amount: 1000000 },
          ],
        }),
      });
    });

    await page.click('text=Secondary Royalties');
    await page.click('text=Batch Distribution');

    // Select multiple pending sales
    await page.check('input[name="select-sale-001"]');
    await page.check('input[name="select-sale-002"]');
    await page.check('input[name="select-sale-003"]');
    await page.check('input[name="select-sale-004"]');
    await page.check('input[name="select-sale-005"]');

    // Verify batch summary
    await expect(page.locator('text=5 sales selected')).toBeVisible();
    await expect(page.locator('text=Total Royalties: 10,000,000')).toBeVisible();

    // Distribute batch
    await page.click('button:has-text("Distribute Batch")');

    // Verify success
    await expect(page.locator('text=5 secondary sales distributed')).toBeVisible();
  });

  test('should validate secondary sale data before recording', async ({ page }) => {
    await page.click('text=Secondary Royalties');
    await page.click('text=Record Sale');

    // Test invalid seller address
    await page.fill('input[name="sale-amount"]', '50000000');
    await page.fill('input[name="seller-address"]', 'INVALID');
    await page.fill('input[name="buyer-address"]', 'GBUYERADDRESS');
    await page.fill('input[name="royalty-percentage"]', '5');

    await page.click('button:has-text("Record Sale")');

    // Should show validation error
    await expect(page.locator('text=Invalid seller address')).toBeVisible();

    // Test invalid royalty percentage (>100%)
    await page.fill('input[name="seller-address"]', 'GSELLERADDRESS');
    await page.fill('input[name="royalty-percentage"]', '150');

    await page.click('button:has-text("Record Sale")');
    await expect(page.locator('text=Royalty percentage must be between 0 and 100')).toBeVisible();

    // Test zero sale amount
    await page.fill('input[name="royalty-percentage"]', '5');
    await page.fill('input[name="sale-amount"]', '0');

    await page.click('button:has-text("Record Sale")');
    await expect(page.locator('text=Sale amount must be greater than 0')).toBeVisible();
  });

  test('should show secondary royalty history and analytics', async ({ page }) => {
    // Mock history endpoint
    await page.route('**/api/v1/secondary-royalty/history', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sales: [
            {
              recordId: 'sec-sale-001',
              saleAmount: 50000000,
              royaltyAmount: 2500000,
              timestamp: Date.now() - 86400000,
              status: 'distributed',
            },
            {
              recordId: 'sec-sale-002',
              saleAmount: 75000000,
              royaltyAmount: 3750000,
              timestamp: Date.now() - 172800000,
              status: 'distributed',
            },
            {
              recordId: 'sec-sale-003',
              saleAmount: 30000000,
              royaltyAmount: 1500000,
              timestamp: Date.now() - 259200000,
              status: 'pending',
            },
          ],
          totalSales: 3,
          totalRoyalties: 7750000,
          averageRoyalty: 2583333,
        }),
      });
    });

    await page.click('text=Secondary Royalties');
    await page.click('text=History');

    // Verify history display
    await expect(page.locator('text=Total Sales: 3')).toBeVisible();
    await expect(page.locator('text=Total Royalties: 7,750,000')).toBeVisible();
    await expect(page.locator('text=Average Royalty: 2,583,333')).toBeVisible();

    // Verify individual sales
    await expect(page.locator('text=sec-sale-001')).toBeVisible();
    await expect(page.locator('text=sec-sale-002')).toBeVisible();
    await expect(page.locator('text=sec-sale-003')).toBeVisible();
  });

  test('should support automatic royalty distribution on sale recording', async ({ page }) => {
    // Mock auto-distribution endpoint
    await page.route('**/api/v1/secondary-royalty/record-and-distribute', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          recordId: 'sec-sale-auto-001',
          saleAmount: 100000000,
          royaltyAmount: 5000000,
          xdr: 'AAAAAgAUTO...',
          transactionId: 'txn-auto-sec-001',
          distributionCompleted: true,
        }),
      });
    });

    await page.click('text=Secondary Royalties');
    await page.click('text=Record Sale');

    // Enable auto-distribution
    await page.check('input[name="auto-distribute"]');

    await page.fill('input[name="sale-amount"]', '100000000');
    await page.fill('input[name="seller-address"]', 'GSELLERADDRESS');
    await page.fill('input[name="buyer-address"]', 'GBUYERADDRESS');
    await page.fill('input[name="royalty-percentage"]', '5');

    await page.click('button:has-text("Record & Distribute")');

    // Should show combined success message
    await expect(page.locator('text=Sale recorded and royalties distributed')).toBeVisible();
  });

  test('should handle secondary royalty distribution failures with retry', async ({ page }) => {
    let attemptCount = 0;

    await page.route('**/api/v1/secondary-royalty/distribute', async (route) => {
      attemptCount++;

      if (attemptCount < 3) {
        // Fail first two attempts
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Temporary RPC failure',
            retryable: true,
          }),
        });
      } else {
        // Succeed on third attempt
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            xdr: 'AAAAAgSECONDARY...',
            transactionId: 'txn-retry-success-001',
            fee: 100000,
          }),
        });
      }
    });

    await page.click('text=Secondary Royalties');
    await page.click('button:has-text("Distribute Pending")');

    // Should show retry attempts
    await expect(page.locator('text=Retrying (attempt 1)')).toBeVisible();
    await expect(page.locator('text=Retrying (attempt 2)')).toBeVisible();

    // Eventually succeeds
    await expect(page.locator('text=Distribution successful')).toBeVisible({ timeout: 15000 });
  });

  test('should calculate and display net proceeds after royalty', async ({ page }) => {
    await page.click('text=Secondary Royalties');
    await page.click('text=Record Sale');

    // Fill in sale details
    await page.fill('input[name="sale-amount"]', '100000000');
    await page.fill('input[name="royalty-percentage"]', '10');

    // Should show calculated values
    await expect(page.locator('text=Royalty Amount: 10,000,000')).toBeVisible();
    await expect(page.locator('text=Seller Proceeds: 90,000,000')).toBeVisible();

    // Change percentage
    await page.fill('input[name="royalty-percentage"]', '5');

    // Values update
    await expect(page.locator('text=Royalty Amount: 5,000,000')).toBeVisible();
    await expect(page.locator('text=Seller Proceeds: 95,000,000')).toBeVisible();
  });
});
