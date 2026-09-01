import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  calculateComplexity,
  DEFAULT_COMPLEXITY_LIMIT,
  getComplexityLimit,
  requestComplexityMiddleware,
} from "../src/request-complexity.js";
import { sendError, notFoundHandler, errorHandler } from "../src/error-response.js";

describe("Request Complexity Calculation — Unit Tests", () => {
  test("returns 1 for null or undefined or empty body", () => {
    expect(calculateComplexity(null)).toBe(1);
    expect(calculateComplexity(undefined)).toBe(1);
    expect(calculateComplexity("")).toBe(1);
  });

  test("primitive values have minimal base complexity", () => {
    expect(calculateComplexity(123)).toBe(1);
    expect(calculateComplexity(true)).toBe(1);
    expect(calculateComplexity("short string")).toBe(1);
  });

  test("large strings contribute proportional to chunk size", () => {
    const longString = "A".repeat(512); // 512 / 256 = 2 extra chunks
    expect(calculateComplexity(longString)).toBe(3); // 1 (base) + 2
  });

  test("field count contributes linearly to score", () => {
    const obj = {};
    for (let i = 0; i < 50; i++) {
      obj[`key_${i}`] = i;
    }
    // Base(1) + Structure(2) + Depth(1*3=3) + 50 keys = 56
    const score = calculateComplexity(obj);
    expect(score).toBe(56);
  });

  test("array element count contributes linearly to score", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    // Base(1) + Structure(2) + Depth(1*3=3) + 100 elements = 106
    const score = calculateComplexity(arr);
    expect(score).toBe(106);
  });

  test("deeply nested objects scale quadratically with depth multiplier", () => {
    // 10 levels of nesting: { a: { a: { ... } } }
    let nested = { value: 1 };
    for (let d = 0; d < 10; d++) {
      nested = { next: nested };
    }
    const score = calculateComplexity(nested);
    expect(score).toBeGreaterThan(100);
  });

  test("earlyExitLimit stops traversal immediately once limit is exceeded", () => {
    // 500 levels of nested objects — total score would normally be > 10,000
    let deepObj = { leaf: "val" };
    for (let i = 0; i < 500; i++) {
      deepObj = { nested: deepObj, key1: i, key2: i };
    }
    const fullScore = calculateComplexity(deepObj);
    expect(fullScore).toBeGreaterThan(5000);

    const limitedScore = calculateComplexity(deepObj, { earlyExitLimit: 50 });
    expect(limitedScore).toBeGreaterThan(50);
    expect(limitedScore).toBeLessThan(100);
  });


  test("handles circular references gracefully without infinite loops", () => {
    const circular = { a: 1 };
    circular.self = circular;
    expect(() => calculateComplexity(circular)).not.toThrow();
    const score = calculateComplexity(circular);
    expect(score).toBeGreaterThan(0);
  });
});

describe("Request Complexity Middleware — Integration Tests", () => {
  let app;
  const originalEnv = process.env.REQUEST_COMPLEXITY_LIMIT;

  beforeEach(() => {
    delete process.env.REQUEST_COMPLEXITY_LIMIT;
    app = express();
    app.use(express.json());
    app.use(requestComplexityMiddleware());
    app.post("/test-endpoint", (req, res) => {
      res.status(200).json({ success: true, score: req.complexityScore });
    });
    app.use(notFoundHandler);
    app.use(errorHandler);
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.REQUEST_COMPLEXITY_LIMIT = originalEnv;
    } else {
      delete process.env.REQUEST_COMPLEXITY_LIMIT;
    }
  });

  test("passes simple valid requests normally", async () => {
    const payload = {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      walletAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      collaborators: ["GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"],
      shares: [10000],
    };

    const res = await request(app)
      .post("/test-endpoint")
      .send(payload)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.score).toBeLessThan(50);
  });

  test("skips request complexity checks for GET requests", async () => {
    const res = await request(app).get("/test-endpoint").expect(404);

    expect(res.body.status).toBe(404);
  });

  test("rejects requests exceeding default complexity limit (1000) with HTTP 400", async () => {
    // Generate an object with 1200 keys
    const densePayload = {};
    for (let i = 0; i < 1200; i++) {
      densePayload[`k_${i}`] = i;
    }

    const res = await request(app)
      .post("/test-endpoint")
      .send(densePayload)
      .expect(400);

    expect(res.body.code).toBe("request_too_complex");
    expect(res.body.error).toBeDefined();
    expect(res.body.complexity_score).toBeGreaterThan(1000);
    expect(res.body.limit).toBe(1000);
    expect(res.body.status).toBe(400);
  });

  test("rejects deeply nested requests exceeding complexity limit with HTTP 400", async () => {
    // Create deeply nested object (depth = 60)
    let deeplyNested = { leaf: "val" };
    for (let i = 0; i < 60; i++) {
      deeplyNested = { [`level_${i}`]: deeplyNested, extra: `padding_${i}` };
    }

    const res = await request(app)
      .post("/test-endpoint")
      .send(deeplyNested)
      .expect(400);

    expect(res.body.code).toBe("request_too_complex");
    expect(res.body.complexity_score).toBeGreaterThan(1000);
    expect(res.body.limit).toBe(1000);
  });

  test("rejects large arrays exceeding complexity limit with HTTP 400", async () => {
    // Create an array with 1500 items
    const bigArray = Array.from({ length: 1500 }, (_, i) => i);

    const res = await request(app)
      .post("/test-endpoint")
      .send(bigArray)
      .expect(400);

    expect(res.body.code).toBe("request_too_complex");
    expect(res.body.complexity_score).toBeGreaterThan(1000);
    expect(res.body.limit).toBe(1000);
  });

  test("respects REQUEST_COMPLEXITY_LIMIT override from environment", async () => {
    process.env.REQUEST_COMPLEXITY_LIMIT = "100";

    const customApp = express();
    customApp.use(express.json());
    customApp.use(requestComplexityMiddleware());
    customApp.post("/test-endpoint", (req, res) => {
      res.status(200).json({ success: true, score: req.complexityScore });
    });

    const payloadWith150Keys = {};
    for (let i = 0; i < 150; i++) {
      payloadWith150Keys[`k_${i}`] = i;
    }

    const res = await request(customApp)
      .post("/test-endpoint")
      .send(payloadWith150Keys)
      .expect(400);

    expect(res.body.code).toBe("request_too_complex");
    expect(res.body.complexity_score).toBeGreaterThan(100);
    expect(res.body.limit).toBe(100);
  });

  test("performance test: sub-millisecond calculation on complex payload", () => {
    const complexObj = {
      items: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        name: `item_${i}`,
        tags: ["a", "b", "c"],
        meta: { active: true, priority: i % 5 },
      })),
    };

    const start = performance.now();
    for (let i = 0; i < 50; i++) {
      calculateComplexity(complexObj);
    }
    const elapsed = (performance.now() - start) / 50;
    // Calculation should be ultra-fast (< 2ms per payload)
    expect(elapsed).toBeLessThan(2);
  });
});
