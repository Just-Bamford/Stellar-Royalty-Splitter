import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

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

await jest.unstable_mockModule("../src/database/index.js", () => ({
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 6),
}));

const { sendEmail, isEmailConfigured, verifyConnection } = await import("../src/email/email-service.js");

describe("Email service (#569)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("isEmailConfigured returns false when SMTP_HOST is unset", () => {
    delete process.env.SMTP_HOST;
    expect(isEmailConfigured()).toBe(false);
  });

  test("isEmailConfigured returns true when SMTP_HOST is set", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    expect(isEmailConfigured()).toBe(true);
  });

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
    delete process.env.SMTP_HOST;

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
    delete process.env.SMTP_HOST;

    const result = await verifyConnection();

    expect(result).toBe(false);
  });
});
