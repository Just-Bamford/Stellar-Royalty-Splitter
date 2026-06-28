import { describe, test, expect, jest } from "@jest/globals";
import {
  ERROR_CODES,
  buildErrorPayload,
  sendError,
  sendValidationError,
  normalizeErrorCode,
} from "../src/error-response.js";

describe("error-response format (#400)", () => {
  test("buildErrorPayload includes required fields: code, message, status, timestamp", () => {
    const payload = buildErrorPayload(404, "not_found", "Resource not found");
    expect(payload).toMatchObject({
      status: 404,
      code: "not_found",
      message: "Resource not found",
    });
    expect(typeof payload.timestamp).toBe("string");
    expect(() => new Date(payload.timestamp)).not.toThrow();
  });

  test("buildErrorPayload timestamp is a valid ISO 8601 string", () => {
    const payload = buildErrorPayload(500, "internal_server_error", "Oops");
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("ERROR_CODES enum contains at least 15 codes", () => {
    expect(Object.keys(ERROR_CODES).length).toBeGreaterThanOrEqual(15);
  });

  test("normalizeErrorCode falls back to defaultErrorCodes by HTTP status", () => {
    expect(normalizeErrorCode(401, null)).toBe("unauthorized");
    expect(normalizeErrorCode(429, null)).toBe("too_many_requests");
    expect(normalizeErrorCode(503, null)).toBe("service_unavailable");
  });

  test("normalizeErrorCode uses explicit code when provided", () => {
    expect(normalizeErrorCode(400, "custom_code")).toBe("custom_code");
  });

  test("sendValidationError includes field-level details with field, message, constraint", () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    sendValidationError(res, [
      { field: "email", message: "Invalid email format", constraint: "format" },
      { field: "amount", message: "Must be positive", constraint: "min" },
    ]);

    expect(res.status).toHaveBeenCalledWith(400);
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("validation_error");
    expect(body.details).toHaveLength(2);
    expect(body.details[0]).toMatchObject({ field: "email", message: "Invalid email format" });
    expect(body.details[1]).toMatchObject({ field: "amount", constraint: "min" });
    expect(typeof body.timestamp).toBe("string");
  });

  test("sendError passes extra fields through to response body", () => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    sendError(res, 409, "conflict", "Duplicate entry", { resourceId: "abc-123" });
    const body = res.json.mock.calls[0][0];
    expect(body.code).toBe("conflict");
    expect(body.resourceId).toBe("abc-123");
    expect(body.timestamp).toBeDefined();
  });
});
