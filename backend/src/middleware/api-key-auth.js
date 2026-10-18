/**
 * Partner API key authentication, tiered rate limiting and metering — #996.
 *
 * Three middlewares, mounted in this order:
 *
 *   1. apiKeyAuth({ required })   — validates `x-api-key`, attaches req.apiKey
 *   2. meterApiCall()             — records the call against the key
 *   3. partnerRateLimit()         — enforces the key's tier quota (429)
 *
 * `meterApiCall` is mounted *before* the limiter so throttled requests are
 * still counted (and visible in the analytics dashboard). It registers on
 * `res.on("finish")` so the recorded status code and duration match what the
 * client actually received.
 *
 * Example:
 *   app.use(apiKeyAuth(), meterApiCall(), partnerRateLimit(), partnerRouter);
 */

import { sendError } from "../error-response.js";
import logger from "../logger.js";
import {
  checkRateLimit,
  findApiKey,
  recordApiCall,
  touchApiKey,
} from "../services/api-metering.js";

/** Header partners are documented to use. `authorization: Bearer` is also accepted. */
export const API_KEY_HEADER = "x-api-key";

/**
 * Read the API key from the request.
 * Supports `x-api-key: <key>` and `Authorization: Bearer <key>`.
 *
 * @returns {string|null}
 */
export function extractApiKey(req) {
  const header = req.headers?.[API_KEY_HEADER] ?? req.get?.(API_KEY_HEADER);
  if (typeof header === "string" && header.trim()) return header.trim();

  const auth = req.headers?.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return null;
}

/**
 * Resolve the partner key on a request and attach it to `req.apiKey`.
 *
 * When `required` is false (the default) a missing key is not an error — the
 * request simply stays anonymous, which keeps the endpoints usable by the
 * existing wallet-based front end. When `required` is true, a missing or
 * unusable key returns 401.
 *
 * @param {object} [options]
 * @param {boolean} [options.required=false]
 * @returns {import("express").RequestHandler}
 */
export function apiKeyAuth({ required = false } = {}) {
  return function apiKeyAuthMiddleware(req, res, next) {
    const presented = extractApiKey(req);

    if (!presented) {
      if (required) {
        return sendError(
          res,
          401,
          "api_key_required",
          `An API key is required. Send it in the ${API_KEY_HEADER} header.`
        );
      }
      req.apiKey = null;
      req.partnerId = null;
      return next();
    }

    const key = findApiKey(presented);

    if (!key) {
      logger.warn("Partner API key rejected", { path: req.originalUrl, ip: req.ip });
      return sendError(res, 401, "invalid_api_key", "Invalid API key");
    }

    if (key.reason === "revoked") {
      return sendError(res, 401, "api_key_revoked", "This API key has been revoked");
    }

    if (key.reason === "expired") {
      return sendError(res, 401, "api_key_expired", "This API key has expired");
    }

    req.apiKey = key;
    req.partnerId = key.partnerId;
    touchApiKey(key.id);
    return next();
  };
}

/**
 * Express middleware factory that rejects the request when the key's tier quota
 * is exhausted. Anonymous requests (no API key) pass through — the global
 * per-IP limiter in index.js still protects them.
 *
 * When the call is allowed the quota state is stashed on `req.apiQuota` and
 * echoed back as `X-RateLimit-*` headers so partners can self-throttle.
 */
export function partnerRateLimit() {
  return function partnerRateLimitMiddleware(req, res, next) {
    if (!req.apiKey) return next();

    const quota = checkRateLimit(req.apiKey);
    req.apiQuota = quota;

    if (quota.limit !== null) {
      res.set("X-RateLimit-Limit", String(quota.limit));
      res.set("X-RateLimit-Remaining", String(quota.remaining));
      res.set("X-RateLimit-Reset", String(quota.resetsAt ? new Date(quota.resetsAt).getTime() : 0));
      res.set("X-RateLimit-Tier", quota.tier);
    }

    if (!quota.allowed) {
      logger.warn("Partner rate limit exceeded", {
        keyId: req.apiKey.keyId,
        partnerId: req.apiKey.partnerId,
        tier: quota.tier,
        window: quota.window,
      });

      if (quota.resetsAt) {
        res.set("Retry-After", String(Math.max(1, Math.ceil((new Date(quota.resetsAt).getTime() - Date.now()) / 1000))));
      }

      return sendError(
        res,
        429,
        "rate_limit_exceeded",
        `${quota.tier} tier limit of ${quota.limit} calls per ${quota.window} reached`,
        {
          tier: quota.tier,
          window: quota.window,
          limit: quota.limit,
          used: quota.used,
          remaining: 0,
          resetsAt: quota.resetsAt,
        }
      );
    }

    return next();
  };
}

/**
 * Normalise a request path into a stable, low-cardinality endpoint label.
 * ID-like segments are collapsed so `/contract/abc…` and `/contract/def…`
 * aggregate as one endpoint in the analytics dashboard.
 */
export function normalizeEndpoint(path) {
  if (typeof path !== "string" || !path) return "unknown";
  return path
    .split("?")[0]
    .replace(/\/key_[0-9a-zA-Z]+/g, "/:keyId")
    .replace(/\/keys\/[0-9a-zA-Z]+/g, "/keys/:keyId")
    .replace(/\/[0-9a-fA-F-]{16,}/g, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
}

/**
 * Record every request made with a partner key.
 *
 * Throttled calls are stored with `rateLimited: true` so they show up in the
 * analytics dashboard, but they are never charged against the key's quota.
 */
export function meterApiCall() {
  return function meterApiCallMiddleware(req, res, next) {
    if (!req.apiKey) return next();

    const startedAt = Date.now();
    // Set by partnerRateLimit() so a throttled call is metered as throttled.
    let throttled = false;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 429) throttled = true;
      return originalJson(body);
    };

    res.on("finish", () => {
      const durationMs = Date.now() - startedAt;
      try {
        recordApiCall({
          keyId: req.apiKey.keyId,
          partnerId: req.apiKey.partnerId,
          endpoint: normalizeEndpoint(req.originalUrl || req.url || req.path),
          method: req.method,
          statusCode: res.statusCode,
          durationMs,
          rateLimited: throttled || res.statusCode === 429,
        });
      } catch (error) {
        // Metering must never break the response path.
        logger.error("Failed to record partner API call", { error: error.message });
      }
    });

    return next();
  };
}
