/**
 * HTTP request metrics (#935) and canary traffic shadowing (#936).
 */
import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

import { httpMetricsMiddleware } from "../src/middleware/http-metrics.js";
import { createTrafficShadowMiddleware, SHADOW_HEADER } from "../src/middleware/traffic-shadow.js";
import { prometheusMetrics, resetMetrics } from "../src/metrics.js";

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("httpMetricsMiddleware", () => {
  beforeEach(() => resetMetrics());

  test("labels by route pattern, not raw URL", async () => {
    const app = express();
    app.use(httpMetricsMiddleware);
    const router = express.Router();
    router.get("/:contractId", (_req, res) => res.json({ ok: true }));
    router.get("/", (_req, res) => res.json({ ok: true }));
    app.use("/api/v1/history", router);
    app.get("/boom", (_req, res) => res.status(500).end());

    await request(app).get("/api/v1/history/CAAA");
    await request(app).get("/api/v1/history/CBBB");
    await request(app).get("/api/v1/history");
    await request(app).get("/boom");
    await request(app).get("/nope");

    const text = await prometheusMetrics();
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/api\/v1\/history\/:contractId",status="200"\} 2/);
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/api\/v1\/history",status="200"\} 1/);
    expect(text).toMatch(/http_requests_total\{method="GET",route="\/boom",status="500"\} 1/);
    expect(text).toMatch(/http_requests_total\{method="GET",route="unmatched",status="404"\} 1/);
    expect(text).not.toMatch(/CAAA/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{le="0.01",method="GET",route="\/boom",status="500"\}/);
  });
});

describe("traffic shadow middleware", () => {
  beforeEach(() => resetMetrics());

  function buildApp(options) {
    const app = express();
    app.use(express.json());
    app.use(createTrafficShadowMiddleware(options));
    app.get("/api/v1/history/:id", (_req, res) => res.json({ source: "stable" }));
    app.post("/api/v1/distribute", (_req, res) => res.json({ source: "stable" }));
    app.get("/admin/key-status", (_req, res) => res.json({}));
    return app;
  }

  test("is a no-op without SHADOW_TARGET_URL", async () => {
    const fetchImpl = jest.fn();
    const app = buildApp({ targetUrl: "", fetchImpl });
    await request(app).get("/api/v1/history/1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("mirrors GET requests to the canary without affecting the response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    const app = buildApp({ targetUrl: "http://canary.local:3002", fetchImpl });

    const res = await request(app).get("/api/v1/history/1?limit=5").set("Authorization", "Bearer secret");
    expect(res.body).toEqual({ source: "stable" });

    await waitFor(() => fetchImpl.mock.calls.length === 1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("http://canary.local:3002/api/v1/history/1?limit=5");
    expect(init.method).toBe("GET");
    expect(init.headers[SHADOW_HEADER]).toBe("1");
    expect(init.headers.authorization).toBeUndefined();

    await new Promise((r) => setTimeout(r, 50));
    expect(await prometheusMetrics()).toMatch(/stellar_shadow_requests_total\{result="match"\} 1/);
  });

  test("never mirrors writes, admin routes, or already-mirrored requests", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    const app = buildApp({ targetUrl: "http://canary.local:3002", fetchImpl });

    await request(app).post("/api/v1/distribute").send({});
    await request(app).get("/admin/key-status");
    await request(app).get("/api/v1/history/1").set(SHADOW_HEADER, "1");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("records mismatches and errors from the canary", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 503, arrayBuffer: async () => new ArrayBuffer(0) })
      .mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const app = buildApp({ targetUrl: "http://canary.local:3002", fetchImpl });

    await request(app).get("/api/v1/history/1");
    await request(app).get("/api/v1/history/2");
    await waitFor(() => fetchImpl.mock.calls.length === 2);
    await new Promise((r) => setTimeout(r, 50));

    const text = await prometheusMetrics();
    expect(text).toMatch(/stellar_shadow_requests_total\{result="mismatch"\} 1/);
    expect(text).toMatch(/stellar_shadow_requests_total\{result="error"\} 1/);
  });

  test("respects the sample rate", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) });
    const app = buildApp({ targetUrl: "http://canary.local:3002", fetchImpl, sampleRate: 0.5, random: () => 0.9 });
    await request(app).get("/api/v1/history/1");
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
