/**
 * POST /api/v1/oracle/predict must validate `confidence` (#1369).
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockStorePrediction = jest.fn();

await jest.unstable_mockModule("../src/middleware/rbac.js", () => ({
  attachRole: (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  storePrediction: mockStorePrediction,
  getLatestPrediction: jest.fn(),
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

const predict = (confidence) =>
  request(app)
    .post("/api/v1/oracle/predict")
    .send({
      contractId: VALID_CONTRACT,
      predictedAmount: "1000",
      confidence,
      factors: { volume: "high" },
      modelVersion: "v1.0.0",
    });

describe("POST /api/v1/oracle/predict confidence validation (#1369)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorePrediction.mockReturnValue(1);
  });

  test.each([
    ["a non-numeric string", "high"],
    ["a negative number", -0.5],
    ["a number above 1", 1.01],
    ["a large number", 85],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
    ["a boolean", true],
    ["an array", [0.5]],
    ["an object", { value: 0.5 }],
  ])("rejects %s with 400 and stores nothing", async (_name, confidence) => {
    const res = await predict(confidence);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
    expect(JSON.stringify(res.body)).toMatch(/confidence must be a number between 0 and 1/);
    expect(mockStorePrediction).not.toHaveBeenCalled();
  });

  test.each([0, 0.85, 1])("accepts confidence %s", async (confidence) => {
    const res = await predict(confidence);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockStorePrediction).toHaveBeenCalledWith(expect.objectContaining({ confidence }));
  });

  test("accepts a numeric string and stores it as a number", async () => {
    const res = await predict("0.85");

    expect(res.status).toBe(200);
    expect(mockStorePrediction).toHaveBeenCalledWith(expect.objectContaining({ confidence: 0.85 }));
  });

  test("still reports a missing confidence as a missing field", async () => {
    const res = await request(app)
      .post("/api/v1/oracle/predict")
      .send({ contractId: VALID_CONTRACT, predictedAmount: "1000", factors: {}, modelVersion: "v1" });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Missing required fields/);
  });
});
