/**
 * Redis-backed cache client (#926).
 *
 * Provides get/set/delete with TTL support, matching the shape of the
 * in-memory cache.js API so callers don't need to change much. Also
 * exposes a pub/sub helper so a distribution/admin action on one backend
 * instance can invalidate cached data on every other instance sharing the
 * same Redis deployment.
 *
 * This module never throws on connection failure — every public function
 * resolves to a safe fallback value (undefined/false/no-op) and logs a
 * warning instead, so cache.js can fall back to its in-memory Map without
 * an unhandled rejection or process crash.
 */

import Redis from "ioredis";
import logger from "./logger.js";

export const KEY_PREFIX = "srs:";

/** Resource-type TTLs in milliseconds, per #926. */
export const REDIS_TTL_MS = {
  contractState: 5 * 60 * 1000, // 5 minutes
  analytics: 60 * 60 * 1000, // 1 hour
  collaborator: 30 * 60 * 1000, // 30 minutes
  session: 24 * 60 * 60 * 1000, // 24 hours
};

const INVALIDATION_CHANNEL = "srs:invalidate";

/**
 * Build a namespaced cache key: srs:<resourceType>:<...parts>
 * e.g. namespacedKey("contract", contractId, "state") -> "srs:contract:C...:state"
 */
export function namespacedKey(resourceType, ...parts) {
  return [`${KEY_PREFIX}${resourceType}`, ...parts.map((p) => String(p))].join(":");
}

/**
 * Thin wrapper around an ioredis client exposing the subset of behavior
 * cache.js needs. Multiple instances can be created (e.g. one per process)
 * and, when pointed at the same Redis deployment, will see each other's
 * writes and invalidation events — this is what makes the cache usable
 * across horizontally-scaled backend instances.
 */
export class RedisCacheClient {
  /**
   * @param {object} [options]
   * @param {string} [options.url] - defaults to process.env.REDIS_URL
   * @param {boolean} [options.tls] - defaults to process.env.REDIS_TLS === "true"
   * @param {new (...args: any[]) => any} [options.RedisImpl] - injectable Redis
   *   constructor, primarily for tests (e.g. ioredis-mock).
   * @param {number} [options.connectTimeoutMs]
   * @param {number} [options.maxRetriesPerRequest]
   */
  constructor({
    url = process.env.REDIS_URL,
    tls = process.env.REDIS_TLS === "true",
    RedisImpl = Redis,
    connectTimeoutMs = 5000,
    maxRetriesPerRequest = 1,
  } = {}) {
    this.url = url ?? null;
    this.available = false;
    this.client = null;
    this.subscriber = null;
    this._invalidationHandlers = new Set();
    this._connectPromise = null;

    if (!this.url) {
      logger.info("Redis cache: REDIS_URL not set, Redis cache client disabled");
      return;
    }

    try {
      const redisOptions = {
        connectTimeout: connectTimeoutMs,
        maxRetriesPerRequest,
        lazyConnect: true,
        tls: tls ? {} : undefined,
        retryStrategy: () => null, // don't keep retrying forever; caller falls back
      };

      this.client = new RedisImpl(this.url, redisOptions);
      // An in-flight explicit connect() call is authoritative over any
      // "connect" event that fires while it is pending: some clients
      // (ioredis-mock in particular) emit their own internal "connect"
      // event from a background timer that is not ordered relative to the
      // rejection of an overridden connect() method, so the event can fire
      // either before or after connect()'s own catch block runs. Blocking
      // `available` writes from the event entirely while `_connecting` is
      // true, and letting connect()'s own resolution set `available` as the
      // sole authority for that call, removes the ordering dependency.
      // Once no explicit connect() is pending, later unsolicited "connect"
      // events (e.g. real ioredis reconnecting after a transient outage)
      // still flip `available` back to true as intended.
      this._connecting = false;

      this.client.on("error", (err) => {
        // ioredis emits "error" for every failed reconnect attempt; without
        // a listener this would crash the process (unhandled 'error' event).
        logger.warn("Redis cache client error", { error: err.message });
        if (!this._connecting) this.available = false;
      });
      this.client.on("connect", () => {
        if (this._connecting) return;
        this.available = true;
        logger.info("Redis cache client connected");
      });
      this.client.on("end", () => {
        this.available = false;
      });
    } catch (err) {
      logger.warn("Redis cache client failed to initialize", { error: err.message });
      this.client = null;
      this.available = false;
    }
  }

