/**
 * Advanced multi-layer caching strategy (#970)
 * 
 * L1: Hot cache (10 most-accessed contracts, refreshed every 30s)
 * L2: Warm cache (recently accessed, refreshed every 5min)
 * L3: Redis distributed cache (shared across instances)
 * 
 * Features:
 * - Automatic cache warming for hot contracts
 * - LRU eviction for warm cache
 * - Proactive refresh before expiry
 * - Fine-grained invalidation
 */

import logger from "./logger.js";
import { RedisCacheClient, namespacedKey, REDIS_TTL_MS } from "./cache-redis.js";

// Shared Redis client instance
let redisClient = null;

function getRedisClient() {
  if (!redisClient && process.env.REDIS_URL) {
    redisClient = new RedisCacheClient();
  }
  return redisClient;
}

// Layer 1: Hot cache - most frequently accessed contracts
const L1_SIZE = parseInt(process.env.CACHE_L1_SIZE ?? "10", 10);
const L1_REFRESH_INTERVAL_MS = parseInt(process.env.CACHE_L1_REFRESH_MS ?? "30000", 10);

// Layer 2: Warm cache - recently accessed contracts
const L2_SIZE = parseInt(process.env.CACHE_L2_SIZE ?? "100", 10);
const L2_REFRESH_INTERVAL_MS = parseInt(process.env.CACHE_L2_REFRESH_MS ?? "300000", 10);

// Access tracking for promotion to L1
const accessCount = new Map(); // key -> count
const lastAccess = new Map(); // key -> timestamp

class CacheEntry {
  constructor(value, ttl) {
    this.value = value;
    this.fetchedAt = Date.now();
    this.expiresAt = Date.now() + ttl;
    this.hits = 0;
  }

  isExpired() {
    return Date.now() >= this.expiresAt;
  }

  isStale(leadTimeMs = 10000) {
    return Date.now() >= this.expiresAt - leadTimeMs;
  }
}

class LRUCache {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return undefined;
    
    const entry = this.cache.get(key);
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    
    return entry;
  }

  set(key, entry) {
    // Remove if exists (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      logger.debug("Cache LRU eviction", { key: oldestKey });
    }

    this.cache.set(key, entry);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

// L1: Hot cache (fixed size, frequently refreshed)
const l1Cache = new Map();

// L2: Warm cache (LRU, larger size)
const l2Cache = new LRUCache(L2_SIZE);

// Refresh queue to prevent thundering herd
const refreshInFlight = new Map();

// Fetch function registry
let fetchFunction = null;

// Metrics
const metrics = {
  l1: { hits: 0, misses: 0, refreshes: 0 },
  l2: { hits: 0, misses: 0, evictions: 0 },
  redis: { hits: 0, misses: 0, errors: 0 },
  total: { hits: 0, misses: 0 },
};

/**
 * Configure the fetch function for cache misses and refreshes
 */
export function configureAdvancedCache(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("fetch function must be a function");
  }
  fetchFunction = fn;
}

/**
 * Record an access to promote frequently-accessed keys to L1
 */
function recordAccess(key) {
  accessCount.set(key, (accessCount.get(key) || 0) + 1);
  lastAccess.set(key, Date.now());
}

/**
 * Get top N most frequently accessed keys
 */
function getHotKeys(n = L1_SIZE) {
  const entries = Array.from(accessCount.entries());
  entries.sort((a, b) => b[1] - a[1]); // Sort by access count descending
  return entries.slice(0, n).map(([key]) => key);
}

/**
 * Multi-layer cache get with automatic promotion/demotion
 */
