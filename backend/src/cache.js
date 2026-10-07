import logger from "./logger.js";
import { RedisCacheClient, namespacedKey, REDIS_TTL_MS } from "./cache-redis.js";

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

// ---------------------------------------------------------------------------
// Redis-backed distributed cache (#926)
// ---------------------------------------------------------------------------
// The in-memory Map above only ever sees the current process, so it breaks
// down across multiple backend instances (each has its own cache, and an
// invalidation on one instance never reaches the others). When REDIS_URL is
// set, we mirror every cacheSet()/invalidateContract() into Redis (write-
// through, fire-and-forget) and publish an invalidation message so sibling
// instances can evict their own local Map entries too. If Redis is not
// configured, fails to connect, or errors at runtime, every Redis operation
// below is a no-op/logged-warning — the in-memory Map remains fully
// functional as the fallback and no caller-visible behavior changes.
//
// cacheGet()/cacheSet() stay synchronous so none of the existing call sites
// (collaborators.js, contract.js, history.js) need to change. Callers that
// want a cross-instance-consistent read can use the async cacheGetAsync(),
// which checks Redis first and falls back to the local Map.

let redisClient = null;
let redisConnectAttempted = false;

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (!redisClient) {
    redisClient = new RedisCacheClient();
  }
  return redisClient;
}

/**
 * Kick off (idempotent, non-blocking) Redis connection + invalidation
 * subscription. Safe to call multiple times; safe to call when REDIS_URL is
 * unset (no-ops). Never throws or produces an unhandled rejection.
 */
export function initRedisCache() {
  const client = getRedisClient();
  if (!client) return;
  if (redisConnectAttempted) return;
  redisConnectAttempted = true;

  client
    .connect()
    .then((connected) => {
      if (!connected) return;
      return client.subscribeToInvalidation((message) => {
        // Messages carry Redis-namespaced keys (srs:...); translate back to
        // the local unprefixed key shape before touching the in-memory Map
        // or notifying local listeners (collaborators.js / contract.js).
        if (message?.key) {
          const localKey = fromRedisKey(message.key);
          invalidateContract(localKey);
          for (const fn of _invalidationListeners) {
            try {
              fn(localKey, { prefix: false });
            } catch (err) {
              logger.warn("Cache invalidation listener threw", { error: err.message });
            }
          }
        } else if (message?.prefix) {
          const localPrefix = fromRedisKey(message.prefix);
          for (const k of cacheStore.keys()) {
            if (k.startsWith(localPrefix)) invalidateContract(k);
          }
          for (const fn of _invalidationListeners) {
            try {
              fn(localPrefix, { prefix: true });
            } catch (err) {
              logger.warn("Cache invalidation listener threw", { error: err.message });
            }
          }
        }
      });
    })
    .catch((err) => {
      // getRedisClient()/connect() already catch internally, but guard here
      // too so a future change to RedisCacheClient can never crash the app.
      logger.warn("Redis cache initialization failed, using in-memory cache only", {
        error: err.message,
      });
    });
}

/**
 * Export Redis TTL/key-namespacing helpers so route modules can build
 * correctly-namespaced keys (srs:<type>:...) without duplicating the prefix
 * logic. Kept here (rather than only in cache-redis.js) so callers only
 * need one import for both the in-memory and Redis-backed helpers.
 */
export { namespacedKey, REDIS_TTL_MS };

/**
 * Translate a local in-memory cache key (e.g. "collaborators:C123...",
 * produced by cacheKey()) into its namespaced Redis key ("srs:collaborators:
 * C123..."). Local Map keys are left unprefixed/unchanged (existing
 * call sites and tests depend on the exact local key shape), but every key
 * that leaves this process toward Redis is namespaced per #926 so a shared
 * Redis instance can be safely reused by other services without key
 * collisions.
 */
function toRedisKey(localKey) {
  return localKey.startsWith("srs:") ? localKey : `srs:${localKey}`;
}

function fromRedisKey(redisKey) {
  return redisKey.startsWith("srs:") ? redisKey.slice(4) : redisKey;
}

/**
 * Async read that checks Redis first (so a value written by another
 * instance is visible here), then falls back to the local in-memory Map.
 * Returns undefined on a full miss. Never throws.
 */
export async function cacheGetAsync(key) {
  const client = getRedisClient();
  if (client?.available) {
    const value = await client.get(toRedisKey(key));
    if (value !== undefined) {
      metrics.hits++;
      return value;
    }
  }
  return cacheGet(key);
}

/**
 * Write-through set: writes to the local in-memory Map synchronously (same
 * as cacheSet) and, if Redis is configured, mirrors the write to Redis in
 * the background so other instances sharing REDIS_URL can see it via
 * cacheGetAsync(). Fire-and-forget: does not await the Redis write and
 * never throws.
 */
export function cacheSetSync(key, value, ttlMs = TTL_MS) {
  cacheSet(key, value, ttlMs);
  const client = getRedisClient();
  if (client) {
    client.set(toRedisKey(key), value, ttlMs).catch(() => {});
  }
}

/**
 * Invalidate a key both locally and (if configured) across every other
 * instance sharing Redis, via pub/sub. Call this after any distribution or
 * admin action that changes data another instance may have cached.
 *
 * @param {string} key - exact cache key, or a prefix when prefix=true
 * @param {{ prefix?: boolean, reason?: string }} [options]
 */
export function invalidateCacheDistributed(key, { prefix = false, reason } = {}) {
  if (prefix) {
    for (const k of cacheStore.keys()) {
      if (k.startsWith(key)) invalidateContract(k);
    }
  } else {
    invalidateContract(key);
  }

  for (const fn of _invalidationListeners) {
    try {
      fn(key, { prefix });
    } catch (err) {
      logger.warn("Cache invalidation listener threw", { error: err.message });
    }
  }

  const client = getRedisClient();
  if (!client) return;

  const redisKey = toRedisKey(key);
  const message = prefix ? { prefix: redisKey, reason } : { key: redisKey, reason };

  if (prefix) {
    client.deleteByPrefix(redisKey).catch(() => {});
  } else {
    client.delete(redisKey).catch(() => {});
  }
  client.publishInvalidation(message).catch(() => {});
}

/**
 * Route modules that keep their own local "stale" cache alongside cache.js
 * (collaborators.js, contract.js — see their cache-warming sections) can
 * register a listener here to also be notified on invalidation, whether
 * triggered locally or by another instance via Redis pub/sub. This keeps
 * their stale-serving fallback from continuing to serve data that was
 * invalidated by a distribution/admin action.
 *
 * @param {(key: string, opts: { prefix: boolean }) => void} fn
 */
const _invalidationListeners = new Set();
export function onCacheInvalidated(fn) {
  _invalidationListeners.add(fn);
  return () => _invalidationListeners.delete(fn);
}

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

// Per-resource-type TTLs (#926). `history` preserves the pre-existing
// generic default; the others were previously referenced as TTL.collaborators
// / TTL.contractState by collaborators.js / contract.js but were never
// actually defined here, so cacheSet() silently fell back to the generic
// CACHE_TTL_MS default (30s) instead of the intended 5m/30m windows. Fixed
// to match the durations specified in #926.
export const TTL = {
  history: TTL_MS,
  contractState: REDIS_TTL_MS.contractState, // 5 minutes
  analytics: REDIS_TTL_MS.analytics, // 1 hour
  collaborators: REDIS_TTL_MS.collaborator, // 30 minutes
  collaborator: REDIS_TTL_MS.collaborator, // alias, matches srs:collaborator: namespace
  session: REDIS_TTL_MS.session, // 24 hours
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
