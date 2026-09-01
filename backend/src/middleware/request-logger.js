import { randomUUID } from "crypto";
import logger from "../logger.js";

// Headers whose values must never appear in logs.
const REDACTED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
  "x-secret",
  "x-private-key",
]);

// Sanitise request headers so sensitive values are replaced with "[redacted]".
function safeHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers)) {
    safe[name] = REDACTED_HEADERS.has(name.toLowerCase()) ? "[redacted]" : value;
  }
  return safe;
}

/**
 * Structured request logging middleware.
 *
 * Assigns a correlation ID to each request, attaches it to both the request
 * object and the `X-Request-Id` response header, then logs method, route,
 * status, and duration on response finish.
 *
 * Accepts an incoming `X-Request-Id` header from trusted upstreams (e.g. a
 * reverse proxy or API gateway). Values are trimmed to 128 characters to
 * prevent log injection via oversized IDs.
 *
 * Sensitive header values (Authorization, X-Api-Key, Cookie, etc.) are
 * redacted before any log entry is written.
 */
export function requestLogger(req, res, next) {
  const start = Date.now();

  const incoming = req.headers["x-request-id"];
  const requestId = typeof incoming === "string" && incoming.trim().length > 0
    ? incoming.trim().slice(0, 128)
    : randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  res.on("finish", () => {
    const duration = Date.now() - start;

    logger.info("request completed", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration,
    });
  });

  next();
}

export { safeHeaders };
