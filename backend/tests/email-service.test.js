import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ─── Mock nodemailer ──────────────────────────────────────────────────────────

const mockSendMail = jest.fn();
const mockVerify = jest.fn();

jest.unstable_mockModule("nodemailer", () => ({
  default: {
    createTransport: jest.fn(() => ({
      sendMail: mockSendMail,
      verify: mockVerify,
    })),
  },
}));

// ─── Mock @sendgrid/mail ──────────────────────────────────────────────────────

const mockSgSend = jest.fn();

jest.unstable_mockModule("@sendgrid/mail", () => ({
  default: {
    setApiKey: jest.fn(),
    send: mockSgSend,
  },
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const { sendEmail, isEmailConfigured, verifyConnection, isSendGridConfigured } =
  await import("../src/email/email-service.js");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Email service (#569 + SendGrid migration)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    // Reset: no email transport by default
    delete process.env.SMTP_HOST;
    delete process.env.SENDGRID_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── isEmailConfigured ──────────────────────────────────────────────────────

  describe("isEmailConfigured", () => {
    test("returns false when neither SMTP nor SendGrid is configured", () => {
      expect(isEmailConfigured()).toBe(false);
    });

    test("returns true when SMTP_HOST is set", () => {
      process.env.SMTP_HOST = "smtp.example.com";
      expect(isEmailConfigured()).toBe(true);
    });

    test("returns true when SENDGRID_API_KEY is set", () => {
      process.env.SENDGRID_API_KEY = "SG.test-key";
      expect(isEmailConfigured()).toBe(true);
    });

    test("returns true when both are set", () => {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SENDGRID_API_KEY = "SG.test-key";
      expect(isEmailConfigured()).toBe(true);
    });
  });

  // ── isSendGridConfigured ───────────────────────────────────────────────────

  describe("isSendGridConfigured", () => {
    test("returns false when SENDGRID_API_KEY is unset", () => {
      expect(isSendGridConfigured()).toBe(false);
    });

    test("returns true when SENDGRID_API_KEY is set", () => {
      process.env.SENDGRID_API_KEY = "SG.test-key";
      expect(isSendGridConfigured()).toBe(true);
    });
  });

  // ── SMTP path ─────────────────────────────────────────────────────────────

  describe("SMTP path (no SendGrid key)", () => {
    test("sendEmail sends mail with correct parameters", async () => {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.EMAIL_FROM = "Test <test@example.com>";
      mockSendMail.mockResolvedValue({ messageId: "msg-123" });

      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(result.sent).toBe(true);
      expect(result.messageId).toBe("msg-123");
      expect(mockSendMail).toHaveBeenCalledWith({
        from: "Test <test@example.com>",
        to: "recipient@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });
    });

    test("sendEmail returns failure when SMTP not configured", async () => {
      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toBe("smtp_not_configured");
    });

    test("sendEmail handles send errors", async () => {
      process.env.SMTP_HOST = "smtp.example.com";
      mockSendMail.mockRejectedValue(new Error("Connection refused"));

      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain("Connection refused");
    });

    test("verifyConnection returns true on success", async () => {
      process.env.SMTP_HOST = "smtp.example.com";
      mockVerify.mockResolvedValue(true);

      const result = await verifyConnection();

      expect(result).toBe(true);
    });

    test("verifyConnection returns false when SMTP not configured", async () => {
      const result = await verifyConnection();

      expect(result).toBe(false);
    });
  });

  // ── SendGrid path ─────────────────────────────────────────────────────────

  describe("SendGrid path (SENDGRID_API_KEY set)", () => {
    beforeEach(() => {
      process.env.SENDGRID_API_KEY = "SG.test-key";
    });

    test("sendEmail routes through SendGrid when API key is set", async () => {
      mockSgSend.mockResolvedValue([{ headers: { "x-message-id": "sg-msg-1" } }]);

      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Test SendGrid",
        html: "<p>Hello</p>",
        text: "Hello",
      });

      expect(result.sent).toBe(true);
      expect(result.messageId).toBe("sg-msg-1");
      // SMTP should not have been called
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test("SendGrid takes priority over SMTP when both are configured", async () => {
      process.env.SMTP_HOST = "smtp.example.com";
      mockSgSend.mockResolvedValue([{ headers: { "x-message-id": "sg-wins" } }]);

      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Priority test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(result.sent).toBe(true);
      expect(mockSgSend).toHaveBeenCalledTimes(1);
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    test("verifyConnection returns true for SendGrid (no live API call)", async () => {
      const result = await verifyConnection();
      expect(result).toBe(true);
      expect(mockVerify).not.toHaveBeenCalled();
    });

    test("sendEmail returns failure when SendGrid send fails", async () => {
      const err = new Error("Forbidden");
      err.response = { status: 403 };
      mockSgSend.mockRejectedValue(err);

      const result = await sendEmail({
        to: "recipient@test.com",
        subject: "Test",
        html: "<p>Hi</p>",
        text: "Hi",
      });

      expect(result.sent).toBe(false);
      expect(result.reason).toContain("Forbidden");
    });
  });
});
