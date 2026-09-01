/**
 * Normal Load Test — #611
 *
 * Simulates typical daily traffic with 50 virtual users.
 * Tests: health check, contract info, analytics, and snapshot endpoints.
 *
 * Thresholds:
 *   - HTTP failure rate < 1%
 *   - P95 response time < 2000ms
 *   - P99 response time < 5000ms
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

// Custom metrics
const failureRate = new Rate("failed_requests");
const responseTime = new Trend("response_time");

export const options = {
  stages: [
    { duration: "30s", target: 10 },   // Ramp up to 10 VUs
    { duration: "1m", target: 50 },     // Ramp up to 50 VUs
    { duration: "3m", target: 50 },     // Stay at 50 VUs
    { duration: "30s", target: 0 },     // Ramp down
  ],
  thresholds: {
    failed_requests: ["rate<0.01"],        // < 1% failure rate
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    response_time: ["avg<500"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001/api/v1";

export default function () {
  // Health check endpoint (unauthenticated)
  group("Health Check", () => {
    const res = http.get(`${BASE_URL.replace("/api/v1", "/api/v1/health")}`);
    check(res, {
      "health status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(1);
  });

  // Analytics endpoints
  group("Analytics", () => {
    const res = http.get(`${BASE_URL}/analytics/demo-contract`, {
      tags: { endpoint: "analytics" },
    });
    check(res, {
      "analytics status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(2);
  });

  // Snapshot endpoints
  group("Snapshots", () => {
    const res = http.get(`${BASE_URL}/snapshots/demo-contract`, {
      tags: { endpoint: "snapshots" },
    });
    check(res, {
      "snapshots status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(1);
  });

  // Contract info
  group("Contract Info", () => {
    const res = http.get(`${BASE_URL}/contract/demo-contract`, {
      tags: { endpoint: "contract" },
    });
    check(res, {
      "contract info status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(1);
  });
}