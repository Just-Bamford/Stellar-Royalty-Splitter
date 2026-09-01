import { describe, test, expect } from "@jest/globals";
import { renderWeeklyDigestHtml, renderWeeklyDigestText } from "../src/email/templates/weekly-digest.js";

const mockEarnings = {
  totalEarned: 12.3456789,
  payoutCount: 5,
  topContract: {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    totalEarned: 10.1234567,
    payoutCount: 3,
  },
  contracts: [
    {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      totalEarned: 10.1234567,
      payoutCount: 3,
    },
    {
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      totalEarned: 2.2222222,
      payoutCount: 2,
    },
  ],
};

const mockZeroEarnings = {
  totalEarned: 0,
  payoutCount: 0,
  topContract: null,
  contracts: [],
};

const mockSingleContract = {
  totalEarned: 5.0,
  payoutCount: 2,
  topContract: {
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    totalEarned: 5.0,
    payoutCount: 2,
  },
  contracts: [
    {
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      totalEarned: 5.0,
      payoutCount: 2,
    },
  ],
};

const commonProps = {
  walletAddress: "GAPTAQKSMN2ILFVHXDE5V274BUPC6QCRMJZYJFNGW7ENT2X3BQOS4M3C",
  weekStart: "Jul 20, 2026",
  weekEnd: "Jul 26, 2026",
  unsubscribeUrl: "https://example.com/unsubscribe?token=abc123",
};

describe("Weekly digest email template (#569)", () => {
  describe("HTML template", () => {
    test("renders earnings summary correctly", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockEarnings });

      expect(html).toContain("Weekly Earnings Summary");
      expect(html).toContain("Jul 20, 2026");
      expect(html).toContain("Jul 26, 2026");
      expect(html).toContain("12.3456789");
      expect(html).toContain("5");
      expect(html).toContain("Unsubscribe from weekly digests");
    });

    test("renders top-earning contract", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockEarnings });

      expect(html).toContain("Top Earning Contract");
      expect(html).toContain("10.1234567 earned");
    });

    test("renders contract breakdown table for multiple contracts", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockEarnings });

      expect(html).toContain("All Contracts");
      expect(html).toContain("CBBBBBBB");
    });

    test("does not render contract table for single contract", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockSingleContract });

      expect(html).not.toContain("All Contracts");
    });

    test("renders zero earnings correctly", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockZeroEarnings });

      expect(html).toContain("0.0000000");
      expect(html).toContain("N/A");
      expect(html).toContain("Unsubscribe from weekly digests");
    });

    test("includes unsubscribe link", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockEarnings });

      expect(html).toContain("https://example.com/unsubscribe?token=abc123");
    });

    test("truncates wallet address in display", () => {
      const html = renderWeeklyDigestHtml({ ...commonProps, earnings: mockEarnings });

      expect(html).toContain("GAAAAAAAAA...AAAAAAAA");
    });
  });

  describe("Plain text template", () => {
    test("renders earnings summary correctly", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockEarnings });

      expect(text).toContain("Weekly Earnings Summary");
      expect(text).toContain("Jul 20, 2026");
      expect(text).toContain("Jul 26, 2026");
      expect(text).toContain("12.3456789");
      expect(text).toContain("5");
    });

    test("renders contract breakdown for multiple contracts", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockEarnings });

      expect(text).toContain("Contract Breakdown");
      expect(text).toContain("CBBBBBBB");
    });

    test("does not render contract breakdown for single contract", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockSingleContract });

      expect(text).not.toContain("Contract Breakdown");
    });

    test("renders zero earnings", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockZeroEarnings });

      expect(text).toContain("0.0000000");
      expect(text).toContain("N/A");
    });

    test("includes unsubscribe link", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockEarnings });

      expect(text).toContain("Unsubscribe: https://example.com/unsubscribe?token=abc123");
    });

    test("truncates wallet address in display", () => {
      const text = renderWeeklyDigestText({ ...commonProps, earnings: mockEarnings });

      expect(text).toContain("GAAAAAAAAA...AAAAAAAA");
    });
  });
});
