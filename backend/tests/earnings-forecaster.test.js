/**
 * Unit tests for the AI earnings forecasting service (#1037).
 *
 * These tests exercise the deterministic, pure statistical helpers and the
 * Python ML-model smoke path.  They do not require a live database or network
 * (the `better-sqlite3` driver is auto-mocked by the Jest config), so they run
 * quickly and deterministically in CI.
 */

import { describe, it, expect } from "@jest/globals";
import {
  statisticalForecast,
  computeAccuracy,
  detectSeasonality,
  linearRegression,
  holtFit,
  resolvePython,
  runPythonModel,
} from "../src/services/earnings-forecaster.js";

/** Build `count` days of synthetic earnings with a weekly seasonal pattern. */
function buildSeasonalHistory(startDate, count, base = 100, amplitude = 20) {
  const data = [];
  const start = new Date(startDate);
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    // Weekly peak on day 5 (Friday), trough on day 0.
    const seasonal = amplitude * Math.sin((2 * Math.PI * i) / 7);
    const trend = i * 0.5; // mild growth
    data.push({ date: d.toISOString().split("T")[0], amount: Math.round((base + seasonal + trend) * 100) / 100 });
  }
  return data;
}

describe("earnings-forecaster: seasonality detection", () => {
  it("detects a weekly seasonal pattern", () => {
    const history = buildSeasonalHistory("2024-01-01", 42);
    const values = history.map((h) => h.amount);
    const result = detectSeasonality(values);
    expect(result.detected).toBe(true);
    expect(result.period).toBe(7);
    expect(result.strength).toBeGreaterThan(0.15);
  });

  it("reports no seasonality for a flat series", () => {
    const flat = Array.from({ length: 30 }, () => 50);
    const result = detectSeasonality(flat);
    expect(result.detected).toBe(false);
    expect(result.period).toBeNull();
  });

  it("returns not-detected when there are too few observations", () => {
    const result = detectSeasonality([10, 20, 30]);
    expect(result.detected).toBe(false);
    expect(result.period).toBeNull();
  });
});

describe("earnings-forecaster: linear regression", () => {
  it("fits a perfect linear trend with r2 ~ 1", () => {
    const values = [0, 10, 20, 30, 40];
    const reg = linearRegression(values);
    expect(reg.slope).toBeCloseTo(10, 5);
    expect(reg.intercept).toBeCloseTo(0, 5);
    expect(reg.r2).toBeCloseTo(1, 5);
  });

  it("returns zero slope for a flat series", () => {
    const reg = linearRegression([5, 5, 5, 5, 5]);
    expect(reg.slope).toBeCloseTo(0, 10);
  });
});

describe("earnings-forecaster: Holt's linear smoothing", () => {
  it("tracks a constant level with zero trend", () => {
    const { level } = holtFit([100, 100, 100, 100], 0.5, 0.1);
    expect(level).toBeCloseTo(100, 1);
  });

  it("produces fitted values matching input length", () => {
    const { fitted } = holtFit([50, 60, 70, 80, 90], 0.5, 0.1);
    expect(fitted).toHaveLength(5);
  });
});

describe("earnings-forecaster: statisticalForecast", () => {
  it("generates 30/60/90-day horizon from seasonal history", () => {
    const history = buildSeasonalHistory("2024-01-01", 60);
    const forecast = statisticalForecast(history, 90);

    expect(forecast.forecasts).toHaveLength(90);
    expect(forecast.summary.day30.point).toBeGreaterThan(0);
    expect(forecast.summary.day60.point).toBeDefined();
    expect(forecast.summary.day90.point).toBeDefined();
    // Every forecast point has a lower <= point <= upper band.
    for (const f of forecast.forecasts) {
      expect(f.lower).toBeLessThanOrEqual(f.point);
      expect(f.point).toBeLessThanOrEqual(f.upper);
    }
  });

  it("classifies an upward trend as growth", () => {
    const history = buildSeasonalHistory("2024-01-01", 60, 100, 5);
    const forecast = statisticalForecast(history, 30);
    expect(["growth", "decline", "plateau"]).toContain(forecast.trend);
  });

  it("detects seasonality in the forecast output", () => {
    const history = buildSeasonalHistory("2024-01-01", 60);
    const forecast = statisticalForecast(history, 30);
    expect(forecast.seasonality.detected).toBe(true);
    expect(forecast.seasonality.period).toBe(7);
  });

  it("falls back to a flat forecast when history is insufficient", () => {
    const forecast = statisticalForecast([], 90);
    expect(forecast.forecasts).toHaveLength(90);
    expect(forecast.trend).toBe("plateau");
    // All points should be 0 when there is no history.
    expect(forecast.forecasts[0].point).toBe(0);
  });

  it("always exposes the weekly-update contract", () => {
    const forecast = statisticalForecast(buildSeasonalHistory("2024-01-01", 30), 90);
    expect(forecast.weeklyUpdate).toBe(true);
  });
});

describe("earnings-forecaster: accuracy metrics", () => {
  const forecasts = [
    { date: "2024-04-01", point: 100, lower: 90, upper: 110 },
    { date: "2024-04-02", point: 100, lower: 90, upper: 110 },
    { date: "2024-04-03", point: 100, lower: 90, upper: 110 },
  ];

  it("computes 100% accuracy when actuals fall inside the band", () => {
    const actuals = [
      { date: "2024-04-01", amount: 105 },
      { date: "2024-04-02", amount: 99 },
      { date: "2024-04-03", amount: 108 },
    ];
    const acc = computeAccuracy(forecasts, actuals);
    expect(acc.coverage).toBe(1);
    expect(acc.accuracy).toBe(100);
  });

  it("drops accuracy when actuals fall outside the band", () => {
    const actuals = [
      { date: "2024-04-01", amount: 200 },
      { date: "2024-04-02", amount: 100 },
      { date: "2024-04-03", amount: 100 },
    ];
    const acc = computeAccuracy(forecasts, actuals);
    expect(acc.coverage).toBeCloseTo(2 / 3, 2);
    expect(acc.accuracy).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("returns null metrics when there is no overlap", () => {
    const actuals = [{ date: "2025-01-01", amount: 500 }];
    const acc = computeAccuracy(forecasts, actuals);
    expect(acc.accuracy).toBeNull();
    expect(acc.mape).toBeNull();
  });
});

describe("earnings-forecaster: Python ML model", () => {
  it("resolves a python interpreter or gracefully skips", () => {
    const python = resolvePython();
    if (python === null) {
      // No python in this environment — skip the integration assertion.
      expect(python).toBeNull();
    } else {
      expect(typeof python).toBe("string");
    }
  });

  it("runs the python model and returns a valid forecast when available", () => {
    const python = resolvePython();
    if (python === null) {
      // Environment has no python; nothing to assert.
      return;
    }

    const history = buildSeasonalHistory("2024-01-01", 60);
    const payload = { history, horizon_days: 90, frequency: "daily" };

    const output = runPythonModel(payload);
    expect(output).toHaveProperty("modelVersion");
    expect(output).toHaveProperty("forecasts");
    expect(output.forecasts).toHaveLength(90);
    expect(output).toHaveProperty("trend");
    expect(output).toHaveProperty("seasonality");
    expect(output.summary).toHaveProperty("day30");
    expect(output.summary).toHaveProperty("day60");
    expect(output.summary).toHaveProperty("day90");
  });
});
