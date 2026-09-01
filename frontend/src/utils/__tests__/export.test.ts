import { describe, it, expect } from "vitest";
import {
  formatDateStamp,
  buildExportFilename,
  escapeCSV,
  buildCollaboratorsCSV,
  buildCollaboratorsJSON,
  buildEarningsCSV,
  buildEarningsJSON,
  type CollaboratorExportItem,
  type CollaboratorEarningExportItem,
  type PayoutExportItem,
} from "../export";

describe("Export Utilities (#896)", () => {
  describe("formatDateStamp", () => {
    it("formats dates as YYYY-MM-DD", () => {
      const d = new Date("2025-08-20T14:30:00Z");
      expect(formatDateStamp(d)).toBe("2025-08-20");
    });
  });

  describe("buildExportFilename", () => {
    const testDate = new Date("2025-08-20T00:00:00Z");

    it("generates filename without contract ID", () => {
      expect(buildExportFilename("collaborators", "csv", undefined, testDate)).toBe(
        "collaborators-2025-08-20.csv",
      );
      expect(buildExportFilename("earnings", "json", undefined, testDate)).toBe(
        "earnings-2025-08-20.json",
      );
    });

    it("includes snippet when contract ID is provided", () => {
      expect(
        buildExportFilename("collaborators", "csv", "CCONTRACT123456789", testDate),
      ).toBe("collaborators-CCONTRAC-2025-08-20.csv");
    });

    it("ignores __all__ contract pseudo-id", () => {
      expect(
        buildExportFilename("earnings", "csv", "__all__", testDate),
      ).toBe("earnings-2025-08-20.csv");
    });
  });

  describe("escapeCSV & Formula Injection Protection", () => {
    it("handles plain alphanumeric strings without quoting", () => {
      expect(escapeCSV("GABC12345")).toBe("GABC12345");
      expect(escapeCSV(1234)).toBe("1234");
      expect(escapeCSV(null)).toBe("");
      expect(escapeCSV(undefined)).toBe("");
    });

    it("escapes commas, quotes, and newlines per RFC 4180", () => {
      expect(escapeCSV("Doe, John")).toBe('"Doe, John"');
      expect(escapeCSV('Hello "World"')).toBe('"Hello ""World"""');
      expect(escapeCSV("Line 1\nLine 2")).toBe('"Line 1\nLine 2"');
    });

    it("neutralizes formula injection characters (=, +, -, @, \\t, \\r)", () => {
      expect(escapeCSV("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(escapeCSV("+12345")).toBe("'+12345");
      expect(escapeCSV("-CMD('calc')")).toBe("'-CMD('calc')");
      expect(escapeCSV("@hyperlink")).toBe("'@hyperlink");
    });
  });

  describe("buildCollaboratorsCSV and buildCollaboratorsJSON", () => {
    const sampleCollaborators: CollaboratorExportItem[] = [
      {
        address: "GBJ5WEXXF67LGBWOG36P552XQ4X7L3L67B5472Q",
        name: "Alice Artist",
        basisPoints: 6000,
        sharePercentage: 60,
        tier: "VIP",
        paymentStatus: "Paid",
        payoutCount: 5,
      },
      {
        address: "GAYOA5J2XQ4X7L3L67B5472QGBJ5WEXXF67LGBW",
        name: "Bob Builder",
        basisPoints: 4000,
        sharePercentage: 40,
        tier: "Regular",
        paymentStatus: "Unpaid",
        payoutCount: 0,
      },
    ];

    it("generates correct CSV headers and row data", () => {
      const csv = buildCollaboratorsCSV(sampleCollaborators);
      const lines = csv.split("\r\n");

      expect(lines[0]).toBe(
        "Address,Name,Basis Points,Share (%),Tier,Payment Status,Payout Count",
      );
      expect(lines[1]).toContain("GBJ5WEXXF67LGBWOG36P552XQ4X7L3L67B5472Q");
      expect(lines[1]).toContain("Alice Artist");
      expect(lines[1]).toContain("6000");
      expect(lines[1]).toContain("60.00");
      expect(lines[1]).toContain("VIP");
      expect(lines[1]).toContain("Paid");
      expect(lines[1]).toContain("5");
    });

    it("generates valid JSON with metadata", () => {
      const jsonStr = buildCollaboratorsJSON(sampleCollaborators, {
        contractId: "C12345678",
        activeFilters: { shareRange: "gt10" },
      });
      const parsed = JSON.parse(jsonStr);

      expect(parsed.metadata.contractId).toBe("C12345678");
      expect(parsed.metadata.recordCount).toBe(2);
      expect(parsed.metadata.totalBasisPoints).toBe(10000);
      expect(parsed.metadata.totalSharePercentage).toBe("100.00");
      expect(parsed.metadata.activeFilters.shareRange).toBe("gt10");
      expect(parsed.collaborators).toHaveLength(2);
      expect(parsed.collaborators[0].name).toBe("Alice Artist");
    });

    it("handles large scale datasets (150+ collaborators) without loss or truncation", () => {
      const largeList: CollaboratorExportItem[] = Array.from({ length: 150 }, (_, i) => ({
        address: `GADDR${i.toString().padStart(6, "0")}`,
        name: `Collaborator ${i}`,
        basisPoints: 50,
        sharePercentage: 0.5,
        tier: i % 2 === 0 ? "VIP" : "Regular",
        paymentStatus: i % 3 === 0 ? "Paid" : "Unpaid",
        payoutCount: i % 3 === 0 ? 10 : 0,
      }));

      const csv = buildCollaboratorsCSV(largeList);
      const rows = csv.split("\r\n");
      // Header line + 150 data rows
      expect(rows).toHaveLength(151);

      const jsonStr = buildCollaboratorsJSON(largeList);
      const parsed = JSON.parse(jsonStr);
      expect(parsed.collaborators).toHaveLength(150);
      expect(parsed.metadata.recordCount).toBe(150);
      expect(parsed.metadata.totalBasisPoints).toBe(7500);
    });
  });

  describe("buildEarningsCSV and buildEarningsJSON", () => {
    const earnings: CollaboratorEarningExportItem[] = [
      {
        address: "GADDR0001",
        name: "Alice",
        basisPoints: 6000,
        sharePercentage: 60,
        totalEarned: 1500,
        payoutCount: 3,
        avgPayout: 500,
      },
    ];

    const payouts: PayoutExportItem[] = [
      {
        id: "tx-123",
        type: "primary",
        timestamp: "2025-08-20T10:00:00Z",
        amount: 2500,
        status: "confirmed",
        txHash: "hash123",
        details: "Primary Distribution",
      },
    ];

    it("generates CSV containing both earnings and payout sections", () => {
      const csv = buildEarningsCSV(earnings, payouts);
      expect(csv).toContain("# Collaborator Earnings Breakdown");
      expect(csv).toContain("GADDR0001");
      expect(csv).toContain("1500");
      expect(csv).toContain("# Recent Payout History");
      expect(csv).toContain("tx-123");
      expect(csv).toContain("2500");
    });

    it("generates structured JSON for analytics dashboard", () => {
      const json = buildEarningsJSON(
        {
          collaborators: earnings,
          payouts,
          totalDistributed: 2500,
          primaryTotal: 2500,
          secondaryTotal: 0,
        },
        { contractId: "C123" },
      );
      const parsed = JSON.parse(json);

      expect(parsed.metadata.contractId).toBe("C123");
      expect(parsed.earningsSummary.totalDistributed).toBe(2500);
      expect(parsed.collaborators).toHaveLength(1);
      expect(parsed.recentPayouts).toHaveLength(1);
    });
  });
});
