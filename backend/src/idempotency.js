/**
 * Idempotency middleware for preventing duplicate transaction submissions.
 *
 * Persistent idempotency responses and short-lived in-flight deduplication are
 * deliberately kept as two separate concerns:
 *
 *   - `cache` stores successful responses for the configured idempotency TTL.
 *   - `inFlightRequests` only coordinates requests that are currently running.
 *
 * The in-flight map is process-local. It prevents duplicate work within one
 * Node.js process; a shared store is required if this service is deployed
 * across multiple processes or instances.
 *
 * Configuration:
 * - IDEMPOTENCY_CACHE_TTL_MS: How long to cache responses (default: 24 hours)
 * - IDEMPOTENCY_MAX_ENTRIES: Max cache entries before eviction (default: 10000)
 * - IDEMPOTENCY_DEDUP_WINDOW_MS: How long an in-flight request may be shared
 *   (default: 10 seconds)
 */

import crypto from "crypto";
import logger from "./logger.js";
import { sendError } from "./error-response.js";

// In-memory cache: Map<idempotencyKey, { response, expiresAt }>
const cache = new Map();

// In-memory, process-local map used only while an operation is executing.
// Map<hash(operation + idempotencyKey), InFlightEntry>
const inFlightRequests = new Map();

// Configuration
const CACHE_TTL_MS = parsePositiveInteger(process.env.IDEMPOTENCY_CACHE_TTL_MS, 86400000); // 24 hours
const MAX_ENTRIES = parsePositiveInteger(process.env.IDEMPOTENCY_MAX_ENTRIES, 10000);
const DEDUP_WINDOW_MS = parsePositiveInteger(process.env.IDEMPOTENCY_DEDUP_WINDOW_MS, 10000);

/** Simple counters for deduplication observability. */
export const dedupMetrics = {
  hits: 0,
  misses: 0,
};

// Marks requests that already passed through the standalone deduplication
// middleware. This lets the persistent middleware be composed after it without
// registering the same request in the in-flight map a second time.
const DEDUPLICATION_HANDLED = Symbol("idempotencyDeduplicationHandled");

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
 * Build the deterministic key used for in-flight deduplication.
 *
 * Only the operation name and the caller's idempotency key participate in the
 * key. Hashing keeps request headers and operation names out of map keys and
 * provides a fixed-size key for bounded memory use.
 */
export function createDeduplicationKey(operation, idempotencyKey) {
  const raw = JSON.stringify({
    operation: String(operation ?? "unknown"),
    idempotencyKey: String(idempotencyKey),
  });
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Useful aliases for callers that prefer a shorter name.
export const getDeduplicationKey = createDeduplicationKey;
export const getDedupKey = createDeduplicationKey;

function getIdempotencyKey(req) {
  const headers = req?.headers ?? {};
  const value = headers["idempotency-key"] ?? headers["Idempotency-Key"];
  return Array.isArray(value) ? value[0] : value;
}

function getOperationName(req, operation) {
  if (operation) return String(operation);
  if (req?.idempotencyOperation) return String(req.idempotencyOperation);
  if (req?.operation) return String(req.operation);
  if (req?.body?.operation) return String(req.body.operation);
  if (req?.route?.path) {
    return `${req.method ?? "UNKNOWN"}:${req.baseUrl ?? ""}${req.route.path}`;
  }
  return `${req?.method ?? "UNKNOWN"}:${req?.originalUrl ?? req?.path ?? "unknown"}`;
}

function isValidIdempotencyKey(idempotencyKey) {
  return typeof idempotencyKey === "string" && /^[a-zA-Z0-9_-]{1,255}$/.test(idempotencyKey);
}

function getResponseStatus(res, statusCode) {
  if (Number.isInteger(statusCode)) return statusCode;
  if (Number.isInteger(res?.statusCode)) return res.statusCode;
  if (Number.isInteger(res?._status)) return res._status;
  return 200;
}

function removeInFlightEntry(key, entry) {
  if (inFlightRequests.get(key) === entry) {
    inFlightRequests.delete(key);
  }
}

function settleInFlightEntry(key, entry, response, error) {
  if (entry.settled) return;

  entry.settled = true;
  clearTimeout(entry.timeout);
  removeInFlightEntry(key, entry);

  if (error) {
    entry.reject(error);
  } else {
    entry.resolve(response);
  }
}

function createInFlightEntry(key) {
  let resolve;
  let reject;

  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  // A request may be the only request for a key. Attach a rejection handler so
  // a timeout cannot become an unhandled rejection before another caller joins.
  promise.catch(() => {});

  const entry = {
    promise,
    resolve,
    reject,
    settled: false,
    timeout: null,
  };

  entry.timeout = setTimeout(() => {
    // The identity check prevents an old timer from deleting a newer request
    // that reused the same key after the old entry expired.
    removeInFlightEntry(key, entry);
    if (!entry.settled) {
      const timeoutError = new Error("In-flight idempotency request timed out");
      timeoutError.status = 503;
      timeoutError.code = "idempotency_dedup_timeout";
      settleInFlightEntry(key, entry, null, timeoutError);
    }
  }, DEDUP_WINDOW_MS);
  entry.timeout.unref?.();

  return entry;
}

/**
 * Send a response captured from the original request to a waiting caller.
 */
function sendSharedResponse(res, response) {
  const status = getResponseStatus(res, response.status);
  if (typeof res.status === "function") res.status(status);
  if (typeof res.json === "function") return res.json(response.body);
  if (typeof res.send === "function") return res.send(response.body);
  return undefined;
}

function sendSharedError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = error?.code ?? "idempotency_dedup_failed";
  const message = error?.message ?? "The original request failed";
  return sendError(res, status, code, message);
}

