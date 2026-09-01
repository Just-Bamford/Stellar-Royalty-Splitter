import { test, expect } from '@playwright/test';

test.describe('Live Earnings Counter', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Freighter wallet
    await page.evaluate(() => {
      (window as any).freighter = {
        isConnected: async () => true,
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
            collaboratorStats: [
              { address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', totalEarned: 500, payoutCount: 5 },
              { address: 'GABCDEF123456789012345678901234567890ABCDEF', totalEarned: 500, payoutCount: 5 },
            ],
          },
        }),
      });
    });

    await page.route('**/api/v1/collaborators/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', basisPoints: 5000 },
          { address: 'GABCDEF123456789012345678901234567890ABCDEF', basisPoints: 5000 },
        ]),
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

    // Navigate to earnings dashboard
    await page.goto('/');
    await page.getByRole('button', { name: /connect/i }).click();
    await page.waitForTimeout(1000);
  });

  test('should display live earnings counters', async ({ page }) => {
    // Check that the earnings dashboard is visible
    await expect(page.getByTestId('earnings-dashboard')).toBeVisible();

    // Check that the live earnings counters are displayed
    await expect(page.getByTestId('total-distributed')).toBeVisible();
    await expect(page.getByTestId('primary-royalties')).toBeVisible();
    await expect(page.getByTestId('secondary-royalties')).toBeVisible();
  });

  test('should show initial earnings values', async ({ page }) => {
    // Check that the initial values are displayed
    await expect(page.getByTestId('total-distributed-value')).toContainText('1,000');
    await expect(page.getByTestId('primary-royalties-value')).toContainText('600');
    await expect(page.getByTestId('secondary-royalties-value')).toContainText('400');
  });

  test('should update earnings on distribution event', async ({ page }) => {
    // Mock WebSocket connection
    await page.evaluate(() => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        send: (data: string) => {
          const msg = JSON.parse(data);
          if (msg.type === 'subscribe') {
            // Simulate subscribed response
            setTimeout(() => {
              const event = new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'notification',
                  data: {
                    type: 'distribution_completed',
                    contractId: 'C12345678901234567890123456789012345678901234567890123456',
                    transactionId: 'txn-123',
                    timestamp: new Date().toISOString(),
                    requestedAmount: '100',
                  },
                }),
              });
              // @ts-ignore
              window.dispatchEvent(event);
            }, 100);
          }
        },
        close: () => {},
        onmessage: null,
        onopen: null,
        onclose: null,
        onerror: null,
      };
      // @ts-ignore
      window.WebSocket = function () {
        return mockWs;
      };
    });

    // Wait for the dashboard to load
    await page.waitForSelector('[data-testid="total-distributed-value"]');

    // Get initial value
    const initialValue = await page.getByTestId('total-distributed-value').textContent();

    // Simulate a distribution event by updating the mock API response
    await page.route('**/api/v1/analytics/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            totalDistributed: 1100,
            primaryRoyaltiesTotal: 700,
            secondaryRoyaltiesTotal: 400,
            collaboratorStats: [
              { address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', totalEarned: 600, payoutCount: 6 },
              { address: 'GABCDEF123456789012345678901234567890ABCDEF', totalEarned: 500, payoutCount: 5 },
            ],
          },
        }),
      });
    });

    // Click refresh to trigger data reload
    await page.getByRole('button', { name: /refresh/i }).click();

    // Wait for the value to update
    await page.waitForTimeout(2000);

    // Check that the value has been updated
    const newValue = await page.getByTestId('total-distributed-value').textContent();
    expect(newValue).toContain('1,100');
  });

  test('should show delta badge on earnings increase', async ({ page }) => {
    // Wait for the dashboard to load
    await page.waitForSelector('[data-testid="total-distributed-value"]');

    // Check that no delta badge is initially visible
    await expect(page.getByTestId('total-distributed-delta')).not.toBeVisible();

    // Simulate a distribution event by updating the mock API response
    await page.route('**/api/v1/analytics/*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            totalDistributed: 1500,
            primaryRoyaltiesTotal: 900,
            secondaryRoyaltiesTotal: 600,
            collaboratorStats: [
              { address: 'GTEST123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', totalEarned: 750, payoutCount: 7 },
              { address: 'GABCDEF123456789012345678901234567890ABCDEF', totalEarned: 750, payoutCount: 7 },
            ],
          },
        }),
      });
    });

    // Click refresh to trigger data reload
    await page.getByRole('button', { name: /refresh/i }).click();

    // Wait for the value to update
    await page.waitForTimeout(2000);

    // Check that the delta badge is visible
    await expect(page.getByTestId('total-distributed-delta')).toBeVisible();
    await expect(page.getByTestId('total-distributed-delta')).toContainText('+');
  });

  test('should show WebSocket connection indicator', async ({ page }) => {
    // Wait for the dashboard to load
    await page.waitForSelector('[data-testid="earnings-dashboard"]');

    // Check that the WebSocket indicator is visible
    await expect(page.locator('.ws-indicator')).toBeVisible();
  });

  test('should show last update timestamp', async ({ page }) => {
    // Wait for the dashboard to load
    await page.waitForSelector('[data-testid="total-distributed"]');

    // Check that the timestamp is displayed
    await expect(page.getByTestId('total-distributed-timestamp')).toBeVisible();
    await expect(page.getByTestId('total-distributed-timestamp')).toContainText('Updated');
  });
});
