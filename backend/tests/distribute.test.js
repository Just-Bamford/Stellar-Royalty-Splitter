import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

const retryBuildTx = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-456");

await jest.unstable_mockModule("../src/database.js", () => ({
  recordTransaction,
  addAuditLog: jest.fn(),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const validBody = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

describe("POST /api/v1/distribute", () => {
  beforeEach(() => jest.clearAllMocks());

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
});
