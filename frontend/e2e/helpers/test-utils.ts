/**
 * Test utilities for E2E tests
 */

export interface MockCollaborator {
  address: string;
  share: number;
}

export function generateMockCollaborators(count: number): MockCollaborator[] {
  const collaborators: MockCollaborator[] = [];
  const sharePerCollaborator = Math.floor(10000 / count); // Total shares = 10000
  
  for (let i = 0; i < count; i++) {
    collaborators.push({
      address: `G${generateRandomString(55)}`,
      share: sharePerCollaborator
    });
  }
  
  return collaborators;
}

export function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function initializeTestContract(page: any, collaborators: MockCollaborator[]) {
  await page.goto('/initialize');
  
  // Mock file upload
  const csvContent = generateCSV(collaborators);
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: 'test-collaborators.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvContent)
  });
  
  await page.click('[data-testid="submit-initialize"]');
  await page.waitForSelector('[data-testid="success-message"]', { timeout: 60000 });
}

function generateCSV(collaborators: MockCollaborator[]): string {
  const header = 'address,share\n';
  const rows = collaborators.map(c => `${c.address},${c.share}`).join('\n');
  return header + rows;
}

export async function connectMockWallet(page: any) {
  await page.goto('/');
  await page.click('[data-testid="connect-wallet"]');
  await page.click('[data-testid="wallet-freighter"]');
  // Wait for wallet connection
  await page.waitForSelector('[data-testid="wallet-connected"]', { timeout: 10000 });
}

export async function disconnectWallet(page: any) {
  await page.click('[data-testid="wallet-menu"]');
  await page.click('[data-testid="disconnect-wallet"]');
}
