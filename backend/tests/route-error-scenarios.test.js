import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";
import rateLimit from "express-rate-limit";

const retryBuildTx = jest.fn();
const recordTransaction = jest.fn(() => "tx-999");
const addAuditLog = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized: jest.fn(() => Promise.resolve(false)),
  addressToScVal: jest.fn((a) => a),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog,
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

const { distributeRouter } = await import("../src/routes/distribute.js");
const { resetMetrics } = await import("../src/metrics.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN    = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const valid    = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

function makeApp() {
  const a = express();
  a.use(express.json({ limit: "10kb" }));
  a.use("/api/v1/distribute", distributeRouter);
  a.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return a;
}

function makeRateLimitedApp(max = 3) {
  const a = express();
  a.use(express.json({ limit: "10kb" }));
  a.use(rateLimit({ windowMs: 60_000, max, standardHeaders: false, legacyHeaders: false }));
  a.use("/api/v1/distribute", distributeRouter);
  a.use((err, _req, res, _next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Payload too large" });
    res.status(500).json({ error: err.message ?? "Internal server error" });
  });
  return a;
}

const app = makeApp();

// ── distributeSchema validation failures ─────────────────────────────────────

describe("distributeSchema validation failure tests", () => {
  beforeEach(() => { jest.clearAllMocks(); resetMetrics(); });

  test("400 when body is completely empty", async () => {
    const res = await request(app).post("/api/v1/distribute").send({});
    expect(res.status).toBe(400);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("400 when contractId is missing", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ walletAddress: WALLET, tokenId: TOKEN });
    expect(res.status).toBe(400);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("400 when contractId is a Stellar address (starts with G, not C)", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, contractId: WALLET });
    expect(res.status).toBe(400);
  });

  test("400 when contractId is too short", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, contractId: "CAAA" });
    expect(res.status).toBe(400);
  });

  test("400 when contractId contains invalid base32 characters (numeric 0s)", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, contractId: "C" + "0".repeat(55) });
    expect(res.status).toBe(400);
  });

  test("400 when contractId is null", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, contractId: null });
    expect(res.status).toBe(400);
  });

  test("400 when walletAddress is missing", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ contractId: CONTRACT, tokenId: TOKEN });
    expect(res.status).toBe(400);
  });

  test("400 when walletAddress is a contract address (starts with C, not G)", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, walletAddress: CONTRACT });
    expect(res.status).toBe(400);
  });

  test("400 when walletAddress is too short", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, walletAddress: "GAAA" });
    expect(res.status).toBe(400);
  });

  test("400 when walletAddress is an empty string", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, walletAddress: "" });
    expect(res.status).toBe(400);
  });

  test("400 when tokenId is missing", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ contractId: CONTRACT, walletAddress: WALLET });
    expect(res.status).toBe(400);
  });

  test("400 when tokenId is a Stellar address (starts with G)", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, tokenId: WALLET });
    expect(res.status).toBe(400);
  });

  test("400 when tokenId is an empty string", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, tokenId: "" });
    expect(res.status).toBe(400);
  });

  test("validation error response contains status, code, and details fields", async () => {
    const res = await request(app).post("/api/v1/distribute").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("code");
    expect(res.body).toHaveProperty("details");
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  test("validation details include the failing field name", async () => {
    const res = await request(app).post("/api/v1/distribute").send({ ...valid, walletAddress: "INVALID" });
    expect(res.status).toBe(400);
    const fields = (res.body.details ?? []).map((d) => d.field);
    expect(fields).toContain("walletAddress");
  });
});

// ── Database constraint violation tests ──────────────────────────────────────

