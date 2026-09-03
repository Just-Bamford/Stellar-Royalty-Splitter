import logger from "./logger.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_WARM_LEAD_TIME_MS = 30_000;

const TTL_MS = parseInt(process.env.CACHE_TTL_MS ?? DEFAULT_TTL_MS, 10);
const WARM_LEAD_TIME_MS = parseInt(
  process.env.CACHE_WARM_LEAD_TIME_MS ?? DEFAULT_WARM_LEAD_TIME_MS,
  10
);

// If warm lead time is >= TTL, disable warming to preserve existing behavior.
const WARMING_ENABLED = WARM_LEAD_TIME_MS < TTL_MS;

const cacheStore = new Map(); // key -> { value, expiresAt, fetchedAt }
const refreshInFlight = new Map(); // key -> Promise
const accessCount = new Map(); // key -> number of accesses

let fetchFunction = null; // async (key) => Promise<value>

const metrics = {
  hits: 0,
  misses: 0,
  staleServes: 0,
  refreshLatencyMs: 0,
};

/**
 * Configure the cache for use with an external fetch function.
 * This must be called before the cache can refresh data.
 */
export function configureCache(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("fetch function must be a function");
  }
  fetchFunction = fn;
}

/**
 * Generate a deterministic cache key from arguments.
 */
export function cacheKey(...parts) {
  return parts.map((p) => String(p)).join(":");
}

/**
 * Store a value in the cache with an optional TVL (defaults to CACHE_TTL_MS).
 * Records the fetch time and expiry time.
 */
export function cacheSet(key, value, ttlMs = TTL_MS) {
  const now = Date.now();
  cacheStore.set(key, {
    value,
    fetchedAt: now,
    expiresAt: now + ttlMs,
  });
}

/**
 * Retrieve a value from the cache.
 * - If the entry is missing, returns undefined (caller should fetch and set).
 * - If the entry is stale (past TTL), returns undefined to maintain old behavior.
 * - If the entry is within the lead time before expiry, returns stale value and
 *   triggers an asynchronous refresh if not already in flight.
 * - Otherwise, returns the cached value.
 */
export function cacheGet(key) {
  const entry = cacheStore.get(key);
  const now = Date.now();

  if (!entry) {
    metrics.misses++;
    return undefined;
  }

  const isExpired = now >= entry.expiresAt;
  const isWarmingWindow = WARMING_ENABLED && now >= entry.expiresAt - WARM_LEAD_TIME_MS;

  if (isExpired) {
    metrics.misses++;
    return undefined;
  }

  if (isWarmingWindow) {
    if (!refreshInFlight.has(key)) {
      refreshContract(key);
    }
    metrics.staleServes++;
    return entry.value;
  }

  metrics.hits++;
  return entry.value;
}

/**
 * Force a background refresh for a given key. Returns a promise that resolves
 * when the refresh completes (or rejects, but the rejection is caught).
 * If a refresh is already in flight, returns the existing promise.
 */
export function refreshContract(key) {
  if (!fetchFunction) {
    logger.warn("Cache refresh attempted but no fetch function configured", { key });
    return Promise.resolve();
  }

  if (refreshInFlight.has(key)) {
    return refreshInFlight.get(key);
  }

  const refreshPromise = (async () => {
    const start = Date.now();
    try {
      const freshValue = await fetchFunction(key);
      cacheSet(key, freshValue);
      metrics.refreshLatencyMs += Date.now() - start;
      logger.info("Cache refreshed", { key, durationMs: Date.now() - start });
    } catch (error) {
      logger.error("Cache background refresh failed", { key, error });
      // Keep stale data by not removing the cache entry.
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, refreshPromise);
  return refreshPromise;
}

/**
 * Background scheduler that periodically refreshes the cache for contracts
 * listed in the active-contracts table. Spreads load to avoid a thundering herd.
 *
 * @param {Function} getActiveContracts - Returns a promise of an array of contract keys.
 * @param {number} intervalMs - How often to run the scheduler.
 * @param {number} batchSize - Max number of contracts to refresh per tick.
 */
export function startCacheWarmingScheduler(
  getActiveContracts,
  intervalMs = 60_000,
  batchSize = 10
) {
  if (typeof getActiveContracts !== "function") {
    throw new TypeError("getActiveContracts must be a function");
  }

  setInterval(async () => {
    try {
      let contracts = await getActiveContracts();
      if (!Array.isArray(contracts)) contracts = [];

      // Prioritize frequently accessed contracts
      contracts.sort((a, b) => (accessCount.get(b) || 0) - (accessCount.get(a) || 0));

      const toRefresh = contracts.slice(0, batchSize);
      for (const contract of toRefresh) {
        const delay = Math.random() * (intervalMs / 2);
        setTimeout(() => refreshContract(contract), delay);
      }
    } catch (error) {
      logger.error("Cache warming scheduler failed", { error });
    }
  }, intervalMs);
}

/**
 * Increment the access count for a key.
 * Call this when a contract is served from the cache.
 */
export function recordAccess(key) {
  accessCount.set(key, (accessCount.get(key) || 0) + 1);
}

export { metrics };

export const TTL = {
  history: TTL_MS,
};

export function getMetrics() {
  return { ...metrics };
}

export function resetMetrics() {
  metrics.hits = 0;
  metrics.misses = 0;
  metrics.staleServes = 0;
  metrics.refreshLatencyMs = 0;
}

// For unit testing
export function __test__clear() {
  cacheStore.clear();
  refreshInFlight.clear();
  accessCount.clear();
  resetMetrics();
}

// Alias for tests that import clearCache
export const clearCache = __test__clear;

/**
 * Invalidate a specific cache entry for a contract.
 */
export function invalidateContract(key) {
  cacheStore.delete(key);
  refreshInFlight.delete(key);
  accessCount.delete(key);
}
