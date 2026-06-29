import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
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
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
  getNetworkLabel: jest.fn(() => "Testnet"),
}));

const recordTransaction = jest.fn(() => "tx-123");
const addAuditLog = jest.fn();

// better-sqlite3 is globally stubbed to no-ops for tests (see
// __mocks__/better-sqlite3.js), so request-nonces.js's real DB-backed
// recordNonceIfNew can't be exercised here. Simulate the same
// (contractId, nonce) uniqueness semantics with an in-memory Set instead —
// consistent with how the other database functions are mocked in
// initialize.test.js.
const seenNonces = new Set();
const recordNonceIfNew = jest.fn((contractId, nonce) => {
  const key = `${contractId}:${nonce}`;
  if (seenNonces.has(key)) return false;
  seenNonces.add(key);
  return true;
});

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  recordNonceIfNew,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { initializeRouter } = await import("../src/routes/initialize.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/initialize", initializeRouter);
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Payload too large" });
  }
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CONTRACT_2 = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const NONCE = "11111111-1111-4111-8111-111111111111";

const validBody = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  collaborators: [COLLAB1, COLLAB2],
  shares: [5000, 5000],
};

describe("POST /api/v1/initialize — nonce dedup (#421)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seenNonces.clear();
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    recordTransaction.mockReturnValue("tx-123");
  });

  test("request without a nonce behaves as before", async () => {
    const res = await request(app).post("/api/v1/initialize").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("first request with a nonce succeeds", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, nonce: NONCE });

    expect(res.status).toBe(200);
  });

  test("second request with the same nonce and contractId returns 409 and builds no new transaction", async () => {
    await request(app).post("/api/v1/initialize").send({ ...validBody, nonce: NONCE });
    retryBuildTx.mockClear();
    recordTransaction.mockClear();

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, nonce: NONCE });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been processed/i);
    expect(retryBuildTx).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  test("the same nonce is reusable for a different contractId", async () => {
    await request(app).post("/api/v1/initialize").send({ ...validBody, nonce: NONCE });

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, contractId: CONTRACT_2, nonce: NONCE });

    expect(res.status).toBe(200);
  });

  test("invalid (non-UUID) nonce is rejected with 400", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, nonce: "not-a-uuid" });

    expect(res.status).toBe(400);
  });
});
