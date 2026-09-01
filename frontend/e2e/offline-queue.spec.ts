import { test, expect } from '@playwright/test';

test.describe('Offline write queue (#771)', () => {
  test('shows the offline banner when connectivity drops and hides it once restored', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('status')).not.toBeVisible();

    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByRole('status')).toContainText(/you're offline/i);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('status')).not.toBeVisible();
  });
});
