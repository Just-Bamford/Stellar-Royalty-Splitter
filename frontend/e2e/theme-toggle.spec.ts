import { test, expect } from '@playwright/test';

test.describe('Dark mode theme toggle (#769)', () => {
  test('toggles between light and dark theme', async ({ page }) => {
    await page.goto('/');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    await page.getByRole('button', { name: /toggle theme/i }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: /toggle theme/i }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('persists the chosen theme across a reload', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: /toggle theme/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('dark');
  });

  test('respects the OS color scheme preference on first visit', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
