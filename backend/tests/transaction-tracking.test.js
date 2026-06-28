import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";

let fakeDb = new Map();

const recordRequestStart = jest.fn((transactionId, correlationId, method, path, requestBody) => {
  fakeDb.set(transactionId, {
    transactionId,
    correlationId,
    method,
    path,
    requestBody: JSON.stringify(requestBody),
    responseStatus: null,
    responseBody: null,
    timestamp: new Date().toISOString(),
  });
});

const recordRequestEnd = jest.fn((transactionId, responseStatus, responseBody) => {
  const row = fakeDb.get(transactionId);
  if (row) {
    row.responseStatus = responseStatus;
    row.responseBody = JSON.stringify(responseBody);
  }
});

const getRequestTracking = jest.fn((transactionId) => {
  return fakeDb.get(transactionId) || null;
});

const cleanupRequestTracking = jest.fn(() => {
  return 0;
});

// Mock database module
await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordRequestStart,
  recordRequestEnd,
  getRequestTracking,
  cleanupRequestTracking,
  countWrite: jest.fn(),
}));

const { transactionTrackingMiddleware, isValidTransactionId } = await import(
  "../src/transaction-tracking.js"
);
const { transactionRouter } = await import("../src/routes/transaction.js");
const { sendError } = await import("../src/error-response.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.correlationId = "corr-123";
    next();
  });
  app.use(transactionTrackingMiddleware);
  app.use("/api/v1/transaction", transactionRouter);
  app.get("/ping", (req, res) => {
    res.json({ ok: true });
  });
  app.get("/error-test", (req, res) => {
    return sendError(res, 400, "bad_request", "Some bad request");
  });
  return app;
}

describe("Transaction Tracking System (#425)", () => {
  beforeEach(() => {
    fakeDb.clear();
    jest.clearAllMocks();
  });

  test("generates a new UUID v4 when X-Transaction-ID header is missing", async () => {
    const res = await request(makeApp()).get("/ping");
    expect(res.status).toBe(200);
    const txId = res.headers["x-transaction-id"];
    expect(isValidTransactionId(txId)).toBe(true);

    // Wait a brief tick for res.on('finish') to execute database writes
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(recordRequestStart).toHaveBeenCalledWith(
      txId,
      "corr-123",
      "GET",
      "/ping",
      expect.any(Object)
    );
  });

  test("reuses the valid incoming X-Transaction-ID header", async () => {
    const validId = "550e8400-e29b-41d4-a716-446655440000";
    const res = await request(makeApp())
      .get("/ping")
      .set("X-Transaction-ID", validId);
    expect(res.status).toBe(200);
    expect(res.headers["x-transaction-id"]).toBe(validId);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(recordRequestStart).toHaveBeenCalledWith(
      validId,
      "corr-123",
      "GET",
      "/ping",
      expect.any(Object)
    );
  });

  test("generates a new ID when incoming header format is invalid", async () => {
    const res = await request(makeApp())
      .get("/ping")
      .set("X-Transaction-ID", "invalid-id");
    expect(res.status).toBe(200);
    const txId = res.headers["x-transaction-id"];
    expect(txId).not.toBe("invalid-id");
    expect(isValidTransactionId(txId)).toBe(true);
  });

  test("GET /api/v1/transaction/:id returns details when transaction exists", async () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    fakeDb.set(id, {
      transactionId: id,
      correlationId: "corr-123",
      method: "POST",
      path: "/api/v1/distribute",
      requestBody: JSON.stringify({ amount: "10" }),
      responseStatus: 200,
      responseBody: JSON.stringify({ success: true }),
      timestamp: "2026-06-28T20:00:00Z",
    });

    const res = await request(makeApp()).get(`/api/v1/transaction/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transactionId: id,
      correlationId: "corr-123",
      method: "POST",
      path: "/api/v1/distribute",
      requestBody: { amount: "10" },
      responseStatus: 200,
      responseBody: { success: true },
      timestamp: "2026-06-28T20:00:00Z",
    });
  });

  test("GET /api/v1/transaction/:id returns 404 when transaction does not exist", async () => {
    const missingId = "550e8400-e29b-41d4-a716-446655449999";
    const res = await request(makeApp()).get(`/api/v1/transaction/${missingId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("transaction_not_found");
  });

  test("GET /api/v1/transaction/:id returns 400 on invalid UUID format", async () => {
    const res = await request(makeApp()).get("/api/v1/transaction/invalid-id-format");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_transaction_id");
  });

  test("includes transactionId in error payload", async () => {
    const res = await request(makeApp()).get("/error-test");
    expect(res.status).toBe(400);
    expect(res.body.transactionId).toBeDefined();
    expect(isValidTransactionId(res.body.transactionId)).toBe(true);
  });
});
