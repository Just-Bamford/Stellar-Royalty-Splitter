import { describe, expect, test } from "@jest/globals";
import {
  buildChartSeries,
  calculatePeriodSummary,
  fillMissingDays,
  filterEventsInRange,
  getRangeDates,
  measureChartTransformMs,
  uniqueContractIds,
  type DailySnapshot,
} from "./earnings-history";

const sampleSnapshots: DailySnapshot[] = [
  { date: "2026-07-01", contractId: "C1", amount: 10 },
  { date: "2026-07-02", contractId: "C1", amount: 20 },
  { date: "2026-07-02", contractId: "C2", amount: 5 },
  { date: "2026-07-10", contractId: "C1", amount: 15 },
];

describe("earnings history transforms", () => {
  test("returns correct date windows for each range", () => {
    const ref = new Date("2026-07-27T12:00:00.000Z");
    expect(getRangeDates("7d", ref)).toEqual({ start: "2026-07-21", end: "2026-07-27" });
    expect(getRangeDates("30d", ref).start).toBe("2026-06-28");
    expect(getRangeDates("90d", ref).start).toBe("2026-04-29");
    expect(getRangeDates("all", ref).start).toBe("1970-01-01");
  });

  test("fills missing days for each contract", () => {
    const filled = fillMissingDays(sampleSnapshots, "2026-07-01", "2026-07-03", ["C1", "C2"]);
    expect(filled).toHaveLength(6);
    expect(filled.find((row) => row.date === "2026-07-03" && row.contractId === "C1")?.amount).toBe(0);
  });

  test("builds aggregated chart series with multi-contract totals", () => {
    const contracts = new Set(["C1", "C2"]);
    const series = buildChartSeries(sampleSnapshots, contracts);
    expect(series).toHaveLength(3);
    expect(series[1]).toMatchObject({ date: "2026-07-02", total: 25, C1: 20, C2: 5 });
  });

  test("calculates absolute and percent change for a period", () => {
    const summary = calculatePeriodSummary(sampleSnapshots, "30d", new Date("2026-07-27T00:00:00.000Z"));
    expect(summary.total).toBe(50);
    expect(summary.absoluteChange).toBe(50);
    expect(summary.percentChange).toBeNull();
  });

  test("filters event markers to the selected range", () => {
    const events = filterEventsInRange(
      [
        { type: "contract_added", contractId: "C1", date: "2026-07-01T00:00:00.000Z", label: "New contract" },
        { type: "distribution_failure", contractId: "C2", date: "2026-08-01T00:00:00.000Z", label: "Distribution failed" },
      ],
      "2026-07-01",
      "2026-07-31",
    );
    expect(events).toHaveLength(1);
    expect(events[0].contractId).toBe("C1");
  });

  test("transforms 100+ points in under one second", () => {
    const elapsed = measureChartTransformMs(150);
    expect(elapsed).toBeLessThan(1000);
    expect(uniqueContractIds(sampleSnapshots)).toEqual(["C1", "C2"]);
  });
});
