/**
 * Tests for src/services/sendgrid.js
 *
 * Covers:
 *   - isSendGridConfigured
 *   - getEmailStatus / setEmailStatus
 *   - sendEmailViaSendGrid (success, suppressed, retry on temp error, hard failure)
 *   - sendPayoutConfirmationEmail
 *   - sendAlertEmailViaSendGrid
 *   - processSendGridWebhookEvents (delivered, bounce, soft-bounce, spamreport,
 *     unsubscribe, open, click, dropped, deferred, unknown)
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ─── Mock @sendgrid/mail before importing the service ────────────────────────

const mockSend = jest.fn();

jest.unstable_mockModule("@sendgrid/mail", () => ({
  default: {
    setApiKey: jest.fn(),
    send: mockSend,
  },
}));

// Mock database so the module can be imported in test context
await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const {
  isSendGridConfigured,
  getEmailStatus,
  setEmailStatus,
  sendEmailViaSendGrid,
  sendPayoutConfirmationEmail,
  sendAlertEmailViaSendGrid,
  processSendGridWebhookEvents,
} = await import("../src/services/sendgrid.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SAMPLE_EMAIL = "collaborator@example.com";

// ─── isSendGridConfigured ─────────────────────────────────────────────────────

describe("isSendGridConfigured", () => {
  const orig = process.env.SENDGRID_API_KEY;
  afterEach(() => {
    if (orig === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = orig;
  });

  test("returns false when SENDGRID_API_KEY is unset", () => {
    delete process.env.SENDGRID_API_KEY;
    expect(isSendGridConfigured()).toBe(false);
  });

  test("returns true when SENDGRID_API_KEY is set", () => {
    process.env.SENDGRID_API_KEY = "SG.test-key";
    expect(isSendGridConfigured()).toBe(true);
  });
});

// ─── getEmailStatus / setEmailStatus ─────────────────────────────────────────

describe("email status store", () => {
  test("returns valid by default for unknown address", () => {
    const result = getEmailStatus("unknown@example.com");
    expect(result.status).toBe("valid");
    expect(result.updatedAt).toBeNull();
  });

  test("setEmailStatus updates the status", () => {
    setEmailStatus("bounce@example.com", "invalid");
    expect(getEmailStatus("bounce@example.com").status).toBe("invalid");
    expect(getEmailStatus("bounce@example.com").updatedAt).not.toBeNull();
  });

  test("setEmailStatus can mark as suppressed", () => {
    setEmailStatus("spam@example.com", "suppressed");
    expect(getEmailStatus("spam@example.com").status).toBe("suppressed");
  });
});

// ─── sendEmailViaSendGrid ─────────────────────────────────────────────────────

describe("sendEmailViaSendGrid", () => {
  const savedKey = process.env.SENDGRID_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = "SG.test-key";
    // Reset status for the test email address to valid
    setEmailStatus(SAMPLE_EMAIL, "valid");
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.SENDGRID_API_KEY;
    else process.env.SENDGRID_API_KEY = savedKey;
  });

  test("sends email and returns { sent: true, messageId } on success", async () => {
    mockSend.mockResolvedValue([{ headers: { "x-message-id": "msg-abc" } }]);

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("msg-abc");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("skips send to suppressed address", async () => {
    setEmailStatus(SAMPLE_EMAIL, "suppressed");

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("address_suppressed");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("skips send to invalid address", async () => {
    setEmailStatus(SAMPLE_EMAIL, "invalid");

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toBe("address_invalid");
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("auto-retries once on temporary 429 error and succeeds", async () => {
    const tempError = new Error("rate limited");
    tempError.response = { status: 429 };

    mockSend
      .mockRejectedValueOnce(tempError)
      .mockResolvedValueOnce([{ headers: { "x-message-id": "msg-retry" } }]);

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(true);
    expect(result.retried).toBe(true);
    expect(result.messageId).toBe("msg-retry");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test("returns failure when retry also fails", async () => {
    const tempError = new Error("rate limited");
    tempError.response = { status: 429 };

    mockSend
      .mockRejectedValueOnce(tempError)
      .mockRejectedValueOnce(new Error("still failing"));

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("still failing");
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test("does not retry on non-retryable 401 error", async () => {
    const authError = new Error("unauthorized");
    authError.response = { status: 401 };
    mockSend.mockRejectedValue(authError);

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("throws when SENDGRID_API_KEY is unset", async () => {
    delete process.env.SENDGRID_API_KEY;

    const result = await sendEmailViaSendGrid({
      to: SAMPLE_EMAIL,
      subject: "Test",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(result.sent).toBe(false);
    expect(result.reason).toContain("SENDGRID_API_KEY");
  });
});

// ─── sendPayoutConfirmationEmail ──────────────────────────────────────────────

describe("sendPayoutConfirmationEmail", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = "SG.test-key";
    setEmailStatus("artist@example.com", "valid");
  });

  test("sends payout confirmation with correct subject and content", async () => {
    mockSend.mockResolvedValue([{ headers: { "x-message-id": "payout-msg" } }]);

    const result = await sendPayoutConfirmationEmail({
      to: "artist@example.com",
      walletAddress: "GARTIST000000000000000000000000000000000000000000000000000",
      amount: "100.0000000",
      token: "XLM",
      contractId: "CABC123456789012345678901234567890123456789012345678901234",
      transactionId: "tx-abc-123",
    });

    expect(result.sent).toBe(true);
    const sentMsg = mockSend.mock.calls[0][0];
    expect(sentMsg.subject).toContain("royalty payout");
    expect(sentMsg.html).toContain("100.0000000");
    expect(sentMsg.html).toContain("XLM");
    expect(sentMsg.html).toContain("tx-abc-123");
  });
});

// ─── sendAlertEmailViaSendGrid ────────────────────────────────────────────────

describe("sendAlertEmailViaSendGrid", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SENDGRID_API_KEY = "SG.test-key";
    setEmailStatus("admin@example.com", "valid");
  });

  test("sends alert email with severity in subject", async () => {
    mockSend.mockResolvedValue([{ headers: {} }]);

    const result = await sendAlertEmailViaSendGrid({
      to: "admin@example.com",
      alert: {
        contract: "CABC...",
        errorCount: 5,
        threshold: 3,
        severity: "critical",
        remedy: "Check logs immediately.",
      },
    });

    expect(result.sent).toBe(true);
    const sentMsg = mockSend.mock.calls[0][0];
    expect(sentMsg.subject).toContain("[CRITICAL]");
    expect(sentMsg.html).toContain("Check logs immediately.");
  });
});

// ─── processSendGridWebhookEvents ─────────────────────────────────────────────

describe("processSendGridWebhookEvents", () => {
  beforeEach(() => {
    // Reset statuses before each test
    setEmailStatus("ok@example.com", "valid");
    setEmailStatus("bounced@example.com", "valid");
    setEmailStatus("spam@example.com", "valid");
    setEmailStatus("dropped@example.com", "valid");
  });

  test("returns { processed: 0, errors: 0 } for empty array", () => {
    const result = processSendGridWebhookEvents([]);
    expect(result).toEqual({ processed: 0, errors: 0 });
  });

  test("delivery event marks address as valid", () => {
    processSendGridWebhookEvents([
      { email: "ok@example.com", event: "delivered", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("ok@example.com").status).toBe("valid");
  });

  test("hard bounce marks address as invalid", () => {
    processSendGridWebhookEvents([
      { email: "bounced@example.com", event: "bounce", type: "bounce", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("bounced@example.com").status).toBe("invalid");
  });

  test("soft bounce (blocked) does not mark as invalid", () => {
    processSendGridWebhookEvents([
      { email: "bounced@example.com", event: "bounce", type: "blocked", timestamp: 1700000000 },
    ]);
    // Status should remain unchanged (still valid since we reset above)
    expect(getEmailStatus("bounced@example.com").status).toBe("valid");
  });

  test("spamreport marks address as suppressed", () => {
    processSendGridWebhookEvents([
      { email: "spam@example.com", event: "spamreport", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("spam@example.com").status).toBe("suppressed");
  });

  test("unsubscribe marks address as suppressed", () => {
    processSendGridWebhookEvents([
      { email: "spam@example.com", event: "unsubscribe", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("spam@example.com").status).toBe("suppressed");
  });

  test("dropped marks address as invalid", () => {
    processSendGridWebhookEvents([
      { email: "dropped@example.com", event: "dropped", reason: "Invalid", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("dropped@example.com").status).toBe("invalid");
  });

  test("open and click events are processed without status change", () => {
    const { processed, errors } = processSendGridWebhookEvents([
      { email: "ok@example.com", event: "open", timestamp: 1700000000 },
      { email: "ok@example.com", event: "click", timestamp: 1700000000 },
    ]);
    expect(processed).toBe(2);
    expect(errors).toBe(0);
    expect(getEmailStatus("ok@example.com").status).toBe("valid");
  });

  test("deferred events do not change status", () => {
    processSendGridWebhookEvents([
      { email: "ok@example.com", event: "deferred", reason: "DNS failure", timestamp: 1700000000 },
    ]);
    expect(getEmailStatus("ok@example.com").status).toBe("valid");
  });

  test("unknown event types are logged but counted as processed", () => {
    const { processed, errors } = processSendGridWebhookEvents([
      { email: "ok@example.com", event: "group_unsubscribe", timestamp: 1700000000 },
    ]);
    expect(processed).toBe(1);
    expect(errors).toBe(0);
  });

  test("processes a mixed batch and returns correct counts", () => {
    const events = [
      { email: "a@example.com", event: "delivered", timestamp: 1700000000 },
      { email: "b@example.com", event: "bounce", type: "bounce", timestamp: 1700000000 },
      { email: "c@example.com", event: "spamreport", timestamp: 1700000000 },
      { email: "d@example.com", event: "open", timestamp: 1700000000 },
    ];
    const { processed, errors } = processSendGridWebhookEvents(events);
    expect(processed).toBe(4);
    expect(errors).toBe(0);
    expect(getEmailStatus("b@example.com").status).toBe("invalid");
    expect(getEmailStatus("c@example.com").status).toBe("suppressed");
  });

  test("increments error count on malformed event", () => {
    // A null event will throw during destructuring
    const { processed, errors } = processSendGridWebhookEvents([null]);
    expect(errors).toBe(1);
    expect(processed).toBe(0);
  });
});
