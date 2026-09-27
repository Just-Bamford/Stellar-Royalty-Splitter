/**
 * E2E Tests: Admin Operations
 * Tests suspend, resume, tier change, pause, and other admin operations
 */

import { test, expect } from '@playwright/test';

test.describe('Admin Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin');
  });

  test('should suspend a collaborator', async ({ page }) => {
    await page.goto('/admin/collaborators');
    const firstCollaborator = page.locator('[data-testid="collaborator-row"]').first();
    await firstCollaborator.locator('[data-testid="actions-menu"]').click();
    await page.click('[data-testid="suspend-action"]');
    await page.fill('[data-testid="suspension-reason"]', 'Violation of terms');
    await page.click('[data-testid="confirm-suspend"]');
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
    await expect(firstCollaborator.locator('[data-testid="status-badge"]')).toHaveText('Suspended');
  });

  test('should resume a suspended collaborator', async ({ page }) => {
    await page.goto('/admin/collaborators');
    await page.click('[data-testid="filter-status"]');
    await page.click('[data-testid="status-suspended"]');
    const suspendedCollaborator = page.locator('[data-testid="collaborator-row"]').first();
    await suspendedCollaborator.locator('[data-testid="actions-menu"]').click();
    await page.click('[data-testid="resume-action"]');
    await page.click('[data-testid="confirm-resume"]');
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
  });

  test('should change collaborator tier', async ({ page }) => {
    await page.goto('/admin/collaborators');
    const collaborator = page.locator('[data-testid="collaborator-row"]').first();
    await collaborator.locator('[data-testid="actions-menu"]').click();
    await page.click('[data-testid="change-tier-action"]');
    await page.click('[data-testid="tier-select"]');
    await page.click('[data-testid="tier-premium"]');
    await page.fill('[data-testid="tier-change-reason"]', 'Performance upgrade');
    await page.click('[data-testid="confirm-tier-change"]');
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
  });

  test('should pause contract distributions', async ({ page }) => {
    await page.goto('/admin/contract-settings');
    await page.click('[data-testid="pause-contract-btn"]');
    await page.fill('[data-testid="pause-reason"]', 'Maintenance window');
    await page.click('[data-testid="confirm-pause"]');
    await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
    await expect(page.locator('[data-testid="contract-status"]')).toHaveText('Paused');
  });

  test('should bulk suspend multiple collaborators', async ({ page }) => {
    await page.goto('/admin/collaborators');
    await page.locator('[data-testid="select-collaborator"]').nth(0).check();
    await page.locator('[data-testid="select-collaborator"]').nth(1).check();
    await page.locator('[data-testid="select-collaborator"]').nth(2).check();
    await expect(page.locator('[data-testid="selected-count"]')).toHaveText('3');
    await page.click('[data-testid="bulk-actions"]');
    await page.click('[data-testid="bulk-suspend"]');
    await page.fill('[data-testid="suspension-reason"]', 'Bulk compliance review');
    await page.click('[data-testid="confirm-bulk-suspend"]');
    await expect(page.locator('[data-testid="success-message"]')).toContainText('3 collaborators suspended');
  });

  test('should view audit log of admin actions', async ({ page }) => {
    await page.goto('/admin/audit-log');
    await expect(page.locator('[data-testid="audit-log-table"]')).toBeVisible();
    const auditEntries = await page.locator('[data-testid="audit-entry"]').count();
    expect(auditEntries).toBeGreaterThan(0);
  });
});
