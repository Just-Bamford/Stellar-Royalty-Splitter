/**
 * Idempotency middleware for preventing duplicate transaction submissions.
 *
 * Uses an in-memory cache with TTL to deduplicate requests based on a
 * composite key derived from the request content and user. The client-
 * supplied Idempotency-Key header is still required to opt into caching,
 * but the actual cache key is content-derived to prevent collisions.
 *
 * Cache key format:
 *   {walletAddress}:{sha256}
 *
 * Components:
 *   - walletAddress:  Per-user scope extracted from req.body.walletAddress.
 *                      Falls back to "unknown" when not present.
 *   - sha256:         SHA-256 hex digest of the full request body serialized
 *                      with stable (sorted-key) JSON. This provides content-
 *                      based deduplication — two requests with different bodies
 *                      produce different hashes even when contractId alone matches.
 *
 * Hashing: SHA-256 via Node.js crypto module.
 * Ordering: Object keys are sorted lexicographically before serialization
 *           to ensure the same logical object always produces the same hash.
 *
 * Configuration:
 * - IDEMPOTENCY_CACHE_TTL_MS: How long to cache responses (default: 24 hours)
 * - IDEMPOTENCY_MAX_ENTRIES: Max cache entries before eviction (default: 10000)
 */

import crypto from "crypto";
import logger from "./logger.js";
import { sendError } from "./error-response.js";

/**
 * Stable JSON serialization with sorted keys for deterministic hashing.
 * Nested objects also have their keys sorted recursively.
 */
function stableStringify(obj) {
  if (typeof obj !== "object" || obj === null) {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}

/**
 * Build an idempotency cache key from the request.
 *
 * The key is derived from:
 *   1. walletAddress — per-user scope (req.body.walletAddress, falls back to "unknown")
 *   2. SHA-256 hex digest of stable (sorted-key) JSON of the full req.body
 *
 * The client-supplied Idempotency-Key header is NOT part of the cache key;
 * it only opts the request into caching. This prevents collisions between
 * different legitimate requests whose clients happen to derive their keys
 * from overlapping fields (e.g. just contractId + amount).
 */
export function buildIdempotencyKey(req) {
  const walletAddress = req.body?.walletAddress || "unknown";
  const bodyStr = stableStringify(req.body || {});
  const hash = crypto.createHash("sha256").update(bodyStr, "utf8").digest("hex");
  return `${walletAddress}:${hash}`;
}

// In-memory cache: Map<cacheKey, { response, expiresAt }>
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
cleanupInterval.unref?.();

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
 * Requires an Idempotency-Key header to opt into caching. The actual cache
 * key is a composite of the user's wallet address and a SHA-256 hash of the
 * full request body (stable JSON), preventing collisions between different
 * legitimate requests whose clients happen to use the same key.
 *
 * Returns cached response if found, otherwise intercepts the response
 * and caches it for future requests.
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
    return sendError(
      res,
      400,
      "invalid_idempotency_key",
      "Invalid Idempotency-Key format. Must be 1-255 alphanumeric characters, hyphens, or underscores."
    );
  }

  // Build composite cache key from request content + user account.
  // Two requests with the same Idempotency-Key header but different body
  // content or different users will NOT collide.
  const cacheKey = buildIdempotencyKey(req);

  // Check cache for existing response
  const cachedResponse = getCachedResponse(cacheKey);
  if (cachedResponse) {
    logger.info(`Returning cached response for idempotency key: ${idempotencyKey} (cacheKey: ${cacheKey})`);
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
      cacheResponse(cacheKey, {
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
