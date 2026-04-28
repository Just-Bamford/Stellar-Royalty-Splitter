import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// Capture mock functions at factory time so we hold the same instances the route uses
const retryBuildTx = jest.fn();
const isContractInitialized = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized,
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-123");
const addAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database.js", () => ({
  recordTransaction,
  addAuditLog,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1  = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2  = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

const validBody = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  collaborators: [COLLAB1, COLLAB2],
  shares: [5000, 5000],
};

describe("POST /api/v1/initialize", () => {
  beforeEach(() => jest.clearAllMocks());

  test("happy path — returns xdr and transactionId", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    recordTransaction.mockReturnValue("tx-123");

    const res = await request(app).post("/api/v1/initialize").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("409 when contract is already initialized", async () => {
    isContractInitialized.mockResolvedValue(true);

    const res = await request(app).post("/api/v1/initialize").send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already initialized/i);
  });

  test("400 when shares do not sum to 10000", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [3000, 3000] });

    expect(res.status).toBe(400);
  });

  test("400 when collaborators and shares lengths differ", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [10000] });

    expect(res.status).toBe(400);
  });

  test("400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ contractId: CONTRACT });

    expect(res.status).toBe(400);
  });

  test("503 when Stellar RPC is unavailable", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockRejectedValue({ status: 503, message: "Stellar RPC is currently unavailable. Please try again later." });
    recordTransaction.mockReturnValue("tx-123");

    const res = await request(app).post("/api/v1/initialize").send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
