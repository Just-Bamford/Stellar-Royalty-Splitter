/**
 * Per-API-key sliding window rate limiter (#420).
 *
 * Separate from and additive to the IP-based limiters in index.js. A
 * request that supplies a valid API key via the X-API-Key header is
 * rate-limited against its own quota, independent of the shared-IP limits —
 * so one bad actor can't exhaust another tenant's quota by rotating IPs,
 * and a single malicious actor can no longer DOS a shared contract by
 * hiding behind the general per-IP limit.
 *
 * Implementation: an in-memory Map<apiKeyId, timestamps[]> sliding window
 * log. On each request, timestamps older than the window are dropped before
 * counting — this is a true sliding window, not a fixed-window approximation.
 *
 * Configuration:
 * - API_KEY_RATE_LIMIT_WINDOW_MS: sliding window size (default: 60s)
 * - API_KEY_RATE_LIMIT_MAX: max requests per window per key (default: 60)
 */

import logger from "./logger.js";
import { sendError } from "./error-response.js";
import { findActiveKeyByRawKey } from "./database/index.js";

const WINDOW_MS = parseInt(process.env.API_KEY_RATE_LIMIT_WINDOW_MS || "60000", 10);
const MAX_REQUESTS = parseInt(process.env.API_KEY_RATE_LIMIT_MAX || "60", 10);

// Map<apiKeyId, number[]> — request timestamps (ms) within the current window
const requestLog = new Map();

function pruneExpired(timestamps, now) {
  const cutoff = now - WINDOW_MS;
  let start = 0;
  while (start < timestamps.length && timestamps[start] <= cutoff) {
    start += 1;
  }
  return start > 0 ? timestamps.slice(start) : timestamps;
}

/** Periodically drop fully-expired entries so the map doesn't grow forever. */
function cleanupExpiredKeys() {
  const now = Date.now();
  for (const [keyId, timestamps] of requestLog.entries()) {
    const pruned = pruneExpired(timestamps, now);
    if (pruned.length === 0) {
      requestLog.delete(keyId);
    } else if (pruned !== timestamps) {
      requestLog.set(keyId, pruned);
    }
  }
}

const cleanupInterval = setInterval(cleanupExpiredKeys, 5 * 60 * 1000);
cleanupInterval.unref?.();
process.on("SIGINT", () => clearInterval(cleanupInterval));

function setRateLimitHeaders(res, { limit, remaining, resetSeconds }) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, remaining)));
  res.setHeader("X-RateLimit-Reset", String(resetSeconds));
}

/**
 * Express middleware. No-op (calls next immediately) when X-API-Key is
 * absent, so it has zero effect on unauthenticated/IP-limited traffic.
 */
export function apiKeyRateLimiter(req, res, next) {
  const rawKey = req.headers["x-api-key"];
  if (!rawKey) return next();

  const keyRow = findActiveKeyByRawKey(rawKey);
  if (!keyRow) {
    logger.warn("Rejected request with invalid or revoked API key", {
      event: "api_key_rejected",
    });
    return sendError(res, 401, "invalid_api_key", "Invalid or revoked API key");
  }

  const now = Date.now();
  const existing = requestLog.get(keyRow.id) ?? [];
  const timestamps = pruneExpired(existing, now);
  const resetSeconds = Math.ceil(((timestamps[0] ?? now) + WINDOW_MS) / 1000);

  if (timestamps.length >= MAX_REQUESTS) {
    requestLog.set(keyRow.id, timestamps);
    setRateLimitHeaders(res, { limit: MAX_REQUESTS, remaining: 0, resetSeconds });
    return sendError(res, 429, "too_many_requests", "API key rate limit exceeded, please slow down.");
  }

  timestamps.push(now);
  requestLog.set(keyRow.id, timestamps);
  setRateLimitHeaders(res, {
    limit: MAX_REQUESTS,
    remaining: MAX_REQUESTS - timestamps.length,
    resetSeconds,
  });

  next();
}

/** Reset in-memory rate limit state (tests only). */
export function _resetApiKeyRateLimitState() {
  requestLog.clear();
}
