import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const registerWebhook = jest.fn(() => 1);
const listWebhooks = jest.fn(() => []);
const deleteWebhook = jest.fn(() => true);
const getWebhookById = jest.fn();
const rotateWebhookSecret = jest.fn(() => true);
const parseEvents = jest.fn((json) => (json == null ? null : JSON.parse(json)));

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  getWebhookById,
  rotateWebhookSecret,
  parseEvents,
}));

const registerAdvancedWebhook = jest.fn();
const testWebhook = jest.fn();
const emitWebhookEvent = jest.fn();
const getWebhookDeliveryHistory = jest.fn();
const getWebhookDeliveryStats = jest.fn();

await jest.unstable_mockModule("../src/services/webhook-manager.js", () => ({
  WEBHOOK_EVENTS: [
    "distribution.completed",
    "distribute.confirmed",
    "dispute.created",
    "dispute.resolved",
    "governance.vote.started",
    "governance.vote.ended",
    "contract.status.changed",
  ],
  registerAdvancedWebhook,
  testWebhook,
  emitWebhookEvent,
  getWebhookDeliveryHistory,
  getWebhookDeliveryStats,
  generateWebhookSecret: jest.fn(() => "new-secret"),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 25),
}));

const { default: webhooksRouter } = await import("../src/routes/webhooks.js");

import express from "express";

const app = express();
app.use(express.json());
app.use("/api/v1", webhooksRouter);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Advanced webhook routes (#1059)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("GET /webhooks/events lists supported events", async () => {
    const res = await request(app).get("/api/v1/webhooks/events");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        "distribution.completed",
        "dispute.created",
        "dispute.resolved",
        "governance.vote.started",
        "governance.vote.ended",
        "contract.status.changed",
      ])
    );
  });

  test("POST /webhooks/:contractId without events keeps the legacy shape", async () => {
    registerWebhook.mockReturnValue(42);

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}`)
      .send({ url: "https://example.com/hook" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, webhookId: 42 });
    expect(registerWebhook).toHaveBeenCalledWith(CONTRACT, "https://example.com/hook");
    expect(registerAdvancedWebhook).not.toHaveBeenCalled();
  });

  test("POST /webhooks/:contractId with events returns a one-time secret", async () => {
    registerAdvancedWebhook.mockReturnValue({
      webhookId: 9,
      url: "https://example.com/hook",
      events: ["dispute.created"],
      secret: "s3cr3t",
    });

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}`)
      .send({ url: "https://example.com/hook", events: ["dispute.created"] });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ webhookId: 9, secret: "s3cr3t" });
    expect(registerAdvancedWebhook).toHaveBeenCalledWith(CONTRACT, "https://example.com/hook", [
      "dispute.created",
    ]);
  });

  test("POST /webhooks/:contractId rejects unknown events", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}`)
      .send({ url: "https://example.com/hook", events: ["bogus"] });

    expect(res.status).toBe(400);
    expect(registerAdvancedWebhook).not.toHaveBeenCalled();
  });

  test("POST /webhooks/:contractId/emit fans out events", async () => {
    emitWebhookEvent.mockResolvedValue({ delivered: 2, failed: 0, attempted: 2 });

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}/emit`)
      .send({ event: "governance.vote.started", data: { proposalId: 1 } });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, delivered: 2 });
    expect(emitWebhookEvent).toHaveBeenCalledWith({
      contractId: CONTRACT,
      event: "governance.vote.started",
      data: { proposalId: 1 },
    });
  });

  test("POST /webhooks/:contractId/emit rejects unknown events", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}/emit`)
      .send({ event: "bogus", data: {} });

    expect(res.status).toBe(400);
    expect(emitWebhookEvent).not.toHaveBeenCalled();
  });

  test("POST /webhooks/:contractId/:webhookId/test reports delivery", async () => {
    testWebhook.mockResolvedValue({ success: true, deliveryId: 3, event: "webhook.test" });

    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/7/test`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(testWebhook).toHaveBeenCalledWith(CONTRACT, 7);
  });

  test("POST /webhooks/:contractId/:webhookId/test surfaces remote failure as 502", async () => {
    testWebhook.mockResolvedValue({ success: false, deliveryId: 3, error: "boom" });

    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/7/test`);

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
  });

  test("POST /webhooks/:contractId/:webhookId/rotate-secret returns a new secret", async () => {
    getWebhookById.mockReturnValue({ id: 7, contractId: CONTRACT, enabled: 1 });

    const res = await request(app).post(`/api/v1/webhooks/${CONTRACT}/7/rotate-secret`);

    expect(res.status).toBe(200);
    expect(res.body.secret).toBe("new-secret");
    expect(rotateWebhookSecret).toHaveBeenCalledWith(7, "new-secret");
  });

  test("GET /webhooks/:contractId/deliveries returns paginated history", async () => {
    getWebhookDeliveryHistory.mockReturnValue({ data: [{ id: 1 }], total: 1 });

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/deliveries?limit=10&status=delivered`);

    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(1);
    expect(getWebhookDeliveryHistory).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT, status: "delivered", limit: 10 })
    );
  });

  test("GET /webhooks/:contractId/delivery-stats returns the dashboard stats", async () => {
    getWebhookDeliveryStats.mockReturnValue({ total: 5, delivered: 4, failed: 1, pending: 0, exhausted: 0 });

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}/delivery-stats`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 5, delivered: 4 });
  });
});
