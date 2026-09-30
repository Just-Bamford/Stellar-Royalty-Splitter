/**
 * Unit tests for the pure anomaly-scoring engine (#1042).
 *
 * These exercise only deterministic, I/O-free logic so they run quickly and
 * do not require a database or the Python runtime.
 */

import { describe, it, expect } from "@jest/globals";
import {
  scoreTransaction,
  deriveAlertLevel,
  POINTS,
  DEFAULT_THRESHOLDS,
} from "../src/services/anomaly-scorer.js";

describe("anomaly-scorer: scoreTransaction", () => {
  it("returns a zero score with no risk factors", () => {
    const { score, factors } = scoreTransaction({
      amount: 100,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 0,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(0);
    expect(factors).toHaveLength(0);
  });

  it("flags an amount over 3x the historical average (+30)", () => {
    const { score, factors } = scoreTransaction({
      amount: 350,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 0,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(POINTS.LARGE_AMOUNT);
    expect(factors.map((f) => f.name)).toEqual(["large_amount"]);
  });

  it("does NOT flag an amount at exactly 3x the average (boundary)", () => {
    const { score } = scoreTransaction({
      amount: 300,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 0,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(0);
  });

  it("flags a new location (+20)", () => {
    const { score, factors } = scoreTransaction({
      amount: 100,
      historicalAverage: 100,
      isNewLocation: true,
      failedAttempts: 0,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(POINTS.NEW_LOCATION);
    expect(factors.some((f) => f.name === "new_location")).toBe(true);
  });

  it("flags multiple failed attempts (>= threshold, +25)", () => {
    const { score, factors } = scoreTransaction({
      amount: 100,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 2,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(POINTS.MULTIPLE_FAILED);
    expect(factors.some((f) => f.name === "multiple_failed_attempts")).toBe(true);
  });

  it("does NOT flag failed attempts below the threshold", () => {
    const { score } = scoreTransaction({
      amount: 100,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 1,
      hour: 12,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(0);
  });

  it("flags activity outside usual hours (+15)", () => {
    const { score, factors } = scoreTransaction({
      amount: 100,
      historicalAverage: 100,
      isNewLocation: false,
      failedAttempts: 0,
      hour: 3,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(POINTS.OFF_HOURS);
    expect(factors.some((f) => f.name === "off_hours")).toBe(true);
  });

  it("sums every risk factor (defaults max out at 90, below the 100 cap)", () => {
    const all = scoreTransaction({
      amount: 1000,
      historicalAverage: 10,
      isNewLocation: true,
      failedAttempts: 5,
      hour: 2,
      usualHours: { start: 8, end: 22 },
    });
    const total = POINTS.LARGE_AMOUNT + POINTS.NEW_LOCATION + POINTS.MULTIPLE_FAILED + POINTS.OFF_HOURS;
    expect(all.score).toBe(total);
    expect(all.score).toBe(90);
    expect(all.score).toBeLessThanOrEqual(100);
    expect(all.factors.map((f) => f.name).sort()).toEqual(
      ["large_amount", "new_location", "multiple_failed_attempts", "off_hours"].sort(),
    );
  });

  it("treats an amount below 3x as normal even with high average", () => {
    const { score } = scoreTransaction({
      amount: 100,
      historicalAverage: 50, // 3x = 150; 100 is under
      isNewLocation: false,
      failedAttempts: 0,
      hour: 10,
      usualHours: { start: 8, end: 22 },
    });
    expect(score).toBe(0);
  });

  it("uses custom thresholds when provided", () => {
    const { score } = scoreTransaction({
      amount: 100,
      historicalAverage: 10, // 2x with custom multiplier
      isNewLocation: false,
      failedAttempts: 1,
      hour: 10,
      usualHours: { start: 8, end: 22 },
      thresholds: { ...DEFAULT_THRESHOLDS, amountMultiplier: 2, failedAttempts: 2 },
    });
    expect(score).toBe(POINTS.LARGE_AMOUNT);
  });
});

describe("anomaly-scorer: deriveAlertLevel", () => {
  it("allows scores at or below the verification threshold", () => {
    expect(deriveAlertLevel(0)).toBe("allow");
    expect(deriveAlertLevel(50)).toBe("allow");
    expect(deriveAlertLevel(51)).toBe("require_verification");
  });

  it("requires verification for scores > 50 and <= 80", () => {
    expect(deriveAlertLevel(51)).toBe("require_verification");
    expect(deriveAlertLevel(80)).toBe("require_verification");
  });

  it("blocks scores strictly greater than 80", () => {
    expect(deriveAlertLevel(81)).toBe("block");
    expect(deriveAlertLevel(100)).toBe("block");
  });
});
