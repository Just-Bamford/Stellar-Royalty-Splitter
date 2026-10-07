/**
 * Shared helper for invalidating every cache entry associated with a
 * contractId after a distribution or admin action (#926).
 *
 * A single contractId can be cached under several different keys —
 * `collaborators:{contractId}`, `contractState:{contractId}:{tokenId}`,
 * `history:{contractId}:...` — so a plain `invalidateContract(contractId)`
 * (the pre-#926 behavior in distribute.js/batch-distribute.js/initialize.js)
 * never actually matched any of them and was a silent no-op. This helper
 * invalidates every namespaced key with that contractId as a prefix
 * component, both locally and (via invalidateCacheDistributed) across every
 * other backend instance sharing REDIS_URL.
 */

import { invalidateCacheDistributed } from "./cache.js";

const INVALIDATED_RESOURCE_TYPES = ["collaborators", "contractState", "history"];

/**
 * Invalidate every cached entry (in-memory + Redis, local + distributed)
 * that relates to a given contractId, across every resource type cache.js
 * knows about.
 *
 * @param {string} contractId
 * @param {{ reason?: string }} [options]
 */
export function invalidateContractCaches(contractId, { reason } = {}) {
  for (const resourceType of INVALIDATED_RESOURCE_TYPES) {
    invalidateCacheDistributed(`${resourceType}:${contractId}`, { prefix: true, reason });
  }
}
