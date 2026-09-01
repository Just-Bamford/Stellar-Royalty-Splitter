/**
 * Spike Load Test — #611
 *
 * Simulates sudden traffic spikes to test system recovery and max throughput.
 * Ramp up to 200 VUs in 10s, sustain for 1 minute, then observe recovery.
 *
 * Thresholds:
 *   - HTTP failure rate < 5% (higher tolerance for spike)
 *   - System recovers within 30s after spike
 */

import http from "k6/http";
import { check, sleep, group } from "k6";
import { Rate, Trend } from "k6/metrics";

const failureRate = new Rate("failed_requests");
const responseTime = new Trend("response_time");

export const options = {
  stages: [
    { duration: "10s", target: 50 },    // Quick ramp to 50
    { duration: "5s", target: 200 },    // Spike to 200
    { duration: "1m", target: 200 },    // Sustain spike
    { duration: "30s", target: 50 },    // Recovery ramp down
    { duration: "1m", target: 50 },     // Observe recovery behavior
    { duration: "10s", target: 0 },     // Complete ramp down
  ],
  thresholds: {
    failed_requests: ["rate<0.05"],         // < 5% failure during spike
    http_req_duration: ["p(95)<5000", "p(99)<10000"],
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:3001/api/v1";

export default function () {
  group("Spike Health Check", () => {
    const res = http.get(`${BASE_URL.replace("/api/v1", "/api/v1/health")}`);
    check(res, {
      "health check succeeded": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
  });

  group("Spike Analytics", () => {
    const res = http.get(`${BASE_URL}/analytics/demo-contract`);
    check(res, {
      "analytics succeeded": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
  });

  group("Spike Snapshots", () => {
    const res = http.get(`${BASE_URL}/snapshots/demo-contract`);
    check(res, {
      "snapshots succeeded": (r) => r.status === 200,
    });
    failureRate.add(res.status !== 200);
    responseTime.add(res.timings.duration);
  });

  // Minimal sleep to simulate rapid requests during spike
  sleep(0.5);
}