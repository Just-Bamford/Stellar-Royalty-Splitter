import { describe, it, expect } from "@jest/globals";
import {
  addMonths,
  allocationUnlockPercent,
  circulatingSupplyAt,
  projectSupply,
  calculateDilution,
  getUnlockEvents,
  simulateDistribution,
  buildTokenEconomicsModel,
  normalizeConfig,
  projectionToCsv,
} from "../src/services/token-economics.js";

const TGE = "2025-01-01T00:00:00.000Z";

function baseConfig(overrides = {}) {
  return {
    tokenSymbol: "SRS",
    totalSupply: 1000,
    tgeDate: TGE,
    allocations: [
      { name: "Team", amount: 1000, tgePercent: 10, cliffMonths: 6, vestingMonths: 12 },
    ],
    ...overrides,
  };
}

describe("token-economics", () => {
  describe("addMonths", () => {
    it("advances calendar months and clamps the day", () => {
      // 31 Jan + 1 month should clamp to the end of February.
      expect(addMonths("2025-01-31T00:00:00.000Z", 1).toISOString()).toBe(
        "2025-02-28T00:00:00.000Z",
      );
      expect(addMonths("2025-01-01T00:00:00.000Z", 12).toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });
  });

  describe("normalizeConfig", () => {
    it("rejects a non-positive total supply", () => {
      expect(() => normalizeConfig({ totalSupply: 0 })).toThrow(/totalSupply/);
    });

    it("rejects allocations exceeding total supply", () => {
      expect(() =>
        normalizeConfig({
          totalSupply: 100,
          allocations: [{ name: "A", amount: 200 }],
        }),
      ).toThrow(/exceed total supply/);
    });

    it("fills defaults for missing allocation fields", () => {
      const config = normalizeConfig({
        totalSupply: 100,
        allocations: [{ name: "A", amount: 100 }],
      });
      expect(config.allocations[0]).toMatchObject({
        tgePercent: 0,
        cliffMonths: 0,
        vestingMonths: 0,
      });
    });
  });

  describe("allocationUnlockPercent", () => {
    const allocation = { tgePercent: 10, cliffMonths: 6, vestingMonths: 12 };

    it("is 0 before TGE", () => {
      expect(allocationUnlockPercent(allocation, TGE, "2024-12-01T00:00:00.000Z")).toBe(0);
    });

    it("unlocks only the TGE percentage at the cliff", () => {
      expect(allocationUnlockPercent(allocation, TGE, "2025-07-01T00:00:00.000Z")).toBe(10);
    });

    it("is linear at the midpoint of vesting", () => {
      // cliff 2025-07-01 + ~6 of 12 months => roughly 10 + 45 = 55
      const percent = allocationUnlockPercent(
        allocation,
        TGE,
        "2026-01-01T00:00:00.000Z",
      );
      expect(percent).toBeGreaterThan(54);
      expect(percent).toBeLessThan(56);
    });

    it("is 100 after vesting completes", () => {
      expect(allocationUnlockPercent(allocation, TGE, "2026-08-01T00:00:00.000Z")).toBe(100);
    });
  });

  describe("circulatingSupplyAt", () => {
    it("tracks circulating and locked supply", () => {
      const atTge = circulatingSupplyAt(baseConfig(), TGE);
      expect(atTge.circulatingSupply).toBe(100);
      expect(atTge.lockedSupply).toBe(900);
      expect(atTge.circulatingPercent).toBe(10);

      const fullyVested = circulatingSupplyAt(baseConfig(), "2026-08-01T00:00:00.000Z");
      expect(fullyVested.circulatingSupply).toBe(1000);
      expect(fullyVested.lockedSupply).toBe(0);
      expect(fullyVested.circulatingPercent).toBe(100);
    });
  });

  describe("projectSupply", () => {
    it("returns a monotonic timeline bounded by the horizon", () => {
      const projection = projectSupply(baseConfig(), {
        months: 24,
        intervalDays: 30,
        from: TGE,
      });
      expect(projection.points.length).toBeGreaterThan(1);
      expect(projection.startCirculating).toBe(100);
      expect(projection.endCirculating).toBe(1000);
      for (let i = 1; i < projection.points.length; i++) {
        expect(projection.points[i].circulatingSupply).toBeGreaterThanOrEqual(
          projection.points[i - 1].circulatingSupply,
        );
      }
    });
  });

  describe("calculateDilution", () => {
    it("computes dilution from future circulating supply", () => {
      const dilution = calculateDilution(baseConfig(), {
        asOf: TGE,
        horizonMonths: 24,
      });
      expect(dilution.currentCirculatingSupply).toBe(100);
      expect(dilution.futureCirculatingSupply).toBe(1000);
      expect(dilution.newlyUnlocked).toBe(900);
      expect(dilution.supplyGrowthPercent).toBe(900);
      expect(dilution.dilutionPercent).toBe(90);
    });
  });

  describe("getUnlockEvents", () => {
    it("returns positive monthly unlock deltas", () => {
      const events = getUnlockEvents(baseConfig(), { horizonMonths: 24, from: TGE });
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.unlockedAmount).toBeGreaterThan(0);
      }
    });
  });

  describe("simulateDistribution", () => {
    it("compares base and scenario projections", () => {
      const result = simulateDistribution(
        baseConfig(),
        {
          allocations: [
            { name: "Team", amount: 1000, tgePercent: 50, cliffMonths: 6, vestingMonths: 12 },
          ],
        },
        { months: 24, asOf: TGE },
      );
      expect(result.base.projection.endCirculating).toBe(1000);
      expect(result.scenario.dilution.newlyUnlocked).toBeLessThan(
        result.base.dilution.newlyUnlocked,
      );
      expect(result.comparison.circulatingSupplyDelta).toBe(0);
      expect(typeof result.comparison.dilutionDelta).toBe("number");
    });
  });

  describe("buildTokenEconomicsModel", () => {
    it("returns supply, projection, dilution and unlock events", () => {
      const model = buildTokenEconomicsModel(baseConfig(), {
        asOf: TGE,
        horizonMonths: 24,
      });
      expect(model.totalSupply).toBe(1000);
      expect(model.current.circulatingSupply).toBe(100);
      expect(model.projection.points.length).toBeGreaterThan(0);
      expect(model.dilution.dilutionPercent).toBe(90);
      expect(Array.isArray(model.unlockEvents)).toBe(true);
    });
  });

  describe("projectionToCsv", () => {
    it("emits a header and one row per point", () => {
      const projection = projectSupply(baseConfig(), { months: 6, from: TGE });
      const csv = projectionToCsv(projection);
      const lines = csv.split("\r\n");
      expect(lines[0]).toBe(
        "Date,Total Supply,Circulating Supply,Locked Supply,Circulating %",
      );
      expect(lines.length).toBe(projection.points.length + 1);
    });
  });
});
