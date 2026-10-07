import logger from "../logger.js";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

/**
 * Build the deduplication key for one distribution tuple.
 * Amount is stringified so numeric and serialized request values compare
 * consistently across callers.
 */
export function createBatchDedupKey({ contractId, tokenId, amount } = {}) {
  return JSON.stringify({
    contractId: String(contractId ?? ""),
    tokenId: String(tokenId ?? ""),
    amount: String(amount ?? ""),
  });
}

function responseStatus(res, capturedStatus) {
  return Number.isInteger(capturedStatus) ? capturedStatus : res.statusCode ?? 200;
}

function sendResponse(res, response) {
  if (typeof res.status === "function") res.status(response.status);
  return res.json(response.body);
}

/**
 * Share an in-flight or recently completed response for identical
 * contract/token/amount requests. The cache is intentionally local to the
 * middleware instance, matching the process-local idempotency patterns used
 * elsewhere in the backend.
 */
export function batchDeduplicationMiddleware({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
  loggerImpl = logger,
} = {}) {
  const entries = new Map();

  function removeExpired() {
    const currentTime = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(key);
    }
  }

  function evictIfNeeded() {
    while (entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  function middleware(req, res, next) {
    const { contractId, tokenId, amount } = req.body ?? {};
    if (!contractId || !tokenId || amount === undefined || amount === null) {
      return next();
    }

    removeExpired();
    const key = createBatchDedupKey({ contractId, tokenId, amount });
    const existing = entries.get(key);
    if (existing) {
      existing.promise.then(
        (response) => sendResponse(res, response),
        (error) => next(error)
      );
      return;
    }

    let resolveEntry;
    let rejectEntry;
    const promise = new Promise((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });
    promise.catch(() => {});

    evictIfNeeded();
    const entry = {
      promise,
      expiresAt: now() + ttlMs,
    };
    entries.set(key, entry);

    const originalStatus = typeof res.status === "function" ? res.status.bind(res) : null;
    const originalJson = res.json?.bind(res);
    if (!originalJson) {
      entries.delete(key);
      return next();
    }

    let statusCode = res.statusCode ?? 200;
    if (originalStatus) {
      res.status = (status) => {
        statusCode = status;
        return originalStatus(status);
      };
    }

    res.json = (body) => {
      const response = { status: responseStatus(res, statusCode), body };
      entry.expiresAt = now() + ttlMs;
      resolveEntry(response);
      return originalJson(body);
    };

    const wrappedNext = (error) => {
      if (error) {
        entries.delete(key);
        rejectEntry(error);
        loggerImpl.debug("Batch deduplication request failed", {
          error: error?.message ?? String(error),
        });
      }
      return next(error);
    };

    return wrappedNext();
  }

  middleware.clear = () => entries.clear();
  middleware.size = () => entries.size;
  return middleware;
}

export const batchDedupMiddleware = batchDeduplicationMiddleware;