// Tests for request body size validation and DoS protection (#426).
//
// Covers all acceptance criteria:
//   ✓ Max JSON body size enforced (10 KB)
//   ✓ Max multipart body size enforced (50 KB)
//   ✓ 413 returned for oversized bodies
//   ✓ Rate limiting on repeated validation failures (429 after threshold)
//   ✓ Logging tracks rejected payloads
//   ✓ Metrics counters increment correctly

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";

// ---------------------------------------------------------------------------
// Mock logger so we can assert log calls without stdout noise
// ---------------------------------------------------------------------------
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: mockLogger,
  resolveLevel: () => "info",
  VALID_LEVELS: ["error", "warn", "info", "debug"],
}));

// ---------------------------------------------------------------------------
// Imports after mocks are registered
// ---------------------------------------------------------------------------
const {
  buildDoSLimiter,
  buildRawBodySizeGuard,
  buildJsonErrorInterceptor,
  createBodySizeLimiters,
  MAX_JSON_BYTES,
  MAX_MULTIPART_BYTES,
} = await import("../src/body-size-limit.js");

const { getMetricsSnapshot, resetMetrics } = await import("../src/metrics.js");
const { sendError } = await import("../src/error-response.js");
const expressModule = await import("express");
const expressDefault = expressModule.default;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Express app with configurable size limits.
 * Accepts optional overrides for jsonLimit and multipartLimit so each
 * test suite can use small sizes without relying on env vars.
 */
function buildTestApp({ jsonLimit = 200, multipartLimit = 500, dosMax = 3 } = {}) {
  const app = expressDefault();

  // Build a DoS limiter with a tight max so tests can hit the 429 path quickly
  const { buildDoSLimiter: _build, buildRawBodySizeGuard: _guard, buildJsonErrorInterceptor: _jei } =
    // Re-use imported factories directly
    { buildDoSLimiter, buildRawBodySizeGuard, buildJsonErrorInterceptor };

  const dosLimiter = buildDoSLimiter({ windowMs: 60_000, max: dosMax });
  const jsonParser = expressDefault.json({ limit: `${jsonLimit}b` });
  const jsonErrorInterceptor = buildJsonErrorInterceptor(jsonLimit, dosLimiter);
  const multipartSizeGuard = buildRawBodySizeGuard(multipartLimit, dosLimiter);

  app.use(multipartSizeGuard);
  app.use(jsonParser);
  app.use(jsonErrorInterceptor);

  // Echo route for JSON
  app.post("/json", (req, res) => res.json({ received: true, size: JSON.stringify(req.body).length }));

  // Echo route for multipart (just absorbs the body)
  app.post("/upload", (req, res) => {
    let bytes = 0;
    req.on("data", (c) => (bytes += c.length));
    req.on("end", () => res.json({ received: true, bytes }));
  });

  // Central error handler fallback
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") {
      return sendError(res, 413, "payload_too_large", "Payload too large");
    }
    res.status(500).json({ error: err.message });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Suite 1: JSON body size enforcement
// ---------------------------------------------------------------------------
describe("JSON body size enforcement", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
    app = buildTestApp({ jsonLimit: 200, multipartLimit: 500 });
  });

  test("accepts a JSON body under the limit", async () => {
    const payload = JSON.stringify({ data: "small" }); // well under 200 bytes
    const res = await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test("returns 413 for a JSON body exceeding 10 KB default limit", async () => {
    // Use a real 10 KB limit to validate the acceptance-criteria constant
    const bigApp = buildTestApp({ jsonLimit: MAX_JSON_BYTES, multipartLimit: MAX_MULTIPART_BYTES });
    const oversized = JSON.stringify({ padding: "x".repeat(MAX_JSON_BYTES + 100) });

    const res = await request(bigApp)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  test("returns 413 with correct error shape for oversized JSON", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    const res = await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      status: 413,
      code: "payload_too_large",
      message: "Payload too large",
    });
  });

  test("increments oversized_requests metric on rejection", async () => {
    const before = getMetricsSnapshot().oversizedRequestsRejectedTotal;
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(getMetricsSnapshot().oversizedRequestsRejectedTotal).toBe(before + 1);
  });

  test("logs a warning with request details when JSON body is oversized", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "JSON body exceeds size limit — rejected",
      expect.objectContaining({
        path: "/json",
        method: "POST",
        limit: 200,
        detectionMethod: "express-json-parser",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Multipart / non-JSON body size enforcement
// ---------------------------------------------------------------------------
describe("Multipart body size enforcement", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
    app = buildTestApp({ jsonLimit: 200, multipartLimit: 500 });
  });

  test("accepts a multipart body under the limit", async () => {
    const smallData = Buffer.alloc(100, "a");

    const res = await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", String(smallData.length))
      .send(smallData);

    // The upload route may respond 200 or the request may complete without 413
    expect(res.status).not.toBe(413);
  });

  test("returns 413 when Content-Length header declares oversized multipart body", async () => {
    const res = await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", "600") // over 500-byte limit
      .send(Buffer.alloc(10, "a")); // actual body doesn't matter — header check fires first

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  test("returns 413 for oversized multipart body exceeding 50 KB default limit", async () => {
    const bigApp = buildTestApp({ jsonLimit: MAX_JSON_BYTES, multipartLimit: MAX_MULTIPART_BYTES });
    const oversized = Buffer.alloc(MAX_MULTIPART_BYTES + 1000, "x");

    const res = await request(bigApp)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", String(oversized.length))
      .send(oversized);

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("payload_too_large");
  });

  test("increments oversized_requests metric for oversized multipart", async () => {
    const before = getMetricsSnapshot().oversizedRequestsRejectedTotal;

    await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", "9999")
      .send(Buffer.alloc(10, "a"));

    expect(getMetricsSnapshot().oversizedRequestsRejectedTotal).toBe(before + 1);
  });

  test("logs a warning with detection method for oversized multipart body", async () => {
    await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", "9999")
      .send(Buffer.alloc(10, "a"));

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Request body exceeds size limit — rejected",
      expect.objectContaining({
        path: "/upload",
        method: "POST",
        detectionMethod: "content-length-header",
        declared: 9999,
        limit: 500,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3: DoS rate limiting on repeated oversized requests
// ---------------------------------------------------------------------------
describe("DoS rate limiting on repeated oversized payloads", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
    // dosMax: 3 means first 3 oversized requests get 413, then 429
    app = buildTestApp({ jsonLimit: 200, multipartLimit: 500, dosMax: 3 });
  });

  test("first oversized request returns 413, not 429", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    const res = await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(413);
  });

  test("returns 429 after repeated oversized requests exceed the DoS threshold", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    // Exhaust the DoS allowance (dosMax = 3)
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(oversized);
    }

    // The 4th oversized request should be DoS rate-limited
    const res = await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe("too_many_requests");
  });

  test("429 response includes Retry-After header", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(oversized);
    }

    const res = await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(parseInt(res.headers["retry-after"], 10)).toBeGreaterThan(0);
  });

  test("logs DoS attack warning when rate limit fires", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(oversized);
    }

    await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Suspected DoS attack: repeated oversized payloads",
      expect.objectContaining({
        path: "/json",
        method: "POST",
      }),
    );
  });

  test("increments dosRateLimitedTotal metric when DoS limiter fires", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(300) });

    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/json")
        .set("Content-Type", "application/json")
        .send(oversized);
    }

    const before = getMetricsSnapshot().dosRateLimitedTotal;

    await request(app)
      .post("/json")
      .set("Content-Type", "application/json")
      .send(oversized);

    expect(getMetricsSnapshot().dosRateLimitedTotal).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: createBodySizeLimiters integration
