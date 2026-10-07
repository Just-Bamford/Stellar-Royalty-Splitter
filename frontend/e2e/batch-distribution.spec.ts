import { test, expect } from '@playwright/test';

/**
 * E2E Test: Batch distribution workflow
 * Tests distributing royalties for multiple tokens in a single transaction
 * Part of Issue #964 - Comprehensive E2E test suite
 */

test.describe('Batch Distribution', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter wallet
    await page.addInitScript(() => {
      window.freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GDIRORW5XBUFBRHZ3YINQXWBZX6XMBVJT7LMYQNGFQVFQVCQBWKRKWW',
        signTransaction: async (xdr: string) => xdr,
      };
    });

    // Mock contract state
    await page.addInitScript(() => {
      window.__MOCK_CONTRACT_STATE__ = {
        contractId: 'CBATCHTEST',
        collaborators: [
          { address: 'GCOLLABAA', share: 5000 },
          { address: 'GCOLLABBB', share: 3000 },
          { address: 'GCOLLABCC', share: 2000 },
        ],
      };
    });

    await page.goto('http://localhost:5173');
  });

  test('should distribute multiple tokens in batch', async ({ page }) => {
    // Mock batch distribution endpoint
    await page.route('**/api/v1/batch-distribute', async (route) => {
      const request = route.request();
      const postData = JSON.parse(request.postData() || '{}');

      // Validate batch request structure
      expect(postData).toHaveProperty('contractId');
      expect(postData).toHaveProperty('tokens');
      expect(Array.isArray(postData.tokens)).toBe(true);
      expect(postData.tokens.length).toBeGreaterThan(1);

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgBATCH...',
          transactionId: 'txn-batch-001',
          totalFee: 150000,
          gasEstimate: 500000,
          tokensIncluded: postData.tokens.length,
          breakdown: postData.tokens.map((token: string) => ({
            token,
            recipients: 3,
            estimatedFee: 50000,
          })),
        }),
      });
    });

    await page.route('**/api/v1/transaction/*/confirm', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'confirmed',
          fee: 150000,
          distributionsCompleted: 3,
        }),
      });
    });

    // Navigate to batch distribution
    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Add multiple tokens
    const tokens = [
      'CUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
      'CXLM1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
      'CEURO1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789',
    ];

    for (let i = 0; i < tokens.length; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Token")');
      }
      await page.fill(`input[name="token-${i}"]`, tokens[i]);
    }

    // Verify batch preview shows all tokens
    await expect(page.locator('text=3 tokens selected')).toBeVisible();

    // Submit batch distribution
    await page.click('button:has-text("Distribute Batch")');

    // Verify batch summary
    await expect(page.locator('text=Total Fee: 150,000 stroops')).toBeVisible();
    await expect(page.locator('text=Gas Estimate: 500,000')).toBeVisible();

    // Confirm transaction
    await page.click('button:has-text("Sign & Submit")');

    // Wait for success
    await expect(page.locator('text=Batch distribution completed successfully')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('text=3 distributions completed')).toBeVisible();
  });

  test('should show gas savings comparison for batch vs individual', async ({ page }) => {
    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Add 5 tokens
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Token")');
      }
      const token = `CTOKEN${i}${'A'.repeat(50)}`.slice(0, 56);
      await page.fill(`input[name="token-${i}"]`, token);
    }

    // Request gas estimate comparison
    await page.route('**/api/v1/batch-distribute/estimate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          batchFee: 200000,
          individualFeesTotal: 1000000,
          savings: 800000,
          savingsPercentage: 80,
          recommendBatch: true,
        }),
      });
    });

    await page.click('button:has-text("Compare Gas Costs")');

    // Verify savings display
    await expect(page.locator('text=Batch: 200,000 stroops')).toBeVisible();
    await expect(page.locator('text=Individual: 1,000,000 stroops')).toBeVisible();
    await expect(page.locator('text=Save 80% with batch')).toBeVisible();
  });

  test('should handle partial batch failure gracefully', async ({ page }) => {
    await page.route('**/api/v1/batch-distribute', async (route) => {
      await route.fulfill({
        status: 207, // Multi-status
        contentType: 'application/json',
        body: JSON.stringify({
          transactionId: 'txn-batch-partial-002',
          totalFee: 100000,
          results: [
            { token: 'CTOKEN1', status: 'success', recipients: 3 },
            { token: 'CTOKEN2', status: 'success', recipients: 3 },
            { token: 'CTOKEN3', status: 'failed', error: 'Insufficient balance', recipients: 0 },
          ],
          successCount: 2,
          failureCount: 1,
        }),
      });
    });

    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Add 3 tokens
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Token")');
      }
      await page.fill(`input[name="token-${i}"]`, `CTOKEN${i + 1}`);
    }

    await page.click('button:has-text("Distribute Batch")');
    await page.click('button:has-text("Sign & Submit")');

    // Verify partial success message
    await expect(page.locator('text=2 of 3 distributions completed')).toBeVisible();
    await expect(page.locator('text=1 distribution failed')).toBeVisible();
    await expect(page.locator('text=Insufficient balance')).toBeVisible();
  });

  test('should support idempotency for batch distributions', async ({ page }) => {
    const idempotencyKey = 'batch-unique-key-12345';

    await page.route('**/api/v1/batch-distribute', async (route) => {
      const headers = route.request().headers();
      expect(headers['idempotency-key']).toBe(idempotencyKey);

      // First request succeeds
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgBATCH...',
          transactionId: 'txn-batch-003',
          totalFee: 150000,
          tokensIncluded: 2,
        }),
      });
    });

    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Enable idempotency
    await page.check('input[name="use-idempotency"]');
    await page.fill('input[name="idempotency-key"]', idempotencyKey);

    // Add tokens
    await page.fill('input[name="token-0"]', 'CTOKEN1');
    await page.click('button:has-text("Add Token")');
    await page.fill('input[name="token-1"]', 'CTOKEN2');

    await page.click('button:has-text("Distribute Batch")');

    // Mock second request (duplicate) returns cached result
    await page.route('**/api/v1/batch-distribute', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgBATCH...',
          transactionId: 'txn-batch-003', // Same transaction ID
          totalFee: 150000,
          tokensIncluded: 2,
          cached: true,
        }),
      });
    });

    // Retry with same key
    await page.click('button:has-text("Distribute Batch")');

    // Should show cached response indicator
    await expect(page.locator('text=Using cached transaction')).toBeVisible();
  });

  test('should validate batch size limits', async ({ page }) => {
    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Try to add more than maximum allowed tokens (e.g., 20)
    for (let i = 0; i < 25; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Token")');
      }
      await page.fill(`input[name="token-${i}"]`, `CTOKEN${i}`);
    }

    // Should show validation error
    await expect(page.locator('text=Maximum 20 tokens per batch')).toBeVisible();
    await expect(page.locator('button:has-text("Distribute Batch")')).toBeDisabled();
  });

  test('should show real-time fee updates as tokens are added', async ({ page }) => {
    await page.route('**/api/v1/batch-distribute/estimate', async (route) => {
      const request = route.request();
      const postData = JSON.parse(request.postData() || '{}');
      const tokenCount = postData.tokens?.length || 0;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          estimatedFee: 50000 * tokenCount,
          gasEstimate: 150000 * tokenCount,
        }),
      });
    });

    await page.click('text=Distribute');
    await page.click('text=Batch Mode');

    // Add first token
    await page.fill('input[name="token-0"]', 'CTOKEN1');
    await expect(page.locator('text=Estimated Fee: 50,000')).toBeVisible();

    // Add second token
    await page.click('button:has-text("Add Token")');
    await page.fill('input[name="token-1"]', 'CTOKEN2');
    await expect(page.locator('text=Estimated Fee: 100,000')).toBeVisible();

    // Add third token
    await page.click('button:has-text("Add Token")');
    await page.fill('input[name="token-2"]', 'CTOKEN3');
    await expect(page.locator('text=Estimated Fee: 150,000')).toBeVisible();
  });
});
