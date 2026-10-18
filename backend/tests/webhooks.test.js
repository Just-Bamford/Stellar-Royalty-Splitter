import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const registerWebhook = jest.fn(() => 1);
const listWebhooks = jest.fn(() => []);
const deleteWebhook = jest.fn(() => true);

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  registerWebhook,
  listWebhooks,
  deleteWebhook,
  // Extended surface used by the advanced webhook system (#1059). The
  // legacy routes under test never call these, but the module graph
  // (routes/webhooks.js -> services/webhook-manager.js) imports them.
  getWebhookById: jest.fn(() => null),
  listWebhooksForEvent: jest.fn(() => []),
  updateWebhookEvents: jest.fn(() => false),
  rotateWebhookSecret: jest.fn(() => false),
  updateWebhookRetryState: jest.fn(() => false),
  updateWebhookRetryStateWithPayload: jest.fn(() => false),
  getWebhooksDueForRetry: jest.fn(() => []),
  resetWebhookRetryCount: jest.fn(() => false),
  moveToDlq: jest.fn(() => null),
  serializeEvents: jest.fn(() => null),
  parseEvents: jest.fn(() => null),
  recordDelivery: jest.fn(() => null),
  updateDelivery: jest.fn(() => false),
  listDeliveries: jest.fn(() => []),
  countDeliveries: jest.fn(() => 0),
  getDeliveryStats: jest.fn(() => ({ total: 0, delivered: 0, failed: 0, pending: 0, exhausted: 0 })),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 3),
}));

const { default: webhooksRouter } = await import("../src/routes/webhooks.js");

import express from "express";

const app = express();
app.use(express.json());
app.use("/api/v1", webhooksRouter);

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("Webhook routes (#295)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("POST /webhooks/:contractId registers an HTTPS URL", async () => {
    registerWebhook.mockReturnValue(42);

    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}`)
      .send({ url: "https://example.com/hook" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      webhookId: 42,
      url: "https://example.com/hook",
    });
    expect(registerWebhook).toHaveBeenCalledWith(CONTRACT, "https://example.com/hook");
  });

  test("POST rejects non-HTTPS webhook URLs", async () => {
    const res = await request(app)
      .post(`/api/v1/webhooks/${CONTRACT}`)
      .send({ url: "http://example.com/hook" });

    expect(res.status).toBe(400);
    expect(registerWebhook).not.toHaveBeenCalled();
  });

  test("GET /webhooks/:contractId lists webhooks", async () => {
    listWebhooks.mockReturnValue([
      {
        id: 1,
        contractId: CONTRACT,
        url: "https://example.com/hook",
        enabled: 1,
        createdAt: "2026-05-31T12:00:00.000Z",
      },
    ]);

    const res = await request(app).get(`/api/v1/webhooks/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  test("DELETE /webhooks/:contractId/:webhookId removes a webhook", async () => {
    const res = await request(app).delete(`/api/v1/webhooks/${CONTRACT}/1`);

    expect(res.status).toBe(200);
    expect(deleteWebhook).toHaveBeenCalledWith(CONTRACT, 1);
  });
});
