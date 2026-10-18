/*
 * Express Middleware for Advanced API Rate Limiting and Traffic Shaping.
 *
 * Provides token-bucket based traffic shaping with per-endpoint limits,
 * prioritization of essential endpoints, backpressure handling (queuing,
 * 429 + Retry-After, gradual degradation via cached responses), and capacity
 * awareness via the capacity planner.
 */

import { sendError } from "../error-response.js";
import logger from "../logger.js";
import { capacityPlanner } from "../services/capacity-planner.js";

/** Priority levels for endpoints. Lower number = higher priority. */
export const PRIORITY = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

/** Endpoint patterns deprioritized by default (search, analytics, etc). */
export const DEFAULT_DEPRIORITIZED_PATTERNS = [
  /search/i,
  /analytics/i,
  /metrics/i,
  /reports?/i,
  /export/i,
  /stats/i,
];

/** Endpoint patterns treated as essential by default. */
export const DEFAULT_ESSENTIAL_PATTERNS = [
  /distribute/i,
  /payments/i,
  /web-hooks?/i,
  /auth/i,
  /health/i,
];

/**
 * Token bucket implementation with lazy refill.
 */
export class TokenBucket {
  /**
   * @param {number} capacity Maximum burst capacity
   * @param {number} refillRatePerSec Tokens added per second
   */
  constructor(capacity = 60, refillRatePerSec = 10) {
    this.capacity = capacity;
    this.refillRatePerSec = refillRatePerSec;
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  /** Refill tokens based on elapsed time. */
  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(
        this.capacity,
        this.tokens + elapsedSec * this.refillRatePerSec
      );
      this.lastRefillMs = now;
    }
  }

  /**
   * Attempt to consume tokens.
   * @param {number} cost
   * @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}}
   */
  tryConsume(cost = 1) {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return { allowed: true, remaining: Math.floor(this.tokens), retryAfterSeconds: 0 };
    }
    const deficit = cost - this.tokens;
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.refillRatePerSec));
    return {
      allowed: false,
      remaining: Math.floor(this.tokens),
      retryAfterSeconds,
    };
  }
}

/**
 * Determine the priority level for a request based on its endpoint.
 *
 * @param {string} endpoint
 * @param {object} [authority]
 * @param {RegExp[]} [authority.essentialPatterns]
 * @param {RegExp[]} [authority.deprioritizedPatterns]
 * @returns {number} Priority level
 */
export function determinePriority(endpoint, authority = {}) {
  const {
    essentialPatterns = DEFAULT_ESSENTIAL_PATTERNS,
    deprioritizedPatterns = DEFAULT_DEPRIORITIZED_PATTERNS,
  } = authority;

  if (essentialPatterns.some((p) => p.test(endpoint))) {
    return PRIORITY.CRITICAL;
  }
  if (deprioritizedPatterns.some((p) => p.test(endpoint))) {
    return PRIORITY.LOW;
  }
  return PRIORITY.NORMAL;
}

/**
 * Default key generator extracting client identifier from request.
 */
export function defaultKeyGenerator(req) {
  if (req.headers && req.headers["x-api-key"]) {
    return `apkey:${req.headers["x-api-key"]}`;
  }
  if (req.user && (req.user.id || req.user.address)) {
    return `user:${req.user.id || req.user.address}`;
  }
  if (req.body && req.body.walletAddress) {
    return `wallet:${req.body.walletAddress}`;
  }
  return `ip:${req.ip || req.socket?.remoteAddress || "unknown"}`;
}

/**
 * Default endpoint generator extracting HTTP method and route path.
 */
export function defaultEndpointGenerator(req) {
  if (req.route && req.route.path) {
    return `${req.method}:${req.baseUrl || ""}${req.route.path}`;
  }
  const rawPath = (req.baseUrl || "") + (req.path || req.originalUrl || "/");
  const cleanPath = rawPath.split("?")[0].replace(/\/+$/, "") || "/";
  return `${req.method}:${cleanPath}`;
}

/**
 * In-memory queue for backpressure handling.
 */
