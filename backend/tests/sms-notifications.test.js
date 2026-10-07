/**
 * Tests for the SMS notification dispatch service — closes #927.
 *
 * Covers the opt-in/opt-out gating (large payout, dispute opened, payment
 * failed all send SMS when opted in with a phone on file, and do NOT send
 * when opted out or no phone on file) and delivery-status persistence.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";

const mockGetSmsPreferences = jest.fn();
const mockRecordSmsSendAttempt = jest.fn();
const mockSendSms = jest.fn();

await jest.unstable_mockModule("../src/database/sms-preferences.js", () => ({
  getSmsPreferences: mockGetSmsPreferences,
  recordSmsSendAttempt: mockRecordSmsSendAttempt,
}));

await jest.unstable_mockModule("../src/services/twilio-sms.js", () => ({
  sendSms: mockSendSms,
}));

const { sendEventSms } = await import("../src/services/sms-notifications.js");

const WALLET = "GA7E6YDRQKJ2JNOG27UPSCQ3FQ6U4X3QQGJKHNGF23T7QCI2FM6E3W2P";

describe("sendEventSms (#927)", () => {
  beforeEach(() => jest.clearAllMocks());

  describe("large_payout", () => {
    test("sends SMS when opted in with a phone number on file", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 1, phoneNumber: "+15551234567" });
      mockSendSms.mockResolvedValue({ sent: true, sid: "SM123", status: "queued" });

      const result = await sendEventSms(WALLET, "large_payout", {
        amount: "1,000.0000000 XLM",
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(result).toEqual({ attempted: true, sent: true, reason: undefined });
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(mockSendSms.mock.calls[0][0]).toBe("+15551234567");
      expect(mockSendSms.mock.calls[0][1]).toContain("1,000.0000000 XLM");
      expect(mockRecordSmsSendAttempt).toHaveBeenCalledWith(
        expect.objectContaining({ walletAddress: WALLET, eventType: "large_payout", sent: true, providerSid: "SM123" })
      );
    });

    test("does NOT send when opted out", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 0, phoneNumber: "+15551234567" });

      const result = await sendEventSms(WALLET, "large_payout", { amount: "1,000 XLM", contractId: "C..." });

      expect(result).toEqual({ attempted: false, reason: "not_opted_in" });
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    test("does NOT send when opted in but no phone number on file", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 1, phoneNumber: null });

      const result = await sendEventSms(WALLET, "large_payout", { amount: "1,000 XLM", contractId: "C..." });

      expect(result).toEqual({ attempted: false, reason: "not_opted_in" });
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    test("does NOT send when no preference record exists at all", async () => {
      mockGetSmsPreferences.mockReturnValue(null);

      const result = await sendEventSms(WALLET, "large_payout", { amount: "1,000 XLM", contractId: "C..." });

      expect(result).toEqual({ attempted: false, reason: "not_opted_in" });
      expect(mockSendSms).not.toHaveBeenCalled();
    });
  });

  describe("dispute_opened", () => {
    test("sends SMS when opted in", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 1, phoneNumber: "+15551234567" });
      mockSendSms.mockResolvedValue({ sent: true, sid: "SM456", status: "queued" });

      const result = await sendEventSms(WALLET, "dispute_opened", { ticketId: "DSP-A3F2C019" });

      expect(result.attempted).toBe(true);
      expect(result.sent).toBe(true);
      expect(mockSendSms.mock.calls[0][1]).toContain("DSP-A3F2C019");
    });

    test("does NOT send when opted out", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 0, phoneNumber: null });

      const result = await sendEventSms(WALLET, "dispute_opened", { ticketId: "DSP-A3F2C019" });

      expect(result.attempted).toBe(false);
      expect(mockSendSms).not.toHaveBeenCalled();
    });
  });

  describe("payment_failed", () => {
    test("sends SMS when opted in", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 1, phoneNumber: "+15551234567" });
      mockSendSms.mockResolvedValue({ sent: true, sid: "SM789", status: "queued" });

      const result = await sendEventSms(WALLET, "payment_failed", {
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        reason: "insufficient balance",
      });

      expect(result.attempted).toBe(true);
      expect(result.sent).toBe(true);
      expect(mockSendSms.mock.calls[0][1]).toContain("insufficient balance");
    });

    test("does NOT send when opted out", async () => {
      mockGetSmsPreferences.mockReturnValue({ smsEnabled: 0, phoneNumber: "+15551234567" });

      const result = await sendEventSms(WALLET, "payment_failed", { contractId: "C..." });

      expect(result.attempted).toBe(false);
      expect(mockSendSms).not.toHaveBeenCalled();
    });
  });

  test("records a failed delivery attempt when Twilio send fails", async () => {
    mockGetSmsPreferences.mockReturnValue({ smsEnabled: 1, phoneNumber: "+15551234567" });
    mockSendSms.mockResolvedValue({ sent: false, reason: "twilio_not_configured" });

    const result = await sendEventSms(WALLET, "dispute_opened", { ticketId: "DSP-1" });

    expect(result).toEqual({ attempted: true, sent: false, reason: "twilio_not_configured" });
    expect(mockRecordSmsSendAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ sent: false, failureReason: "twilio_not_configured" })
    );
  });

  test("returns without sending for an unknown event type", async () => {
    const result = await sendEventSms(WALLET, "some_unknown_event", {});

    expect(result).toEqual({ attempted: false, reason: "unknown_event_type" });
    expect(mockGetSmsPreferences).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  test("does not throw when the preferences lookup itself throws", async () => {
    mockGetSmsPreferences.mockImplementation(() => {
      throw new Error("db unavailable");
    });

    const result = await sendEventSms(WALLET, "dispute_opened", { ticketId: "DSP-1" });

    expect(result).toEqual({ attempted: false, reason: "preferences_lookup_failed" });
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
