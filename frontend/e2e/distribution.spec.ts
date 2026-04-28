import { test, expect } from '@playwright/test';

test.describe('Distribution Flow', () => {
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

  test('should display distribute form', async ({ page }) => {
    await page.getByRole('link', { name: /distribute/i }).click();
    
    await expect(page.getByLabel(/contract id/i)).toBeVisible();
    await expect(page.getByLabel(/token/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /distribute/i })).toBeVisible();
  });

  test('should validate required fields', async ({ page }) => {
    await page.getByRole('link', { name: /distribute/i }).click();
    
    // Try to submit without filling fields
    await page.getByRole('button', { name: /distribute/i }).click();
    
    // Should show validation errors
    await expect(page.getByText(/required/i).first()).toBeVisible();
  });

  test('should successfully distribute funds', async ({ page, context }) => {
    // Mock API response
    await context.route('**/api/v1/distribute', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          xdr: 'MOCK_XDR_STRING',
          transactionId: 456
        })
      });
    });
    
    await page.getByRole('link', { name: /distribute/i }).click();
    
    // Fill form
    await page.getByLabel(/contract id/i).fill('CTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.getByLabel(/token/i).fill('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    
    // Submit
    await page.getByRole('button', { name: /distribute/i }).click();
    
    // Should show success
    await expect(page.getByText(/success/i)).toBeVisible();
  });
});
