import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const registerWebhook = jest.fn();
const getWebhookById = jest.fn();
const listWebhooks = jest.fn();
const listWebhooksForEvent = jest.fn();
const deleteWebhook = jest.fn();
const updateWebhookRetryStateWithPayload = jest.fn();
const resetWebhookRetryCount = jest.fn();
const moveToDlq = jest.fn();
const recordDelivery = jest.fn(() => 7);
const updateDelivery = jest.fn(() => true);
const listDeliveries = jest.fn(() => []);
const countDeliveries = jest.fn(() => 0);
const getDeliveryStats = jest.fn(() => ({ total: 0, delivered: 0, failed: 0, pending: 0, exhausted: 0 }));
const parseEvents = jest.fn((json) => (json == null ? null : JSON.parse(json)));

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  registerWebhook,
  getWebhookById,
  listWebhooks,
  listWebhooksForEvent,
  deleteWebhook,
  updateWebhookRetryStateWithPayload,
  resetWebhookRetryCount,
  moveToDlq,
  recordDelivery,
  updateDelivery,
  listDeliveries,
  countDeliveries,
  getDeliveryStats,
  parseEvents,
}));

const postWebhook = jest.fn(async () => ({}));

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  postWebhook,
  _config: { BACKOFF_MS: [60_000, 300_000, 900_000, 3_600_000], MAX_WEBHOOK_RETRIES: 4 },
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  WEBHOOK_EVENTS,
  isSupportedEvent,
  normalizeEvents,
  generateWebhookSecret,
  signPayload,
  verifyWebhookSignature,
  registerAdvancedWebhook,
  deregisterWebhook,
  listAdvancedWebhooks,
  emitWebhookEvent,
  testWebhook,
  getWebhookDeliveryHistory,
  getWebhookDeliveryStats,
} = await import("../src/services/webhook-manager.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("webhook-manager (#1059)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("supports the required event set", () => {
    for (const event of [
      "distribution.completed",
      "dispute.created",
      "dispute.resolved",
      "governance.vote.started",
      "governance.vote.ended",
      "contract.status.changed",
    ]) {
      expect(WEBHOOK_EVENTS).toContain(event);
      expect(isSupportedEvent(event)).toBe(true);
    }
    expect(isSupportedEvent("nope")).toBe(false);
  });

  test("normalizeEvents rejects unknown events and dedupes", () => {
    expect(normalizeEvents(null)).toBeNull();
    expect(normalizeEvents([])).toBeNull();
    expect(normalizeEvents(["dispute.created", "dispute.created"])).toEqual(["dispute.created"]);
    expect(() => normalizeEvents(["bogus"])).toThrow("Unsupported webhook event");
    expect(() => normalizeEvents("dispute.created")).toThrow("must be an array");
  });

  test("HMAC sign/verify round-trips and rejects tampering", () => {
    const secret = generateWebhookSecret();
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThan(16);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());

    const body = JSON.stringify({ event: "dispute.created" });
    const signature = signPayload(secret, body);
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, `${body} `, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "deadbeef")).toBe(false);
    expect(verifyWebhookSignature(null, body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  test("registerAdvancedWebhook generates a secret and subscribes to events", () => {
    registerWebhook.mockReturnValue(11);

    const result = registerAdvancedWebhook(CONTRACT, "https://example.com/hook", ["dispute.created"]);

    expect(registerWebhook).toHaveBeenCalledWith(
      CONTRACT,
      "https://example.com/hook",
      ["dispute.created"],
      expect.any(String)
    );
    expect(result).toMatchObject({ webhookId: 11, url: "https://example.com/hook" });
    expect(result.secret).toEqual(expect.any(String));
    expect(result.events).toEqual(["dispute.created"]);
  });

  test("registerAdvancedWebhook rejects unknown events before touching the DB", () => {
    expect(() => registerAdvancedWebhook(CONTRACT, "https://example.com/hook", ["bogus"])).toThrow();
    expect(registerWebhook).not.toHaveBeenCalled();
  });

  test("deregisterWebhook delegates to the database", () => {
    deleteWebhook.mockReturnValue(true);
    expect(deregisterWebhook(CONTRACT, 3)).toBe(true);
    expect(deleteWebhook).toHaveBeenCalledWith(CONTRACT, 3);
  });

  test("listAdvancedWebhooks redacts secrets", () => {
    listWebhooks.mockReturnValue([
      {
        id: 1,
        contractId: CONTRACT,
        url: "https://example.com/hook",
        enabled: 1,
        events: JSON.stringify(["dispute.created"]),
        secret: "s3cr3t",
        retry_count: 0,
        next_retry_time: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const [entry] = listAdvancedWebhooks(CONTRACT);
    expect(entry.events).toEqual(["dispute.created"]);
    expect(entry.hasSecret).toBe(true);
    expect(entry).not.toHaveProperty("secret");
  });

  test("emitWebhookEvent delivers signed payloads in real time", async () => {
    listWebhooksForEvent.mockReturnValue([
      { id: 1, contractId: CONTRACT, url: "https://example.com/hook", secret: "s3cr3t", retry_count: 0 },
    ]);

    const result = await emitWebhookEvent({
      contractId: CONTRACT,
      event: "dispute.created",
      data: { ticketId: "T-1" },
    });

    expect(result).toEqual({ delivered: 1, failed: 0, attempted: 1 });
    expect(postWebhook).toHaveBeenCalledTimes(1);
    const [url, envelope, options] = postWebhook.mock.calls[0];
    expect(url).toBe("https://example.com/hook");
    expect(envelope.event).toBe("dispute.created");
    expect(envelope.contractId).toBe(CONTRACT);
    expect(options.headers["X-Webhook-Event"]).toBe("dispute.created");
    expect(options.headers["X-Webhook-Signature"]).toMatch(/^sha256=[0-9a-f]+$/);
    expect(resetWebhookRetryCount).toHaveBeenCalledWith(1);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: 1, event: "dispute.created", status: "pending" })
    );
    expect(updateDelivery).toHaveBeenCalledWith(7, expect.objectContaining({ status: "delivered" }));
  });

  test("emitWebhookEvent schedules retry with backoff on failure", async () => {
    listWebhooksForEvent.mockReturnValue([
      { id: 2, contractId: CONTRACT, url: "https://example.com/hook", secret: null, retry_count: 0 },
    ]);
    postWebhook.mockRejectedValueOnce(new Error("Webhook returned HTTP 500"));

    const result = await emitWebhookEvent({
      contractId: CONTRACT,
      event: "distribution.completed",
      data: {},
    });

    expect(result).toEqual({ delivered: 0, failed: 1, attempted: 1 });
    expect(updateWebhookRetryStateWithPayload).toHaveBeenCalledTimes(1);
    const [id, retryCount, nextRetry, payload] = updateWebhookRetryStateWithPayload.mock.calls[0];
    expect(id).toBe(2);
    expect(retryCount).toBe(1);
    expect(new Date(nextRetry).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.parse(payload).event).toBe("distribution.completed");
    expect(updateDelivery).toHaveBeenCalledWith(7, expect.objectContaining({ status: "failed" }));
    expect(moveToDlq).not.toHaveBeenCalled();
  });

  test("emitWebhookEvent moves to DLQ after max retries", async () => {
    listWebhooksForEvent.mockReturnValue([
      { id: 3, contractId: CONTRACT, url: "https://example.com/hook", secret: null, retry_count: 3 },
    ]);
    postWebhook.mockRejectedValueOnce(new Error("boom"));

    const result = await emitWebhookEvent({
      contractId: CONTRACT,
      event: "governance.vote.started",
      data: {},
    });

    expect(result.failed).toBe(1);
    expect(moveToDlq).toHaveBeenCalledTimes(1);
    expect(updateDelivery).toHaveBeenCalledWith(7, expect.objectContaining({ status: "exhausted" }));
  });

  test("emitWebhookEvent rejects unsupported events", async () => {
    await expect(emitWebhookEvent({ contractId: CONTRACT, event: "bogus", data: {} })).rejects.toThrow(
      "Unsupported webhook event"
    );
    expect(postWebhook).not.toHaveBeenCalled();
  });

  test("testWebhook sends a signed ping and records success", async () => {
    getWebhookById.mockReturnValue({
      id: 4,
      contractId: CONTRACT,
      url: "https://example.com/hook",
      enabled: 1,
      secret: "s3cr3t",
    });

    const result = await testWebhook(CONTRACT, 4);

    expect(result.success).toBe(true);
    expect(result.event).toBe("webhook.test");
    const [, envelope, options] = postWebhook.mock.calls[0];
    expect(envelope.event).toBe("webhook.test");
    expect(options.headers["X-Webhook-Signature"]).toMatch(/^sha256=/);
    expect(updateDelivery).toHaveBeenCalledWith(7, expect.objectContaining({ status: "delivered" }));
  });

  test("testWebhook returns failure (no throw) when the endpoint is down", async () => {
    getWebhookById.mockReturnValue({
      id: 5,
      contractId: CONTRACT,
      url: "https://example.com/hook",
      enabled: 1,
      secret: null,
    });
    postWebhook.mockRejectedValueOnce(new Error("Webhook returned HTTP 503"));

    const result = await testWebhook(CONTRACT, 5);

    expect(result.success).toBe(false);
    expect(result.error).toMatch("503");
    expect(updateDelivery).toHaveBeenCalledWith(7, expect.objectContaining({ status: "failed" }));
  });

  test("testWebhook throws 404 for unknown webhooks", async () => {
    getWebhookById.mockReturnValue(null);
    await expect(testWebhook(CONTRACT, 999)).rejects.toMatchObject({ status: 404 });
    expect(postWebhook).not.toHaveBeenCalled();
  });

  test("delivery history and stats delegate to the database", () => {
    listDeliveries.mockReturnValue([{ id: 1 }]);
    countDeliveries.mockReturnValue(1);

    expect(getWebhookDeliveryHistory({ contractId: CONTRACT })).toEqual({ data: [{ id: 1 }], total: 1 });
    expect(getWebhookDeliveryStats(CONTRACT)).toEqual({
      total: 0,
      delivered: 0,
      failed: 0,
      pending: 0,
      exhausted: 0,
    });
    expect(getDeliveryStats).toHaveBeenCalledWith(CONTRACT);
  });
});