describe("database constraint violation tests", () => {
  beforeEach(() => { jest.clearAllMocks(); resetMetrics(); });

  test("500 when recordTransaction throws a generic SQLite error before RPC call", async () => {
    const err = Object.assign(new Error("SQLITE_ERROR: database is locked"), { code: "SQLITE_ERROR" });
    recordTransaction.mockImplementation(() => { throw err; });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("500 when recordTransaction throws SQLITE_CONSTRAINT_UNIQUE", async () => {
    const err = Object.assign(
      new Error("UNIQUE constraint failed: transactions.txHash"),
      { code: "SQLITE_CONSTRAINT_UNIQUE" }
    );
    recordTransaction.mockImplementation(() => { throw err; });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("500 when recordTransaction throws SQLITE_BUSY", async () => {
    const err = Object.assign(new Error("SQLITE_BUSY: database is busy"), { code: "SQLITE_BUSY" });
    recordTransaction.mockImplementation(() => { throw err; });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
  });

  test("500 when recordTransaction throws SQLITE_FULL (disk full)", async () => {
    const err = Object.assign(new Error("SQLITE_FULL: database or disk is full"), { code: "SQLITE_FULL" });
    recordTransaction.mockImplementation(() => { throw err; });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
  });

  test("500 when recordTransaction throws SQLITE_READONLY", async () => {
    const err = Object.assign(
      new Error("SQLITE_READONLY: attempt to write a readonly database"),
      { code: "SQLITE_READONLY" }
    );
    recordTransaction.mockImplementation(() => { throw err; });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
  });

  test("500 error response body contains an error field when DB throws", async () => {
    recordTransaction.mockImplementation(() => { throw new Error("db failure"); });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
  });
});

// ── Horizon / RPC connection failure tests ────────────────────────────────────

describe("Horizon/RPC connection failure tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMetrics();
    recordTransaction.mockReturnValue("tx-999");
  });

  test("503 when Horizon returns service unavailable", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/unavailable/i);
  });

  test("503 on Horizon timeout (status 503 error shape)", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(503);
  });

  test("503 on Horizon connection refused (status 503 error shape)", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(503);
  });

  test("500 when Horizon throws an unexpected internal error", async () => {
    retryBuildTx.mockRejectedValue(new Error("Internal RPC failure: unexpected state"));

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(500);
  });

  test("RPC error response body contains a non-empty string in error field", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable. Please try again later.",
    });

    const res = await request(app).post("/api/v1/distribute").send(valid);
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  test("recordTransaction is called before retryBuildTx (DB write precedes RPC call)", async () => {
    const callOrder = [];
    recordTransaction.mockImplementation(() => { callOrder.push("db"); return "tx-999"; });
    retryBuildTx.mockImplementation(async () => { callOrder.push("rpc"); return "xdr"; });

    await request(app).post("/api/v1/distribute").send(valid);
    expect(callOrder).toEqual(["db", "rpc"]);
  });
});

// ── Payload size and rate limit boundary tests ────────────────────────────────

describe("payload size and rate limit boundary tests", () => {
  beforeEach(() => { jest.clearAllMocks(); resetMetrics(); });

  test("413 when payload exceeds the 10 kb JSON body limit", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ ...valid, padding: "x".repeat(12_000) }));

    expect(res.status).toBe(413);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("requests at exactly the rate limit all succeed", async () => {
    recordTransaction.mockReturnValue("tx-999");
    retryBuildTx.mockResolvedValue("xdr-ok");
    const rateLimited = makeRateLimitedApp(3);

    for (let i = 0; i < 3; i++) {
      const res = await request(rateLimited).post("/api/v1/distribute").send(valid);
      expect(res.status).toBe(200);
    }
  });

  test("429 when request count exceeds the rate limit", async () => {
    recordTransaction.mockReturnValue("tx-999");
    retryBuildTx.mockResolvedValue("xdr-ok");
    const rateLimited = makeRateLimitedApp(3);

    for (let i = 0; i < 3; i++) {
      await request(rateLimited).post("/api/v1/distribute").send(valid);
    }
    const res = await request(rateLimited).post("/api/v1/distribute").send(valid);
    expect(res.status).toBe(429);
  });
});
