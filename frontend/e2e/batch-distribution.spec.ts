/**
 * E2E Tests: Batch Distribution Workflows
 * Tests batch transaction processing with compression
 */

import { test, expect } from '@playwright/test';

test.describe('Batch Distribution', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Mock wallet connection
  });

  test('should enable batch mode for multiple distributions', async ({ page }) => {
    await page.goto('/distribute');
    
    // Enable batch mode
    const batchToggle = page.locator('[data-testid="enable-batch-mode"]');
    await batchToggle.check();
    
    await expect(page.locator('[data-testid="batch-mode-indicator"]')).toBeVisible();
    await expect(page.locator('[data-testid="batch-mode-indicator"]')).toHaveText(/Batch Mode: Enabled/);
  });

  test('should queue multiple distributions for batching', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Add first distribution
    await page.fill('[data-testid="amount-input"]', '1000');
    await page.click('[data-testid="add-to-batch"]');
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('1');
    
    // Add second distribution
    await page.fill('[data-testid="amount-input"]', '2000');
    await page.click('[data-testid="add-to-batch"]');
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('2');
    
    // Add third distribution
    await page.fill('[data-testid="amount-input"]', '3000');
    await page.click('[data-testid="add-to-batch"]');
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('3');
  });

  test('should show compression savings preview', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Queue 5 distributions
    for (let i = 1; i <= 5; i++) {
      await page.fill('[data-testid="amount-input"]', `${i * 1000}`);
      await page.click('[data-testid="add-to-batch"]');
    }
    
    // Should show compression preview
    await expect(page.locator('[data-testid="compression-savings"]')).toBeVisible();
    const savingsText = await page.locator('[data-testid="compression-savings"]').textContent();
    expect(savingsText).toMatch(/\d+%/); // Should show percentage
  });

  test('should execute batch distribution with all queued items', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Queue 10 distributions
    for (let i = 1; i <= 10; i++) {
      await page.fill('[data-testid="amount-input"]', `${i * 500}`);
      await page.click('[data-testid="add-to-batch"]');
    }
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('10');
    
    // Execute batch
    await page.click('[data-testid="execute-batch"]');
    
    // Should show processing indicator
    await expect(page.locator('[data-testid="batch-processing"]')).toBeVisible();
    
    // Wait for completion
    await expect(page.locator('[data-testid="batch-success"]')).toBeVisible({ timeout: 30000 });
    
    // Queue should be cleared
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('0');
  });

  test('should display batch statistics after execution', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    for (let i = 1; i <= 5; i++) {
      await page.fill('[data-testid="amount-input"]', '1000');
      await page.click('[data-testid="add-to-batch"]');
    }
    
    await page.click('[data-testid="execute-batch"]');
    await expect(page.locator('[data-testid="batch-success"]')).toBeVisible({ timeout: 30000 });
    
    // Check statistics
    await expect(page.locator('[data-testid="batch-stats"]')).toBeVisible();
    await expect(page.locator('[data-testid="operations-count"]')).toContainText('5');
    await expect(page.locator('[data-testid="compression-ratio"]')).toBeVisible();
    await expect(page.locator('[data-testid="bytes-saved"]')).toBeVisible();
  });

  test('should handle batch execution errors gracefully', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Add invalid distribution to trigger error
    await page.fill('[data-testid="amount-input"]', '-1000');
    await page.click('[data-testid="add-to-batch"]');
    
    await page.click('[data-testid="execute-batch"]');
    
    // Should show error
    await expect(page.locator('[data-testid="batch-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="batch-error"]')).toContainText('invalid');
  });

  test('should allow removing items from batch queue', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Add 3 items
    for (let i = 1; i <= 3; i++) {
      await page.fill('[data-testid="amount-input"]', `${i * 1000}`);
      await page.click('[data-testid="add-to-batch"]');
    }
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('3');
    
    // Remove second item
    await page.locator('[data-testid="batch-item"]').nth(1).locator('[data-testid="remove-from-batch"]').click();
    
    await expect(page.locator('[data-testid="batch-queue-count"]')).toHaveText('2');
  });

  test('should support priority batching for admin operations', async ({ page }) => {
    await page.goto('/admin');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Queue admin operations
    await page.click('[data-testid="suspend-collaborator"]');
    await page.click('[data-testid="add-to-batch"]');
    
    await page.click('[data-testid="change-tier"]');
    await page.click('[data-testid="add-to-batch"]');
    
    // Admin operations should show higher priority
    await expect(page.locator('[data-testid="batch-item"]').first()).toContainText('Priority: Critical');
  });

  test('should display real-time batch optimization suggestions', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    // Add many small distributions
    for (let i = 1; i <= 15; i++) {
      await page.fill('[data-testid="amount-input"]', '100');
      await page.click('[data-testid="add-to-batch"]');
    }
    
    // Should show optimization suggestion
    await expect(page.locator('[data-testid="batch-optimization-tip"]')).toBeVisible();
    await expect(page.locator('[data-testid="batch-optimization-tip"]')).toContainText(/optimal/i);
  });

  test('should support batch export for auditing', async ({ page }) => {
    await page.goto('/distribute');
    await page.locator('[data-testid="enable-batch-mode"]').check();
    
    for (let i = 1; i <= 5; i++) {
      await page.fill('[data-testid="amount-input"]', '1000');
      await page.click('[data-testid="add-to-batch"]');
    }
    
    // Export batch details
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="export-batch"]');
    const download = await downloadPromise;
    
    expect(download.suggestedFilename()).toMatch(/batch.*\.json$/);
  });
});
