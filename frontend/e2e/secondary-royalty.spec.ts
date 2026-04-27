import { test, expect } from '@playwright/test';

test.describe('Secondary Royalty Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    
    // Mock wallet connection
    await page.evaluate(() => {
      (window as any).freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GADMIN123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        signTransaction: async (xdr: string) => xdr,
      };
    });
  });

  test('should display secondary royalty section', async ({ page }) => {
    await page.getByRole('link', { name: /secondary/i }).click();
    
    await expect(page.getByText(/secondary royalty/i)).toBeVisible();
  });

  test('should record secondary sale', async ({ page, context }) => {
    // Mock API response
    await context.route('**/api/v1/secondary-royalty/record', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          saleId: 789
        })
      });
    });
    
    await page.getByRole('link', { name: /secondary/i }).click();
    
    // Fill secondary sale form
    await page.getByLabel(/nft id/i).fill('NFT_001');
    await page.getByLabel(/sale price/i).fill('1000');
    
    // Submit
    await page.getByRole('button', { name: /record sale/i }).click();
    
    // Should show success
    await expect(page.getByText(/recorded/i)).toBeVisible();
  });

  test('should distribute secondary royalties', async ({ page, context }) => {
    // Mock API response
    await context.route('**/api/v1/secondary-royalty/distribute', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          xdr: 'MOCK_XDR_STRING'
        })
      });
    });
    
    await page.getByRole('link', { name: /secondary/i }).click();
    
    // Click distribute button
    await page.getByRole('button', { name: /distribute royalties/i }).click();
    
    // Should show success
    await expect(page.getByText(/distributed/i)).toBeVisible();
  });
});
