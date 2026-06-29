import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const retryBuildTx = jest.fn();

const stellarSdkMock = {
  Address: { fromScVal: jest.fn((scVal) => ({ toString: () => scVal })) },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn((method) => ({ method })),
  })),
  SorobanRpc: { Api: { isSimulationError: jest.fn(() => false) } },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  BASE_FEE: "100",
  Account: jest.fn(),
  scValToNative: jest.fn((value) => value),
};

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: stellarSdkMock,
  ...stellarSdkMock,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-456");

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog: jest.fn(),
  lookupCollaborators: jest.fn(() => []),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { distributeRouter } = await import("../src/routes/distribute.js");
const { resetMetrics } = await import("../src/metrics.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/distribute", distributeRouter);
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const validBody = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

describe("POST /api/v1/distribute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
  });

  test("happy path — returns xdr and transactionId", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "distribute-xdr", transactionId: "tx-456" });
  });

  test("400 when contractId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ walletAddress: WALLET, tokenId: TOKEN });

    expect(res.status).toBe(400);
  });

  test("400 when tokenId is not a valid contract address", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, tokenId: "not-a-contract" });

    expect(res.status).toBe(400);
  });

  test("400 when walletAddress is not a valid Stellar address", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, walletAddress: "INVALID" });

    expect(res.status).toBe(400);
  });

  test("503 when Stellar RPC is unavailable", async () => {
    recordTransaction.mockReturnValue("tx-456");
    retryBuildTx.mockRejectedValue({ status: 503, message: "Stellar RPC is currently unavailable. Please try again later." });

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });

  test("413 when request payload exceeds the JSON size limit", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...validBody, padding: "x".repeat(12_000) }));

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/payload too large/i);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });
});
