/**
 * Idempotency middleware for preventing duplicate transaction submissions.
 *
 * Uses an in-memory cache with TTL to deduplicate requests based on
 * Idempotency-Key header. When a duplicate key is detected within the
 * configured window, returns the cached response instead of processing
 * the request again.
 *
 * Configuration:
 * - IDEMPOTENCY_CACHE_TTL_MS: How long to cache responses (default: 24 hours)
 * - IDEMPOTENCY_MAX_ENTRIES: Max cache entries before eviction (default: 10000)
 */

import logger from "./logger.js";

// In-memory cache: Map<idempotencyKey, { response, expiresAt }>
const cache = new Map();

// Configuration
const CACHE_TTL_MS = parseInt(process.env.IDEMPOTENCY_CACHE_TTL_MS || "86400000", 10); // 24 hours
const MAX_ENTRIES = parseInt(process.env.IDEMPOTENCY_MAX_ENTRIES || "10000", 10);

/**
 * Cleanup expired entries periodically to prevent unbounded memory growth.
 * Runs every 5 minutes.
 */
function cleanupExpiredEntries() {
  const now = Date.now();
  let removed = 0;

  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt < now) {
      cache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    logger.debug(`Idempotency cache cleanup: removed ${removed} expired entries`);
  }
}

// Start cleanup interval
const cleanupInterval = setInterval(cleanupExpiredEntries, 5 * 60 * 1000);

// Cleanup on shutdown
process.on("exit", () => clearInterval(cleanupInterval));
process.on("SIGINT", () => {
  clearInterval(cleanupInterval);
  process.exit(0);
});

/**
 * Evict oldest entries when cache exceeds MAX_ENTRIES.
 * Uses FIFO eviction strategy.
 */
function evictOldestIfNeeded() {
  if (cache.size >= MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
    logger.debug(`Idempotency cache full: evicted oldest entry (${firstKey})`);
  }
}

/**
 * Get cached response for an idempotency key.
 * Returns null if not found or expired.
 */
export function getCachedResponse(idempotencyKey) {
  const entry = cache.get(idempotencyKey);

  if (!entry) {
    return null;
  }

  // Check expiration
  if (entry.expiresAt < Date.now()) {
    cache.delete(idempotencyKey);
    logger.debug(`Idempotency cache: expired entry removed (${idempotencyKey})`);
    return null;
  }

  logger.info(`Idempotency cache hit: ${idempotencyKey}`);
  return entry.response;
}

/**
 * Store response in cache with TTL.
 */
export function cacheResponse(idempotencyKey, response) {
  evictOldestIfNeeded();

  cache.set(idempotencyKey, {
    response,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  logger.debug(`Idempotency cache: stored response for ${idempotencyKey}`);
}

/**
 * Express middleware for idempotency support.
 *
 * Checks for Idempotency-Key header and returns cached response if found.
 * Otherwise, intercepts the response and caches it for future requests.
 *
 * Usage:
 *   router.post("/endpoint", idempotencyMiddleware, handler);
 */
export function idempotencyMiddleware(req, res, next) {
  const idempotencyKey = req.headers["idempotency-key"];

  // If no idempotency key provided, skip caching
  if (!idempotencyKey) {
    return next();
  }

  // Validate idempotency key format (alphanumeric, hyphens, underscores, 1-255 chars)
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(idempotencyKey)) {
    return res.status(400).json({
      error: "Invalid Idempotency-Key format. Must be 1-255 alphanumeric characters, hyphens, or underscores.",
    });
  }

  // Check cache for existing response
  const cachedResponse = getCachedResponse(idempotencyKey);
  if (cachedResponse) {
    logger.info(`Returning cached response for idempotency key: ${idempotencyKey}`);
    return res.status(cachedResponse.status).json(cachedResponse.body);
  }

  // Intercept response to cache it
  const originalJson = res.json.bind(res);
  const originalStatus = res.status.bind(res);

  let statusCode = 200;

  // Override status() to capture status code
  res.status = function (code) {
    statusCode = code;
    return originalStatus(code);
  };

  // Override json() to cache response
  res.json = function (body) {
    // Only cache successful responses (2xx status codes)
    if (statusCode >= 200 && statusCode < 300) {
      cacheResponse(idempotencyKey, {
        status: statusCode,
        body,
      });
    }

    return originalJson(body);
  };

  next();
}

/**
 * Get cache statistics for monitoring.
 */
export function getCacheStats() {
  const now = Date.now();
  let expired = 0;

  for (const entry of cache.values()) {
    if (entry.expiresAt < now) {
      expired++;
    }
  }

  return {
    size: cache.size,
    expired,
    active: cache.size - expired,
    maxEntries: MAX_ENTRIES,
    ttlMs: CACHE_TTL_MS,
  };
}

/**
 * Clear all cached entries (for testing).
 */
export function clearCache() {
  cache.clear();
  logger.debug("Idempotency cache cleared");
}

</content>
