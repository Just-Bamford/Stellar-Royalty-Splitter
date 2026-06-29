import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const registerWebhook = jest.fn(() => 1);
const listWebhooks = jest.fn(() => []);
const deleteWebhook = jest.fn(() => true);
const getDeliveryAttempts = jest.fn(() => []);
const getDeliveryStats = jest.fn(() => ({ total: 0, successes: 0, avgLatencyMs: null, lastAttempt: null }));
const getContractDeliveryStats = jest.fn(() => []);
const recordDeliveryAttempt = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  getDeliveryAttempts,
  getDeliveryStats,
  getContractDeliveryStats,
  recordDeliveryAttempt,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 4),
}));

const { default: webhooksRouter } = await import("../src/routes/webhooks.js");

const app = express();
app.use(express.json());
app.use("/api/v1", webhooksRouter);

describe("Webhook status endpoints (#506)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("GET /webhooks/:contractId/:webhookId/status returns stats and attempts", async () => {
    getDeliveryStats.mockReturnValue({ total: 5, successes: 4, avgLatencyMs: 120.5, lastAttempt: "2026-06-01T00:00:00Z" });
    getDeliveryAttempts.mockReturnValue([
      { id: 1, webhookId: 1, contractId: CONTRACT, success: 1, statusCode: 200, errorMessage: null, durationMs: 100, attempt: 1, timestamp: "2026-06-01T00:00:00Z" },
    ]);

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/1/status`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      webhookId: 1,
      total: 5,
      successes: 4,
      failures: 1,
      successRate: 80,
      avgLatencyMs: 121,
    });
    expect(res.body.data.recentAttempts).toHaveLength(1);
  });

  test("GET /webhooks/:contractId/stats returns per-webhook stats", async () => {
    getContractDeliveryStats.mockReturnValue([
      { webhookId: 1, url: "https://example.com/hook", total: 10, successes: 9, avgLatencyMs: 200, lastAttempt: "2026-06-01T00:00:00Z" },
    ]);

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      webhookId: 1,
      url: "https://example.com/hook",
      total: 10,
      successes: 9,
      failures: 1,
      successRate: 90,
    });
  });

  test("GET status returns successRate null when no attempts", async () => {
    getDeliveryStats.mockReturnValue({ total: 0, successes: 0, avgLatencyMs: null, lastAttempt: null });
    getDeliveryAttempts.mockReturnValue([]);

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/1/status`);

    expect(res.status).toBe(200);
    expect(res.body.data.successRate).toBeNull();
    expect(res.body.data.total).toBe(0);
  });

  test("POST /webhooks/:contractId/:webhookId/test delivers a test ping and records attempt", async () => {
    listWebhooks.mockReturnValue([
      { id: 1, contractId: CONTRACT, url: "https://example.com/hook", enabled: 1 },
    ]);

    global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));

    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/1/test`);

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(true);
    expect(res.body.statusCode).toBe(200);
    expect(recordDeliveryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 1, contractId: CONTRACT, success: true, statusCode: 200 })
    );
  });

  test("POST test endpoint returns delivered:false on HTTP error", async () => {
    listWebhooks.mockReturnValue([
      { id: 2, contractId: CONTRACT, url: "https://example.com/hook", enabled: 1 },
    ]);

    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));

    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/2/test`);

    expect(res.status).toBe(200);
    expect(res.body.delivered).toBe(false);
    expect(res.body.statusCode).toBe(503);
  });

  test("GET status returns 400 for invalid webhook ID", async () => {
    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/abc/status`);
    expect(res.status).toBe(400);
  });

  test("POST test returns 404 when webhook not found", async () => {
    listWebhooks.mockReturnValue([]);
    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/99/test`);
    expect(res.status).toBe(404);
  });
});
