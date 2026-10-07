/**
 * Distributed Rate Limiter Service with Token Bucket and Sliding Window (#978).
 *
 * Implements a production-grade distributed rate limiter backed by Redis.
 * Shared across multiple backend instances via atomic Lua scripts to prevent
 * race conditions during concurrent request checks.
 *
 * Algorithms Provided:
 *  1. Token Bucket (Default):
 *     Allows short bursts up to `capacity` above the steady `refillRatePerSec`.
 *     Tokens refill continuously over time. Best for smoothing traffic while
 *     permitting brief bursts.
 *  2. Sliding Window Log (Alternative):
 *     Strictly guarantees that no more than `limit` requests occur within any
 *     rolling window of `windowMs`. Best when strict hard caps are required.
 *
 * Features:
 *  - Atomic execution in Redis using EVAL Lua scripts (no race conditions between instances).
 *  - Adaptive Rate Limiting: Automatically scales down effective capacity when error rates spike.
 *  - Fault Tolerance: Configurable fail-open (default) vs fail-closed policies on Redis outage.
 *  - Configuration validation & comprehensive error handling.
 */

import Redis from "ioredis";
import logger from "../logger.js";

export const KEY_PREFIX = "srs:ratelimit:";

// ---------------------------------------------------------------------------
// Atomic Lua Scripts
// ---------------------------------------------------------------------------

/**
 * Token Bucket Lua Script
 * KEYS[1]: Token bucket hash key
 * ARGV[1]: Max capacity (burst allowance)
 * ARGV[2]: Refill rate per millisecond
 * ARGV[3]: Tokens requested (cost)
 * ARGV[4]: Current timestamp (ms)
 * ARGV[5]: TTL in seconds
 *
 * Returns: [ allowed (0|1), remaining_tokens, retry_after_ms, max_capacity ]
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local data = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil or lastRefill == nil then
  tokens = capacity
  lastRefill = now
else
  local elapsed = math.max(0, now - lastRefill)
  tokens = math.min(capacity, tokens + (elapsed * refillRate))
  lastRefill = now
end

local allowed = 0
local remaining = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
  remaining = math.floor(tokens)
else
  allowed = 0
  remaining = 0
  local needed = cost - tokens
  if refillRate > 0 then
    retryAfterMs = math.ceil(needed / refillRate)
  else
    retryAfterMs = 1000
  end
end

redis.call("HMSET", key, "tokens", tokens, "lastRefill", lastRefill)
redis.call("EXPIRE", key, ttl)

return { allowed, remaining, retryAfterMs, capacity }
`;

/**
 * Sliding Window Lua Script
 * KEYS[1]: Sliding window sorted set key
 * ARGV[1]: Window duration in milliseconds
 * ARGV[2]: Max requests allowed in window
 * ARGV[3]: Current timestamp (ms)
 * ARGV[4]: Unique request identifier
 *
 * Returns: [ allowed (0|1), remaining_slots, retry_after_ms, limit ]
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
local clearBefore = now - windowMs

-- Prune timestamps outside current sliding window
redis.call("ZREMRANGEBYSCORE", key, "-inf", clearBefore)

local currentCount = redis.call("ZCARD", key)
local allowed = 0
local remaining = 0
local retryAfterMs = 0

if currentCount < limit then
  redis.call("ZADD", key, now, member)
  allowed = 1
  remaining = limit - (currentCount + 1)
else
  allowed = 0
  remaining = 0
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  if #oldest >= 2 then
    local oldestTime = tonumber(oldest[2])
    retryAfterMs = math.max(0, (oldestTime + windowMs) - now)
  else
    retryAfterMs = windowMs
  end
end

local ttlSeconds = math.ceil((windowMs * 2) / 1000)
redis.call("EXPIRE", key, ttlSeconds)

return { allowed, remaining, retryAfterMs, limit }
`;

/**
 * Metric Recording Lua Script for Adaptive Limiting
 * KEYS[1]: Error counter hash key
 * ARGV[1]: Is error (1 or 0)
 * ARGV[2]: Window duration in seconds
 */