// ---------------------------------------------------------------------------
describe("createBodySizeLimiters factory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
  });

  test("returns an array of middleware", () => {
    const limiters = createBodySizeLimiters({ jsonLimit: 200, multipartLimit: 500 });
    expect(Array.isArray(limiters)).toBe(true);
    expect(limiters.length).toBeGreaterThan(0);
    for (const mw of limiters) {
      expect(typeof mw).toBe("function");
    }
  });

  test("normal JSON request flows through without interference", async () => {
    const app = expressDefault();
    app.use(...createBodySizeLimiters({ jsonLimit: 200, multipartLimit: 500 }));
    app.post("/test", (req, res) => res.json({ ok: true, body: req.body }));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ hello: "world" }));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.body.hello).toBe("world");
  });

  test("oversized JSON is rejected with 413", async () => {
    const app = expressDefault();
    app.use(...createBodySizeLimiters({ jsonLimit: 200, multipartLimit: 500 }));
    app.post("/test", (req, res) => res.json({ ok: true }));
    app.use((err, _req, res, _next) => {
      if (err.type === "entity.too.large") return res.status(413).json({ code: "payload_too_large" });
      res.status(500).json({ error: err.message });
    });

    const res = await request(app)
      .post("/test")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(300) }));

    expect(res.status).toBe(413);
  });

  test("oversized multipart is rejected with 413", async () => {
    const app = expressDefault();
    app.use(...createBodySizeLimiters({ jsonLimit: 200, multipartLimit: 500 }));
    app.post("/upload", (req, res) => {
      req.resume();
      req.on("end", () => res.json({ ok: true }));
    });
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

    const res = await request(app)
      .post("/upload")
      .set("Content-Type", "multipart/form-data")
      .set("Content-Length", "999")
      .send(Buffer.alloc(10));

    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Prometheus metrics output includes DoS counters
// ---------------------------------------------------------------------------
describe("Prometheus metrics include DoS counters", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
  });

  test("prometheusMetrics output includes oversized_requests counter", async () => {
    const { prometheusMetrics } = await import("../src/metrics.js");
    const output = await prometheusMetrics();
    expect(output).toContain("stellar_oversized_requests_rejected_total");
    expect(output).toContain("# TYPE stellar_oversized_requests_rejected_total counter");
  });

  test("prometheusMetrics output includes dos_rate_limited counter", async () => {
    const { prometheusMetrics } = await import("../src/metrics.js");
    const output = await prometheusMetrics();
    expect(output).toContain("stellar_dos_rate_limited_total");
    expect(output).toContain("# TYPE stellar_dos_rate_limited_total counter");
  });

  test("counter values update correctly after rejections", async () => {
    const { recordOversizedRequest, recordDoSRejection, getMetricsSnapshot: snap } =
      await import("../src/metrics.js");

    recordOversizedRequest();
    recordOversizedRequest();
    recordDoSRejection();

    const s = snap();
    expect(s.oversizedRequestsRejectedTotal).toBe(2);
    expect(s.dosRateLimitedTotal).toBe(1);
  });
});
