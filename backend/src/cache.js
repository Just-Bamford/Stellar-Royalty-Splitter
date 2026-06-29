/**
 * Cache Manager with TTL and selective invalidation (#399)
 * Wraps Redis with contract-state-aware invalidation.
 * Preserves 30s TTL for non-admin state.
 */
import Redis from "ioredis";
import logger from "./logger.js";

class InMemoryRedis {
  constructor() {
    this.store = new Map();
  }

  async get(key) {
    return this.store.get(key) ?? null;
  }

  async setex(key, _ttl, value) {
    this.store.set(key, value);
    return "OK";
  }

  async del(...keys) {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async flushdb() {
    this.store.clear();
    return "OK";
  }

  async ping() {
    return "PONG";
  }

  async quit() {
    return "OK";
  }
}

export class CacheManager {
  constructor(redisUrl, defaultTTL = 30) {
    const RedisClient = process.env.NODE_ENV === "test" ? InMemoryRedis : Redis;
    this.redis = new RedisClient(redisUrl);
    this.defaultTTL = defaultTTL; // seconds
  }

  static KEYS = {
    ADMIN: "contract:admin",
    COLLABORATORS: "contract:collaborators",
    SHARES: "contract:shares",
    HEALTH: "health:full",
    STATE_PREFIX: "contract:state:",
  };

  /**
   * Get a cached value. Returns null if expired or missing.
   */
  async get(key) {
    const value = await this.redis.get(key);
    return value ? JSON.parse(value) : null;
  }

  /**
   * Set a value with optional TTL (defaults to 30s).
   */
  async set(key, value, ttl = this.defaultTTL) {
    await this.redis.setex(key, ttl, JSON.stringify(value));
  }

  /**
   * Invalidate a specific cache key immediately.
   */
  async invalidate(key) {
    const deleted = await this.redis.del(key);
    if (deleted > 0) {
      logger.info("[Cache] Invalidated key", { key });
    }
    return deleted > 0;
  }

  /**
   * Invalidate only the admin key — preserves all other state cache.
   */
  async invalidateAdmin() {
    const result = await this.invalidate(CacheManager.KEYS.ADMIN);
    // Also invalidate health cache since it embeds admin info
    await this.invalidate(CacheManager.KEYS.HEALTH);
    logger.info("[Cache] Admin cache invalidated", { adminInvalidated: result });
    return result;
  }

  /**
   * Invalidate multiple keys at once.
   */
  async invalidateKeys(keys) {
    if (keys.length === 0) return 0;
    const deleted = await this.redis.del(...keys);
    logger.info("[Cache] Bulk invalidated keys", { keys, count: deleted });
    return deleted;
  }

  /**
   * Flush entire cache (use sparingly — tests only).
   */
  async flushAll() {
    await this.redis.flushdb();
    logger.info("[Cache] Full cache flushed");
  }

  /**
   * Health check: verify cached admin matches on-chain state.
   * Returns { consistent: boolean, cachedAdmin: string|null, liveAdmin: string, elapsedMs: number }
   */
  async verifyAdminConsistency(fetchLiveAdmin) {
    const start = Date.now();
    const cachedAdmin = await this.get(CacheManager.KEYS.ADMIN);
    const liveAdmin = await fetchLiveAdmin();

    const consistent = cachedAdmin === liveAdmin;

    if (!consistent && cachedAdmin !== null) {
      // Stale cache detected — refresh immediately
      await this.set(CacheManager.KEYS.ADMIN, liveAdmin);
      logger.warn("[Cache] Stale admin detected — cache refreshed", {
        cachedAdmin,
        liveAdmin,
      });
    }

    const elapsed = Date.now() - start;
    return { consistent, cachedAdmin, liveAdmin, elapsedMs: elapsed };
  }

  /**
   * Get Redis connection health.
   */
  async ping() {
    const result = await this.redis.ping();
    return result === "PONG";
  }

  async disconnect() {
    await this.redis.quit();
  }
}

// Singleton instance
let cacheManager = null;

export function getCacheManager() {
  if (!cacheManager) {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    cacheManager = new CacheManager(redisUrl);
  }
  return cacheManager;
}

export function setCacheManagerForTests(mock) {
  cacheManager = mock;
}
