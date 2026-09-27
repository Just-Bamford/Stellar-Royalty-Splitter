/**
 * E2E Tests: Large-Scale Contract Initialization
 * Tests initializing contracts with 50+ collaborators
 */

import { test, expect } from '@playwright/test';
import { generateMockCollaborators, initializeTestContract } from './helpers/test-utils';

test.describe('Large-Scale Contract Initialization', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Assume wallet is connected via test helpers
  });

  test('should initialize contract with 50 collaborators', async ({ page }) => {
    const collaborators = generateMockCollaborators(50);
    
    await page.click('[data-testid="initialize-contract-btn"]');
    await page.waitForSelector('[data-testid="initialize-form"]');
    
    // Upload CSV with 50 collaborators
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'collaborators-50.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(generateCSV(collaborators))
    });
    
    await page.click('[data-testid="submit-initialize"]');
    
    // Should show progress indicator
    await expect(page.locator('[data-testid="initialization-progress"]')).toBeVisible();
    
    // Wait for completion (may take a while)
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible({ timeout: 60000 });
    
    // Verify all collaborators were added
    await page.goto('/collaborators');
    const collaboratorCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(collaboratorCount).toBe(50);
  });

  test('should initialize contract with 100 collaborators', async ({ page }) => {
    const collaborators = generateMockCollaborators(100);
    
    await page.click('[data-testid="initialize-contract-btn"]');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'collaborators-100.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(generateCSV(collaborators))
    });
    
    await page.click('[data-testid="submit-initialize"]');
    
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible({ timeout: 90000 });
    
    // Verify performance - should complete within 90 seconds
    await page.goto('/collaborators');
    const collaboratorCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(collaboratorCount).toBeGreaterThanOrEqual(100);
  });

  test('should handle initialization errors gracefully with large dataset', async ({ page }) => {
    const collaborators = generateMockCollaborators(50);
    // Add invalid collaborator to trigger error
    collaborators.push({ address: 'INVALID_ADDRESS', share: 100 });
    
    await page.click('[data-testid="initialize-contract-btn"]');
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'collaborators-invalid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(generateCSV(collaborators))
    });
    
    await page.click('[data-testid="submit-initialize"]');
    
    // Should show error message
    await expect(page.locator('[data-testid="error-message"]')).toBeVisible();
    await expect(page.locator('[data-testid="error-message"]')).toContainText('INVALID_ADDRESS');
  });

  test('should paginate collaborators list efficiently with 50+ entries', async ({ page }) => {
    // Assume contract already initialized with 60 collaborators
    await page.goto('/collaborators');
    
    // Check pagination controls
    await expect(page.locator('[data-testid="pagination"]')).toBeVisible();
    
    // First page should show default page size (e.g., 20)
    const firstPageCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(firstPageCount).toBeLessThanOrEqual(20);
    
    // Navigate to next page
    await page.click('[data-testid="next-page"]');
    const secondPageCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(secondPageCount).toBeGreaterThan(0);
    
    // Should show correct page indicator
    await expect(page.locator('[data-testid="current-page"]')).toHaveText('2');
  });

  test('should search and filter in large collaborator set', async ({ page }) => {
    await page.goto('/collaborators');
    
    const searchInput = page.locator('[data-testid="search-collaborators"]');
    await searchInput.fill('GABC');
    
    // Results should filter in real-time
    await page.waitForTimeout(500); // Debounce
    const resultCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(resultCount).toBeGreaterThan(0);
    
    // All visible results should contain search term
    const addresses = await page.locator('[data-testid="collaborator-address"]').allTextContents();
    addresses.forEach(addr => {
      expect(addr).toContain('GABC');
    });
  });
});

function generateCSV(collaborators: Array<{ address: string; share: number }>): string {
  const header = 'address,share\n';
  const rows = collaborators.map(c => `${c.address},${c.share}`).join('\n');
  return header + rows;
}
