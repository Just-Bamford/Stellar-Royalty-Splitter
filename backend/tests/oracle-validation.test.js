import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockStorePrediction = jest.fn();
const mockGetLatestPrediction = jest.fn();

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  storePrediction: mockStorePrediction,
  getLatestPrediction: mockGetLatestPrediction,
  getPredictionHistory: jest.fn(() => []),
  storeModelMetadata: jest.fn(),
  getLatestModelMetadata: jest.fn(),
  getModelMetadata: jest.fn(),
  storeMarketData: jest.fn(),
  getLatestMarketData: jest.fn(),
  getMarketDataHistory: jest.fn(() => []),
  calculatePredictionAccuracy: jest.fn(),
  getMarketTrends: jest.fn(),
}));

const { oracleRouter } = await import("../src/routes/oracle.js");

const app = express();
app.use(express.json());
app.use("/api/v1", oracleRouter);

const VALID_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVALID_CONTRACT = "not-a-contract";

describe("Oracle ContractId Validation (#1380)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/v1/oracle/predict", () => {
    test("rejects invalid contractId with 400", async () => {
      const res = await request(app)
        .post("/api/v1/oracle/predict")
        .send({
          contractId: INVALID_CONTRACT,
          predictedAmount: "1000",
          confidence: 0.95,
          factors: { volume: "high" },
          modelVersion: "v1.0.0",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_contract_id");
    });

    test("accepts valid contractId", async () => {
      mockStorePrediction.mockReturnValue(1);

      const res = await request(app)
        .post("/api/v1/oracle/predict")
        .send({
          contractId: VALID_CONTRACT,
          predictedAmount: "1000",
          confidence: 0.95,
          factors: { volume: "high" },
          modelVersion: "v1.0.0",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockStorePrediction).toHaveBeenCalled();
    });
  });

  describe("GET /api/v1/oracle/predict/:contractId", () => {
    test("rejects invalid contractId with 400", async () => {
      const res = await request(app).get(`/api/v1/oracle/predict/${INVALID_CONTRACT}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_contract_id");
    });

    test("accepts valid contractId", async () => {
      mockGetLatestPrediction.mockReturnValue(null);

      const res = await request(app).get(`/api/v1/oracle/predict/${VALID_CONTRACT}`);

      expect(res.status).toBe(200);
      expect(mockGetLatestPrediction).toHaveBeenCalledWith(VALID_CONTRACT, "7d");
    });
  });
});
