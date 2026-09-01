import { describe, expect, test } from "vitest";
import { buildContractPerformanceSummary } from "./contractPerformance";

describe("contract performance summaries", () => {
  test("returns zeroed state for no contracts", () => {
    const summary = buildContractPerformanceSummary([]);

    expect(summary.totalRevenue).toBe(0);
    expect(summary.activeContracts).toBe(0);
    expect(summary.transactionsThisMonth).toBe(0);
    expect(summary.contracts).toEqual([]);
  });

  test("summarizes a single contract and marks it active", () => {
    const summary = buildContractPerformanceSummary([
      {
        contractId: "C123",
        revenue: 1200,
        transactions: 3,
        lastActivity: "2026-07-21T12:00:00.000Z",
      },
    ]);

    expect(summary.activeContracts).toBe(1);
    expect(summary.totalRevenue).toBe(1200);
    expect(summary.transactionsThisMonth).toBe(3);
    expect(summary.contracts[0]).toMatchObject({
      contractId: "C123",
      status: "active",
    });
  });

  test("sorts and caps a large contract list by revenue", () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
      contractId: `C${index + 1}`,
      revenue: 100 + index,
      transactions: 1 + (index % 5),
      lastActivity: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

    const summary = buildContractPerformanceSummary(rows, {
      sortBy: "revenue",
      direction: "desc",
      limit: 100,
    });

    expect(summary.contracts).toHaveLength(100);
    expect(summary.contracts[0].contractId).toBe("C120");
    expect(summary.contracts[summary.contracts.length - 1].contractId).toBe(
      "C21",
    );
  });
});