  /**
   * Attempt to connect (idempotent). Never throws or rejects — resolves to
   * true if connected/available, false otherwise. Safe to call repeatedly.
   */
  async connect() {
    if (!this.client) return false;
    if (this.available) return true;
    if (this._connectPromise) return this._connectPromise;

    this._connecting = true;

    this._connectPromise = (async () => {
      try {
        // ioredis-mock and ioredis both support .connect(); if already
        // connecting/connected ioredis resolves/no-ops rather than throwing.
        await this.client.connect();
        this.available = true;
        return true;
      } catch (err) {
        logger.warn("Redis cache: connection failed, falling back to in-memory cache", {
          error: err.message,
        });
        this.available = false;
        return false;
      } finally {
        this._connecting = false;
        this._connectPromise = null;
      }
    })();

    return this._connectPromise;
  }

  /**
   * Get a value by key. Returns undefined on miss, on error, or when Redis
   * is unavailable (never throws).
   */
  async get(key) {
    if (!this.client || !this.available) return undefined;
    try {
      const raw = await this.client.get(key);
      if (raw === null || raw === undefined) return undefined;
      return JSON.parse(raw);
    } catch (err) {
      logger.warn("Redis cache get failed", { key, error: err.message });
      return undefined;
    }
  }

  /**
   * Set a value with TTL in milliseconds. Returns true on success, false
   * otherwise (never throws).
   */
  async set(key, value, ttlMs) {
    if (!this.client || !this.available) return false;
    try {
      const serialized = JSON.stringify(value);
      if (ttlMs && ttlMs > 0) {
        await this.client.set(key, serialized, "PX", Math.floor(ttlMs));
      } else {
        await this.client.set(key, serialized);
      }
      return true;
    } catch (err) {
      logger.warn("Redis cache set failed", { key, error: err.message });
      return false;
    }
  }

  /**
   * Delete a key. Returns true if a key was removed, false otherwise.
   */
  async delete(key) {
    if (!this.client) return false;
    try {
      const removed = await this.client.del(key);
      return removed > 0;
    } catch (err) {
      logger.warn("Redis cache delete failed", { key, error: err.message });
      return false;
    }
  }

  /**
   * Delete every key matching a prefix (used for bulk invalidation, e.g.
   * all cache entries for a given contractId). Uses SCAN rather than KEYS
   * to avoid blocking Redis on large keyspaces.
   */
  async deleteByPrefix(prefix) {
    if (!this.client) return 0;
    let cursor = "0";
    let deleted = 0;
    try {
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          `${prefix}*`,
          "COUNT",
          100
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          deleted += await this.client.del(...keys);
        }
      } while (cursor !== "0");
    } catch (err) {
      logger.warn("Redis cache deleteByPrefix failed", { prefix, error: err.message });
    }
    return deleted;
  }

  /**
   * Publish an invalidation message so other instances subscribed to the
   * invalidation channel can evict their own local caches for the same key
   * or prefix. Never throws.
   *
   * @param {{ key?: string, prefix?: string, reason?: string }} message
   */
  async publishInvalidation(message) {
    if (!this.client) return false;
    try {
      await this.client.publish(INVALIDATION_CHANNEL, JSON.stringify(message));
      return true;
    } catch (err) {
      logger.warn("Redis cache invalidation publish failed", { error: err.message });
      return false;
    }
  }

  /**
   * Subscribe to invalidation messages published by any instance (including
   * this one). The handler receives the parsed message object.
   * Uses a dedicated connection, per ioredis pub/sub requirements (a
   * connection in subscriber mode cannot issue other commands).
   *
   * @param {(message: { key?: string, prefix?: string, reason?: string }) => void} handler
   */
  async subscribeToInvalidation(handler) {
    if (!this.client) return false;
    this._invalidationHandlers.add(handler);

    if (this.subscriber) return true;

    try {
      const RedisImpl = this.client.constructor;
      this.subscriber = this.url
        ? new RedisImpl(this.url, { lazyConnect: true, retryStrategy: () => null })
        : this.client.duplicate();

      this.subscriber.on("error", (err) => {
        logger.warn("Redis cache subscriber error", { error: err.message });
      });

      await this.subscriber.connect().catch(() => {});
      await this.subscriber.subscribe(INVALIDATION_CHANNEL);

      this.subscriber.on("message", (channel, rawMessage) => {
        if (channel !== INVALIDATION_CHANNEL) return;
        let parsed;
        try {
          parsed = JSON.parse(rawMessage);
        } catch {
          return;
        }
        for (const fn of this._invalidationHandlers) {
          try {
            fn(parsed);
          } catch (err) {
            logger.warn("Redis cache invalidation handler threw", { error: err.message });
          }
        }
      });

      return true;
    } catch (err) {
      logger.warn("Redis cache: failed to subscribe to invalidation channel", {
        error: err.message,
      });
      return false;
    }
  }

  /** Close all connections. Safe to call multiple times. */
  async close() {
    this._invalidationHandlers.clear();
    for (const conn of [this.client, this.subscriber]) {
      if (!conn) continue;
      try {
        await conn.quit();
      } catch {
        try {
          conn.disconnect();
        } catch {
          // ignore
        }
      }
    }
    this.available = false;
  }
}
