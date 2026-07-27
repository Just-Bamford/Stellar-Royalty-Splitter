import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockGetWebhooksDueForRetry = jest.fn(() => []);
const mockUpdateWebhookRetryState = jest.fn();
const mockResetWebhookRetryCount = jest.fn();

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  getWebhooksDueForRetry: mockGetWebhooksDueForRetry,
  updateWebhookRetryState: mockUpdateWebhookRetryState,
  resetWebhookRetryCount: mockResetWebhookRetryCount,
}));

const mockPostWebhook = jest.fn();

await jest.unstable_mockModule("../src/webhook-delivery.js", () => ({
  postWebhook: mockPostWebhook,
}));

const mockSendEmail = jest.fn(() => Promise.resolve({ sent: true, messageId: "msg-123" }));
const mockIsEmailConfigured = jest.fn(() => true);

await jest.unstable_mockModule("../src/email/email-service.js", () => ({
  sendEmail: mockSendEmail,
  isEmailConfigured: mockIsEmailConfigured,
}));

const mockAddAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  addAuditLog: mockAddAuditLog,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  retryWebhookDelivery,
  retryFailedWebhooks,
  sendWebhookRetryExhaustedAlert,
  startWebhookRetryScheduler,
  _resetAlertedExhaustedIds,
  _config,
} = await import("../src/jobs/retry-failed-webhooks.js");

function makeFailedWebhook(overrides = {}) {
  return {
    id: 1,
    contractId: "CAAAAAAAA",
    url: "https://example.com/hook",
    enabled: 1,
    retry_count: 0,
    next_retry_time: "2026-01-01T00:00:00.000Z",
    payload: JSON.stringify({ event: "distribute.confirmed", transactionHash: "abc123" }),
    ...overrides,
  };
}

