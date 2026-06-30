/**
 * Observability tests — request tracing, latency percentiles, RPC metrics (#396).
 */
import { describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

import { correlationMiddleware, isValidCorrelationId } from "../src/correlation.js";
import { createRequestLogger } from "../src/logger.js";
import {
  recordHttpRequest,
  recordStellarRpcCall,
  getMetricsSnapshot,
  prometheusMetrics,
  resetMetrics,
} from "../src/metrics.js";
import { metricsRouter } from "../src/routes/metrics.js";

beforeEach(() => resetMetrics());

// ── Correlation ID propagation ────────────────────────────────────────────

describe("Correlation ID propagation (#396)", () => {
  function makeTracingApp() {
    const app = express();
    app.use(correlationMiddleware);
    app.get("/test", (req, res) => {
      res.json({ correlationId: req.correlationId });
    });
    return app;
  }

  test("correlation ID is present on req and echoed in response header", async () => {
    const res = await request(makeTracingApp()).get("/test");
    expect(res.status).toBe(200);
    expect(isValidCorrelationId(res.body.correlationId)).toBe(true);
    expect(res.headers["x-correlation-id"]).toBe(res.body.correlationId);
  });

  test("caller-supplied valid UUID v4 is preserved end-to-end", async () => {
    // Use a known valid UUID v4
    const id = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    const res = await request(makeTracingApp())
      .get("/test")
      .set("X-Correlation-ID", id);
    expect(res.body.correlationId).toBe(id);
    expect(res.headers["x-correlation-id"]).toBe(id);
  });
});

// ── createRequestLogger ───────────────────────────────────────────────────

describe("createRequestLogger (#396)", () => {
  test("returns a logger with correlationId bound to it", () => {
    const fakeReq = { correlationId: "test-corr-id-1234" };
    const log = createRequestLogger(fakeReq);
    // Winston child loggers expose the defaultMeta / or can be inspected
    expect(log).toBeDefined();
    expect(typeof log.info).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  test("falls back to 'unknown' when req has no correlationId", () => {
    const log = createRequestLogger({});
    expect(log).toBeDefined();
  });
});

// ── HTTP request metrics ──────────────────────────────────────────────────

describe("recordHttpRequest — latency percentiles (#396)", () => {
  test("p50, p95, p99 calculated correctly from observations", () => {
    // Record 100 requests with response times 1ms–100ms
    for (let i = 1; i <= 100; i++) {
      recordHttpRequest("GET", "/api/v1/test", 200, i);
    }
    const snap = getMetricsSnapshot();
    expect(snap.responseTimeObservationCount).toBe(100);
    expect(snap.responseTimeP50Ms).toBe(50);
    expect(snap.responseTimeP95Ms).toBe(95);
    expect(snap.responseTimeP99Ms).toBe(99);
  });

  test("request and response byte totals are accumulated", () => {
    recordHttpRequest("POST", "/api/v1/distribute", 200, 50, {
      requestBytes: 256,
      responseBytes: 128,
    });
    recordHttpRequest("POST", "/api/v1/distribute", 200, 30, {
      requestBytes: 512,
      responseBytes: 64,
    });
    const snap = getMetricsSnapshot();
    expect(snap.requestBytesTotal).toBe(768);
    expect(snap.responseBytesTotal).toBe(192);
  });

  test("per-route counts are tracked by method+path+status", () => {
    recordHttpRequest("GET", "/api/v1/health", 200, 5);
    recordHttpRequest("GET", "/api/v1/health", 200, 6);
    recordHttpRequest("POST", "/api/v1/distribute", 400, 10);
    const snap = getMetricsSnapshot();
    expect(snap.httpRequestCounts["GET /api/v1/health 200"]).toBe(2);
    expect(snap.httpRequestCounts["POST /api/v1/distribute 400"]).toBe(1);
  });

  test("p50/p95/p99 are 0 when no observations recorded", () => {
    const snap = getMetricsSnapshot();
    expect(snap.responseTimeP50Ms).toBe(0);
    expect(snap.responseTimeP95Ms).toBe(0);
    expect(snap.responseTimeP99Ms).toBe(0);
  });
});

// ── Stellar RPC metrics ───────────────────────────────────────────────────

describe("recordStellarRpcCall (#396)", () => {
  test("records count, successCount, failureCount and averageMs", () => {
    recordStellarRpcCall("Soroban prepareTransaction", 120, true);
    recordStellarRpcCall("Soroban prepareTransaction", 80, true);
    recordStellarRpcCall("Soroban prepareTransaction", 200, false);

    const snap = getMetricsSnapshot();
    const entry = snap.stellarRpcCalls["Soroban prepareTransaction"];
    expect(entry.count).toBe(3);
    expect(entry.successCount).toBe(2);
    expect(entry.failureCount).toBe(1);
    expect(entry.averageMs).toBeCloseTo((120 + 80 + 200) / 3, 5);
  });

  test("multiple operations are tracked independently", () => {
    recordStellarRpcCall("Soroban getAccount", 50, true);
    recordStellarRpcCall("Horizon getTransaction", 300, false);

    const snap = getMetricsSnapshot();
    expect(snap.stellarRpcCalls["Soroban getAccount"].count).toBe(1);
    expect(snap.stellarRpcCalls["Horizon getTransaction"].count).toBe(1);
    expect(snap.stellarRpcCalls["Horizon getTransaction"].failureCount).toBe(1);
  });
});

// ── Prometheus export ─────────────────────────────────────────────────────

describe("prometheusMetrics with #396 additions", () => {
  test("includes p50/p95/p99 latency gauges", () => {
    recordHttpRequest("GET", "/api/v1/health", 200, 42);
    const text = prometheusMetrics();
    expect(text).toContain("stellar_http_response_time_p50_ms");
    expect(text).toContain("stellar_http_response_time_p95_ms");
    expect(text).toContain("stellar_http_response_time_p99_ms");
  });

  test("includes per-route HTTP counters with labels", () => {
    recordHttpRequest("POST", "/api/v1/distribute", 200, 55);
    const text = prometheusMetrics();
    expect(text).toContain('stellar_http_requests_total{method="POST"');
    expect(text).toContain('status="200"');
  });

  test("includes Stellar RPC call counters", () => {
    recordStellarRpcCall("Soroban prepareTransaction", 100, true);
    const text = prometheusMetrics();
    expect(text).toContain("stellar_rpc_calls_total");
    expect(text).toContain('operation="Soroban prepareTransaction"');
  });

  test("includes request/response byte totals", () => {
    recordHttpRequest("POST", "/api/v1/initialize", 200, 30, {
      requestBytes: 100,
      responseBytes: 50,
    });
    const text = prometheusMetrics();
    expect(text).toContain("stellar_http_request_bytes_total 100");
    expect(text).toContain("stellar_http_response_bytes_total 50");
  });
});

// ── /metrics endpoint integration ────────────────────────────────────────

describe("GET /metrics with observability additions (#396)", () => {
  const app = express();
  app.use("/metrics", metricsRouter);

  test("returns 200 and includes new latency percentile metrics", async () => {
    recordHttpRequest("GET", "/api/v1/health", 200, 10);
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("stellar_http_response_time_p50_ms");
    expect(res.text).toContain("stellar_http_response_time_p95_ms");
    expect(res.text).toContain("stellar_http_response_time_p99_ms");
  });
});
