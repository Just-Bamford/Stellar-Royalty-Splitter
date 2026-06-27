/**
 * Generates a UUID v4 nonce for permanent per-contract request dedup on
 * POST /api/v1/initialize (#421). Distinct from the commit-reveal salt/nonce
 * in init-commitment.ts, which are 32-byte hex commitment values, not UUIDs.
 */
export function generateRequestNonce(): string {
  return crypto.randomUUID();
}