describe("Webhook Retry Job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEmailConfigured.mockReturnValue(true);
    mockSendEmail.mockResolvedValue({ sent: true, messageId: "msg-123" });
    _resetAlertedExhaustedIds();
    delete process.env.ADMIN_ALERT_EMAIL;
  });

  describe("getWebhooksDueForRetry", () => {
    test("returns webhooks with next_retry_time <= now and retry_count < 4", async () => {
      const now = new Date("2026-06-15T12:00:00.000Z");
      const dueWebhook = makeFailedWebhook({
        retry_count: 1,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockGetWebhooksDueForRetry.mockReturnValue([dueWebhook]);

      const result = await retryFailedWebhooks(now);

      expect(result.processed).toBe(1);
      expect(mockPostWebhook).toHaveBeenCalledTimes(1);
    });

    test("returns empty when no webhooks are due", async () => {
      mockGetWebhooksDueForRetry.mockReturnValue([]);

      const result = await retryFailedWebhooks(new Date());

      expect(result.processed).toBe(0);
      expect(mockPostWebhook).not.toHaveBeenCalled();
    });

    test("excludes webhooks at max retry count", async () => {
      const dueWebhook = makeFailedWebhook({
        retry_count: 4,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockGetWebhooksDueForRetry.mockReturnValue([dueWebhook]);

      const result = await retryFailedWebhooks(new Date());

      expect(result.processed).toBe(0);
      expect(mockPostWebhook).not.toHaveBeenCalled();
    });
  });

  describe("retryWebhookDelivery - success", () => {
    test("resets retry state on successful delivery after previous failures", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 2,
        next_retry_time: "2026-06-15T11:00:00.000Z",
        payload: JSON.stringify({ event: "distribute.confirmed", transactionHash: "abc123" }),
      });
      mockPostWebhook.mockResolvedValue(undefined);

      const now = new Date("2026-06-15T12:00:00.000Z");
      const outcome = await retryWebhookDelivery(webhook, now);

      expect(outcome).toBe("retried");
      expect(mockResetWebhookRetryCount).toHaveBeenCalledWith(webhook.id);
    });

    test("saves audit log on successful retry", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 0,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockPostWebhook.mockResolvedValue(undefined);

      await retryWebhookDelivery(webhook, new Date());

      expect(mockAddAuditLog).toHaveBeenCalledWith(
        webhook.contractId,
        "webhook_retry_succeeded",
        "system",
        expect.objectContaining({
          webhookId: webhook.id,
          retryNumber: 1,
        })
      );
    });
  });

  describe("retryWebhookDelivery - failure", () => {
    test("increments retry_count and sets next_retry_time on failure", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 0,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockPostWebhook.mockRejectedValue(new Error("HTTP 500"));

      const now = new Date("2026-06-15T12:00:00.000Z");
      const outcome = await retryWebhookDelivery(webhook, now);

      expect(outcome).toBe("error");
      expect(mockUpdateWebhookRetryState).toHaveBeenCalledWith(
        webhook.id,
        1,
        expect.any(String)
      );
    });

    test("saves audit log on failed retry", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 0,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockPostWebhook.mockRejectedValue(new Error("HTTP 500"));

      await retryWebhookDelivery(webhook, new Date());

      expect(mockAddAuditLog).toHaveBeenCalledWith(
        webhook.contractId,
        "webhook_retry_failed",
        "system",
        expect.objectContaining({
          webhookId: webhook.id,
          retryNumber: 1,
          error: "HTTP 500",
        })
      );
    });

    test("sends alert after final failure (4 retries)", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 3,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockPostWebhook.mockRejectedValue(new Error("HTTP 500"));

      const now = new Date("2026-06-15T12:00:00.000Z");
      const outcome = await retryWebhookDelivery(webhook, now);

      expect(outcome).toBe("exhausted");
      expect(mockSendEmail).toHaveBeenCalledTimes(1);
      expect(mockAddAuditLog).toHaveBeenCalledWith(
        webhook.contractId,
        "webhook_retry_exhausted",
        "system",
        expect.objectContaining({
          webhookId: webhook.id,
          totalRetries: 4,
          adminNotified: true,
        })
      );
    });

    test("does not send duplicate alerts for same webhook", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 3,
        next_retry_time: "2026-06-15T11:00:00.000Z",
      });
      mockPostWebhook.mockRejectedValue(new Error("HTTP 500"));

      await retryWebhookDelivery(webhook, new Date());
      await retryWebhookDelivery(webhook, new Date());

      expect(mockSendEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("backoff timing", () => {
    test("uses exponential backoff: 1m, 5m, 15m, 1h", () => {
      expect(_config.BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
    });

    test("max retries is 4", () => {
      expect(_config.MAX_WEBHOOK_RETRIES).toBe(4);
    });
  });

  describe("exhausted webhook with no payload", () => {
    test("uses fallback payload when webhook has no stored payload", async () => {
      const webhook = makeFailedWebhook({
        retry_count: 3,
        next_retry_time: "2026-06-15T11:00:00.000Z",
        payload: null,
      });
      mockPostWebhook.mockRejectedValue(new Error("HTTP 500"));

      const now = new Date("2026-06-15T12:00:00.000Z");
      const outcome = await retryWebhookDelivery(webhook, now);

      expect(outcome).toBe("exhausted");
      expect(mockPostWebhook).toHaveBeenCalledWith(webhook.url, {
        event: "distribute.confirmed",
        contractId: webhook.contractId,
        timestamp: expect.any(String),
      });
    });
  });

  describe("sendWebhookRetryExhaustedAlert", () => {
    test("returns reason when ADMIN_ALERT_EMAIL is not configured", async () => {
      const result = await sendWebhookRetryExhaustedAlert(makeFailedWebhook());

      expect(result.sent).toBe(false);
      expect(result.reason).toBe("admin_email_not_configured");
    });

    test("returns reason when SMTP is not configured", async () => {
      mockIsEmailConfigured.mockReturnValue(false);

      const result = await sendWebhookRetryExhaustedAlert(makeFailedWebhook());

      expect(result.sent).toBe(false);
      expect(result.reason).toBe("smtp_not_configured");
    });

    test("sends email when admin email and SMTP are configured", async () => {
      process.env.ADMIN_ALERT_EMAIL = "admin@example.com";
      mockIsEmailConfigured.mockReturnValue(true);
      mockSendEmail.mockResolvedValue({ sent: true, messageId: "msg-456" });

      const webhook = makeFailedWebhook();
      const result = await sendWebhookRetryExhaustedAlert(webhook);

      expect(result.sent).toBe(true);
      expect(mockSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "admin@example.com",
          subject: expect.stringContaining("Webhook retry exhausted"),
        })
      );
    });
  });
});