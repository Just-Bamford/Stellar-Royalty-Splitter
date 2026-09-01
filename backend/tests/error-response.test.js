/**
 * Tests for the standardized error response format (#662).
 */
import { describe, test, expect, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  defaultErrorCodes,
  normalizeErrorCode,
  buildErrorPayload,
  sendError,
  sendValidationError,
  notFoundHandler,
  errorHandler,
} from "../src/error-response.js";

function mockRes() {
  return {
    status: jest.fn(function status() {
      return this;
    }),
    json: jest.fn(function json() {
      return this;
    }),
  };
}

describe("normalizeErrorCode", () => {
  test("uses the explicit code when provided", () => {
    expect(normalizeErrorCode(400, "custom_code")).toBe("custom_code");
  });

  test("falls back to the default code for a known status", () => {
    expect(normalizeErrorCode(404, undefined)).toBe(defaultErrorCodes[404]);
    expect(normalizeErrorCode(429, null)).toBe("too_many_requests");
  });

  test("falls back to a generic 'error' code for an unlisted status", () => {
    expect(normalizeErrorCode(418, undefined)).toBe("error");
  });
});

describe("buildErrorPayload", () => {
  test("returns the standard shape with status/code/message/error duplicated", () => {
    const payload = buildErrorPayload(400, "validation_failed", "Bad input");
    expect(payload).toMatchObject({
      status: 400,
      code: "validation_failed",
      message: "Bad input",
      error: "Bad input",
    });
    expect(payload.retryable).toBe(false);
    expect(payload.retryAfter).toBeNull();
    expect(payload.details_url).toBe("docs/errors#validation_failed");
  });

  test("normalizes a falsy code via the status-based default", () => {
    const payload = buildErrorPayload(404, undefined, "Not found");
    expect(payload.code).toBe("not_found");
  });

  test("merges extra fields without overwriting the standard ones", () => {
    const payload = buildErrorPayload(400, "validation_failed", "Bad input", {
      details: [{ field: "amount", message: "must be positive" }],
    });
    expect(payload.details).toEqual([{ field: "amount", message: "must be positive" }]);
    expect(payload.status).toBe(400);
  });

  test("never includes a stack trace or raw error object", () => {
    const err = new Error("internal failure");
    const payload = buildErrorPayload(500, "internal_server_error", err.message);
    expect(payload.stack).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("at ");
  });

  test("includes retryable field for retryable errors", () => {
    const payload = buildErrorPayload(429, "too_many_requests", "Rate limit exceeded");
    expect(payload.retryable).toBe(true);
    expect(payload.retryAfter).toBe(60);
  });

  test("includes retryable field for service unavailable", () => {
    const payload = buildErrorPayload(503, "service_unavailable", "Service unavailable");
    expect(payload.retryable).toBe(true);
    expect(payload.retryAfter).toBe(5);
  });

  test("sets retryable to false for non-retryable errors", () => {
    const payload = buildErrorPayload(400, "validation_failed", "Bad input");
    expect(payload.retryable).toBe(false);
    expect(payload.retryAfter).toBeNull();
  });
});

describe("sendError", () => {
  test("sets the HTTP status and JSON body from buildErrorPayload", () => {
    const res = mockRes();
    sendError(res, 403, "forbidden", "Not allowed", { reason: "rbac" });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 403,
        code: "forbidden",
        message: "Not allowed",
        error: "Not allowed",
        reason: "rbac",
        retryable: false,
        retryAfter: null,
        details_url: "docs/errors#forbidden",
      })
    );
  });
});

describe("sendValidationError", () => {
  test("uses the first issue's message and includes all issues as details", () => {
    const res = mockRes();
    const issues = [
      { field: "shares", message: "shares must sum to 10000" },
      { field: "collaborators", message: "too many collaborators" },
    ];
    sendValidationError(res, issues);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        code: "validation_failed",
        message: "shares must sum to 10000",
        error: "shares must sum to 10000",
        details: issues,
        retryable: false,
        retryAfter: null,
        details_url: "docs/errors#validation_failed",
      })
    );
  });

  test("falls back to a generic message when there are no issues", () => {
    const res = mockRes();
    sendValidationError(res, []);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Validation failed" }),
    );
  });
});

describe("notFoundHandler + errorHandler — end-to-end response shape (#662)", () => {
  function buildApp() {
    const app = express();
    app.use(express.json({ limit: "10kb" }));

    app.get("/ok", (_req, res) => res.json({ ok: true }));

    app.post("/boom-with-status", (_req, _res) => {
      const err = new Error("Soroban RPC unavailable");
      err.status = 503;
      err.code = "service_unavailable";
      err.detail = "connect ECONNREFUSED";
      throw err;
    });

    app.post("/boom-generic", (_req, _res) => {
      throw new Error("something broke");
    });

    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
  }

  test("unmatched route returns a standard 404, not Express's HTML page", async () => {
    const res = await request(buildApp()).get("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body).toEqual(
      expect.objectContaining({ status: 404, code: "not_found" }),
    );
  });

  test("oversized JSON body returns 413 with the standard shape", async () => {
    const res = await request(buildApp())
      .post("/ok")
      .send({ padding: "x".repeat(20 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 413,
        code: "payload_too_large",
        message: "Payload too large",
      }),
    );
  });

  test("a thrown error with .status/.code is passed through with detail", async () => {
    const res = await request(buildApp()).post("/boom-with-status").send({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 503,
        code: "service_unavailable",
        message: "Soroban RPC unavailable",
        detail: "connect ECONNREFUSED",
      }),
    );
  });

  test("an unstructured thrown error falls back to a safe generic 500", async () => {
    const res = await request(buildApp()).post("/boom-generic").send({});
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_server_error");
    // The route's own message is surfaced (it's not sensitive here), but no
    // stack trace or raw error object ever reaches the client.
    expect(res.body.stack).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/at Object|at Module/);
  });
});
