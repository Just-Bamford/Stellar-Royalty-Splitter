/**
 * Sustained Load Test — #611
 *
 * Long-running test for memory leak detection and performance stability.
 * Runs 30 VUs for 30 minutes with realistic think times.
 *
 * Thresholds:
 *   - HTTP failure rate < 1%
 *   - P95 response time < 3000ms (allowing for db load)
 *   - No memory growth trend (analyzed post-run)
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const failureRate = new Rate("failed_requests");
const responseTime = new Trend("response_time");

export const options = {
  stages: [
    { duration: "2m", target: 10 },     // Gradual ramp up
    { duration: "3m", target: 30 },     // Increase to target
    { duration: "25m", target: 30 },    // Sustained load
    { duration: "2m", target: 0 },      // Cool down
  ],
  thresholds: {
    failed_requests: ["rate<0.01"],
    http_req_duration: ["p(95)<3000", "p(99)<8000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001/api/v1";
const CONTRACT_IDS = ["demo-contract", "test-contract-a", "test-contract-b"];

export default function () {
  // Rotate through multiple contracts to simulate realistic workload
  const contractId = CONTRACT_IDS[Math.floor(Math.random() * CONTRACT_IDS.length)];

  group("Sustained Analytics", () => {
    const res = http.get(`${BASE_URL}/analytics/${contractId}`, {
      tags: { endpoint: "analytics", contract: contractId },
    });
    check(res, {
      "analytics status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(3);
  });

  group("Sustained Snapshots", () => {
    const res = http.get(`${BASE_URL}/snapshots/${contractId}`, {
      tags: { endpoint: "snapshots", contract: contractId },
    });
    check(res, {
      "snapshots status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(2);
  });

  group("Sustained Volume Analytics", () => {
    const res = http.get(`${BASE_URL}/analytics/${contractId}/volume`, {
      tags: { endpoint: "volume", contract: contractId },
    });
    check(res, {
      "volume analytics status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(2);
  });

  group("Sustained Health Check", () => {
    const res = http.get(`${BASE_URL.replace("/api/v1", "/api/v1/health")}`);
    check(res, {
      "health check status is 200": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
    sleep(5);
  });
}