/**
 * Capture the first response and resolve the shared promise when it completes.
 * The original response methods are still called, so this does not alter the
 * response sent to the first caller.
 */
function interceptResponse(req, res, key, entry) {
  let statusCode = getResponseStatus(res);

  const originalStatus = typeof res.status === "function" ? res.status.bind(res) : null;
  if (originalStatus) {
    res.status = function capturedStatus(code) {
      statusCode = code;
      return originalStatus(code);
    };
  }

  const originalJson = typeof res.json === "function" ? res.json.bind(res) : null;
  if (originalJson) {
    res.json = function capturedJson(body) {
      let result;
      try {
        result = originalJson(body);
      } finally {
        settleInFlightEntry(key, entry, {
          status: getResponseStatus(res, statusCode),
          body,
        });
      }
      return result;
    };
  }

  // Keep a reference on the request for diagnostics and for tests that need
  // to assert which operation is being deduplicated.
  req.deduplicationKey = key;
}

/**
 * Register a request in the short-lived in-flight map or wait for the request
 * that already owns the same operation/idempotency-key pair.
 */
function runInFlightDeduplication(req, res, next, operation) {
  const idempotencyKey = getIdempotencyKey(req);

  // Idempotency remains optional. Requests without a key must retain the old
  // behaviour and execute independently, but still count as dedup misses when
  // this middleware is explicitly installed for the route.
  if (!idempotencyKey) {
    dedupMetrics.misses += 1;
    return next();
  }

  // Let the persistent middleware return the normal validation response. The
  // standalone deduplication middleware can appear before it in a route.
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return next();
  }

  const deduplicationKey = createDeduplicationKey(getOperationName(req, operation), idempotencyKey);
  const existing = inFlightRequests.get(deduplicationKey);

  if (existing) {
    dedupMetrics.hits += 1;
    logger.debug(`Idempotency dedup hit: ${deduplicationKey}`);

    return existing.promise
      .then((response) => sendSharedResponse(res, response))
      .catch((error) => sendSharedError(res, error));
  }

  dedupMetrics.misses += 1;
  const entry = createInFlightEntry(deduplicationKey);
  inFlightRequests.set(deduplicationKey, entry);
  interceptResponse(req, res, deduplicationKey, entry);

  try {
    return next();
  } catch (error) {
    settleInFlightEntry(deduplicationKey, entry, null, error);
    throw error;
  }
}

/**
 * Short-lived in-flight deduplication middleware.
 *
 * Use an explicit operation name for routes that share an idempotency header
 * namespace. The key is intentionally based on operation + Idempotency-Key,
 * not on the request body, so callers retrying the same operation share work
 * even if an equivalent body was serialized differently.
 *
 * Usage:
 *   router.post("/", deduplicationMiddleware("distribute"), idempotencyMiddleware, handler);
 */
export function deduplicationMiddleware(operation) {
  return function inFlightDeduplicationMiddleware(req, res, next) {
    req[DEDUPLICATION_HANDLED] = true;
    return runInFlightDeduplication(req, res, next, operation);
  };
}

/**
 * Get deduplication metrics for monitoring and tests.
 */
