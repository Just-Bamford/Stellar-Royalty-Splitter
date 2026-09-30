/**
 * Express Middleware for Distributed Rate Limiting (#978).
 *
 * Wraps the distributed Token Bucket and Sliding Window rate limiters.
 * Extracts client identifiers (API key, user ID, wallet address, IP),
 * checks rate limits atomically against Redis, sets standard headers
 * (X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After),
 * and responds with a standard 429 payload when quota is exhausted.
 *
 * Traffic shaping integration (#Advanced API rate limiting and traffic shaping):
 * - Per-endpoint token buckets via the traffic shaper.
 * - Endpoint prioritization (essential endpoints get greater capacity/refill).
 * - Backpressure: queue during load, return 429 with Retry-After, gracefully
 *   degrade to cached data when available.
 */

import { distributedRateLimiter } from "../rate-limiter/distributed.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";
import { trafficShaper, classifyEndpoint } from "./traffic-shaper.js";

/**
 * Default key generator extracting user identifier from request.
 * Priorities: API key -> authenticated user -> wallet address in body -> client IP.
 *
 * @param {import("express").Request} req
 * @returns {string} Client identifier
 */
export function defaultKeyGenerator(req) {
  if (req.headers && req.headers["x-api-key"]) {
    return `apikey:${req.headers["x-api-key"]}`;
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
 *
 * @param {import("express").Request} req
 * @returns {string} Endpoint identifier
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
 * Creates Express middleware for distributed rate limiting.
 *
 * @param {object} [options]
 * @param {DistributedRateLimiter} [options.limiter] - Limiter instance (defaults to singleton)
 * @param {"token-bucket"|"sliding-window"} [options.algorithm="token-bucket"] - Limiting algorithm
 * @param {number} [options.capacity=60] - Max burst capacity for token bucket
 * @param {number} [options.refillRatePerSec=10] - Token refill rate per second for token bucket
 * @param {number} [options.limit=100] - Request limit for sliding window
 * @param {number} [options.windowMs=60000] - Window duration in ms for sliding window
 * @param {number} [options.cost=1] - Token cost per request
 * @param {(req: import("express").Request) => string} [options.keyGenerator] - Custom key extractor
 * @param {(req: import("express").Request) => string} [options.endpointGenerator] - Custom endpoint extractor
 * @param {(req: import("express").Request) => boolean} [options.skip] - Predicate to bypass rate limit
 * @param {boolean} [options.recordErrors=true] - Track 5xx errors for adaptive rate limiting
 * @param {object} [options.shaper] - Traffic shaper instance (defaults to singleton)
 * @param {boolean} [options.shapingEnabled=true] - Enable traffic shaping/prioritization
 * @param {boolean} [options.backpressureEnabled=true] - Enable backpressure queuing
 * @param {boolean} [options.gracefulDegradation=true] - Serve cached data on overload
 * @returns {import("express").RequestHandler} Express middleware
 */
export function createDistributedRateLimit({
  limiter = distributedRateLimiter,
  algorithm = "token-bucket",
  capacity = 60,
  refillRatePerSec = 10,
  limit = 100,
  windowMs = 60000,
  cost = 1,
  keyGenerator = defaultKeyGenerator,
  endpointGenerator = defaultEndpointGenerator,
  skip = () => false,
  recordErrors = true,
  shaper = trafficShaper,
  shapingEnabled = true,
  backpressureEnabled = true,
  gracefulDegradation = true,
} = {}) {
  return async function distributedRateLimitMiddleware(req, res, next) {
    if (skip(req)) {
      return next();
    }

    const userKey = keyGenerator(req);
    const endpoint = endpointGenerator(req);
    const priority = classifyEndpoint(endpoint);

    try {
      // Traffic shaping + backpressure check runs before the distributed limiter.
      // It enforces per-endpoint token buckets, prioritizes essential endpoints,
      // and queues requests under load.
      if (shapingEnabled && shaper) {
        const shapeResult = await shaper.check(req, {
          userKey,
          endpoint,
          priority,
          backpressureEnabled,
          gracefulDegradation,
        });

        if (shapeResult.headers) {
          for (const [name, value] of Object.entries(shapeResult.headers)) {
            res.setHeader(name, value);
          }
        }

        if (!shapeResult.allowed) {
          // Graceful degradation: serve cached data if available.
          if (gracefulDegradation && shapeResult.cachedData) {
            res.setHeader("X-RateLimit-Degraded", "cached");
            return res.status(200).json(shapeResult.cachedData);
          }

          const retryAfterSec = shapeResult.retryAfterSeconds || 1;
          res.setHeader("Retry-After", String(retryAfterSec));

          logger.warn("Traffic shaper rejected request", {
            userKey,
            endpoint,
            priority,
            retryAfterSeconds: retryAfterSec,
            ip: req.ip,
          });

          return sendError(
            res,
            429,
            "too_many_requests",
            "Rate limit exceeded. Please retry later.",
            { retryAfterSeconds: retryAfterSec, priority }
          );
        }
      }

      let result;

      if (algorithm === "sliding-window") {
        result = await limiter.consumeSlidingWindow(userKey, endpoint, {
          limit,
          windowMs,
        });
      } else {
        result = await limiter.consumeTokenBucket(userKey, endpoint, {
          capacity,
          refillRatePerSec,
          cost,
        });
      }

      // Populate standard rate limit response headers
      res.setHeader("X-RateLimit-Limit", String(result.limit));
      res.setHeader("X-RateLimit-Remaining", String(result.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetTimeMs / 1000)));
      res.setHeader("X-RateLimit-Priority", priority);

      if (result.adaptiveApplied) {
        res.setHeader("X-RateLimit-Adaptive", "active");
      }

      if (result.allowed) {
        // Track error responses on response completion for adaptive throttling
        if (recordErrors) {
          res.on("finish", () => {
            if (res.statusCode >= 500) {
              void limiter.recordResult(userKey, endpoint, true);
            } else if (res.statusCode < 400) {
              void limiter.recordResult(userKey, endpoint, false);
            }
          });
        }
        return next();
      }

      // Rate limit exceeded (429)
      const retryAfterSec = result.retryAfterSeconds || 1;
      res.setHeader("Retry-After", String(retryAfterSec));

      logger.warn("Distributed rate limit exceeded", {
        userKey,
        endpoint,
        retryAfterSeconds: retryAfterSec,
        ip: req.ip,
      });

      return sendError(
        res,
        429,
        "too_many_requests",
        "Rate limit exceeded. Please retry later.",
        { retryAfterSeconds: retryAfterSec }
      );
    } catch (err) {
      logger.error("Distributed rate limit middleware error:", err);
      return next();
    }
  };
}

export const distributedRateLimit = createDistributedRateLimit();
export default createDistributedRateLimit;
