import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import {
  buildDistributePayload,
  VALID_CONTRACT_ID as CONTRACT,
  VALID_TOKEN_ID as TOKEN,
  VALID_WALLET_A as WALLET,
} from "./test-helpers.js";

const retryBuildTx = jest.fn();
const runHook = jest.fn(async () => []);
const loggerError = jest.fn();

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
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (key) => typeof key === "string" && key.startsWith("G") && key.length === 56
    ),
  },
};

await jest.unstable_mockModule("@stellar/stellar-sdk", () => ({
  default: stellarSdkMock,
  ...stellarSdkMock,
}));

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  buildTx: jest.fn(),
  pollHorizonTransaction: jest.fn(),
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  getRecommendedFee: jest.fn(async () => "12345"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/plugins/plugin-framework.js", () => ({
  runHook,
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: loggerError,
    debug: jest.fn(),
  },
}));

const recordTransaction = jest.fn(() => "tx-456");
const recordTransactionFee = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  recordTransactionFee,
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const broadcastToContract = jest.fn(() => 0);

await jest.unstable_mockModule("../src/websocket.js", () => ({
  initializeWebSocket: jest.fn(),
  sendNotification: jest.fn(),
  broadcastToContract,
  broadcastFinalityUpdate: jest.fn(),
  broadcastTransactionStatus: jest.fn(),
  broadcastContractEdit: jest.fn(),
  broadcastAuditEvent: jest.fn(),
}));

const { distributeRouter } = await import("../src/routes/distribute.js");
const { resetMetrics } = await import("../src/metrics.js");
const { notFoundHandler, errorHandler } = await import("../src/error-response.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/distribute", distributeRouter);
app.use(notFoundHandler);
app.use(errorHandler);

const validBody = buildDistributePayload({
  contractId: CONTRACT,
  walletAddress: WALLET,
  tokenId: TOKEN,
});

describe("POST /api/v1/distribute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runHook.mockImplementation(async () => []);
    resetMetrics();
  });

  test("happy path — returns xdr and transactionId", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "distribute-xdr", transactionId: "tx-456" });
  });

  test("returns before the afterDistribute hook completes", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    let finishHook;
    runHook.mockImplementation((hookName) => {
      if (hookName === "afterDistribute") {
        return new Promise((resolve) => {
          finishHook = resolve;
        });
      }
      return Promise.resolve([]);
    });

    let timeoutId;
    const responsePromise = request(app).post("/api/v1/distribute").send(validBody);
    const result = await Promise.race([
      responsePromise.then((res) => ({ type: "response", res })),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ type: "timeout" }), 1000);
      }),
    ]);
    clearTimeout(timeoutId);
    finishHook([]);

    expect(result.type).toBe("response");
    expect(result.res.status).toBe(200);
  });

  test("logs afterDistribute hook failures", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");
    runHook.mockImplementation((hookName) =>
      hookName === "afterDistribute"
        ? Promise.reject(new Error("plugin failed"))
        : Promise.resolve([]),
    );

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(loggerError).toHaveBeenCalledWith("afterDistribute plugin hook failed", {
      error: "plugin failed",
    });
  });

  test("records the transaction fee after a successful distribution", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(recordTransactionFee).toHaveBeenCalledWith("tx-456", CONTRACT, "12345");
  });

  test("broadcasts distribution_pending, not distribution_completed, once the XDR is built (#1177)", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(broadcastToContract).toHaveBeenCalledTimes(1);
    expect(broadcastToContract).toHaveBeenCalledWith(
      CONTRACT,
      expect.objectContaining({ type: "distribution_pending", transactionId: "tx-456" }),
    );
    expect(broadcastToContract).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "distribution_completed" }),
    );
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
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

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
