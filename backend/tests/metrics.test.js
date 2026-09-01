import { describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

import { metricsRouter } from "../src/routes/metrics.js";
import {
  recordDistributeCall,
  recordHorizonResponseTime,
  recordHttpRequest,
  recordTransactionFailure,
  recordTransactionSuccess,
  resetMetrics,
} from "../src/metrics.js";

const app = express();
app.use("/metrics", metricsRouter);

describe("GET /metrics", () => {
  beforeEach(() => resetMetrics());

  test("returns Prometheus text metrics", async () => {
    recordDistributeCall();
    recordTransactionSuccess();
    recordTransactionFailure();
    recordHorizonResponseTime(20);
    recordHorizonResponseTime(40);
    recordHttpRequest("GET", "/health", 200, 25);

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("stellar_distribute_calls_total 1");
    expect(res.text).toContain("stellar_transactions_successful_total 1");
    expect(res.text).toContain("stellar_transactions_failed_total 1");
    expect(res.text).toContain("stellar_horizon_response_time_average_ms 30");
    expect(res.text).toContain('http_requests_total{method="GET",route="/health",status="200"} 1');
    expect(res.text).toContain('http_request_duration_seconds_count{method="GET",route="/health",status="200"} 1');
  });
});
