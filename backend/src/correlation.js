/**
 * Correlation ID middleware for distributed request tracing (#396).
 *
 * Generates a UUID v4 correlation ID for every inbound request (or reads one
 * from the X-Correlation-ID request header when present, so upstream callers
 * can propagate their own IDs through the system).
 *
 * The ID is:
 *   - Stored on `req.correlationId`
 *   - Echoed back in the X-Correlation-ID response header
 *   - Available via `getCorrelationId(req)` for use inside route handlers
 *     and service helpers
 *
 * Usage:
 *   import { correlationMiddleware } from './correlation.js';
 *   app.use(correlationMiddleware);
 *
 * Then in a route:
 *   logger.info('doing something', { correlationId: req.correlationId });
 */

/**
 * Generate a UUID v4 string.
 * Uses the built-in `crypto.randomUUID()` when available (Node ≥ 14.17),
 * with a pure-JS fallback for test environments that stub crypto.
 */
export function generateCorrelationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 compliant UUID v4
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validate that a string looks like a UUID v4.
 * Returns true if valid, false otherwise.
 */
export function isValidCorrelationId(id) {
  return typeof id === "string" && UUID_V4_RE.test(id);
}

/**
 * Express middleware that attaches a correlation ID to every request.
 *
 * Priority:
 *   1. X-Correlation-ID request header (caller-provided, validated)
 *   2. Freshly generated UUID v4
 */
export function correlationMiddleware(req, res, next) {
  const incoming = req.headers["x-correlation-id"];
  const correlationId =
    incoming && isValidCorrelationId(incoming) ? incoming : generateCorrelationId();

  req.correlationId = correlationId;
  res.setHeader("X-Correlation-ID", correlationId);
  next();
}

/**
 * Convenience accessor — returns the correlation ID attached by the middleware.
 * Falls back to "unknown" when called before the middleware runs (e.g. in tests).
 */
export function getCorrelationId(req) {
  return req?.correlationId ?? "unknown";
}
