// Issue #422: collaborator shares are effectively immutable once a contract
// is initialized, so we cache them for 5 minutes and invalidate immediately
// on initialize without coupling initialize routes to collaborator RPC code.
export const COLLABORATORS_CACHE_TTL_MS = 5 * 60 * 1000;

const collaboratorsCache = new Map();

export function getCollaboratorsCacheKey(networkLabel, contractId) {
  return `contract:${networkLabel}:${contractId}:collaborators`;
}

export function getCachedCollaborators(cacheKey, now = Date.now()) {
  const cached = collaboratorsCache.get(cacheKey);
  if (!cached || now - cached.fetchedAt >= COLLABORATORS_CACHE_TTL_MS) return null;
  return cached.data;
}

export function setCachedCollaborators(cacheKey, data, now = Date.now()) {
  collaboratorsCache.set(cacheKey, { data, fetchedAt: now });
}

export function invalidateCollaboratorsCache(contractId) {
  for (const cacheKey of collaboratorsCache.keys()) {
    if (cacheKey.endsWith(`:${contractId}:collaborators`)) {
      collaboratorsCache.delete(cacheKey);
    }
  }
}

export function _resetCollaboratorsCache() {
  collaboratorsCache.clear();
}
