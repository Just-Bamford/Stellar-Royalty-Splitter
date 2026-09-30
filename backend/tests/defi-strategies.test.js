/**
 * Tests for DeFi strategy recommendations (#1040).
 */

import { describe, test, expect } from "@jest/globals";
import {
  RISK_TOLERANCE_LEVELS,
  STRATEGY_CATALOG,
  allocatePortfolio,
  projectReturns,
  recommendStrategies,
} from "../src/services/defi-strategies.js";

describe("defi strategies (#1040)", () => {
  test("projects simple and compounded returns", () => {
    const strategy = { apy: 0.1 };
    const simple = projectReturns(strategy, { amountUsd: 1000, horizonDays: 365, compound: false });
    expect(simple.simpleReturn).toBeCloseTo(100, 5);

    const compounded = projectReturns(strategy, { amountUsd: 1000, horizonDays: 365 });
    expect(compounded.compoundedReturn).toBeGreaterThan(100);
    expect(compounded.compoundedReturn).toBeCloseTo(105.16, 1);
  });

  test("filters strategies by risk tolerance", () => {
    const conservative = recommendStrategies({ riskTolerance: "conservative" });
    expect(conservative.every((s) => s.riskLevel <= RISK_TOLERANCE_LEVELS.conservative)).toBe(true);

    const aggressive = recommendStrategies({ riskTolerance: "aggressive" });
    expect(aggressive.length).toBe(STRATEGY_CATALOG.length);
    expect(aggressive.some((s) => s.riskLevel === 5)).toBe(true);
  });

  test("excludes strategies whose lockup exceeds the horizon", () => {
    const shortHorizon = recommendStrategies({ riskTolerance: "aggressive", horizonDays: 3 });
    expect(shortHorizon.every((s) => s.lockupDays <= 3)).toBe(true);
    expect(shortHorizon.some((s) => s.id === "boosted-yield-vault")).toBe(false);
  });

  test("honours an explicit exclusion list and sorts by projected return", () => {
    const recs = recommendStrategies({
      riskTolerance: "aggressive",
      excludeIds: ["xlm-native-staking"],
    });
    expect(recs.some((s) => s.id === "xlm-native-staking")).toBe(false);

    for (let i = 1; i < recs.length; i += 1) {
      expect(recs[i - 1].projectedReturn).toBeGreaterThanOrEqual(recs[i].projectedReturn);
    }
  });

  test("rejects unknown tolerances and non-positive inputs", () => {
    expect(() => recommendStrategies({ riskTolerance: "degen" })).toThrow(/unknown riskTolerance/);
    expect(() => projectReturns({ apy: 0.1 }, { amountUsd: 0, horizonDays: 30 })).toThrow(
      /amountUsd/
    );
    expect(() => recommendStrategies({ horizonDays: -1 })).toThrow(/horizonDays/);
  });

  test("allocates a portfolio and computes the blended APY", () => {
    const recs = [
      { id: "a", apy: 0.05 },
      { id: "b", apy: 0.15 },
    ];
    const result = allocatePortfolio(recs, { amountUsd: 1000 });

    expect(result.allocations).toHaveLength(2);
    expect(result.blendedApy).toBeCloseTo(0.1, 10);
    expect(result.projectedReturn).toBeCloseTo(100, 10);
    const total = result.allocations.reduce((sum, a) => sum + a.amountUsd, 0);
    expect(total).toBeCloseTo(1000, 10);
  });

  test("returns an empty portfolio for no recommendations", () => {
    expect(allocatePortfolio([], { amountUsd: 1000 })).toEqual({
      allocations: [],
      blendedApy: 0,
      projectedReturn: 0,
    });
  });
});
