import { describe, it, expect } from "@jest/globals";
import {
  normalizeVestingSchedule,
  vestedAmountAt,
  availableTokensAt,
  buildVestingSchedule,
  getUnlockEvents,
  projectVesting,
  buildVestingAnalytics,
  simulateVesting,
  vestingToCsv,
} from "../src/services/vesting-analytics.js";

const START = "2025-01-01T00:00:00.000Z";

function schedule(overrides = {}) {
  return {
    label: "Team",
    beneficiary: "GABC",
    totalAmount: 1200,
    releasedAmount: 0,
    startDate: START,
    cliffMonths: 6,
    vestingMonths: 12,
    ...overrides,
  };
}

describe("vesting-analytics", () => {
  describe("normalizeVestingSchedule", () => {
    it("rejects non-positive amounts", () => {
      expect(() => normalizeVestingSchedule({ totalAmount: 0 })).toThrow(
        /totalAmount/,
      );
    });

    it("clamps released amounts to the total", () => {
      const normalized = normalizeVestingSchedule({
        totalAmount: 100,
        releasedAmount: 500,
      });
      expect(normalized.releasedAmount).toBe(100);
    });
  });

  describe("vestedAmountAt", () => {
    it("is 0 before the start", () => {
      expect(vestedAmountAt(schedule(), "2024-12-01T00:00:00.000Z")).toBe(0);
    });

    it("is 0 during the cliff", () => {
      expect(vestedAmountAt(schedule(), "2025-06-30T00:00:00.000Z")).toBe(0);
    });

    it("is 0 at the cliff boundary and grows linearly", () => {
      expect(vestedAmountAt(schedule(), "2025-07-01T00:00:00.000Z")).toBe(0);
      // Roughly half of the 12 vesting months elapsed (calendar months vary).
      const halfway = vestedAmountAt(schedule(), "2026-01-01T00:00:00.000Z");
      expect(halfway).toBeGreaterThan(590);
      expect(halfway).toBeLessThan(620);
    });

    it("is fully vested at the end date", () => {
      expect(vestedAmountAt(schedule(), "2026-07-01T00:00:00.000Z")).toBe(1200);
      expect(vestedAmountAt(schedule(), "2027-01-01T00:00:00.000Z")).toBe(1200);
    });
  });

  describe("availableTokensAt", () => {
    it("subtracts already-released tokens", () => {
      const available = availableTokensAt(schedule({ releasedAmount: 100 }), "2026-07-01T00:00:00.000Z");
      expect(available).toBe(1100);
    });

    it("never returns a negative amount", () => {
      const available = availableTokensAt(schedule({ releasedAmount: 1200 }), START);
      expect(available).toBe(0);
    });
  });

  describe("buildVestingSchedule", () => {
    it("returns cliff/end dates, a curve and unlock events", () => {
      const built = buildVestingSchedule(schedule(), { intervalDays: 30 });
      expect(built.cliffDate).toBe("2025-07-01T00:00:00.000Z");
      expect(built.vestingEndDate).toBe("2026-07-01T00:00:00.000Z");
      expect(built.points.length).toBeGreaterThan(0);
      expect(built.unlockEvents.length).toBeGreaterThan(0);
      expect(built.totalAmount).toBe(1200);
    });
  });

  describe("getUnlockEvents", () => {
    it("returns increasing monthly deltas that sum to the total", () => {
      const events = getUnlockEvents(schedule(), { horizonMonths: 24, from: START });
      const total = events.reduce((sum, e) => sum + e.unlockedAmount, 0);
      expect(total).toBeCloseTo(1200, 4);
      for (const event of events) {
        expect(event.unlockedAmount).toBeGreaterThan(0);
      }
    });
  });

  describe("projectVesting", () => {
    it("aggregates multiple schedules", () => {
      const projection = projectVesting(
        [
          schedule(),
          schedule({ label: "Advisor", totalAmount: 600, cliffMonths: 0, vestingMonths: 6 }),
        ],
        { intervalDays: 30 },
      );
      expect(projection.totalAmount).toBe(1800);
      expect(projection.points.length).toBeGreaterThan(1);
      const last = projection.points[projection.points.length - 1];
      expect(last.vestedAmount).toBeGreaterThan(1700);
      expect(last.vestedAmount).toBeLessThanOrEqual(1800);
    });

    it("handles an empty schedule list", () => {
      expect(projectVesting([])).toMatchObject({ totalAmount: 0, points: [] });
    });
  });

  describe("buildVestingAnalytics", () => {
    it("summarises totals, statuses and merged unlock events", () => {
      const analytics = buildVestingAnalytics([schedule()], {
        asOf: "2026-01-01T00:00:00.000Z",
      });
      expect(analytics.scheduleCount).toBe(1);
      expect(analytics.totalAmount).toBe(1200);
      expect(analytics.totalVested).toBeCloseTo(605, 0);
      expect(analytics.totalLocked).toBeCloseTo(595, 0);
      expect(analytics.vestedPercent).toBeCloseTo(50, 0);
      expect(analytics.schedules[0].status).toBe("vesting");
      expect(Array.isArray(analytics.unlockEvents)).toBe(true);
    });

    it("reports fully vested schedules", () => {
      const analytics = buildVestingAnalytics([schedule()], {
        asOf: "2027-01-01T00:00:00.000Z",
      });
      expect(analytics.schedules[0].status).toBe("fully_vested");
      expect(analytics.totalVested).toBe(1200);
    });
  });

  describe("simulateVesting", () => {
    it("compares base and scenario vesting at the horizon", () => {
      const result = simulateVesting(
        schedule(),
        { cliffMonths: 0, vestingMonths: 6 },
        { asOf: START, horizonMonths: 12 },
      );
      expect(result.base.vestedAtHorizon).toBeCloseTo(605, 0);
      expect(result.scenario.vestedAtHorizon).toBe(1200);
      expect(result.comparison.vestedDelta).toBeCloseTo(595, 0);

      const slower = simulateVesting(
        schedule(),
        { vestingMonths: 36 },
        { asOf: START, horizonMonths: 18 },
      );
      expect(slower.scenario.vestedAtHorizon).toBeLessThan(1200);
      expect(slower.comparison.vestedDelta).toBeLessThan(0);
    });
  });

  describe("vestingToCsv", () => {
    it("emits a header plus one row per schedule", () => {
      const analytics = buildVestingAnalytics([schedule()], { asOf: START });
      const csv = vestingToCsv(analytics);
      const lines = csv.split("\r\n");
      expect(lines[0]).toContain("Total Amount");
      expect(lines.length).toBe(2);
    });
  });
});