export async function getCached(key, ttl = 300000) {
  recordAccess(key);

  // L1: Hot cache check
  if (l1Cache.has(key)) {
    const entry = l1Cache.get(key);
    if (!entry.isExpired()) {
      entry.hits++;
      metrics.l1.hits++;
      metrics.total.hits++;
      
      // Proactive refresh if stale
      if (entry.isStale(10000) && !refreshInFlight.has(key)) {
        refreshKey(key, ttl).catch(() => {});
      }
      
      return entry.value;
    }
    l1Cache.delete(key);
  }

  // L2: Warm cache check
  const l2Entry = l2Cache.get(key);
  if (l2Entry && !l2Entry.isExpired()) {
    l2Entry.hits++;
    metrics.l2.hits++;
    metrics.total.hits++;
    
    // Proactive refresh if stale
    if (l2Entry.isStale(30000) && !refreshInFlight.has(key)) {
      refreshKey(key, ttl).catch(() => {});
    }
    
    return l2Entry.value;
  }

  // L3: Redis check (if available)
  const redisClient = getRedisClient();
  if (redisClient?.available) {
    try {
      const value = await redisClient.get(namespacedKey("cache", key));
      if (value !== undefined) {
        metrics.redis.hits++;
        metrics.total.hits++;
        
        // Promote to L2
        l2Cache.set(key, new CacheEntry(value, ttl));
        
        return value;
      }
    } catch (error) {
      metrics.redis.errors++;
      logger.warn("Redis cache read error", { key, error: error.message });
    }
  }

  // Cache miss - fetch from source
  metrics.total.misses++;
  metrics.l2.misses++;
  
  if (!fetchFunction) {
    logger.warn("Cache miss but no fetch function configured", { key });
    return undefined;
  }

  return await fetchAndCache(key, ttl);
}

/**
 * Fetch from source and populate all cache layers
 */
