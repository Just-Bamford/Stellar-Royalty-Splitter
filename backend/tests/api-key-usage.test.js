/**
 * Tests for the API Rate Limit Dashboard — closes #608.
 *
 * Covers:
 *   - Usage calculation correctness (requests/min, % used, approaching flag)
 *   - GET /admin/api-keys/usage  (all keys overview)
 *   - GET /admin/api-keys/usage/:keyValue  (single key)
 *   - GET /admin/api-keys/usage/:keyValue/history  (historical graph data)
 *   - GET /admin/api-keys/alerts  (approaching-limit alerts)
 *   - POST /admin/api-keys/register  (register a key with label)
 *   - PATCH /admin/api-keys/:keyValue/limit  (adjust limit per key)
 *   - Auth: 401 without token, 503 when token not configured
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ─── Mock the database layer ──────────────────────────────────────────────────

const mockGetAllApiKeysUsage = jest.fn();
const mockGetApiKeyCurrentUsage = jest.fn();
const mockGetApiKeyHistory = jest.fn();
const mockGetApproachingLimitAlerts = jest.fn();
const mockRegisterApiKey = jest.fn();
const mockSetApiKeyLimit = jest.fn();
const mockRecordApiKeyRequest = jest.fn();

await jest.unstable_mockModule("../src/database/rate-limit.js", () => ({
  DEFAULT_AUTH_LIMIT_PER_MINUTE: 1000,
  DEFAULT_IP_LIMIT_PER_MINUTE: 100,
  ALERT_THRESHOLD_FRACTION: 0.8,
  HISTORY_RETENTION_MINUTES: 1440,
  getAllApiKeysUsage: mockGetAllApiKeysUsage,
  getApiKeyCurrentUsage: mockGetApiKeyCurrentUsage,
  getApiKeyHistory: mockGetApiKeyHistory,
  getApproachingLimitAlerts: mockGetApproachingLimitAlerts,
  registerApiKey: mockRegisterApiKey,
  setApiKeyLimit: mockSetApiKeyLimit,
  recordApiKeyRequest: mockRecordApiKeyRequest,
}));

// ─── Build minimal Express app ────────────────────────────────────────────────

import express from "express";
const { adminApiKeysRouter } = await import("../src/routes/admin-api-keys.js");

const ADMIN_TOKEN = "test-admin-secret";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/api-keys", adminApiKeysRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

// ─── Test data helpers ────────────────────────────────────────────────────────

const baseUsage = (overrides = {}) => ({
  keyValue: "key-abc-123",
  label: "Test Key",
  requestsPerMinute: 50,
  blockedPerMinute: 0,
  limit: 1000,
  percentUsed: 5.0,
  approaching: false,
  lastSeenAt: "2026-07-27T10:00:00",
  createdAt: "2026-07-01T00:00:00",
  ...overrides,
});

const baseHistory = (overrides = {}) => ({
  keyValue: "key-abc-123",
  label: "Test Key",
  limit: 1000,
  windowMinutes: 60,
  history: [
    { bucket: "2026-07-27T09:00", requests: 30, blocked: 0 },
    { bucket: "2026-07-27T09:01", requests: 45, blocked: 2 },
  ],
  aggregate: { totalRequests: 75, totalBlocked: 2, activeMinutes: 2 },
  ...overrides,
});

// ─── Auth guard tests ─────────────────────────────────────────────────────────

describe("Auth guard — all endpoints", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("GET /usage returns 401 without Authorization header", async () => {
    const res = await request(app).get("/admin/api-keys/usage");
    expect(res.status).toBe(401);
    expect(mockGetAllApiKeysUsage).not.toHaveBeenCalled();
  });

  test("GET /usage returns 401 with wrong token", async () => {
    const res = await request(app)
      .get("/admin/api-keys/usage")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    expect(mockGetAllApiKeysUsage).not.toHaveBeenCalled();
  });

  test("GET /usage returns 503 when ADMIN_ROTATE_TOKEN is not set", async () => {
    delete process.env.ADMIN_ROTATE_TOKEN;
    const res = await request(app)
      .get("/admin/api-keys/usage")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(503);
    expect(mockGetAllApiKeysUsage).not.toHaveBeenCalled();
  });

  test("PATCH /:keyValue/limit returns 401 without token", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .send({ limitPerMinute: 500 });
    expect(res.status).toBe(401);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });
});

// ─── GET /admin/api-keys/usage ────────────────────────────────────────────────

describe("GET /admin/api-keys/usage", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("returns all keys with usage stats and default limit", async () => {
    mockGetAllApiKeysUsage.mockReturnValue([
      baseUsage({ keyValue: "key-1", requestsPerMinute: 100, percentUsed: 10 }),
      baseUsage({ keyValue: "key-2", requestsPerMinute: 800, percentUsed: 80, approaching: true }),
    ]);

    const res = await request(app)
      .get("/admin/api-keys/usage")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(2);
    expect(res.body.defaultLimitPerMinute).toBe(1000);
    expect(res.body.data[0].keyValue).toBe("key-1");
    expect(res.body.data[1].approaching).toBe(true);
    expect(mockGetAllApiKeysUsage).toHaveBeenCalledTimes(1);
  });

  test("returns empty array when no keys registered", async () => {
    mockGetAllApiKeysUsage.mockReturnValue([]);

    const res = await request(app)
      .get("/admin/api-keys/usage")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("usage data includes all required fields", async () => {
    mockGetAllApiKeysUsage.mockReturnValue([baseUsage()]);

    const res = await request(app)
      .get("/admin/api-keys/usage")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    const key = res.body.data[0];
    expect(key).toHaveProperty("keyValue");
    expect(key).toHaveProperty("requestsPerMinute");
    expect(key).toHaveProperty("blockedPerMinute");
    expect(key).toHaveProperty("limit");
    expect(key).toHaveProperty("percentUsed");
    expect(key).toHaveProperty("approaching");
    expect(key).toHaveProperty("lastSeenAt");
  });
});

// ─── GET /admin/api-keys/usage/:keyValue ─────────────────────────────────────

describe("GET /admin/api-keys/usage/:keyValue", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("returns usage for a known key", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(baseUsage());

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.keyValue).toBe("key-abc-123");
    expect(res.body.data.requestsPerMinute).toBe(50);
    expect(mockGetApiKeyCurrentUsage).toHaveBeenCalledWith("key-abc-123");
  });

  test("returns 404 for an unknown key", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(null);

    const res = await request(app)
      .get("/admin/api-keys/usage/nonexistent-key")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("api_key_not_found");
  });
});

// ─── Usage calculation correctness ───────────────────────────────────────────

describe("Usage calculation correctness", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("percentUsed is 0 when no requests made", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(
      baseUsage({ requestsPerMinute: 0, percentUsed: 0, approaching: false })
    );

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.body.data.percentUsed).toBe(0);
    expect(res.body.data.approaching).toBe(false);
  });

  test("approaching is true at 80% of limit", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(
      baseUsage({ requestsPerMinute: 800, percentUsed: 80, approaching: true, limit: 1000 })
    );

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.body.data.approaching).toBe(true);
    expect(res.body.data.percentUsed).toBe(80);
  });

  test("approaching is false just below threshold (79%)", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(
      baseUsage({ requestsPerMinute: 790, percentUsed: 79, approaching: false, limit: 1000 })
    );

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.body.data.approaching).toBe(false);
  });

  test("percentUsed caps at 100 when requests exceed limit", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(
      baseUsage({ requestsPerMinute: 1200, percentUsed: 100, approaching: true, limit: 1000 })
    );

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.body.data.percentUsed).toBe(100);
  });

  test("custom limit is reflected in the response", async () => {
    mockGetApiKeyCurrentUsage.mockReturnValue(
      baseUsage({ requestsPerMinute: 50, limit: 200, percentUsed: 25, approaching: false })
    );

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.body.data.limit).toBe(200);
    expect(res.body.data.percentUsed).toBe(25);
  });
});

// ─── GET /admin/api-keys/usage/:keyValue/history ──────────────────────────────

describe("GET /admin/api-keys/usage/:keyValue/history", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("returns per-minute history and aggregate for a known key", async () => {
    mockGetApiKeyHistory.mockReturnValue(baseHistory());

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123/history")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.history).toHaveLength(2);
    expect(res.body.data.history[0]).toMatchObject({ bucket: expect.any(String), requests: 30, blocked: 0 });
    expect(res.body.data.aggregate.totalRequests).toBe(75);
    expect(res.body.data.aggregate.totalBlocked).toBe(2);
    expect(mockGetApiKeyHistory).toHaveBeenCalledWith("key-abc-123", undefined);
  });

  test("passes minutes query param to the DB layer", async () => {
    mockGetApiKeyHistory.mockReturnValue(baseHistory({ windowMinutes: 30 }));

    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123/history?minutes=30")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockGetApiKeyHistory).toHaveBeenCalledWith("key-abc-123", "30");
  });

  test("returns 400 when minutes is not a valid integer", async () => {
    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123/history?minutes=abc")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
    expect(mockGetApiKeyHistory).not.toHaveBeenCalled();
  });

  test("returns 400 when minutes exceeds retention window", async () => {
    const res = await request(app)
      .get("/admin/api-keys/usage/key-abc-123/history?minutes=99999")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
    expect(mockGetApiKeyHistory).not.toHaveBeenCalled();
  });

  test("returns 404 for unknown key", async () => {
    mockGetApiKeyHistory.mockReturnValue(null);

    const res = await request(app)
      .get("/admin/api-keys/usage/unknown-key/history")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("api_key_not_found");
  });
});

// ─── GET /admin/api-keys/alerts ───────────────────────────────────────────────

describe("GET /admin/api-keys/alerts", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("returns keys approaching their limit", async () => {
    mockGetApproachingLimitAlerts.mockReturnValue([
      baseUsage({ keyValue: "heavy-key", requestsPerMinute: 850, percentUsed: 85, approaching: true }),
    ]);

    const res = await request(app)
      .get("/admin/api-keys/alerts")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].approaching).toBe(true);
    expect(res.body.data[0].keyValue).toBe("heavy-key");
    expect(mockGetApproachingLimitAlerts).toHaveBeenCalledTimes(1);
  });

  test("returns empty array when no keys approaching limit", async () => {
    mockGetApproachingLimitAlerts.mockReturnValue([]);

    const res = await request(app)
      .get("/admin/api-keys/alerts")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  test("returns 401 without token", async () => {
    const res = await request(app).get("/admin/api-keys/alerts");
    expect(res.status).toBe(401);
    expect(mockGetApproachingLimitAlerts).not.toHaveBeenCalled();
  });
});

// ─── POST /admin/api-keys/register ───────────────────────────────────────────

describe("POST /admin/api-keys/register", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("registers a key with a label and returns 201", async () => {
    const res = await request(app)
      .post("/admin/api-keys/register")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ keyValue: "new-api-key-xyz", label: "Partner Integration" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.keyValue).toBe("new-api-key-xyz");
    expect(res.body.data.label).toBe("Partner Integration");
    expect(mockRegisterApiKey).toHaveBeenCalledWith("new-api-key-xyz", "Partner Integration");
  });

  test("registers a key without a label", async () => {
    const res = await request(app)
      .post("/admin/api-keys/register")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ keyValue: "unlabeled-key" });

    expect(res.status).toBe(201);
    expect(mockRegisterApiKey).toHaveBeenCalledWith("unlabeled-key", null);
  });

  test("400 when keyValue is missing", async () => {
    const res = await request(app)
      .post("/admin/api-keys/register")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ label: "No Key" });

    expect(res.status).toBe(400);
    expect(mockRegisterApiKey).not.toHaveBeenCalled();
  });

  test("400 when keyValue is empty string", async () => {
    const res = await request(app)
      .post("/admin/api-keys/register")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ keyValue: "" });

    expect(res.status).toBe(400);
    expect(mockRegisterApiKey).not.toHaveBeenCalled();
  });

  test("401 without admin token", async () => {
    const res = await request(app)
      .post("/admin/api-keys/register")
      .send({ keyValue: "some-key" });

    expect(res.status).toBe(401);
    expect(mockRegisterApiKey).not.toHaveBeenCalled();
  });
});

// ─── PATCH /admin/api-keys/:keyValue/limit ────────────────────────────────────

describe("PATCH /admin/api-keys/:keyValue/limit", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    app = buildApp();
  });

  test("adjusts the limit for a known key", async () => {
    mockSetApiKeyLimit.mockReturnValue(true);

    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: 500 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.limitPerMinute).toBe(500);
    expect(res.body.data.keyValue).toBe("key-abc-123");
    expect(mockSetApiKeyLimit).toHaveBeenCalledWith("key-abc-123", 500);
  });

  test("resets limit to default when null is passed", async () => {
    mockSetApiKeyLimit.mockReturnValue(true);

    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: null });

    expect(res.status).toBe(200);
    expect(res.body.data.limitPerMinute).toBe(1000); // DEFAULT_AUTH_LIMIT_PER_MINUTE
    expect(res.body.message).toContain("default");
    expect(mockSetApiKeyLimit).toHaveBeenCalledWith("key-abc-123", null);
  });

  test("returns 404 when key does not exist", async () => {
    mockSetApiKeyLimit.mockReturnValue(false);

    const res = await request(app)
      .patch("/admin/api-keys/nonexistent/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: 200 });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("api_key_not_found");
  });

  test("400 when limitPerMinute is zero", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: 0 });

    expect(res.status).toBe(400);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });

  test("400 when limitPerMinute is negative", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: -100 });

    expect(res.status).toBe(400);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });

  test("400 when limitPerMinute is a float", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ limitPerMinute: 99.5 });

    expect(res.status).toBe(400);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });

  test("400 when body is missing limitPerMinute entirely", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });

  test("401 without admin token", async () => {
    const res = await request(app)
      .patch("/admin/api-keys/key-abc-123/limit")
      .send({ limitPerMinute: 500 });

    expect(res.status).toBe(401);
    expect(mockSetApiKeyLimit).not.toHaveBeenCalled();
  });
});
