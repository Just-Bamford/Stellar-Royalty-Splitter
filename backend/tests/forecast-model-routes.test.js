/**
 * Integration tests for the AI earnings forecast API routes (#1037).
 *
 * Mocks the `earnings-forecaster` service so the tests are deterministic and
 * do not depend on a live database or the Python runtime.
 */

import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const mockForecastService = {
  getForecast: jest.fn(),
  generateForecast: jest.fn(),
  getForecastAccuracy: jest.fn(),
  getForecastHistory: jest.fn(),
  trainWeeklyForecast: jest.fn(),
  WEEKLY_FORECAST_COOL_DOWN_MS: 7 * 24 * 60 * 60 * 1000,
};

await jest.unstable_mockModule("../src/services/earnings-forecaster.js", () => ({
  __esModule: true,
  default: mockForecastService,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const express = (await import("express")).default;
const { forecastModelRouter } = await import("../src/routes/analytics/forecast-model.js");

const app = express();
app.use(express.json());
app.use("/api/v1/analytics/forecast-model", forecastModelRouter);

const SAMPLE_FORECAST = {
  modelVersion: "1.0.0",
  engine: "ml-python",
  trend: "growth",
  trendSlope: 0.5,
  seasonality: { detected: true, period: 7, strength: 0.42 },
  confidenceLevel: 0.9,
  confidenceBandPct: 12.5,
  forecasts: Array.from({ length: 90 }, (_, i) => ({
    date: `2024-04-${String(i + 1).padStart(2, "0")}`,
    point: 100 + i,
    lower: 85 + i,
    upper: 115 + i,
  })),
  summary: {
    day30: { point: 129, lower: 114, upper: 144, confidencePct: 12.0 },
    day60: { point: 159, lower: 143, upper: 175, confidencePct: 12.3 },
    day90: { point: 189, lower: 171, upper: 207, confidencePct: 12.5 },
  },
  weeklyUpdate: true,
  generatedAt: new Date().toISOString(),
};

describe("Forecast Model API", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/v1/analytics/forecast-model", () => {
    it("returns a forecast for a valid contract", async () => {
      mockForecastService.getForecast.mockReturnValue(null);
      mockForecastService.generateForecast.mockResolvedValue(SAMPLE_FORECAST);

      const res = await request(app).get("/api/v1/analytics/forecast-model").query({
        contractId: "C123",
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.contractId).toBe("C123");
      expect(res.body.forecast.trend).toBe("growth");
      expect(res.body.forecast.forecasts).toHaveLength(90);
      expect(res.body.forecast.summary).toHaveProperty("day30");
      expect(res.body.forecast.summary).toHaveProperty("day60");
      expect(res.body.forecast.summary).toHaveProperty("day90");
    });

    it("returns 400 when contractId is missing", async () => {
      const res = await request(app).get("/api/v1/analytics/forecast-model");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("validation_failed");
    });

    it("serves a fresh cached forecast instead of regenerating", async () => {
      const cached = {
        forecast: { ...SAMPLE_FORECAST, horizonDays: 90 },
        generatedAt: Math.floor(Date.now() / 1000),
      };
      mockForecastService.getForecast.mockReturnValue(cached);

      const res = await request(app).get("/api/v1/analytics/forecast-model").query({
        contractId: "C123",
      });

      expect(res.status).toBe(200);
      expect(res.body.forecast.fromCache).toBe(true);
      expect(mockForecastService.generateForecast).not.toHaveBeenCalled();
    });

    it("honours the days query parameter (capped at 365)", async () => {
      mockForecastService.getForecast.mockReturnValue(null);
      mockForecastService.generateForecast.mockResolvedValue({
        ...SAMPLE_FORECAST,
        forecasts: Array.from({ length: 30 }, () => ({ point: 50, lower: 40, upper: 60 })),
      });

      const res = await request(app)
        .get("/api/v1/analytics/forecast-model")
        .query({ contractId: "C123", days: "30" });

      expect(res.status).toBe(200);
      expect(mockForecastService.generateForecast).toHaveBeenCalledWith(
        "C123",
        undefined,
        { horizonDays: 30 },
      );
    });
  });

  describe("POST /api/v1/analytics/forecast-model/train", () => {
    it("triggers training for a specific contract", async () => {
      mockForecastService.generateForecast.mockResolvedValue(SAMPLE_FORECAST);

      const res = await request(app)
        .post("/api/v1/analytics/forecast-model/train")
        .send({ contractId: "C123", horizonDays: 90 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.forecast.trend).toBe("growth");
    });

    it("triggers the weekly batch when contractId is omitted", async () => {
      mockForecastService.trainWeeklyForecast.mockResolvedValue([
        { contractId: "C123", success: true, trend: "growth" },
      ]);

      const res = await request(app).post("/api/v1/analytics/forecast-model/train").send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results).toHaveLength(1);
      expect(mockForecastService.trainWeeklyForecast).toHaveBeenCalled();
    });
  });

  describe("GET /api/v1/analytics/forecast-model/accuracy", () => {
    it("returns accuracy metrics", async () => {
      mockForecastService.getForecastAccuracy.mockReturnValue({
        accuracy: 92.5,
        mape: 7.4,
        rmse: 12.3,
        coverage: 0.925,
        samples: 4,
      });

      const res = await request(app)
        .get("/api/v1/analytics/forecast-model/accuracy")
        .query({ contractId: "C123" });

      expect(res.status).toBe(200);
      expect(res.body.accuracy.accuracy).toBe(92.5);
      expect(res.body.accuracy.samples).toBe(4);
    });

    it("returns 400 when contractId is missing", async () => {
      const res = await request(app).get("/api/v1/analytics/forecast-model/accuracy");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/analytics/forecast-model/history", () => {
    it("returns prior weekly forecasts", async () => {
      mockForecastService.getForecastHistory.mockReturnValue([
        { forecast: SAMPLE_FORECAST, weekStart: 1234, trend: "growth" },
      ]);

      const res = await request(app)
        .get("/api/v1/analytics/forecast-model/history")
        .query({ contractId: "C123" });

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(1);
      expect(res.body.history[0].trend).toBe("growth");
    });

    it("returns 400 when contractId is missing", async () => {
      const res = await request(app).get("/api/v1/analytics/forecast-model/history");
      expect(res.status).toBe(400);
    });
  });
});
