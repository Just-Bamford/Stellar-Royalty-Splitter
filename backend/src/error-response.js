import logger from "./logger.js";

export const defaultErrorCodes = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "too_many_requests",
  500: "internal_server_error",
  503: "service_unavailable",
};

export const retryableErrorCodes = {
  too_many_requests: true,
  service_unavailable: true,
  request_timeout: true,
  internal_server_error: false,
};

export function normalizeErrorCode(status, code) {
  return code || defaultErrorCodes[status] || "error";
}

export function buildErrorPayload(status, code, message, extra = {}) {
  const normalizedCode = normalizeErrorCode(status, code);
  const retryable = retryableErrorCodes[normalizedCode] || false;
  const retryAfter = retryable ? (status === 429 ? 60 : 5) : null; // Default retry after hints
  const detailsUrl = `docs/errors#${normalizedCode}`;
  
  return {
    status,
    code: normalizedCode,
    message,
    error: message,
    retryable,
    retryAfter,
    details_url: detailsUrl,
    ...extra,
  };
}

export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json(buildErrorPayload(status, code, message, extra));
}

export function sendValidationError(res, issues) {
  const firstMessage = issues.length > 0 ? issues[0].message : "Validation failed";
  return sendError(res, 400, "validation_failed", firstMessage, { details: issues });
}

/**
 * Express 404 handler for any request that reaches the end of the router
 * stack without matching a route. Mount this after every route/router so
 * unmatched paths get the standard error shape instead of Express's default
 * HTML 404 page (#662).
 */
export function notFoundHandler(req, res) {
  return sendError(res, 404, "not_found", `No route matches ${req.method} ${req.originalUrl}`);
}

/**
 * Central Express error-handling middleware. Normalizes every thrown/next(err)
 * error into the standard { status, code, message, error } shape, logs the
 * full error server-side, and never leaks a stack trace or internal detail
 * to the client (#662). Mount this last, after notFoundHandler.
 */
export function errorHandler(err, _req, res, _next) {
  if (err.type === "entity.too.large") {
    return sendError(res, 413, "payload_too_large", "Payload too large");
  }
  logger.error(err);

  // Structured errors thrown by stellar.js (Soroban / RPC errors)
  if (err.status && err.code) {
    return sendError(res, err.status, err.code, err.message ?? "Error", {
      detail: err.detail,
    });
  }

  if (err.status) {
    return sendError(res, err.status, undefined, err.message ?? "Error");
  }

  return sendError(res, 500, "internal_server_error", err.message ?? "Internal server error");
}
