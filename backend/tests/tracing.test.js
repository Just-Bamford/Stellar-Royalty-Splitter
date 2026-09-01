/**
 * Tests for OpenTelemetry tracing setup (#785).
 *
 * All tests run with OTEL_ENABLED unset (falsy), so the module stays in
 * no-op mode. The key contract: every exported function must be callable
 * without throwing, and the tracing middleware must correctly propagate
 * correlation IDs without breaking the request pipeline.
 */
import { describe, test, expect } from "@jest/globals";
import {
  startSpan,
  getTraceId,
  recordSpanError,
  addSpanAttributes,
  tracingMiddleware,
} from "../src/tracing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReq(headers = {}) {
  return {
    method: "GET",
    path: "/test",
    originalUrl: "/api/v1/test",
    headers,
    correlationId: undefined,
  };
}

function mockRes() {
  const headers = {};
  const listeners = {};
  return {
    setHeader: (k, v) => {
      headers[k] = v;
    },
    getHeader: (k) => headers[k],
    getHeaders: () => headers,
    on: (event, fn) => {
      listeners[event] = fn;
    },
    emit: (event) => listeners[event]?.(),
    statusCode: 200,
    _headers: headers,
  };
}

// ---------------------------------------------------------------------------
// No-op mode tests (OTEL_ENABLED is not "true" in the test environment)
// ---------------------------------------------------------------------------

describe("startSpan (tracing disabled)", () => {
  test("calls fn and returns its result", async () => {
    const result = await startSpan("test-span", { key: "value" }, () => 42);
    expect(result).toBe(42);
  });

  test("returns result of async fn", async () => {
    const result = await startSpan("async-span", {}, async () => "hello");
    expect(result).toBe("hello");
  });

  test("returns undefined when fn is not provided", async () => {
    const result = await startSpan("no-fn-span");
    expect(result).toBeUndefined();
  });

  test("propagates errors thrown by fn", async () => {
    await expect(
      startSpan("error-span", {}, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
  });
});

describe("getTraceId (tracing disabled)", () => {
  test("returns null when tracing is disabled", () => {
    expect(getTraceId()).toBeNull();
  });
});

describe("recordSpanError (tracing disabled)", () => {
  test("does not throw when called with an error", () => {
    expect(() => recordSpanError(new Error("something went wrong"))).not.toThrow();
  });

  test("does not throw when called with undefined", () => {
    expect(() => recordSpanError(undefined)).not.toThrow();
  });
});

describe("addSpanAttributes (tracing disabled)", () => {
  test("does not throw with a flat attribute map", () => {
    expect(() => addSpanAttributes({ key: "value", count: 1 })).not.toThrow();
  });

  test("does not throw with an empty object", () => {
    expect(() => addSpanAttributes({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// tracingMiddleware tests
// ---------------------------------------------------------------------------

describe("tracingMiddleware", () => {
  test("calls next()", () => {
    const req = mockReq();
    const res = mockRes();
    let called = false;
    tracingMiddleware(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  test("sets X-Correlation-Id response header", () => {
    const req = mockReq();
    const res = mockRes();
    tracingMiddleware(req, res, () => {});
    expect(res.getHeader("X-Correlation-Id")).toBeDefined();
    expect(typeof res.getHeader("X-Correlation-Id")).toBe("string");
    expect(res.getHeader("X-Correlation-Id").length).toBeGreaterThan(0);
  });

  test("propagates X-Correlation-Id from request header", () => {
    const correlationId = "my-existing-id-12345";
    const req = mockReq({ "x-correlation-id": correlationId });
    const res = mockRes();
    tracingMiddleware(req, res, () => {});
    expect(res.getHeader("X-Correlation-Id")).toBe(correlationId);
  });

  test("attaches correlationId to req object", () => {
    const req = mockReq();
    const res = mockRes();
    tracingMiddleware(req, res, () => {});
    expect(req.correlationId).toBeDefined();
    expect(typeof req.correlationId).toBe("string");
  });

  test("uses request X-Correlation-Id as req.correlationId", () => {
    const correlationId = "frontend-trace-abc";
    const req = mockReq({ "x-correlation-id": correlationId });
    const res = mockRes();
    tracingMiddleware(req, res, () => {});
    expect(req.correlationId).toBe(correlationId);
  });

  test("generates a new correlation ID when none is provided", () => {
    const req1 = mockReq();
    const req2 = mockReq();
    const res1 = mockRes();
    const res2 = mockRes();
    tracingMiddleware(req1, res1, () => {});
    tracingMiddleware(req2, res2, () => {});
    // IDs should be non-empty strings; they may or may not be unique
    // (uniqueness is probabilistic) but both should be set
    expect(req1.correlationId).toBeTruthy();
    expect(req2.correlationId).toBeTruthy();
  });

  test("does not set X-Trace-Id when tracing is disabled", () => {
    const req = mockReq();
    const res = mockRes();
    tracingMiddleware(req, res, () => {});
    // X-Trace-Id should not appear — no active span in no-op mode
    expect(res.getHeader("X-Trace-Id")).toBeUndefined();
  });
});