const RECORD_METRIC_LUA = `
local key = KEYS[1]
local isError = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

redis.call("HINCRBY", key, "total", 1)
if isError == 1 then
  redis.call("HINCRBY", key, "errors", 1)
end
redis.call("EXPIRE", key, ttl)

local total = tonumber(redis.call("HGET", key, "total") or 0)
local errors = tonumber(redis.call("HGET", key, "errors") or 0)

return { total, errors }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a standardized Redis key for a rate-limiter bucket.
 * @param {string} type - 'tb' (token bucket), 'sw' (sliding window), 'err' (error metrics)
 * @param {string} userKey - User/client identifier (e.g. wallet, API key, IP)
 * @param {string} endpoint - Endpoint or route identifier
 * @returns {string} Namespaced Redis key
 */
export function buildRateLimitKey(type, userKey, endpoint) {
  if (!userKey || typeof userKey !== "string") {
    throw new TypeError("userKey must be a non-empty string");
  }
  if (!endpoint || typeof endpoint !== "string") {
    throw new TypeError("endpoint must be a non-empty string");
  }
  const cleanUser = userKey.trim().replace(/[:\s]+/g, "_");
  const cleanEndpoint = endpoint.trim().replace(/[:\s]+/g, "_");
  return `${KEY_PREFIX}${type}:${cleanUser}:${cleanEndpoint}`;
}

// ---------------------------------------------------------------------------
// DistributedRateLimiter Class
// ---------------------------------------------------------------------------

/**
 * Production-ready Distributed Rate Limiter service backed by Redis.
 */
export class DistributedRateLimiter {
  /**
   * @param {object} [options]
   * @param {string} [options.url] - Redis connection URL (defaults to process.env.REDIS_URL)
   * @param {object} [options.redisClient] - Pre-existing Redis client instance
   * @param {new (...args: any[]) => any} [options.RedisImpl] - Redis constructor (e.g. ioredis-mock)
   * @param {number} [options.defaultCapacity=60] - Default max token capacity (burst limit)
   * @param {number} [options.defaultRefillRate=10] - Default refill rate in tokens per second
   * @param {boolean} [options.failOpen=true] - If true, permits traffic on Redis outage (availability-first)
   * @param {boolean} [options.adaptiveEnabled=true] - Automatically reduce capacity during error spikes
   * @param {number} [options.errorThreshold=0.5] - Error ratio threshold (0.0 - 1.0) triggering adaptive reduction
   * @param {number} [options.minRequestsForAdaptive=5] - Min requests required before adaptive penalty activates
   * @param {number} [options.adaptivePenaltyMultiplier=0.5] - Capacity multiplier applied during error spikes
   */
  constructor({
    url = process.env.REDIS_URL,
    redisClient = null,
    RedisImpl = Redis,
    defaultCapacity = 60,
    defaultRefillRate = 10,
    failOpen = true,
    adaptiveEnabled = true,
    errorThreshold = 0.5,
    minRequestsForAdaptive = 5,
    adaptivePenaltyMultiplier = 0.5,
  } = {}) {
    this.url = url || null;
    this.failOpen = Boolean(failOpen);
    this.defaultCapacity = Math.max(1, Number(defaultCapacity) || 60);
    this.defaultRefillRate = Math.max(0.1, Number(defaultRefillRate) || 10);
    this.adaptiveEnabled = Boolean(adaptiveEnabled);
    this.errorThreshold = Math.min(1, Math.max(0, Number(errorThreshold) || 0.5));
    this.minRequestsForAdaptive = Math.max(1, Number(minRequestsForAdaptive) || 5);
    this.adaptivePenaltyMultiplier = Math.min(1, Math.max(0.1, Number(adaptivePenaltyMultiplier) || 0.5));

    this.client = redisClient;

    if (!this.client && this.url) {
      try {
        this.client = new RedisImpl(this.url, {
          lazyConnect: true,
          connectTimeout: 3000,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        });
        this.client.on("error", (err) => {
          logger.warn("DistributedRateLimiter Redis client error:", { error: err.message });
        });
      } catch (err) {
        logger.error("DistributedRateLimiter failed to initialize Redis client:", err);
      }
    }
  }

  /**
   * Helper to execute a Lua script safely against Redis with fallback handling.
   * @private
   */
  async _evalScript(script, numKeys, keys, args) {
    if (!this.client) {
      throw new Error("Redis client not connected or available");
    }
    if (typeof this.client.eval === "function") {
      return await this.client.eval(script, numKeys, ...keys, ...args);
    }
    throw new Error("Redis client does not support eval");
  }

  /**
   * Calculates the adaptive error multiplier for a given user and endpoint.
   * If recent error rate exceeds `errorThreshold`, capacity is reduced.
   * @param {string} userKey
   * @param {string} endpoint
   * @returns {Promise<number>} Multiplier between 0.1 and 1.0
   */
  async getAdaptiveMultiplier(userKey, endpoint) {
    if (!this.adaptiveEnabled || !this.client || typeof this.client.hmget !== "function") {
      return 1.0;
    }

    try {
      const errKey = buildRateLimitKey("err", userKey, endpoint);
      const data = await this.client.hmget(errKey, "total", "errors");
      const total = parseInt(data[0] || "0", 10);
      const errors = parseInt(data[1] || "0", 10);

      if (total >= this.minRequestsForAdaptive && total > 0) {
        const errorRatio = errors / total;
        if (errorRatio >= this.errorThreshold) {
          logger.warn(
            `Adaptive rate limiting triggered for ${userKey}:${endpoint} (error ratio: ${(errorRatio * 100).toFixed(1)}%)`
          );
          return this.adaptivePenaltyMultiplier;
        }
      }
    } catch (err) {
      logger.warn("Failed checking adaptive rate limit metrics:", { error: err.message });
    }

    return 1.0;
  }

  /**
   * Records request outcome (success or error) for adaptive rate limiting.
   * @param {string} userKey - User/client identifier
   * @param {string} endpoint - Endpoint identifier
   * @param {boolean} isError - True if response was a 5xx or server error
   * @param {number} [windowSeconds=60] - Sliding metric window
   */
  async recordResult(userKey, endpoint, isError, windowSeconds = 60) {
    if (!this.adaptiveEnabled || !this.client) return;

    try {
      const errKey = buildRateLimitKey("err", userKey, endpoint);
      await this._evalScript(
        RECORD_METRIC_LUA,
        1,
        [errKey],
        [isError ? 1 : 0, windowSeconds]
      );
    } catch (err) {
      logger.warn("Failed recording adaptive rate limit result:", { error: err.message });
    }
  }

  /**
   * Check and consume tokens from the distributed token bucket.
   *
   * @param {string} userKey - User identifier
   * @param {string} endpoint - Endpoint identifier
   * @param {object} [options]
   * @param {number} [options.capacity] - Max bucket capacity (burst allowance)
   * @param {number} [options.refillRatePerSec] - Token refill rate per second
   * @param {number} [options.cost=1] - Number of tokens to consume
   * @returns {Promise<{
   *   allowed: boolean,
   *   remaining: number,
   *   limit: number,
   *   retryAfterSeconds: number,
   *   resetTimeMs: number,
   *   adaptiveApplied: boolean,
   *   fallback?: boolean
   * }>}
   */
  async consumeTokenBucket(
    userKey,
    endpoint,
    { capacity = this.defaultCapacity, refillRatePerSec = this.defaultRefillRate, cost = 1 } = {}
  ) {
    const key = buildRateLimitKey("tb", userKey, endpoint);
    const parsedCost = Math.max(1, Number(cost) || 1);
    let baseCapacity = Math.max(1, Number(capacity) || this.defaultCapacity);
    let baseRefillRate = Math.max(0.001, Number(refillRatePerSec) || this.defaultRefillRate);

    // Apply adaptive rate limiting if triggered
    const multiplier = await this.getAdaptiveMultiplier(userKey, endpoint);
    const adaptiveApplied = multiplier < 1.0;
    if (adaptiveApplied) {
      baseCapacity = Math.max(1, Math.floor(baseCapacity * multiplier));
      baseRefillRate = Math.max(0.001, baseRefillRate * multiplier);
    }

    const refillRatePerMs = baseRefillRate / 1000.0;
    const now = Date.now();
    const ttlSeconds = Math.max(60, Math.ceil((baseCapacity / baseRefillRate) * 2));

    try {
      const result = await this._evalScript(
        TOKEN_BUCKET_LUA,
        1,
        [key],
        [baseCapacity, refillRatePerMs, parsedCost, now, ttlSeconds]
      );

      const [allowed, remaining, retryAfterMs, effectiveLimit] = result;
      const retryAfterSeconds = Math.ceil(Number(retryAfterMs) / 1000);

      return {
        allowed: Boolean(allowed === 1),
        remaining: Math.max(0, Number(remaining)),
        limit: Number(effectiveLimit),
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, retryAfterSeconds),
        resetTimeMs: now + Number(retryAfterMs),
        adaptiveApplied,
      };
    } catch (err) {
      logger.error("Distributed rate limiter Redis error:", { error: err.message, userKey, endpoint });

      // Rationale for fail-open: Availability priority for high-traffic financial services.
      if (this.failOpen) {
        logger.warn("Distributed rate limiter failing open (allowing request)");
        return {
          allowed: true,
          remaining: 1,
          limit: baseCapacity,
          retryAfterSeconds: 0,
          resetTimeMs: now,
          adaptiveApplied: false,
          fallback: true,
        };
      }

      // Rationale for fail-closed: Strict security for sensitive endpoints when configured.
      logger.warn("Distributed rate limiter failing closed (blocking request)");
      return {
        allowed: false,
        remaining: 0,
        limit: baseCapacity,
        retryAfterSeconds: 5,
        resetTimeMs: now + 5000,
        adaptiveApplied: false,
        fallback: true,
      };
    }
  }

  /**
   * Check requests using the Sliding Window Log algorithm.
   *
   * @param {string} userKey - User identifier
   * @param {string} endpoint - Endpoint identifier
   * @param {object} [options]
   * @param {number} [options.limit=100] - Max allowed requests per window
   * @param {number} [options.windowMs=60000] - Duration of sliding window in ms
   * @returns {Promise<{
   *   allowed: boolean,
   *   remaining: number,
   *   limit: number,
   *   retryAfterSeconds: number,
   *   resetTimeMs: number,
   *   algorithm: string,
   *   fallback?: boolean
   * }>}
   */
  async consumeSlidingWindow(
    userKey,
    endpoint,
    { limit = 100, windowMs = 60000 } = {}
  ) {
    const key = buildRateLimitKey("sw", userKey, endpoint);
    let effectiveLimit = Math.max(1, Number(limit) || 100);
    const parsedWindowMs = Math.max(100, Number(windowMs) || 60000);

    const multiplier = await this.getAdaptiveMultiplier(userKey, endpoint);
    if (multiplier < 1.0) {
      effectiveLimit = Math.max(1, Math.floor(effectiveLimit * multiplier));
    }

    const now = Date.now();
    const uniqueId = `${now}-${Math.random().toString(36).substring(2, 8)}`;

    try {
      const result = await this._evalScript(
        SLIDING_WINDOW_LUA,
        1,
        [key],
        [parsedWindowMs, effectiveLimit, now, uniqueId]
      );

      const [allowed, remaining, retryAfterMs, configuredLimit] = result;
      const retryAfterSeconds = Math.ceil(Number(retryAfterMs) / 1000);

      return {
        allowed: Boolean(allowed === 1),
        remaining: Math.max(0, Number(remaining)),
        limit: Number(configuredLimit),
        retryAfterSeconds: allowed === 1 ? 0 : Math.max(1, retryAfterSeconds),
        resetTimeMs: now + Number(retryAfterMs),
        algorithm: "sliding-window",
      };
    } catch (err) {
      logger.error("Sliding window rate limiter Redis error:", { error: err.message, userKey, endpoint });

      if (this.failOpen) {
        return {
          allowed: true,
          remaining: 1,
          limit: effectiveLimit,
          retryAfterSeconds: 0,
          resetTimeMs: now,
          fallback: true,
        };
      }

      return {
        allowed: false,
        remaining: 0,
        limit: effectiveLimit,
        retryAfterSeconds: Math.ceil(parsedWindowMs / 1000),
        resetTimeMs: now + parsedWindowMs,
        fallback: true,
      };
    }
  }

  /**
   * Reset/clear bucket state for a given user and endpoint.
   * @param {string} userKey
   * @param {string} endpoint
   */
  async reset(userKey, endpoint) {
    if (!this.client) return;
    try {
      const tbKey = buildRateLimitKey("tb", userKey, endpoint);
      const swKey = buildRateLimitKey("sw", userKey, endpoint);
      const errKey = buildRateLimitKey("err", userKey, endpoint);
      await this.client.del(tbKey, swKey, errKey);
    } catch (err) {
      logger.warn("Failed resetting rate limiter keys:", { error: err.message });
    }
  }
}

export const distributedRateLimiter = new DistributedRateLimiter();
