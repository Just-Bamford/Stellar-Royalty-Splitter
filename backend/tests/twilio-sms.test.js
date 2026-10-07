/**
 * Tests for the Twilio SMS wrapper — closes #927.
 */
import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const mockCreate = jest.fn();
const mockTwilioFactory = jest.fn(() => ({
  messages: { create: mockCreate },
}));

jest.unstable_mockModule("twilio", () => ({
  default: mockTwilioFactory,
}));

const { sendSms, isSmsConfigured } = await import("../src/services/twilio-sms.js");

describe("Twilio SMS wrapper (#927)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("isSmsConfigured", () => {
    test("returns false when TWILIO_ACCOUNT_SID is unset", () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_PHONE = "+15551234567";
      expect(isSmsConfigured()).toBe(false);
    });

    test("returns false when TWILIO_AUTH_TOKEN is unset", () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      delete process.env.TWILIO_AUTH_TOKEN;
      process.env.TWILIO_PHONE = "+15551234567";
      expect(isSmsConfigured()).toBe(false);
    });

    test("returns false when TWILIO_PHONE is unset", () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      delete process.env.TWILIO_PHONE;
      expect(isSmsConfigured()).toBe(false);
    });

    test("returns true when all three are set", () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_PHONE = "+15551234567";
      expect(isSmsConfigured()).toBe(true);
    });
  });

  describe("sendSms", () => {
    test("sends an SMS with the correct parameters", async () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_PHONE = "+15550000000";
      mockCreate.mockResolvedValue({ sid: "SMxxxxx", status: "queued" });

      const result = await sendSms("+15551234567", "Hello from the test suite");

      expect(result.sent).toBe(true);
      expect(result.sid).toBe("SMxxxxx");
      expect(result.status).toBe("queued");
      expect(mockTwilioFactory).toHaveBeenCalledWith("ACxxx", "token");
      expect(mockCreate).toHaveBeenCalledWith({
        to: "+15551234567",
        from: "+15550000000",
        body: "Hello from the test suite",
      });
    });

    test("returns failure without calling Twilio when not configured", async () => {
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE;

      const result = await sendSms("+15551234567", "Hello");

      expect(result.sent).toBe(false);
      expect(result.reason).toBe("twilio_not_configured");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("returns failure when recipient is missing", async () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_PHONE = "+15550000000";

      const result = await sendSms(undefined, "Hello");

      expect(result.sent).toBe(false);
      expect(result.reason).toBe("missing_recipient");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("handles Twilio API errors without throwing", async () => {
      process.env.TWILIO_ACCOUNT_SID = "ACxxx";
      process.env.TWILIO_AUTH_TOKEN = "token";
      process.env.TWILIO_PHONE = "+15550000000";
      mockCreate.mockRejectedValue(new Error("Invalid phone number"));

      const result = await sendSms("+1555bad", "Hello");

      expect(result.sent).toBe(false);
      expect(result.reason).toContain("Invalid phone number");
    });
  });
});
