/**
 * Response Time Middleware and APM Metrics Tests (#985)
 */
import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

import { responseTimeMiddleware, routeLabel } from "../src/middleware/response-time.js";
import {
  recordEndpointResponseTime,
  getEndpointMetrics,
  getAllEndpointMetrics,
  resetEndpointMetrics,
  calculatePercentile,
  prometheusMetrics,
  resetMetrics,
} from "../src/metrics.js";
import logger from "../src/logger.js";

describe("responseTimeMiddleware", () => {
  beforeEach(() => {
    resetMetrics();
    resetEndpointMetrics();
    jest.clearAllMocks();
  });

  test("injects X-Response-Time header formatted in milliseconds", async () => {
    const app = express();
    app.use(responseTimeMiddleware());
    app.get("/api/v1/test", (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/api/v1/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-response-time"]).toBeDefined();
    expect(res.headers["x-response-time"]).toMatch(/^\d+(\.\d+)?ms$/);
  });

  test("normalizes route patterns using routeLabel", async () => {
    const app = express();
    app.use(responseTimeMiddleware());

    const router = express.Router();
    router.get("/:contractId", (_req, res) => res.json({ ok: true }));
    app.use("/api/v1/history", router);

    await request(app).get("/api/v1/history/CAAA123");
    await request(app).get("/api/v1/history/CBBB456");

    const metrics = getEndpointMetrics("GET", "/api/v1/history/:contractId");
    expect(metrics).not.toBeNull();
    expect(metrics.count).toBe(2);
    expect(metrics.route).toBe("/api/v1/history/:contractId");
  });

  test("computes percentiles accurately", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const p50 = calculatePercentile(latencies, 50);
    const p95 = calculatePercentile(latencies, 95);

    expect(p50).toBeCloseTo(55, 0);
    expect(p95).toBeGreaterThan(90);
    expect(calculatePercentile([], 95)).toBe(0);
  });

  test("records endpoint response time and returns APM statistics", () => {
    for (let i = 1; i <= 10; i++) {
      recordEndpointResponseTime("GET", "/api/v1/dashboard", 200, i * 5); // 5ms, 10ms, ..., 50ms
    }

    const stats = getEndpointMetrics("GET", "/api/v1/dashboard");
    expect(stats).not.toBeNull();
    expect(stats.count).toBe(10);
    expect(stats.min).toBe(5);
    expect(stats.max).toBe(50);
    expect(stats.p50).toBeCloseTo(27.5, 0);
    expect(stats.p95).toBeGreaterThan(45);
  });

  test("getAllEndpointMetrics aggregates across multiple routes", () => {
    recordEndpointResponseTime("GET", "/api/v1/health", 200, 2.5);
    recordEndpointResponseTime("POST", "/api/v1/simulate", 200, 15.0);

    const all = getAllEndpointMetrics();
    expect(all.length).toBe(2);

    const health = all.find((m) => m.route === "/api/v1/health");
    const sim = all.find((m) => m.route === "/api/v1/simulate");
    expect(health).toBeDefined();
    expect(sim).toBeDefined();
  });

  test("triggers a critical log and alert when P95 exceeds 100ms threshold", async () => {
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

    // Simulate 10 requests with high latency (> 100ms)
    for (let i = 0; i < 10; i++) {
      recordEndpointResponseTime("GET", "/api/v1/slow-endpoint", 200, 120 + i);
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[CRITICAL] P95 response time alert"),
      expect.objectContaining({
        method: "GET",
        route: "/api/v1/slow-endpoint",
        thresholdMs: 100,
      })
    );

    const metricsText = await prometheusMetrics();
    expect(metricsText).toMatch(/stellar_endpoint_p95_alerts_total/);

    errorSpy.mockRestore();
  });

  test("logs warning when an individual request exceeds slowThresholdMs", async () => {
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});

    const app = express();
    app.use(responseTimeMiddleware({ slowThresholdMs: 50 }));
    app.get("/slow", async (_req, res) => {
      await new Promise((r) => setTimeout(r, 60));
      res.json({ slow: true });
    });

    const res = await request(app).get("/slow");
    expect(res.status).toBe(200);

    expect(warnSpy).toHaveBeenCalledWith(
      "Slow API response time detected",
      expect.objectContaining({
        route: "/slow",
        thresholdMs: 50,
      })
    );

    warnSpy.mockRestore();
  });
});
