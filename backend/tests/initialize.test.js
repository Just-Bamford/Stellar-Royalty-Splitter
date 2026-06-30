import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import express from "express";
import request from "supertest";
import {
  INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES,
  INITIALIZE_PAYLOAD_LIMIT_BYTES,
} from "../src/validation.js";

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
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
  getNetworkLabel: jest.fn(() => "Testnet"),
}));

const recordTransaction = jest.fn(() => "tx-123");
const addAuditLog = jest.fn();
const recordNonceIfNew = jest.fn(() => true);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  lookupCollaborators: jest.fn(() => []),
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
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const COLLAB1 = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const COLLAB2 = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";

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

  test("400 when shares do not sum to 10000 — error message shows actual and expected sums", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [3000, 3000] });

    expect(res.status).toBe(400);
    // Issue #356: error message must include the actual sum and expected total.
    const details = JSON.stringify(res.body);
    expect(details).toMatch(/60%/);
    expect(details).toMatch(/100%/);
  });

  test("400 when shares sum to 9999 — error shows 9999 vs 10000", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [4999, 5000] });

    expect(res.status).toBe(400);
    const details = JSON.stringify(res.body);
    expect(details).toMatch(/99\.99%/);
    expect(details).toMatch(/100%/);
  });

  test("400 when shares sum to 10001 — error shows 10001 vs 10000", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [5001, 5000] });

    expect(res.status).toBe(400);
    const details = JSON.stringify(res.body);
    expect(details).toMatch(/100\.01%/);
    expect(details).toMatch(/100%/);
  });

  test("400 when collaborators and shares lengths differ", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, shares: [10000] });

    expect(res.status).toBe(400);
  });

  test("400 when collaborators array is empty", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, collaborators: [], shares: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/collaborators array must be non-empty/i);
  });

  test("400 when required fields are missing", async () => {
    const res = await request(app).post("/api/v1/initialize").send({ contractId: CONTRACT });

    expect(res.status).toBe(400);
  });

  test("happy path with 1 collaborator (minimum) — returns xdr and transactionId", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    recordTransaction.mockReturnValue("tx-123");

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators: [COLLAB1],
        shares: [10000],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("happy path with 20 collaborators (maximum) — returns xdr and transactionId", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    recordTransaction.mockReturnValue("tx-123");

    const collaborators = Array.from({ length: 20 }, (_, i) => {
      const char = String.fromCharCode(65 + (i % 26));
      return `G${char.repeat(55)}`;
    });
    const shares = Array.from({ length: 20 }, () => 500);

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators,
        shares,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("400 when collaborators array contains invalid addresses", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators: [COLLAB1, "invalid-stellar-address"],
        shares: [5000, 5000],
      });

    expect(res.status).toBe(400);
  });

  test("duplicate addresses in collaborators — succeeds at API validation layer", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockResolvedValue("unsigned-xdr-string");
    recordTransaction.mockReturnValue("tx-123");

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators: [COLLAB1, COLLAB1],
        shares: [5000, 5000],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "unsigned-xdr-string", transactionId: "tx-123" });
  });

  test("413 when initialize request body is too large", async () => {
    const res = await request(app)
      .post("/api/v1/initialize")
      .send({ ...validBody, padding: "x".repeat(INITIALIZE_PAYLOAD_LIMIT_BYTES) });

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Payload too large" });
    expect(isContractInitialized).not.toHaveBeenCalled();
    expect(retryBuildTx).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  test("413 when collaborators payload is too large", async () => {
    const oversizedCollaborator = `G${"A".repeat(INITIALIZE_COLLABORATORS_PAYLOAD_LIMIT_BYTES)}`;

    const res = await request(app)
      .post("/api/v1/initialize")
      .send({
        ...validBody,
        collaborators: [oversizedCollaborator],
        shares: [10000],
    });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ error: "Collaborators payload too large" });
    expect(isContractInitialized).not.toHaveBeenCalled();
    expect(retryBuildTx).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });


  test("503 when Stellar RPC is unavailable", async () => {
    isContractInitialized.mockResolvedValue(false);
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });
    recordTransaction.mockReturnValue("tx-123");

    const res = await request(app).post("/api/v1/initialize").send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});
