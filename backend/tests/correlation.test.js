/**
 * Tests for correlation ID middleware (#396).
 */
import { describe, test, expect } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  correlationMiddleware,
  generateCorrelationId,
  isValidCorrelationId,
  getCorrelationId,
} from "../src/correlation.js";

// ── Unit tests ────────────────────────────────────────────────────────────

describe("generateCorrelationId (#396)", () => {
  test("returns a valid UUID v4", () => {
    const id = generateCorrelationId();
    expect(isValidCorrelationId(id)).toBe(true);
  });

  test("returns a unique ID on every call", () => {
    const ids = new Set(Array.from({ length: 20 }, generateCorrelationId));
    expect(ids.size).toBe(20);
  });
});

describe("isValidCorrelationId (#396)", () => {
  test("accepts well-formed UUID v4", () => {
    expect(isValidCorrelationId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    // version nibble must be 4
    expect(isValidCorrelationId("550e8400-e29b-41d4-8716-446655440000")).toBe(true);
  });

  test("rejects non-UUID strings", () => {
    expect(isValidCorrelationId("not-a-uuid")).toBe(false);
    expect(isValidCorrelationId("")).toBe(false);
    expect(isValidCorrelationId(null)).toBe(false);
    expect(isValidCorrelationId(undefined)).toBe(false);
  });

  test("rejects UUID v1 (version nibble ≠ 4)", () => {
    expect(isValidCorrelationId("550e8400-e29b-11d4-a716-446655440000")).toBe(false);
  });
});

describe("getCorrelationId (#396)", () => {
  test("returns correlationId from req when present", () => {
    const fakeReq = { correlationId: "abc123-test" };
    expect(getCorrelationId(fakeReq)).toBe("abc123-test");
  });

  test("returns 'unknown' when req has no correlationId", () => {
    expect(getCorrelationId({})).toBe("unknown");
    expect(getCorrelationId(null)).toBe("unknown");
    expect(getCorrelationId(undefined)).toBe("unknown");
  });
});

// ── Middleware integration tests ──────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(correlationMiddleware);
  app.get("/ping", (req, res) => {
    res.json({ correlationId: req.correlationId });
  });
  return app;
}

describe("correlationMiddleware (#396)", () => {
  test("generates a UUID v4 when no X-Correlation-ID header is sent", async () => {
    const res = await request(makeApp()).get("/ping");
    expect(res.status).toBe(200);
    expect(isValidCorrelationId(res.body.correlationId)).toBe(true);
    expect(isValidCorrelationId(res.headers["x-correlation-id"])).toBe(true);
  });

  test("echoes a valid incoming X-Correlation-ID back in the response header", async () => {
    const id = generateCorrelationId();
    const res = await request(makeApp()).get("/ping").set("X-Correlation-ID", id);
    expect(res.headers["x-correlation-id"]).toBe(id);
    expect(res.body.correlationId).toBe(id);
  });

  test("generates a fresh ID when the incoming header is not a valid UUID v4", async () => {
    const res = await request(makeApp())
      .get("/ping")
      .set("X-Correlation-ID", "not-a-valid-uuid");
    const returnedId = res.headers["x-correlation-id"];
    expect(returnedId).not.toBe("not-a-valid-uuid");
    expect(isValidCorrelationId(returnedId)).toBe(true);
  });

  test("each request gets a unique correlation ID", async () => {
    const app = makeApp();
    const [r1, r2] = await Promise.all([
      request(app).get("/ping"),
      request(app).get("/ping"),
    ]);
    expect(r1.headers["x-correlation-id"]).not.toBe(r2.headers["x-correlation-id"]);
  });

  test("sets X-Correlation-ID response header on every request", async () => {
    const res = await request(makeApp()).get("/ping");
    expect(res.headers).toHaveProperty("x-correlation-id");
  });
});
