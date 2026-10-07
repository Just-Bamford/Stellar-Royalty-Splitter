/**
 * Tests for SMS notification templates — closes #927.
 *
 * Asserts content correctness and that every template stays within
 * ~300 characters (roughly 1-2 GSM-7 SMS segments).
 */
import { describe, test, expect } from "@jest/globals";
import {
  largePayoutSms,
  disputeOpenedSms,
  paymentFailedSms,
  SMS_TEMPLATES,
} from "../src/sms/templates/event-notifications.js";

const MAX_LENGTH = 300;
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("SMS templates (#927)", () => {
  describe("largePayoutSms", () => {
    test("includes the amount and a details link", () => {
      const body = largePayoutSms({ amount: "1,250.0000000 XLM", contractId: CONTRACT_ID });
      expect(body).toContain("1,250.0000000 XLM");
      expect(body).toContain(CONTRACT_ID);
      expect(body).toMatch(/https?:\/\//);
    });

    test("stays within the SMS length budget", () => {
      const body = largePayoutSms({ amount: "9,999,999.9999999 XLM", contractId: CONTRACT_ID });
      expect(body.length).toBeLessThanOrEqual(MAX_LENGTH);
    });

    test("respects a custom base URL", () => {
      const body = largePayoutSms({ amount: "100 XLM", contractId: CONTRACT_ID, baseUrl: "https://custom.example" });
      expect(body).toContain("https://custom.example/contracts/");
    });
  });

  describe("disputeOpenedSms", () => {
    test("includes the ticket ID and a details link", () => {
      const body = disputeOpenedSms({ ticketId: "DSP-A3F2C019" });
      expect(body).toContain("DSP-A3F2C019");
      expect(body).toMatch(/https?:\/\//);
    });

    test("stays within the SMS length budget", () => {
      const body = disputeOpenedSms({ ticketId: "DSP-A3F2C019" });
      expect(body.length).toBeLessThanOrEqual(MAX_LENGTH);
    });
  });

  describe("paymentFailedSms", () => {
    test("includes the failure reason when provided", () => {
      const body = paymentFailedSms({ contractId: CONTRACT_ID, reason: "insufficient balance" });
      expect(body).toContain("insufficient balance");
      expect(body).toContain(CONTRACT_ID);
    });

    test("omits the parenthetical when no reason is provided", () => {
      const body = paymentFailedSms({ contractId: CONTRACT_ID });
      expect(body).not.toContain("()");
      expect(body).toContain(CONTRACT_ID);
    });

    test("stays within the SMS length budget", () => {
      const body = paymentFailedSms({ contractId: CONTRACT_ID, reason: "insufficient balance in source account" });
      expect(body.length).toBeLessThanOrEqual(MAX_LENGTH);
    });
  });

  describe("SMS_TEMPLATES registry", () => {
    test("maps every supported event type to its builder", () => {
      expect(SMS_TEMPLATES.large_payout).toBe(largePayoutSms);
      expect(SMS_TEMPLATES.dispute_opened).toBe(disputeOpenedSms);
      expect(SMS_TEMPLATES.payment_failed).toBe(paymentFailedSms);
    });
  });
});