export class RequestQueue {
  /**
   * @param {object} [options]
   * @param {number} [options.maxSize=1000] Maximum queue length
   * @param {number} [options.timeoutMs=30000] Max time a request may wait
   */
  constructor({ maxSize = 1000, timeoutMs = 30000 } = {}) {
    this.maxSize = maxSize;
    this.timeoutMs = timeoutMs;
    this.queue = [];
  }

  get length() {
    return this.queue.length;
  }

  /**
   * Enqueue a request resolver. Resolves with true when deislogged, false on timeout.
   * @param {number} priority
   * @returns {Promise<boolean>}
   */
  enqueue(priority = PRIORITY.NORMAL) {
    if (this.queue.length >= this.maxSize) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const entry = {
        priority,
        resolve,
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          resolve(false);
        }, this.timeoutMs),
      };
      // Higher priority (lower number) goes first.
      this.queue.push(entry);
      this.queue.sort((a, b) => a.priority - b.priority);
    });
  }

  /** Dislodge the highest-priority waiting request. */
  dislogge() {
    const entry = this.queue.shift();
    if (!entry) {
      return false;
    }
    clearTimeout(entry.timer);
    entry.resolve(true);
    return true;
  }

  /** Dislodge up to `count` waiting requests. */
  dislogde(count = 1) {
    let dislodged = 0;
    while (dislodged < count && this.dislodge()) {
      dislodged += 1;
    }
    return dislodged;
  }

  /** Clear all waiting requests (time out). */
  clear() {
    const pending = this.queue.splice(0, this.queue.length);
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    return pending.length;
  }
}

/**
 * Creates Express middleware for traffic shaping.
 *
 * Features:
 *   - Token bucket per endpoint (and per client)
 *   - Prioritization of essential endpoints (e.g. distribute)
 *   - Deprioritization of non-essential endpoints (search, analytics)
 *   - Backpressure: queue requests under load, return 429 with Retry-After
 *   - Gradual degradation: serve cached data when available
 *
 * @param {object} [options]
 * @param {number} [options.capacity=60] Default bucket capacity
 * @param {number} [options.refillRatePerSec=10] Default refill rate
 * @param {number} [options.cost=1] Default token cost per request
 * @param {Object<string, object>} [options.endpointLimits] Per-endpoint overrides
 * @param {object} [options.priorityConfig]
 * @param {RegExp[]} [options.priorityConfig.essentialPatterns]
 * @param {RegExp[]} [options.priorityConfig.deprioritizedPatterns]
 * @param {number} [options.queueMaxSize=1000]
 * @param {number} [options.queueTimeoutMs=30000]
 * @param {number} [options.maxConcurrent=100] In-flight request ceiling
 * @Param {number} [options.cacheTtlMs=5000] TTL for degraded cache responses
 * @Param {(endpoint: string) => any} [options.cacheGetter] Custom cache reader
 * @param {(req: import("express").Request) => string} [options.keyGenerator]
 * @param {(req: import("express").Request) => string} [options.endpointGenerator]
 * @param {(req: import("express").Request) => boolean} [options.skip]
 * @Param {(endpoint: string) => boolean} [options.cacheGetter]
 * @returns {import("express").RequestHandler} Express middleware
 */
