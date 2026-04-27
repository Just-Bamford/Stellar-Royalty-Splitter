import { test, expect } from '@playwright/test';

test.describe('Navigation and UI', () => {
  test('should load homepage', async ({ page }) => {
    await page.goto('/');
    
    await expect(page).toHaveTitle(/stellar royalty splitter/i);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('should navigate between sections', async ({ page }) => {
    await page.goto('/');
    
    // Check all navigation links are present
    await expect(page.getByRole('link', { name: /dashboard/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /initialize/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /distribute/i })).toBeVisible();
    
    // Navigate to each section
    await page.getByRole('link', { name: /initialize/i }).click();
    await expect(page.getByText(/initialize/i)).toBeVisible();
    
    await page.getByRole('link', { name: /distribute/i }).click();
    await expect(page.getByText(/distribute/i)).toBeVisible();
    
    await page.getByRole('link', { name: /dashboard/i }).click();
    await expect(page.getByText(/dashboard/i)).toBeVisible();
  });

  test('should display error boundary on error', async ({ page }) => {
    // Trigger an error by navigating to invalid route
    await page.goto('/invalid-route-that-does-not-exist');
    
    // Should show error or redirect
    await expect(page.getByText(/error|not found|404/i)).toBeVisible();
  });
});
