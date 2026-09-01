import { describe, it, expect } from "vitest";
import {
  calculateMovingAverage,
  calculateLinearForecast,
  detectAnomalies,
  calculateHeatmapVariance,
  aggregateByDay,
  aggregateByHour,
  type DailyPoint,
  type PayoutRecord,
} from "../advanced-analytics";

describe("advanced-analytics utility", () => {
  describe("calculateMovingAverage", () => {
    it("returns empty array for empty input", () => {
      expect(calculateMovingAverage([])).toEqual([]);
    });

    it("calculates rolling 7-day moving average correctly", () => {
      const data: DailyPoint[] = [
        { date: "2026-08-01", amount: 10 },
        { date: "2026-08-02", amount: 20 },
        { date: "2026-08-03", amount: 30 },
        { date: "2026-08-04", amount: 40 },
        { date: "2026-08-05", amount: 50 },
        { date: "2026-08-06", amount: 60 },
        { date: "2026-08-07", amount: 70 },
        { date: "2026-08-08", amount: 80 },
      ];

      const result = calculateMovingAverage(data, 7);
      expect(result).toHaveLength(8);

      // Day 1 (index 0): 10 / 1 = 10
      expect(result[0].movingAverage).toBe(10);
      // Day 3 (index 2): (10 + 20 + 30) / 3 = 20
      expect(result[2].movingAverage).toBe(20);
      // Day 7 (index 6): (10+20+30+40+50+60+70) / 7 = 40
      expect(result[6].movingAverage).toBe(40);
      // Day 8 (index 7): (20+30+40+50+60+70+80) / 7 = 50
      expect(result[7].movingAverage).toBe(50);
    });
  });

  describe("calculateLinearForecast", () => {
    it("returns empty array for empty data", () => {
      expect(calculateLinearForecast([])).toEqual([]);
    });

    it("returns flat forecast with confidence bounds for a single data point", () => {
      const data: DailyPoint[] = [{ date: "2026-08-01", amount: 100 }];
      const forecast = calculateLinearForecast(data, 3);

      expect(forecast).toHaveLength(3);
      expect(forecast[0].date).toBe("2026-08-02");
      expect(forecast[0].forecastedAmount).toBe(100);
      expect(forecast[0].lowerBound).toBe(90);
      expect(forecast[0].upperBound).toBe(110);
    });

    it("calculates linear trend and confidence bounds for multiple points", () => {
      const data: DailyPoint[] = [
        { date: "2026-08-01", amount: 100 },
        { date: "2026-08-02", amount: 110 },
        { date: "2026-08-03", amount: 120 },
        { date: "2026-08-04", amount: 130 },
      ];

      const forecast = calculateLinearForecast(data, 2, 0.95);
      expect(forecast).toHaveLength(2);
      expect(forecast[0].date).toBe("2026-08-05");
      // Ideal linear prediction: 140
      expect(forecast[0].forecastedAmount).toBe(140);
      expect(forecast[0].lowerBound).toBeLessThanOrEqual(forecast[0].forecastedAmount);
      expect(forecast[0].upperBound).toBeGreaterThanOrEqual(forecast[0].forecastedAmount);
    });
  });

  describe("detectAnomalies", () => {
    it("returns normal status for fewer than 3 points", () => {
      const data: DailyPoint[] = [
        { date: "2026-08-01", amount: 10 },
        { date: "2026-08-02", amount: 500 },
      ];
      const result = detectAnomalies(data);
      expect(result[1].isAnomaly).toBe(false);
    });

    it("identifies extreme spike and dip outliers", () => {
      const data: DailyPoint[] = [
        { date: "2026-08-01", amount: 100 },
        { date: "2026-08-02", amount: 105 },
        { date: "2026-08-03", amount: 98 },
        { date: "2026-08-04", amount: 102 },
        { date: "2026-08-05", amount: 101 },
        { date: "2026-08-06", amount: 500 }, // Spike!
        { date: "2026-08-07", amount: 100 },
      ];

      const result = detectAnomalies(data, 2.0);
      const spike = result.find((r) => r.date === "2026-08-06");
      expect(spike).toBeDefined();
      expect(spike?.isAnomaly).toBe(true);
      expect(spike?.type).toBe("spike");

      const normal = result.find((r) => r.date === "2026-08-01");
      expect(normal?.isAnomaly).toBe(false);
    });
  });

  describe("calculateHeatmapVariance", () => {
    it("classifies cells as green, yellow, or red based on expected baseline", () => {
      const data: DailyPoint[] = [
        { date: "2026-08-01", amount: 100 },
        { date: "2026-08-02", amount: 100 },
        { date: "2026-08-03", amount: 100 },
        { date: "2026-08-04", amount: 95 }, // ~Green (>= 90%)
        { date: "2026-08-05", amount: 75 }, // Yellow (< 90%, >= 60%)
        { date: "2026-08-06", amount: 20 }, // Red (< 60%)
      ];

      const cells = calculateHeatmapVariance(data, 3);
      expect(cells).toHaveLength(6);
      expect(cells[3].status).toBe("green");
      expect(cells[4].status).toBe("yellow");
      expect(cells[5].status).toBe("red");
    });
  });

  describe("aggregateByDay and aggregateByHour", () => {
    const payouts: PayoutRecord[] = [
      { timestamp: "2026-08-01T10:15:00Z", amount: 50 },
      { timestamp: "2026-08-01T10:45:00Z", amount: 30 },
      { timestamp: "2026-08-01T14:20:00Z", amount: 20 },
      { timestamp: "2026-08-02T08:00:00Z", amount: 100 },
    ];

    it("aggregates payouts by day", () => {
      const daily = aggregateByDay(payouts);
      expect(daily).toEqual([
        { date: "2026-08-01", amount: 100 },
        { date: "2026-08-02", amount: 100 },
      ]);
    });

    it("aggregates payouts by hour for a specific day", () => {
      const hourly = aggregateByHour(payouts, "2026-08-01");
      expect(hourly).toHaveLength(24);
      expect(hourly[10]).toEqual({ hour: 10, label: "10:00", amount: 80, count: 2 });
      expect(hourly[14]).toEqual({ hour: 14, label: "14:00", amount: 20, count: 1 });
      expect(hourly[0].amount).toBe(0);
    });
  });
});
