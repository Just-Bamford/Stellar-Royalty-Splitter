import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const retryBuildTx = jest.fn();

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: {
    Address: { fromScVal: jest.fn((v) => ({ toString: () => v })) },
    Contract: jest.fn().mockImplementation(() => ({ call: jest.fn() })),
    SorobanRpc: { Api: { isSimulationError: jest.fn(() => false) } },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    BASE_FEE: "100",
    Account: jest.fn(),
    scValToNative: jest.fn((v) => v),
    nativeToScVal: jest.fn((v) => v),
  },
  nativeToScVal: jest.fn((v) => v),
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => 1);
const recordLoanLiquidation = jest.fn(() => 42);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog: jest.fn(),
  recordLoanLiquidation,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 4),
}));

const { liquidateRouter } = await import("../src/routes/liquidate.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/liquidate", liquidateRouter);
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
  res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT  = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET    = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BORROWER  = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const LIQUIDATOR = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const validBody = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  borrower: BORROWER,
  liquidator: LIQUIDATOR,
  loanId: "LOAN-001",
  repayAmount: 5_000_000,
  collateralSeized: 6_000_000,
};

describe("POST /api/v1/liquidate", () => {
  beforeEach(() => jest.clearAllMocks());

  test("happy path — returns xdr, transactionId, and liquidationId", async () => {
    retryBuildTx.mockResolvedValue("liquidate-xdr");
    recordTransaction.mockReturnValue(99);
    recordLoanLiquidation.mockReturnValue(42);

    const res = await request(app).post("/api/v1/liquidate").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "liquidate-xdr", transactionId: 99, liquidationId: 42 });
  });

  test("recordLoanLiquidation called with correct args", async () => {
    retryBuildTx.mockResolvedValue("xdr");
    recordTransaction.mockReturnValue(1);

    await request(app).post("/api/v1/liquidate").send(validBody);

    expect(recordLoanLiquidation).toHaveBeenCalledWith(
      CONTRACT, "LOAN-001", BORROWER, LIQUIDATOR, "5000000", "6000000", null
    );
  });

  test("400 when contractId is missing", async () => {
    const { contractId: _unused, ...body } = validBody;
    const res = await request(app).post("/api/v1/liquidate").send(body);
    expect(res.status).toBe(400);
  });

  test("400 when borrower is invalid Stellar address", async () => {
    const res = await request(app)
      .post("/api/v1/liquidate")
      .send({ ...validBody, borrower: "INVALID" });
    expect(res.status).toBe(400);
  });

  test("400 when loanId is empty", async () => {
    const res = await request(app)
      .post("/api/v1/liquidate")
      .send({ ...validBody, loanId: "" });
    expect(res.status).toBe(400);
  });

  test("400 when repayAmount is not positive", async () => {
    const res = await request(app)
      .post("/api/v1/liquidate")
      .send({ ...validBody, repayAmount: 0 });
    expect(res.status).toBe(400);
  });

  test("503 when Stellar RPC is unavailable", async () => {
    recordTransaction.mockReturnValue(1);
    retryBuildTx.mockRejectedValue({ status: 503, message: "Stellar RPC is currently unavailable. Please try again later." });

    const res = await request(app).post("/api/v1/liquidate").send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