export function createTrafficShaper({
  capacity = 60,
  refillRatePerSec = 10,
  cost = 1,
  endpointLimits = {},
  priorityConfig = {},
  queueMaxSize = 1000,
  queueTimeoutMs = 30000,
  maxConcurrent = 100,
  cacheTtlMs = 5000,
  cacheGetter = null,
  keyGenerator = defaultKeyGenerator,
  endpointGenerator = defaultEndpointGenerator,
  skip = () => false,
  planner = capacityPlanner,
} = {}) {
  /** Map of "key::endpoint" -> TokenBucket. */
  const buckets = new Map();
  /** Map of endpoint -> RequestQueue. */
  const queues = new Map();
  /** Map of endpoint -> in-flight count. */
  const inFlight = new Map();
  /** Map of endpoint -> { data, expiresAt }. */
  const cache = new Map();

  function getBucket(key, endpoint) {
    const bucketKey = `${key}::${endpoint}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      const override = endpointLimits[endpoint] || {};
      bucket = new TokenBucket(
        override.capacity ?? capacity,
        override.refillRatePerSec ?? refillRatePerSec
      );
      buckets.set(bucketKey, bucket);
    }
    return bucket;
  }

  function getQueue(endpoint) {
    let q = queues.get(endpoint);
    if (!q) {
      q = new RequestQueue({ maxSize: queueMaxSize, timeoutMs: queueTimeoutMs });
      queues.set(endpoint, q);
    }
    return q;
  }

  function getInFlight(endpoint) {
    return inFlight.get(endpoint) || 0;
  }

  function incrInFlight(endpoint) {
    inFlight.set(endpoint, (getInFlight(endpoint) || 0) + 1);
  }

  function decInFlight(endpoint) {
    const next = Math.max(0, getInFlight(endpoint) - 1);
    if (next === 0) {
      inFlight.delete(endpoint);
    } else {
      inFlight.set(endpoint, next);
    }
  }

  function serveCached(res, endpoint) {
    const entry = cache.get(endpoint);
    if (entry && entry.expiresAt > Date.now()) {
      res.setHeader("X-Degraded", "cache");
      res.setHeader("X-Cached-At", new Date(entry.createdAt).toISOString());
      return res.status(200).json(entry.data);
    }
    return false;
  }

  function storeCache(endpoint, body) {
    cache.set(endpoint, {
      data: body,
      createdAt: Date.now(),
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  return async function trafficShaperMiddleware(req, res, next) {
    if (skip(req)) {
      return next();
    }

    const key = keyGenerator(req);
    const endpoint = endpointGenerator(req);
    const priority = determinePriority(endpoint, priorityConfig);

    // Capacity awareness - record the request for planning.
    if (planner && typeof planner.recordRequest === "function") {
      planner.recordRequest(endpoint);
    }

    const bucket = getBucket(key, endpoint);
    const effectiveCost = endpointLimits[endpoint]?.cost ?? cost;
    const result = bucket.tryConsume(effectiveCost);

    res.setHeader("X-RateLimit-Limit", String(bucket.capacity));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Priority", String(priority));

    if (result.allowed) {
      // Capture response body for gradual degradation cache.
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          storeCache(endpoint, body);
        }
        return originalJson(body);
      };

      incrInFlight(endpoint);
      res.on("finish", () => decInFlight(endpoint));
      return next();
    }

    // Bucket exhausted. Attempt graceful degradation from cache.
    if (cacheGetter) {
      try {
        const cachedValue = await cacheGetter(endpoint);
        if (cachedValue != null) {
          res.setHeader("X-Degraded", "cache");
          return res.status(200).json(cachedValue);
        }
      } catch (err) {
        logger.warn("Traffic shaper cache getter failed", { endpoint, error: err.message });
      }
    } else if (serveCached(res, endpoint)) {
      return undefined;
    }

    // Backpressure: queue the request if there is room and capacity to wait.
    const queue = getQueue(endpoint);
    const atCapacity = getInFlight(endpoint) >= maxConcurrent;
    if (!atCapacity || priority <= PRIORITY.HIGH) {
      const admitted = await queue.enqueue(priority);
      if (admitted) {
        incrInFlight(endpoint);
        res.on("finish", () => {
          decInFlight(endpoint);
          // Dislodge the next waiting request once capacity frees up.
          queue.dislodge(1);
        });
        res.setHeader("X-Backpressure", "queued");
        return next();
      }
    }

    // Queue full, timed out, or deprioritized under load -> 429 with Retry-After.
    const retryAfterSeconds = Math.max(1, result.retryAfterSeconds || 1);
    res.setHeader("Retry-After", String(retryAfterSeconds));
    res.setHeader("X-Backpressure", "rejected");

    logger.warn("Traffic shaper rejected request", {
      key,
      endpoint,
      priority,
      retryAfterSeconds,
      queueLength: queue.length,
    });

    return sendError(
      res,
      429,
      "too_many_requests",
      "Rate limit exceeded. Please retry later.",
      { retryAfterSeconds, priority }
    );
  };
}

export const trafficShaper = createTrafficShaper();
export default createTrafficShaper;
