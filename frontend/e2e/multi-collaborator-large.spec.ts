import { test, expect } from '@playwright/test';

/**
 * E2E Test: Initialize contract with 50+ collaborators
 * Tests large-scale collaborator management and UI performance
 * Part of Issue #964 - Comprehensive E2E test suite
 */

test.describe('Multi-Collaborator Initialization (50+ users)', () => {
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

  test('should handle initialization with 50 collaborators', async ({ page }) => {
    // Mock backend responses
    await page.route('**/api/v1/contract/initialize', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          xdr: 'AAAAAgAAAAA...',
          transactionId: 'txn-50-collab-001',
          fee: 250000,
        }),
      });
    });

    await page.route('**/api/v1/transaction/*/confirm', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'confirmed',
          contractId: 'CCOLLABORATOR50TEST',
          fee: 250000,
        }),
      });
    });

    // Navigate to initialize page
    await page.click('text=Initialize Contract');

    // Generate 50 collaborators with valid addresses and shares
    const collaborators = Array.from({ length: 50 }, (_, i) => ({
      address: `GCOLLAB${String(i + 1).padStart(2, '0')}${'A'.repeat(48)}`.slice(0, 56),
      share: 200, // 200 * 50 = 10,000
    }));

    // Fill in collaborator details
    for (let i = 0; i < 50; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Collaborator")');
      }
      await page.fill(`input[name="collaborator-${i}-address"]`, collaborators[i].address);
      await page.fill(`input[name="collaborator-${i}-share"]`, String(collaborators[i].share));
    }

    // Verify total shares sum to 10,000
    await expect(page.locator('text=Total: 10,000')).toBeVisible();

    // Submit initialization
    await page.click('button:has-text("Initialize Contract")');

    // Wait for success message
    await expect(page.locator('text=Contract initialized successfully')).toBeVisible({
      timeout: 10000,
    });
  });

  test('should reject initialization with 51 collaborators exceeding 10,000 shares', async ({ page }) => {
    await page.click('text=Initialize Contract');

    // Add 51 collaborators with 200 shares each (10,200 total - invalid)
    for (let i = 0; i < 51; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Collaborator")');
      }
      const address = `GCOLLAB${String(i + 1).padStart(2, '0')}${'A'.repeat(48)}`.slice(0, 56);
      await page.fill(`input[name="collaborator-${i}-address"]`, address);
      await page.fill(`input[name="collaborator-${i}-share"]`, '200');
    }

    // Verify validation error
    await expect(page.locator('text=Total shares must equal 10,000')).toBeVisible();

    // Submit button should be disabled
    await expect(page.locator('button:has-text("Initialize Contract")')).toBeDisabled();
  });

  test('should handle UI performance with 100+ collaborators', async ({ page }) => {
    await page.click('text=Initialize Contract');

    // Measure time to add 100 collaborators
    const startTime = Date.now();

    for (let i = 0; i < 100; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Collaborator")');
      }
      const address = `GCOLLAB${String(i + 1).padStart(3, '0')}${'A'.repeat(48)}`.slice(0, 56);
      await page.fill(`input[name="collaborator-${i}-address"]`, address);
      await page.fill(`input[name="collaborator-${i}-share"]`, '100');
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Should complete in under 30 seconds even with 100 collaborators
    expect(duration).toBeLessThan(30000);

    // Verify all collaborators are visible (with scrolling)
    const collaboratorCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(collaboratorCount).toBe(100);
  });

  test('should support bulk import of collaborators via CSV', async ({ page }) => {
    await page.click('text=Initialize Contract');

    // Mock file upload with 75 collaborators
    const csvContent = Array.from({ length: 75 }, (_, i) => {
      const address = `GCOLLAB${String(i + 1).padStart(2, '0')}${'A'.repeat(48)}`.slice(0, 56);
      return `${address},${Math.floor(10000 / 75)}`;
    }).join('\n');

    const csvHeader = 'address,share\n';
    const fullCsv = csvHeader + csvContent;

    // Simulate file upload
    await page.setInputFiles('input[type="file"]', {
      name: 'collaborators.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(fullCsv),
    });

    // Wait for import to process
    await expect(page.locator('text=75 collaborators imported')).toBeVisible();

    // Verify collaborators populated
    const collaboratorCount = await page.locator('[data-testid="collaborator-row"]').count();
    expect(collaboratorCount).toBe(75);
  });

  test('should validate collaborator addresses in bulk', async ({ page }) => {
    await page.click('text=Initialize Contract');

    // Add 30 collaborators, including 3 with invalid addresses
    for (let i = 0; i < 30; i++) {
      if (i > 0) {
        await page.click('button:has-text("Add Collaborator")');
      }
      
      let address;
      if (i === 10 || i === 15 || i === 25) {
        // Invalid addresses (too short)
        address = 'GINVALID123';
      } else {
        address = `GCOLLAB${String(i + 1).padStart(2, '0')}${'A'.repeat(48)}`.slice(0, 56);
      }
      
      await page.fill(`input[name="collaborator-${i}-address"]`, address);
      await page.fill(`input[name="collaborator-${i}-share"]`, '333');
    }

    // Trigger validation
    await page.click('button:has-text("Validate All")');

    // Should show 3 validation errors
    await expect(page.locator('text=3 invalid addresses found')).toBeVisible();
    await expect(page.locator('.error-highlight')).toHaveCount(3);
  });
});
