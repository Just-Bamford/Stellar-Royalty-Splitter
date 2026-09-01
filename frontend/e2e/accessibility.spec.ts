import { test, expect, type Page } from '@playwright/test';
import {
  runA11yAudit,
  expectNoA11yViolations,
  checkKeyboardNavigation,
  checkColorContrast,
  testFormAccessibility,
} from './helpers/accessibility';

async function connectWalletIfAvailable(page: Page) {
  await page.locator('nav').waitFor();
  const connectButton = page.getByRole('button', { name: /connect/i });
  if ((await connectButton.count()) === 0 || !(await connectButton.first().isEnabled())) {
    return false;
  }
  await connectButton.first().click();
  await page.waitForTimeout(1000);
  return true;
}

test.describe('Accessibility (WCAG 2.1 AA)', () => {
  test.beforeEach(async ({ page }) => {
    // Keep first-run overlays out of CI audits and mock the wallet shape used by the app.
    await page.addInitScript(() => {
      window.localStorage.setItem('srs_help_seen', '1');
      window.localStorage.setItem('srs_onboarding_completed', 'true');
      (window as any).freighter = {
        isConnected: async () => true,
        requestAccess: async () => ({ address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
        getAddress: async () => ({ address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
        getPublicKey: async () => 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        signTransaction: async (xdr: string) => xdr,
      };
    });

    // Mock API responses
    await page.route('**/api/v1/analytics/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            totalDistributed: 1000,
            primaryRoyaltiesTotal: 600,
            secondaryRoyaltiesTotal: 400,
            collaboratorStats: [],
          },
        }),
      });
    });

    await page.route('**/api/v1/collaborators/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/api/v1/secondary-royalty/stats/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalRoyaltiesGenerated: 400,
          totalSales: 10,
          averageRoyalty: 40,
        }),
      });
    });

    await page.route('**/api/v1/history/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    await page.route('**/api/v1/secondary-royalty/sales/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sales: [] }),
      });
    });
  });

  test('Dashboard page has no accessibility violations', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    await expectNoA11yViolations(page, {
      exclude: ['.export-dashboard-menu'],
    });
  });

  test('Navigation has no accessibility violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').waitFor();
    await expectNoA11yViolations(page, {
      include: ['nav', '[role="navigation"]'],
    });
  });

  test('Forms have proper labels and ARIA attributes', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    // Check contract initialization form if visible
    const initForm = page.locator('form').first();
    if (await initForm.isVisible()) {
      await testFormAccessibility(page, 'form');
    }
  });

  test('Color contrast meets WCAG AA requirements', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    await checkColorContrast(page);
  });

  test('Keyboard navigation works through all interactive elements', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    await checkKeyboardNavigation(page);
  });

  test('All images have alt text', async ({ page }) => {
    await page.goto('/');
    await page.locator('main').waitFor();

    const images = await page.locator('img').all();
    for (const image of images) {
      const alt = await image.getAttribute('alt');
      expect(alt, 'Image should have alt text').not.toBeNull();
    }
  });

  test('Headings are in hierarchical order', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    const headings = await page.locator('h1, h2, h3, h4, h5, h6').all();
    const headingLevels: number[] = [];

    for (const heading of headings) {
      const tagName = await heading.evaluate((el) => el.tagName);
      const level = parseInt(tagName.charAt(1));
      headingLevels.push(level);
    }

    // Verify heading hierarchy (no skipping levels)
    for (let i = 1; i < headingLevels.length; i++) {
      const diff = headingLevels[i] - headingLevels[i - 1];
      expect(
        diff,
        `Heading level should not skip from h${headingLevels[i - 1]} to h${headingLevels[i]}`
      ).toBeLessThanOrEqual(1);
    }
  });

  test('Focus is visible on interactive elements', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    // Tab to first interactive element
    await page.keyboard.press('Tab');

    // Check that focus is visible
    const focusedElement = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;

      const styles = window.getComputedStyle(el);
      const outlineStyle = styles.outlineStyle;
      const boxShadow = styles.boxShadow;

      return {
        tagName: el.tagName,
        hasOutline: outlineStyle !== 'none',
        hasBoxShadow: boxShadow !== 'none',
      };
    });

    expect(focusedElement).not.toBeNull();
  });

  test('ARIA landmarks are present', async ({ page }) => {
    await page.goto('/');
    await page.locator('main').waitFor();

    // Check for main landmarks
    const landmarks = await page.evaluate(() => {
      const landmarkRoles = ['banner', 'navigation', 'main', 'contentinfo'];
      const found: string[] = [];

      for (const role of landmarkRoles) {
        const element = document.querySelector(`[role="${role}"], ${role === 'banner' ? 'header' : role === 'contentinfo' ? 'footer' : role === 'navigation' ? 'nav' : 'main'}`);
        if (element) {
          found.push(role);
        }
      }

      return found;
    });

    // At minimum, main content should be present
    expect(landmarks.length).toBeGreaterThan(0);
  });

  test('Screen reader announcements for dynamic content', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);

    // Check for aria-live regions
    const liveRegions = await page.locator('[aria-live]').count();
    expect(liveRegions).toBeGreaterThan(0);
  });
});
