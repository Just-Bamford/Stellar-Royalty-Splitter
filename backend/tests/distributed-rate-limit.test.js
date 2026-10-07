/**
 * Unit & Integration Tests for Distributed Rate Limiter & Middleware (#978).
 *
 * Uses ioredis-mock to simulate multi-instance distributed rate limiting backed by Redis.
 *
 * Covers:
 *  1. Primary flow: Within limit succeeds, exceeding limit denied with 429.
 *  2. Boundary case: Burst allowance permits spikes up to max capacity, then throttles to steady rate.
 *  3. Failure case: Redis outage with fail-open and fail-closed configurations.
 *  4. High concurrency: Concurrent requests across multiple mock instances respecting shared bucket.
 *  5. Adaptive rate limiting: Error spike reduces capacity, then recovers.
 *  6. Sliding window algorithm: Guarantees strict request window.
 *  7. Express middleware: Header generation and HTTP 429 payload verification via supertest.
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import RedisMock from "ioredis-mock";
import express from "express";
import request from "supertest";

import {
  DistributedRateLimiter,
  buildRateLimitKey,
} from "../src/rate-limiter/distributed.js";
import {
  createDistributedRateLimit,
  defaultKeyGenerator,
  defaultEndpointGenerator,
} from "../src/middleware/distributed-rate-limit.js";

const SHARED_REDIS_URL = "redis://mock-cluster:6379";

describe("Distributed Rate Limiter Service (#978)", () => {
  let redisClient;
  let limiter;

  beforeEach(() => {
    redisClient = new RedisMock(SHARED_REDIS_URL);
    limiter = new DistributedRateLimiter({
      redisClient,
      defaultCapacity: 5,
      defaultRefillRate: 1, // 1 token per second
      failOpen: true,
      adaptiveEnabled: true,
      minRequestsForAdaptive: 3,
      errorThreshold: 0.5,
      adaptivePenaltyMultiplier: 0.5,
    });
  });

  afterEach(async () => {
    if (redisClient) {
      await redisClient.flushall();
    }
  });

  // -------------------------------------------------------------------------
  // 1. Key generation & validation
  // -------------------------------------------------------------------------
  describe("buildRateLimitKey", () => {
    test("builds namespaced Redis keys correctly", () => {
      const key = buildRateLimitKey("tb", "user_123", "/api/v1/distribute");
      expect(key).toBe("srs:ratelimit:tb:user_123:/api/v1/distribute");
    });

    test("throws TypeError for invalid or empty keys", () => {
      expect(() => buildRateLimitKey("tb", "", "/api")).toThrow(TypeError);
      expect(() => buildRateLimitKey("tb", "user", "")).toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Primary Flow (Token Bucket)
  // -------------------------------------------------------------------------
  describe("Primary Flow (Token Bucket)", () => {
    test("requests within limit are allowed and consume tokens", async () => {
      const userKey = "user_primary";
      const endpoint = "GET:/api/v1/analytics";

      const res1 = await limiter.consumeTokenBucket(userKey, endpoint, {
        capacity: 3,
        refillRatePerSec: 1,
      });
      expect(res1.allowed).toBe(true);
      expect(res1.remaining).toBe(2);
      expect(res1.limit).toBe(3);

      const res2 = await limiter.consumeTokenBucket(userKey, endpoint, {
        capacity: 3,
        refillRatePerSec: 1,
      });
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(1);

      const res3 = await limiter.consumeTokenBucket(userKey, endpoint, {
        capacity: 3,
        refillRatePerSec: 1,
      });
      expect(res3.allowed).toBe(true);
      expect(res3.remaining).toBe(0);

      // 4th request exceeds capacity
      const res4 = await limiter.consumeTokenBucket(userKey, endpoint, {
        capacity: 3,
        refillRatePerSec: 1,
      });
      expect(res4.allowed).toBe(false);
      expect(res4.remaining).toBe(0);
      expect(res4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Boundary Case: Burst Allowance
  // -------------------------------------------------------------------------
  describe("Boundary Case: Burst Allowance", () => {
    test("permits instant burst up to capacity, then enforces steady refill rate", async () => {
      const userKey = "user_burst";
      const endpoint = "POST:/api/v1/distribute";
      const capacity = 10;
      const refillRatePerSec = 2; // 2 tokens/sec

      // Burst of 10 requests should all succeed
      for (let i = 0; i < capacity; i++) {
        const res = await limiter.consumeTokenBucket(userKey, endpoint, {
          capacity,
          refillRatePerSec,
        });
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(capacity - (i + 1));
      }

      // 11th request immediately rejected (bucket exhausted)
      const rejected = await limiter.consumeTokenBucket(userKey, endpoint, {
        capacity,
        refillRatePerSec,
      });
      expect(rejected.allowed).toBe(false);
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Failure Cases: Redis Unavailability
  // -------------------------------------------------------------------------
  describe("Failure Case: Redis Unavailability", () => {
    test("fails open by default when Redis is unavailable", async () => {
      const brokenLimiter = new DistributedRateLimiter({
        redisClient: {
          eval: () => Promise.reject(new Error("Redis connection timed out")),
        },
        failOpen: true,
        defaultCapacity: 50,
      });

      const res = await brokenLimiter.consumeTokenBucket("user_fail", "GET:/test");
      expect(res.allowed).toBe(true);
      expect(res.fallback).toBe(true);
      expect(res.retryAfterSeconds).toBe(0);
    });

    test("fails closed when configured with failOpen: false", async () => {
      const strictLimiter = new DistributedRateLimiter({
        redisClient: {
          eval: () => Promise.reject(new Error("Redis connection refused")),
        },
        failOpen: false,
        defaultCapacity: 50,
      });

      const res = await strictLimiter.consumeTokenBucket("user_strict", "POST:/withdraw");
      expect(res.allowed).toBe(false);
      expect(res.fallback).toBe(true);
      expect(res.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Multi-Instance Concurrency (Under Load)
  // -------------------------------------------------------------------------
  describe("Multi-Instance Concurrency Under Load", () => {
    test("concurrent requests across distinct limiter instances respect shared bucket", async () => {
      const instanceA = new DistributedRateLimiter({ redisClient });
      const instanceB = new DistributedRateLimiter({ redisClient });
      const instanceC = new DistributedRateLimiter({ redisClient });

      const sharedUser = "shared_collaborator";
      const sharedEndpoint = "POST:/api/v1/royalties/claim";
      const capacity = 15;
      const refillRatePerSec = 1;

      // Dispatch 30 concurrent requests evenly split across 3 instances
      const requests = [];
      for (let i = 0; i < 30; i++) {
        const selectedInstance = i % 3 === 0 ? instanceA : i % 3 === 1 ? instanceB : instanceC;
        requests.push(
          selectedInstance.consumeTokenBucket(sharedUser, sharedEndpoint, {
            capacity,
            refillRatePerSec,
          })
        );
      }

      const results = await Promise.all(requests);
      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;

      // Exactly capacity (15) requests must be allowed, and 15 denied
      expect(allowedCount).toBe(capacity);
      expect(deniedCount).toBe(30 - capacity);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Adaptive Rate Limiting
  // -------------------------------------------------------------------------
  describe("Adaptive Rate Limiting", () => {
    test("reduces capacity when error rate spikes, and recovers when errors subside", async () => {
      const userKey = "user_adaptive";
      const endpoint = "POST:/api/v1/distribute";

      const adaptiveLimiter = new DistributedRateLimiter({
        redisClient,
        defaultCapacity: 10,
        defaultRefillRate: 5,
        adaptiveEnabled: true,
        minRequestsForAdaptive: 4,
        errorThreshold: 0.5,
        adaptivePenaltyMultiplier: 0.4, // Reduces capacity to 4
      });

      // Normal state: capacity = 10
      const normalRes = await adaptiveLimiter.consumeTokenBucket(userKey, endpoint);
      expect(normalRes.limit).toBe(10);
      expect(normalRes.adaptiveApplied).toBe(false);

      // Simulate an error spike: 3 errors out of 4 requests (75% error rate > 50% threshold)
      await adaptiveLimiter.recordResult(userKey, endpoint, true);
      await adaptiveLimiter.recordResult(userKey, endpoint, true);
      await adaptiveLimiter.recordResult(userKey, endpoint, true);
      await adaptiveLimiter.recordResult(userKey, endpoint, false);

      // Next request should encounter reduced adaptive limit (10 * 0.4 = 4)
      const throttledRes = await adaptiveLimiter.consumeTokenBucket(userKey, endpoint);
      expect(throttledRes.limit).toBe(4);
      expect(throttledRes.adaptiveApplied).toBe(true);

      // Errors subside: record successful requests to drop error ratio below 50%
      await adaptiveLimiter.recordResult(userKey, endpoint, false);
      await adaptiveLimiter.recordResult(userKey, endpoint, false);
      await adaptiveLimiter.recordResult(userKey, endpoint, false);
      await adaptiveLimiter.recordResult(userKey, endpoint, false);

      // Effective limit recovers to standard 10
      const recoveredRes = await adaptiveLimiter.consumeTokenBucket(userKey, endpoint);
      expect(recoveredRes.limit).toBe(10);
      expect(recoveredRes.adaptiveApplied).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Sliding Window Algorithm
  // -------------------------------------------------------------------------
  describe("Sliding Window Algorithm", () => {
    test("strictly limits requests within specified time window", async () => {
      const userKey = "user_sw";
      const endpoint = "GET:/api/v1/history";
      const limit = 3;
      const windowMs = 5000;

      const r1 = await limiter.consumeSlidingWindow(userKey, endpoint, { limit, windowMs });
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);

      const r2 = await limiter.consumeSlidingWindow(userKey, endpoint, { limit, windowMs });
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await limiter.consumeSlidingWindow(userKey, endpoint, { limit, windowMs });
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);

      const r4 = await limiter.consumeSlidingWindow(userKey, endpoint, { limit, windowMs });
      expect(r4.allowed).toBe(false);
      expect(r4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Express Middleware Integration
  // -------------------------------------------------------------------------
  describe("Express Middleware Integration", () => {
    function buildTestApp(middlewareOptions = {}) {
      const app = express();
      app.use(express.json());

      const rateLimitMiddleware = createDistributedRateLimit({
        limiter,
        capacity: 2,
        refillRatePerSec: 1,
        ...middlewareOptions,
      });

      app.get("/api/test", rateLimitMiddleware, (_req, res) => {
        res.json({ success: true, message: "OK" });
      });

      app.post("/api/error-test", rateLimitMiddleware, (_req, res) => {
        res.status(500).json({ error: "Server failure" });
      });

      return app;
    }

    test("passes allowed requests, sets headers, and blocks excess with 429", async () => {
      const app = buildTestApp();

      // Request 1: Allowed
      const res1 = await request(app)
        .get("/api/test")
        .set("X-API-Key", "api-key-test-1");

      expect(res1.status).toBe(200);
      expect(res1.headers["x-ratelimit-limit"]).toBe("2");
      expect(res1.headers["x-ratelimit-remaining"]).toBe("1");
      expect(res1.headers["x-ratelimit-reset"]).toBeDefined();

      // Request 2: Allowed
      const res2 = await request(app)
        .get("/api/test")
        .set("X-API-Key", "api-key-test-1");

      expect(res2.status).toBe(200);
      expect(res2.headers["x-ratelimit-remaining"]).toBe("0");

      // Request 3: Denied with 429
      const res3 = await request(app)
        .get("/api/test")
        .set("X-API-Key", "api-key-test-1");

      expect(res3.status).toBe(429);
      expect(res3.headers["retry-after"]).toBeDefined();
      expect(res3.body.code).toBe("too_many_requests");
      expect(res3.body.error).toContain("Rate limit exceeded");
    });

    test("skips rate limiting when skip predicate returns true", async () => {
      const app = buildTestApp({
        skip: (req) => req.headers["x-bypass-rate-limit"] === "true",
      });

      for (let i = 0; i < 5; i++) {
        const res = await request(app)
          .get("/api/test")
          .set("x-bypass-rate-limit", "true");
        expect(res.status).toBe(200);
      }
    });

    test("default key and endpoint generators work as expected", () => {
      const reqWithKey = { headers: { "x-api-key": "secret-key" }, ip: "127.0.0.1" };
      expect(defaultKeyGenerator(reqWithKey)).toBe("apikey:secret-key");

      const reqWithUser = { headers: {}, user: { id: "user_42" }, ip: "127.0.0.1" };
      expect(defaultKeyGenerator(reqWithUser)).toBe("user:user_42");

      const reqWithWallet = { headers: {}, body: { walletAddress: "GBB123" }, ip: "127.0.0.1" };
      expect(defaultKeyGenerator(reqWithWallet)).toBe("wallet:GBB123");

      const reqWithIp = { headers: {}, ip: "192.168.1.1" };
      expect(defaultKeyGenerator(reqWithIp)).toBe("ip:192.168.1.1");

      const reqEndpoint = { method: "POST", baseUrl: "/api/v1", route: { path: "/contracts/:id" } };
      expect(defaultEndpointGenerator(reqEndpoint)).toBe("POST:/api/v1/contracts/:id");
    });
  });
});
