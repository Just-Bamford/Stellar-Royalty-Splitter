/**
 * Tests for transaction fee display routes — closes #606.
 */
import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const mockRecordTransactionFee = jest.fn();
const mockGetTransactionFee    = jest.fn();
const mockGetFeesByContract    = jest.fn();

await jest.unstable_mockModule("../src/database/transaction-fees.js", () => ({
  recordTransactionFee: mockRecordTransactionFee,
  getTransactionFee:    mockGetTransactionFee,
  getFeesByContract:    mockGetFeesByContract,
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransactionFee: mockRecordTransactionFee,
  getTransactionFee:    mockGetTransactionFee,
  getFeesByContract:    mockGetFeesByContract,
  initializeDatabase:   jest.fn(),
  getMigrationVersion:  jest.fn(() => 10),
}));

const { feesRouter } = await import("../src/routes/fees.js");

const app = express();
app.use(express.json());
app.use("/api/v1/fees", feesRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TIMESTAMP = "2026-07-27T10:00:00.000Z";

const feeRecord = (txId = 1) => ({
  transactionId: txId,
  contractId: CONTRACT,
  feeStroops: "34567",
  recordedAt: TIMESTAMP,
});

describe("GET /api/v1/fees/:contractId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns fee list for a valid contract", async () => {
    mockGetFeesByContract.mockReturnValue([feeRecord(1), feeRecord(2)]);

    const res = await request(app).get(`/api/v1/fees/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(mockGetFeesByContract).toHaveBeenCalledWith(CONTRACT, 50, 0);
  });

  test("returns empty array when no fees exist", async () => {
    mockGetFeesByContract.mockReturnValue([]);

    const res = await request(app).get(`/api/v1/fees/${CONTRACT}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test("400 when contractId is invalid", async () => {
    const res = await request(app).get("/api/v1/fees/not-a-contract");

    expect(res.status).toBe(400);
    expect(mockGetFeesByContract).not.toHaveBeenCalled();
  });

  test("respects limit and offset query params", async () => {
    mockGetFeesByContract.mockReturnValue([]);

    await request(app).get(`/api/v1/fees/${CONTRACT}?limit=10&offset=20`);

    expect(mockGetFeesByContract).toHaveBeenCalledWith(CONTRACT, 10, 20);
  });
});

describe("GET /api/v1/fees/transaction/:transactionId", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns fee record for a valid transaction", async () => {
    mockGetTransactionFee.mockReturnValue(feeRecord(42));

    const res = await request(app).get("/api/v1/fees/transaction/42");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.transactionId).toBe(42);
    expect(mockGetTransactionFee).toHaveBeenCalledWith(42);
  });

  test("404 when transaction has no fee record", async () => {
    mockGetTransactionFee.mockReturnValue(null);

    const res = await request(app).get("/api/v1/fees/transaction/99");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("fee_not_found");
  });

  test("400 when transactionId is not a number", async () => {
    const res = await request(app).get("/api/v1/fees/transaction/abc");

    expect(res.status).toBe(400);
    expect(mockGetTransactionFee).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/fees/record", () => {
  beforeEach(() => jest.clearAllMocks());

  test("records a fee and returns the saved record", async () => {
    mockRecordTransactionFee.mockReturnValue(feeRecord(7));

    const res = await request(app)
      .post("/api/v1/fees/record")
      .send({ transactionId: 7, contractId: CONTRACT, feeStroops: 34567 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockRecordTransactionFee).toHaveBeenCalledWith(7, CONTRACT, 34567);
  });

  test("accepts feeStroops as a numeric string", async () => {
    mockRecordTransactionFee.mockReturnValue(feeRecord(8));

    const res = await request(app)
      .post("/api/v1/fees/record")
      .send({ transactionId: 8, contractId: CONTRACT, feeStroops: "12345" });

    expect(res.status).toBe(200);
  });

  test("400 when transactionId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/fees/record")
      .send({ contractId: CONTRACT, feeStroops: 100 });

    expect(res.status).toBe(400);
    expect(mockRecordTransactionFee).not.toHaveBeenCalled();
  });

  test("400 when contractId is invalid", async () => {
    const res = await request(app)
      .post("/api/v1/fees/record")
      .send({ transactionId: 1, contractId: "bad", feeStroops: 100 });

    expect(res.status).toBe(400);
  });
});
