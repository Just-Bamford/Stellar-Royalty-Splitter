export const ERROR_CODES = {
  // 4xx client errors
  BAD_REQUEST: "bad_request",
  UNAUTHORIZED: "unauthorized",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not_found",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  CONFLICT: "conflict",
  GONE: "gone",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  UNSUPPORTED_MEDIA_TYPE: "unsupported_media_type",
  UNPROCESSABLE_ENTITY: "unprocessable_entity",
  TOO_MANY_REQUESTS: "too_many_requests",
  // 5xx server errors
  INTERNAL_SERVER_ERROR: "internal_server_error",
  NOT_IMPLEMENTED: "not_implemented",
  SERVICE_UNAVAILABLE: "service_unavailable",
  GATEWAY_TIMEOUT: "gateway_timeout",
  // Domain-specific
  VALIDATION_ERROR: "validation_error",
  AUTH_ERROR: "auth_error",
  CONTRACT_ERROR: "contract_error",
  WEBHOOK_ERROR: "webhook_error",
  DATABASE_ERROR: "database_error",
};

export const defaultErrorCodes = {
  400: ERROR_CODES.BAD_REQUEST,
  401: ERROR_CODES.UNAUTHORIZED,
  403: ERROR_CODES.FORBIDDEN,
  404: ERROR_CODES.NOT_FOUND,
  405: ERROR_CODES.METHOD_NOT_ALLOWED,
  409: ERROR_CODES.CONFLICT,
  410: ERROR_CODES.GONE,
  413: ERROR_CODES.PAYLOAD_TOO_LARGE,
  415: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
  422: ERROR_CODES.UNPROCESSABLE_ENTITY,
  429: ERROR_CODES.TOO_MANY_REQUESTS,
  500: ERROR_CODES.INTERNAL_SERVER_ERROR,
  501: ERROR_CODES.NOT_IMPLEMENTED,
  503: ERROR_CODES.SERVICE_UNAVAILABLE,
  504: ERROR_CODES.GATEWAY_TIMEOUT,
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
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

export function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json(buildErrorPayload(status, code, message, extra));
}

export function sendValidationError(res, issues) {
  const firstMessage = issues.length > 0 ? issues[0].message : "Validation failed";
  return sendError(res, 400, ERROR_CODES.VALIDATION_ERROR, firstMessage, {
    details: issues.map((issue) => ({
      field: issue.field ?? issue.path ?? null,
      message: issue.message,
      constraint: issue.constraint ?? null,
    })),
  });
}
