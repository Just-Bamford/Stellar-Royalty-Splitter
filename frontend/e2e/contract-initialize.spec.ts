import { test, expect } from '@playwright/test';

test.describe('Contract Initialization Flow', () => {
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

  test('should display initialize form', async ({ page }) => {
    // Navigate to initialize section
    await page.getByRole('link', { name: /initialize/i }).click();
    
    // Check form elements
    await expect(page.getByLabel(/contract id/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /add collaborator/i })).toBeVisible();
  });

  test('should validate collaborator shares sum to 10000', async ({ page }) => {
    await page.getByRole('link', { name: /initialize/i }).click();
    
    // Fill in contract ID
    await page.getByLabel(/contract id/i).fill('CTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    
    // Add collaborators with invalid shares
    await page.getByRole('button', { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="address"]').first().fill('GCOL1123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.locator('input[placeholder*="share"]').first().fill('5000');
    
    await page.getByRole('button', { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="address"]').last().fill('GCOL2123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.locator('input[placeholder*="share"]').last().fill('4000');
    
    // Try to submit
    await page.getByRole('button', { name: /initialize/i }).click();
    
    // Should show validation error
    await expect(page.getByText(/must sum to 10000/i)).toBeVisible();
  });

  test('should successfully initialize with valid data', async ({ page, context }) => {
    // Mock API response
    await context.route('**/api/v1/initialize', async (route) => {
      await route.fulfill({
        status: 200,
        body: JSON.stringify({
          success: true,
          xdr: 'MOCK_XDR_STRING',
          transactionId: 123
        })
      });
    });
    
    await page.getByRole('link', { name: /initialize/i }).click();
    
    // Fill valid data
    await page.getByLabel(/contract id/i).fill('CTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    
    await page.getByRole('button', { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="address"]').first().fill('GCOL1123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.locator('input[placeholder*="share"]').first().fill('6000');
    
    await page.getByRole('button', { name: /add collaborator/i }).click();
    await page.locator('input[placeholder*="address"]').last().fill('GCOL2123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.locator('input[placeholder*="share"]').last().fill('4000');
    
    // Submit
    await page.getByRole('button', { name: /initialize/i }).click();
    
    // Should show success message
    await expect(page.getByText(/success/i)).toBeVisible();
  });
});
