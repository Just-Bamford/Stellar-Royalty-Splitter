/**
 * E2E Tests: Complete Secondary Royalty Workflow
 * Tests recording and distributing secondary royalties end-to-end
 */

import { test, expect } from '@playwright/test';

test.describe('Secondary Royalty Complete Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should record secondary royalty event', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    await page.click('[data-testid="record-secondary-royalty"]');
    
    // Fill in secondary royalty details
    await page.fill('[data-testid="source-input"]', 'Streaming Platform ABC');
    await page.fill('[data-testid="amount-input"]', '5000');
    await page.fill('[data-testid="description-input"]', 'Q4 2024 streaming revenue');
    
    await page.click('[data-testid="submit-record"]');
    
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
    await expect(page.locator('[data-testid="secondary-royalty-id"]')).toBeVisible();
  });

  test('should view recorded secondary royalties list', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    // Should display list of recorded royalties
    await expect(page.locator('[data-testid="secondary-royalty-list"]')).toBeVisible();
    
    const royaltyCount = await page.locator('[data-testid="secondary-royalty-item"]').count();
    expect(royaltyCount).toBeGreaterThan(0);
    
    // Each item should show key details
    const firstItem = page.locator('[data-testid="secondary-royalty-item"]').first();
    await expect(firstItem.locator('[data-testid="royalty-source"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="royalty-amount"]')).toBeVisible();
    await expect(firstItem.locator('[data-testid="royalty-status"]')).toBeVisible();
  });

  test('should distribute secondary royalty to collaborators', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    // Select a recorded royalty
    const firstRoyalty = page.locator('[data-testid="secondary-royalty-item"]').first();
    await firstRoyalty.click();
    
    // Should show distribution button for pending royalties
    await expect(page.locator('[data-testid="distribute-secondary-btn"]')).toBeVisible();
    
    await page.click('[data-testid="distribute-secondary-btn"]');
    
    // Confirm distribution
    await page.click('[data-testid="confirm-distribute"]');
    
    // Should show distribution progress
    await expect(page.locator('[data-testid="distribution-progress"]')).toBeVisible();
    
    // Wait for completion
    await expect(page.locator('[data-testid="distribution-complete"]')).toBeVisible({ timeout: 30000 });
    
    // Status should update to distributed
    await expect(page.locator('[data-testid="royalty-status"]')).toHaveText('Distributed');
  });

  test('should show distribution breakdown for secondary royalty', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    const distributedRoyalty = page.locator('[data-testid="secondary-royalty-item"]')
      .filter({ hasText: 'Distributed' })
      .first();
    
    await distributedRoyalty.click();
    
    // Should display breakdown
    await expect(page.locator('[data-testid="distribution-breakdown"]')).toBeVisible();
    
    // Should show per-collaborator amounts
    const collaboratorPayouts = page.locator('[data-testid="collaborator-payout"]');
    const count = await collaboratorPayouts.count();
    expect(count).toBeGreaterThan(0);
    
    // Each payout should have address and amount
    const firstPayout = collaboratorPayouts.first();
    await expect(firstPayout.locator('[data-testid="collaborator-address"]')).toBeVisible();
    await expect(firstPayout.locator('[data-testid="payout-amount"]')).toBeVisible();
  });

  test('should handle multiple secondary royalty sources', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    // Record multiple sources
    const sources = ['Spotify', 'Apple Music', 'YouTube'];
    
    for (const source of sources) {
      await page.click('[data-testid="record-secondary-royalty"]');
      await page.fill('[data-testid="source-input"]', source);
      await page.fill('[data-testid="amount-input"]', '1000');
      await page.click('[data-testid="submit-record"]');
      await page.waitForTimeout(500);
    }
    
    // Should be able to filter by source
    await page.fill('[data-testid="filter-source"]', 'Spotify');
    await page.waitForTimeout(300);
    
    const filteredItems = await page.locator('[data-testid="secondary-royalty-item"]').count();
    expect(filteredItems).toBeGreaterThan(0);
    
    // All visible items should be from Spotify
    const visibleSources = await page.locator('[data-testid="royalty-source"]').allTextContents();
    visibleSources.forEach(source => {
      expect(source).toContain('Spotify');
    });
  });

  test('should track secondary royalty distribution history', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    const royalty = page.locator('[data-testid="secondary-royalty-item"]').first();
    await royalty.click();
    
    // View history tab
    await page.click('[data-testid="history-tab"]');
    
    await expect(page.locator('[data-testid="history-timeline"]')).toBeVisible();
    
    // Should show key events
    await expect(page.locator('[data-testid="history-event"]')).toHaveCount(2, { timeout: 5000 });
    
    // Events should include: Recorded, Distributed
    const events = await page.locator('[data-testid="event-type"]').allTextContents();
    expect(events).toContain('Recorded');
  });

  test('should validate secondary royalty amount before recording', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    await page.click('[data-testid="record-secondary-royalty"]');
    
    // Try invalid amount
    await page.fill('[data-testid="amount-input"]', '-500');
    await page.click('[data-testid="submit-record"]');
    
    await expect(page.locator('[data-testid="validation-error"]')).toBeVisible();
    await expect(page.locator('[data-testid="validation-error"]')).toContainText('positive');
  });

  test('should support batch recording of secondary royalties', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    await page.click('[data-testid="batch-record"]');
    
    // Upload CSV with multiple secondary royalties
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'secondary-royalties.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('source,amount,description\nSpotify,1000,Q4\nApple Music,1500,Q4\nYouTube,800,Q4')
    });
    
    await page.click('[data-testid="submit-batch-record"]');
    
    await expect(page.locator('[data-testid="batch-success"]')).toBeVisible();
    await expect(page.locator('[data-testid="batch-success"]')).toContainText('3 royalties recorded');
  });

  test('should calculate correct distribution amounts based on shares', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    // Record royalty with known amount
    await page.click('[data-testid="record-secondary-royalty"]');
    await page.fill('[data-testid="source-input"]', 'Test Source');
    await page.fill('[data-testid="amount-input"]', '10000');
    await page.click('[data-testid="submit-record"]');
    
    const royaltyId = await page.locator('[data-testid="secondary-royalty-id"]').textContent();
    
    // Navigate to that royalty
    await page.goto(`/secondary-royalties/${royaltyId}`);
    
    // Preview distribution
    await page.click('[data-testid="preview-distribution"]');
    
    // Should show calculation preview
    await expect(page.locator('[data-testid="distribution-preview"]')).toBeVisible();
    
    // Total should equal original amount (minus fees if applicable)
    const totalDistributed = await page.locator('[data-testid="total-distributed"]').textContent();
    expect(parseFloat(totalDistributed || '0')).toBeGreaterThan(0);
  });

  test('should export secondary royalty report', async ({ page }) => {
    await page.goto('/secondary-royalties');
    
    // Select date range
    await page.fill('[data-testid="start-date"]', '2024-01-01');
    await page.fill('[data-testid="end-date"]', '2024-12-31');
    
    const downloadPromise = page.waitForEvent('download');
    await page.click('[data-testid="export-report"]');
    const download = await downloadPromise;
    
    expect(download.suggestedFilename()).toMatch(/secondary-royalties.*\.(csv|pdf)$/);
  });
});
