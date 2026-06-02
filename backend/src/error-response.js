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

export function normalizeErrorCode(status, code) {
  return code || defaultErrorCodes[status] || "error";
}

export function buildErrorPayload(status, code, message, extra = {}) {
  return {
    status,
    code: normalizeErrorCode(status, code),
    message,
    error: message,
    ...extra,
  };
}

export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json(buildErrorPayload(status, code, message, extra));
}

export function sendValidationError(res, issues) {
  return sendError(res, 400, "validation_failed", "Validation failed", { details: issues });
}
