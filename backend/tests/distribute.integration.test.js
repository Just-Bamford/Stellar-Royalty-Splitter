import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

const recordTransaction = jest.fn(() => "tx-integration-001");
const addAuditLog = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  recordNonceIfNew: jest.fn(() => true),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { default: app } = await import("./app.js");

// ── Test fixtures ─────────────────────────────────────────────────────────────

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const validBody = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

// ── Integration tests ─────────────────────────────────────────────────────────

describe("POST /api/v1/distribute — integration", () => {
  beforeEach(() => jest.clearAllMocks());

  // ── Happy path ──────────────────────────────────────────────────────────────

  test("happy path — returns xdr and transactionId", async () => {
    retryBuildTx.mockResolvedValue("signed-xdr-payload");
    recordTransaction.mockReturnValue("tx-integration-001");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      xdr: "signed-xdr-payload",
      transactionId: "tx-integration-001",
    });
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
    expect(recordTransaction).toHaveBeenCalledTimes(1);
  });

  // ── Insufficient funds (RPC simulation failure) ─────────────────────────────

  test("503 when Stellar RPC reports insufficient funds / unavailable", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });

  // ── Invalid admin auth ──────────────────────────────────────────────────────
  // The backend builds unsigned XDR; admin auth is enforced by the smart contract
  // on submission. A missing or malformed walletAddress is the server-side
  // equivalent of an invalid caller identity.

  test("400 when walletAddress is missing", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ contractId: CONTRACT, tokenId: TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation/i);
  });

  test("400 when walletAddress is not a valid Stellar address", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, walletAddress: "NOT-A-VALID-ADDRESS" });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "walletAddress" }),
      ])
    );
  });

  test("400 when walletAddress is a contract address (starts with C, not G)", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, walletAddress: CONTRACT });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "walletAddress" }),
      ])
    );
  });

  // ── Malformed recipient list / body ─────────────────────────────────────────

  test("400 when contractId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ walletAddress: WALLET, tokenId: TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "contractId" }),
      ])
    );
  });

  test("400 when tokenId is missing", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ contractId: CONTRACT, walletAddress: WALLET });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "tokenId" }),
      ])
    );
  });

  test("400 when tokenId is not a valid contract address", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, tokenId: "not-a-contract-id" });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "tokenId" }),
      ])
    );
  });

  test("400 when tokenId is an account address (starts with G, not C)", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, tokenId: WALLET });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "tokenId" }),
      ])
    );
  });

  test("400 when contractId is malformed", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .send({ ...validBody, contractId: "INVALID" });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "contractId" }),
      ])
    );
  });

  test("400 when body is completely empty", async () => {
    const res = await request(app).post("/api/v1/distribute").send({});

    expect(res.status).toBe(400);
    expect(res.body.details.length).toBeGreaterThanOrEqual(3);
  });

  // ── Audit trail ─────────────────────────────────────────────────────────────

  test("records transaction and audit log on success", async () => {
    retryBuildTx.mockResolvedValue("xdr-payload");
    recordTransaction.mockReturnValue("tx-audit-check");

    await request(app).post("/api/v1/distribute").send(validBody);

    expect(recordTransaction).toHaveBeenCalledWith(
      CONTRACT,
      "distribute",
      WALLET,
      expect.objectContaining({ tokenId: TOKEN })
    );
    expect(addAuditLog).toHaveBeenCalledWith(
      CONTRACT,
      "distribution_initiated",
      WALLET,
      expect.objectContaining({ transactionId: "tx-audit-check" })
    );
  });

  test("does not call retryBuildTx when validation fails", async () => {
    await request(app)
      .post("/api/v1/distribute")
      .send({ contractId: "BAD", walletAddress: WALLET, tokenId: TOKEN });

    expect(retryBuildTx).not.toHaveBeenCalled();
  });
});
