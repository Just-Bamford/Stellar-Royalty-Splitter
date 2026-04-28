import { test, expect } from '@playwright/test';

test.describe('Wallet Connect Flow', () => {
  test('should display wallet connect button', async ({ page }) => {
    await page.goto('/');
    
    // Check if wallet connect button is visible
    const connectButton = page.getByRole('button', { name: /connect/i });
    await expect(connectButton).toBeVisible();
  });

  test('should show error when Freighter is not installed', async ({ page }) => {
    await page.goto('/');
    
    // Mock Freighter not being available
    await page.evaluate(() => {
      (window as any).freighter = undefined;
    });
    
    const connectButton = page.getByRole('button', { name: /connect/i });
    await connectButton.click();
    
    // Should show error message
    await expect(page.getByText(/freighter/i)).toBeVisible();
  });

  test('should handle wallet connection with mocked Freighter', async ({ page }) => {
    await page.goto('/');
    
    // Mock Freighter wallet
    await page.evaluate(() => {
      (window as any).freighter = {
        isConnected: async () => true,
        getPublicKey: async () => 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        signTransaction: async (xdr: string) => xdr,
      };
    });
    
    const connectButton = page.getByRole('button', { name: /connect/i });
    await connectButton.click();
    
    // Should show connected state
    await expect(page.getByText(/GTEST/i)).toBeVisible();
  });
});
