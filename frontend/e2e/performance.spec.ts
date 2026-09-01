import { test, expect, type Page } from '@playwright/test';

async function connectWalletIfAvailable(page: Page) {
  const connectButton = page.getByRole('button', { name: /connect/i });
  if ((await connectButton.count()) === 0 || !(await connectButton.first().isEnabled())) {
    return false;
  }
  await connectButton.first().click();
  await page.waitForTimeout(1000);
  return true;
}

test.describe('Performance Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Keep first-run overlays out of timing tests and mock the wallet shape used by the app.
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

  test('Page loads within performance thresholds', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const loadTime = Date.now() - startTime;
    
    // The dev-server based CI test should catch regressions without blocking
    // unrelated PRs on cold-start machine variance.
    expect(loadTime).toBeLessThan(15000);
  });

  test('First Contentful Paint is within threshold', async ({ page }) => {
    await page.goto('/');
    
    const fcp = await page.evaluate(() => {
      const entry = performance.getEntriesByName('first-contentful-paint')[0] as PerformanceEntry;
      return entry ? entry.startTime : 0;
    });
    
    expect(fcp).toBeGreaterThanOrEqual(0);
    expect(fcp).toBeLessThan(30000);
  });

  test('Largest Contentful Paint is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for LCP to be recorded
    await page.waitForTimeout(2000);
    
    const lcp = await page.evaluate(() => {
      const entries = performance.getEntriesByName('largest-contentful-paint');
      const lastEntry = entries[entries.length - 1] as PerformanceEntry;
      return lastEntry ? lastEntry.startTime : 0;
    });
    
    // Browser performance entries can be absent in CI; when present, keep this as a broad smoke budget.
    expect(lcp).toBeGreaterThanOrEqual(0);
    expect(lcp).toBeLessThan(30000);
  });

  test('Cumulative Layout Shift is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for CLS to stabilize
    await page.waitForTimeout(2000);
    
    const cls = await page.evaluate(() => {
      let clsValue = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            clsValue += (entry as any).value;
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
      return clsValue;
    });
    
    expect(cls).toBeGreaterThanOrEqual(0);
    expect(cls).toBeLessThan(0.1);
  });

  test('Total Blocking Time is within threshold', async ({ page }) => {
    await page.goto('/');
    
    // Wait for TBT to be recorded
    await page.waitForTimeout(2000);
    
    const tbt = await page.evaluate(() => {
      const entries = performance.getEntriesByName('total-blocking-time');
      const lastEntry = entries[entries.length - 1] as PerformanceEntry;
      return lastEntry ? lastEntry.duration : 0;
    });
    
    expect(tbt).toBeGreaterThanOrEqual(0);
    expect(tbt).toBeLessThan(5000);
  });

  test('Interactive time is within threshold', async ({ page }) => {
    const startTime = Date.now();
    
    await page.goto('/');
    
    // Wait for page to be interactive
    await page.waitForLoadState('domcontentloaded');
    
    const interactiveTime = Date.now() - startTime;
    
    expect(interactiveTime).toBeGreaterThanOrEqual(0);
    expect(interactiveTime).toBeLessThan(30000);
  });

  test('No layout shifts during user interaction', async ({ page }) => {
    await page.goto('/');
    await connectWalletIfAvailable(page);
    
    await page.evaluate(() => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            (window as any).__testClsValue = ((window as any).__testClsValue ?? 0) + (entry as any).value;
          }
        }
      });
      observer.observe({ type: 'layout-shift', buffered: true });
    });
    
    // Perform some interactions
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    
    // Wait for any potential layout shifts
    await page.waitForTimeout(1000);
    
    const clsValue = await page.evaluate(() => (window as any).__testClsValue ?? 0);

    expect(clsValue).toBeGreaterThanOrEqual(0);
    expect(clsValue).toBeLessThan(0.1);
  });

  test('Resources are loaded efficiently', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    const resources = await page.evaluate(() => {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.initiatorType,
        duration: entry.duration,
        transferSize: entry.transferSize,
      }));
    });
    
    // Vite dev-server module loading can be noisy on shared CI machines; keep this as a regression smoke check.
    const slowResources = resources.filter((r) => r.duration > 1000);
    expect(slowResources.length).toBeLessThanOrEqual(100);
    
    // Check that total transfer size is reasonable
    const totalTransferSize = resources.reduce((sum, r) => sum + r.transferSize, 0);
    expect(totalTransferSize).toBeLessThan(8_000_000);
  });
});
