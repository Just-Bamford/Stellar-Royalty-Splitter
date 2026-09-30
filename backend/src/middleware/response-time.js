/**
 * Response Time Middleware (#985)
 *
 * Measures high-resolution response duration per request and records metrics
 * for APM tracking, latency distribution, and P95 threshold (<100ms) alerting.
 *
 * Features:
 *  - Intercepts response headers to inject standard `X-Response-Time` header (e.g. `12.34ms`)
 *  - Normalizes Express route path to prevent high-cardinality series explosion
 *  - Integrates seamlessly with `metrics.js` for Prometheus counters/histograms and APM sliding window
 *  - Emits structured log warnings for slow responses (>100ms)
 *  - Integrates with repo's Winston-backed structured logger
 */

import logger from "../logger.js";
import { recordEndpointResponseTime } from "../metrics.js";

/**
 * Derives a normalized route label from the Express request.
 * Normalizes route patterns (e.g., `/api/v1/history/:contractId`) rather than
 * dynamic URL instances to prevent metric label explosion.
 *
 * @param {import("express").Request} req - Express request object
 * @returns {string} Normalized route pattern or "unmatched"
 */
export function routeLabel(req) {
  if (req.route?.path !== undefined) {
    const routePath = Array.isArray(req.route.path) ? req.route.path[0] : String(req.route.path);
    return `${req.baseUrl ?? ""}${routePath === "/" && req.baseUrl ? "" : routePath}` || "/";
  }
  return "unmatched";
}

/**
 * Creates response-time middleware that measures request duration, sets
 * the `X-Response-Time` header, and records APM metrics on finish.
 *
 * @param {object} [options]
 * @param {string} [options.headerName="X-Response-Time"] - Header name to set
 * @param {number} [options.digits=2] - Decimal places for milliseconds
 * @param {number} [options.slowThresholdMs=100] - Threshold to log slow request warning
 * @returns {import("express").RequestHandler} Express middleware handler
 */
export function responseTimeMiddleware(options = {}) {
  const headerName = options.headerName || "X-Response-Time";
  const digits = options.digits !== undefined ? options.digits : 2;
  const slowThresholdMs = options.slowThresholdMs !== undefined ? options.slowThresholdMs : 100;

  return function responseTimeHandler(req, res, next) {
    const startBigInt = process.hrtime.bigint();

    // Hook into writeHead to ensure header is set before headers are flushed
    const originalWriteHead = res.writeHead;
    let headerSet = false;

    const setHeaderIfPossible = () => {
      if (!headerSet && !res.headersSent) {
        const durationMs = Number(process.hrtime.bigint() - startBigInt) / 1e6;
        res.setHeader(headerName, `${durationMs.toFixed(digits)}ms`);
        headerSet = true;
      }
    };

    res.writeHead = function (...args) {
      setHeaderIfPossible();
      return originalWriteHead.apply(res, args);
    };

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startBigInt) / 1e6;
      const route = routeLabel(req);

      // Record to APM metrics and Prometheus
      recordEndpointResponseTime(req.method, route, res.statusCode, durationMs);

      // Log warning for slow requests exceeding threshold
      if (durationMs > slowThresholdMs) {
        logger.warn("Slow API response time detected", {
          method: req.method,
          route,
          path: req.originalUrl || req.url,
          status: res.statusCode,
          durationMs: Number(durationMs.toFixed(digits)),
          thresholdMs: slowThresholdMs,
        });
      }
    });

    next();
  };
}

export default responseTimeMiddleware;