export function getDedupMetrics() {
  return {
    hits: dedupMetrics.hits,
    misses: dedupMetrics.misses,
    inFlight: inFlightRequests.size,
    windowMs: DEDUP_WINDOW_MS,
  };
}

/**
 * Get the current number of in-flight entries without exposing the map.
 */
export function getInFlightRequestCount() {
  return inFlightRequests.size;
}

/**
 * Clear in-flight entries. This is primarily useful for test teardown and
 * process shutdown; normal cleanup happens on response, failure, or timeout.
 */
export function clearInFlightRequests() {
  for (const [key, entry] of inFlightRequests.entries()) {
    clearTimeout(entry.timeout);
    removeInFlightEntry(key, entry);
    if (!entry.settled) {
      const clearError = new Error("In-flight idempotency request cleared");
      clearError.status = 503;
      clearError.code = "idempotency_dedup_cleared";
      settleInFlightEntry(key, entry, null, clearError);
    }
  }
  inFlightRequests.clear();
}

/**
 * Express middleware for idempotency support.
 *
 * Checks for Idempotency-Key header and returns cached response if found.
 * Otherwise, intercepts the response and caches it for future requests. When
 * used by itself it also provides in-flight deduplication. Routes that use the
 * standalone `deduplicationMiddleware` are not registered twice.
 *
 * Usage:
 *   router.post("/endpoint", idempotencyMiddleware, handler);
 */
export function idempotencyMiddleware(req, res, next) {
  // Supporting a configured form keeps route operation names deterministic
  // while preserving the original Express middleware API.
  if (typeof req === "string") {
    return createIdempotencyMiddleware(req);
  }

  const idempotencyKey = getIdempotencyKey(req);

  // If no idempotency key provided, skip caching and deduplication. Count a
  // miss here only when the standalone middleware was not already installed.
  if (!idempotencyKey) {
    if (!req?.[DEDUPLICATION_HANDLED]) dedupMetrics.misses += 1;
    return next();
  }

  // Validate idempotency key format (alphanumeric, hyphens, underscores, 1-255 chars)
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return sendError(
      res,
      400,
      "invalid_idempotency_key",
      "Invalid Idempotency-Key format. Must be 1-255 alphanumeric characters, hyphens, or underscores."
    );
  }

  // Check the persistent cache before joining/creating an in-flight request.
  const cachedResponse = getCachedResponse(idempotencyKey);
  if (cachedResponse) {
    logger.info(`Returning cached response for idempotency key: ${idempotencyKey}`);
    return res.status(cachedResponse.status).json(cachedResponse.body);
  }

  // A route may have already installed the explicit operation-aware middleware.
  // In that case it owns the in-flight entry and this middleware only provides
  // persistent response caching.
  if (req[DEDUPLICATION_HANDLED]) {
    return installPersistentResponseCache(req, res, next, idempotencyKey);
  }

  return runPersistentAndInFlight(req, res, next, idempotencyKey);
}

function installPersistentResponseCache(req, res, next, idempotencyKey) {
  const originalJson = res.json.bind(res);
  const originalStatus = res.status.bind(res);
  let statusCode = 200;

  res.status = function (code) {
    statusCode = code;
    return originalStatus(code);
  };

  res.json = function (body) {
    if (statusCode >= 200 && statusCode < 300) {
      cacheResponse(idempotencyKey, {
        status: statusCode,
        body,
      });
    }

    return originalJson(body);
  };

  return next();
}

function runPersistentAndInFlight(req, res, next, idempotencyKey) {
  const operation = getOperationName(req);
  let responseCacheInstalled = false;

  // The in-flight interceptor must be installed before the persistent wrapper
  // so the first response resolves the shared promise after it is cached.
  const originalNext = () => {
    if (!responseCacheInstalled) {
      responseCacheInstalled = true;
      installPersistentResponseCache(req, res, () => {}, idempotencyKey);
    }
    return next();
  };

  return runInFlightDeduplication(req, res, originalNext, operation);
}

/**
 * Create a persistent + in-flight idempotency middleware with an explicit
 * operation name. Prefer this when a route is not using the standalone
 * `deduplicationMiddleware`.
 */
export function createIdempotencyMiddleware(operation) {
  return function configuredIdempotencyMiddleware(req, res, next) {
    req.idempotencyOperation = operation;
    return idempotencyMiddleware(req, res, next);
  };
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
  clearInFlightRequests();
  logger.debug("Idempotency cache cleared");
}
