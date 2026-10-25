/**
 * Tests for admin-token endpoint rate limiting + usage logging (#1183).
 *
 * Covers the three routes guarded by requireAdminToken in
 * src/routes/disputes.js: POST /admin/:ticketId/analyze,
 * GET /admin/:ticketId/analysis, and
 * PATCH /admin/:ticketId/recommendations/:recommendationId.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockGetDisputeByTicketId = jest.fn();

await jest.unstable_mockModule("../src/database/disputes.js", () => ({
  createDispute: jest.fn(),
  getDisputeByTicketId: mockGetDisputeByTicketId,
  getDisputesByWallet: jest.fn(),
  countDisputesByWallet: jest.fn(),
  getAllDisputes: jest.fn(),
  countAllDisputes: jest.fn(),
  updateDisputeStatus: jest.fn(),
  addDisputeComment: jest.fn(),
  getDisputeComments: jest.fn(() => []),
  updateMediationRecommendationStatus: jest.fn(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 8),
}));

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  sendEmail: jest.fn(() => ({ sent: true })),
  isEmailConfigured: jest.fn(() => false),
}));

await jest.unstable_mockModule("../src/database/email-digest.js", () => ({
  getSubscriberByWallet: jest.fn(() => null),
}));

await jest.unstable_mockModule("../src/services/sms-notifications.js", () => ({
  sendEventSms: jest.fn(() => ({ attempted: false, reason: "not_opted_in" })),
}));

await jest.unstable_mockModule("../src/services/ai-dispute-analyzer.js", () => ({
  analyzeDispute: jest.fn(() => ({ success: true, summary: "ok" })),
  getDisputeAnalysisReport: jest.fn(() => ({ summary: "ok" })),
}));

const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { warn: mockLoggerWarn, info: mockLoggerInfo, error: jest.fn() },
}));

const mockConsumeSlidingWindow = jest.fn();

await jest.unstable_mockModule("../src/rate-limiter/distributed.js", () => ({
  distributedRateLimiter: { consumeSlidingWindow: mockConsumeSlidingWindow },
}));

import express from "express";
const { disputesRouter } = await import("../src/routes/disputes.js");

const app = express();
app.use(express.json());
app.use("/api/v1/disputes", disputesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const TICKET_ID = "DSP-A3F2C019";
const ADMIN_TOKEN = "test-admin-token";

const baseDispute = {
  id: 1,
  ticketId: TICKET_ID,
  walletAddress: "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P",
  status: "open",
};

const allow = (overrides = {}) => ({
  allowed: true,
  remaining: 9,
  limit: 10,
  retryAfterSeconds: 0,
  resetTimeMs: Date.now() + 60_000,
  algorithm: "sliding-window",
  ...overrides,
});

const deny = (overrides = {}) => ({
  allowed: false,
  remaining: 0,
  limit: 10,
  retryAfterSeconds: 30,
  resetTimeMs: Date.now() + 30_000,
  algorithm: "sliding-window",
  ...overrides,
});

describe("Admin-token endpoints: rate limiting (#1183)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADMIN_ROTATE_TOKEN = ADMIN_TOKEN;
    mockGetDisputeByTicketId.mockReturnValue(baseDispute);
    mockConsumeSlidingWindow.mockResolvedValue(allow());
  });

  test("allows a request within the limit and calls through to the handler", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
    expect(mockConsumeSlidingWindow).toHaveBeenCalledTimes(1);
    expect(mockConsumeSlidingWindow.mock.calls[0][1]).toMatch(/^admin-token:/);
    expect(mockConsumeSlidingWindow.mock.calls[0][2]).toEqual({ limit: 10, windowMs: 60_000 });
  });

  test("returns 429 with Retry-After when the limit is exceeded, without checking the token", async () => {
    mockConsumeSlidingWindow.mockResolvedValue(deny({ retryAfterSeconds: 42 }));

    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`)
      .set("Authorization", `Bearer wrong-token`);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("42");
    expect(res.body.error).toBeDefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Admin token endpoint rate limit exceeded",
      expect.objectContaining({ endpoint: expect.stringContaining("/analyze") }),
    );
  });

  test("rate limiting is keyed per endpoint, not shared globally across admin routes", async () => {
    await request(app).post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`).set("Authorization", `Bearer ${ADMIN_TOKEN}`);
    await request(app).get(`/api/v1/disputes/admin/${TICKET_ID}/analysis`).set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(mockConsumeSlidingWindow).toHaveBeenCalledTimes(2);
    const [, endpointA] = mockConsumeSlidingWindow.mock.calls[0];
    const [, endpointB] = mockConsumeSlidingWindow.mock.calls[1];
    expect(endpointA).not.toBe(endpointB);
  });

  test("logs a warning and rejects with 401 for a bad token, after passing the rate check", async () => {
    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`)
      .set("Authorization", "Bearer wrong-token");

    expect(res.status).toBe(401);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Admin token endpoint rejected: invalid or missing token",
      expect.objectContaining({ endpoint: expect.any(String) }),
    );
  });

  test("logs an info entry for a successfully authenticated admin request", async () => {
    await request(app)
      .get(`/api/v1/disputes/admin/${TICKET_ID}/analysis`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "Admin token endpoint accessed",
      expect.objectContaining({ endpoint: expect.stringContaining("/analysis") }),
    );
  });

  test("does not consult the rate limiter result if Redis fails open (fallback allowed)", async () => {
    mockConsumeSlidingWindow.mockResolvedValue(allow({ fallback: true }));

    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`);

    expect(res.status).toBe(200);
  });

  test("still enforces the rate limit even when ADMIN_ROTATE_TOKEN is not configured", async () => {
    delete process.env.ADMIN_ROTATE_TOKEN;
    mockConsumeSlidingWindow.mockResolvedValue(deny());

    const res = await request(app)
      .post(`/api/v1/disputes/admin/${TICKET_ID}/analyze`)
      .set("Authorization", "Bearer anything");

    expect(res.status).toBe(429);
  });

  test("PATCH recommendations route is also rate limited", async () => {
    mockConsumeSlidingWindow.mockResolvedValue(deny());

    const res = await request(app)
      .patch(`/api/v1/disputes/admin/${TICKET_ID}/recommendations/1`)
      .set("Authorization", `Bearer ${ADMIN_TOKEN}`)
      .send({ status: "implemented" });

    expect(res.status).toBe(429);
  });
});
