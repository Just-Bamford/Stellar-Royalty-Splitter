/**
 * Issue #409 — k6 load test for POST /api/v1/distribute
 *
 * Simulates 100 concurrent users sending distribute requests over 30 seconds.
 * Passes only if:
 *   - p95 response time < 200 ms
 *   - p99 response time < 500 ms
 *   - error rate < 1 %
 *   - HTTP 200 rate > 99 %
 *
 * Run with:
 *   k6 run tests/load/distribute-load.js
 *
 * Override the target URL at runtime:
 *   BASE_URL=http://localhost:4000 k6 run tests/load/distribute-load.js
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

// ── Custom metrics ─────────────────────────────────────────────────────────────

const errorRate = new Rate("distribute_errors");
const p95Trend  = new Trend("distribute_response_time");

// ── Test configuration ─────────────────────────────────────────────────────────

export const options = {
  // 100 virtual users for 30 seconds
  vus: 100,
  duration: "30s",

  thresholds: {
    // p95 must be under 200 ms
    http_req_duration: ["p(95)<200", "p(99)<500"],
    // Custom error rate must stay below 1 %
    distribute_errors: ["rate<0.01"],
    // At least 99 % of requests must return HTTP 200
    http_req_failed: ["rate<0.01"],
  },
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

// Valid-shaped Stellar addresses (56-char base-32 encoded strings).
// These do not resolve to real contracts; the backend builds unsigned XDR
// without on-chain verification, so the addresses just need to pass
// the format validation layer.
const CONTRACT_ID  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_ADDR  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_IDS    = [
  "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  "CEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  "CFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
];

const HEADERS = {
  "Content-Type": "application/json",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Pick a token from the pool using the VU number so each virtual user
 * targets a slightly different token, distributing load more realistically.
 */
function pickToken() {
  return TOKEN_IDS[(__VU - 1) % TOKEN_IDS.length];
}

/**
 * Generate a simple idempotency key per VU + iteration so we don't
 * accidentally trigger cached responses from the server's idempotency layer.
 */
function idempotencyKey() {
  return `load-vu${__VU}-iter${__ITER}`;
}

// ── Main scenario ──────────────────────────────────────────────────────────────

export default function distributeLoad() {
  const url  = `${BASE_URL}/api/v1/distribute`;
  const body = JSON.stringify({
    contractId:    CONTRACT_ID,
    walletAddress: WALLET_ADDR,
    tokenId:       pickToken(),
  });
  const params = {
    headers: {
      ...HEADERS,
      "Idempotency-Key": idempotencyKey(),
    },
    tags: { name: "distribute" },
  };

  const res = http.post(url, body, params);

  // Record response time in custom trend.
  p95Trend.add(res.timings.duration);

  // Determine if this was an error (anything other than 200 or 400).
  // 400 responses are valid test outcomes when validation fires; they are fast
  // by design. Treat 5xx as errors for the rate threshold.
  const isError = res.status >= 500;
  errorRate.add(isError);

  check(res, {
    "status is 200 or 400": (r) => r.status === 200 || r.status === 400,
    "response time < 500ms": (r) => r.timings.duration < 500,
    "has JSON body": (r) => {
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });

  // Brief think-time between requests so we don't saturate the local loopback.
  sleep(0.1);
}

// ── Setup / teardown hooks (optional smoke check) ─────────────────────────────

export function setup() {
  // Verify the server is reachable before the load run starts.
  const healthUrl = `${BASE_URL}/api/v1/health`;
  const res = http.get(healthUrl, { tags: { name: "health-check" } });
  if (res.status !== 200) {
    console.warn(
      `[setup] Health check returned ${res.status}. ` +
      `Server may not be ready — proceeding anyway.`
    );
  }
}

// ── Ramp scenario (alternative — uncomment to use instead of constant VUs) ────
//
// export const options = {
//   scenarios: {
//     distribute_ramp: {
//       executor: "ramping-vus",
//       startVUs: 0,
//       stages: [
//         { duration: "10s", target: 100 },  // ramp up to 100 VUs
//         { duration: "20s", target: 100 },  // hold at 100 VUs
//         { duration: "5s",  target: 0   },  // ramp down
//       ],
//     },
//   },
//   thresholds: {
//     http_req_duration: ["p(95)<200", "p(99)<500"],
//     distribute_errors: ["rate<0.01"],
//     http_req_failed:   ["rate<0.01"],
//   },
// };