async function fetchAndCache(key, ttl) {
  // Prevent duplicate fetches
  if (refreshInFlight.has(key)) {
    return refreshInFlight.get(key);
  }

  const fetchPromise = (async () => {
    try {
      const value = await fetchFunction(key);
      const entry = new CacheEntry(value, ttl);
      
      // Store in L2
      l2Cache.set(key, entry);
      
      // Store in Redis
      const redisClient = getRedisClient();
      if (redisClient?.available) {
        await redisClient.set(namespacedKey("cache", key), value, ttl).catch(() => {});
      }
      
      logger.debug("Cache populated from source", { key });
      return value;
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, fetchPromise);
  return fetchPromise;
}

/**
 * Background refresh a key
 */
async function refreshKey(key, ttl) {
  if (refreshInFlight.has(key)) {
    return refreshInFlight.get(key);
  }

  const refreshPromise = (async () => {
    try {
      const value = await fetchFunction(key);
      const entry = new CacheEntry(value, ttl);
      
      // Update in all layers where it exists
      if (l1Cache.has(key)) {
        l1Cache.set(key, entry);
        metrics.l1.refreshes++;
      }
      if (l2Cache.has(key)) {
        l2Cache.set(key, entry);
      }
      
      // Update Redis
      const redisClient = getRedisClient();
      if (redisClient?.available) {
        await redisClient.set(namespacedKey("cache", key), value, ttl).catch(() => {});
      }
      
      logger.debug("Cache key refreshed", { key });
    } catch (error) {
      logger.warn("Cache refresh failed", { key, error: error.message });
    } finally {
      refreshInFlight.delete(key);
    }
  })();

  refreshInFlight.set(key, refreshPromise);
  return refreshPromise;
}

/**
 * Set a value in all cache layers
 */
export async function setCached(key, value, ttl = 300000) {
  const entry = new CacheEntry(value, ttl);
  
  // Store in L2
  l2Cache.set(key, entry);
  
  // Store in Redis
  const redisClient = getRedisClient();
  if (redisClient?.available) {
    await redisClient.set(namespacedKey("cache", key), value, ttl).catch(() => {});
  }
  
  recordAccess(key);
}

/**
 * Invalidate a key from all cache layers
 */
export async function invalidateCached(key, { prefix = false } = {}) {
  if (prefix) {
    // Invalidate by prefix
    const l1Keys = Array.from(l1Cache.keys()).filter(k => k.startsWith(key));
    const l2Keys = l2Cache.keys().filter(k => k.startsWith(key));
    
    l1Keys.forEach(k => l1Cache.delete(k));
    l2Keys.forEach(k => l2Cache.delete(k));
    
    const redisClient = getRedisClient();
    if (redisClient?.available) {
      await redisClient.deleteByPrefix(namespacedKey("cache", key)).catch(() => {});
    }
    
    logger.info("Cache prefix invalidated", { prefix: key, count: l1Keys.length + l2Keys.length });
  } else {
    // Invalidate specific key
    l1Cache.delete(key);
    l2Cache.delete(key);
    accessCount.delete(key);
    lastAccess.delete(key);
    
    const redisClient = getRedisClient();
    if (redisClient?.available) {
      await redisClient.delete(namespacedKey("cache", key)).catch(() => {});
    }
    
    logger.debug("Cache key invalidated", { key });
  }
}

/**
 * Start L1 cache warming scheduler
 * Promotes hot keys to L1 and proactively refreshes them
 */
export function startL1WarmingScheduler() {
  const interval = setInterval(async () => {
    const hotKeys = getHotKeys(L1_SIZE);
    
    // Refresh hot keys that are in L1
    for (const key of hotKeys) {
      if (l1Cache.has(key)) {
        const entry = l1Cache.get(key);
        if (entry.isStale(L1_REFRESH_INTERVAL_MS / 2)) {
          refreshKey(key, 300000).catch(() => {});
        }
      } else {
        // Promote to L1 if in L2
        const l2Entry = l2Cache.get(key);
        if (l2Entry && !l2Entry.isExpired()) {
          l1Cache.set(key, l2Entry);
          logger.debug("Key promoted to L1", { key });
        }
      }
    }
    
    // Remove cold keys from L1
    const currentL1Keys = Array.from(l1Cache.keys());
    for (const key of currentL1Keys) {
      if (!hotKeys.includes(key)) {
        const entry = l1Cache.get(key);
        l2Cache.set(key, entry);
        l1Cache.delete(key);
        logger.debug("Key demoted from L1 to L2", { key });
      }
    }
  }, L1_REFRESH_INTERVAL_MS);

  interval.unref?.();
  logger.info("L1 cache warming scheduler started", { 
    interval: L1_REFRESH_INTERVAL_MS,
    size: L1_SIZE 
  });
  
  return interval;
}

/**
 * Start L2 cache warming scheduler
 * Proactively refreshes L2 cache entries before expiry
 */
export function startL2WarmingScheduler() {
  const interval = setInterval(async () => {
    const keys = l2Cache.keys();
    
    for (const key of keys) {
      const entry = l2Cache.get(key);
      if (entry && entry.isStale(L2_REFRESH_INTERVAL_MS / 3)) {
        refreshKey(key, 300000).catch(() => {});
      }
    }
  }, L2_REFRESH_INTERVAL_MS);

  interval.unref?.();
  logger.info("L2 cache warming scheduler started", { 
    interval: L2_REFRESH_INTERVAL_MS,
    size: L2_SIZE 
  });
  
  return interval;
}

/**
 * Get cache metrics for monitoring
 */
export function getAdvancedCacheMetrics() {
  return {
    l1: {
      ...metrics.l1,
      size: l1Cache.size,
      keys: Array.from(l1Cache.keys()),
    },
    l2: {
      ...metrics.l2,
      size: l2Cache.size,
      maxSize: L2_SIZE,
    },
    redis: metrics.redis,
    total: metrics.total,
    accessCount: {
      tracked: accessCount.size,
      topKeys: getHotKeys(5),
    },
  };
}

/**
 * Clear all cache layers (for testing)
 */
export function clearAdvancedCache() {
  l1Cache.clear();
  l2Cache.clear();
  accessCount.clear();
  lastAccess.clear();
  refreshInFlight.clear();
  
  Object.keys(metrics).forEach(layer => {
    if (typeof metrics[layer] === 'object') {
      Object.keys(metrics[layer]).forEach(key => {
        metrics[layer][key] = 0;
      });
    }
  });
}
