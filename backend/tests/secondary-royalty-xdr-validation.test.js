/**
 * Tests for XDR validation on the secondary-royalty transaction routes.
 *
 * The secondary-royalty endpoints build unsigned transaction XDR with
 * `buildTx` and return it to the client. Before this change those three
 * endpoints returned the XDR without validating it, so a malformed envelope
 * could reach the frontend, be signed by Freighter, and waste user fees when
 * the network rejected it.
 *
 * These tests verify that every XDR-returning secondary-royalty route now runs
 * the freshly built XDR through `validateXdrStructure` and rejects invalid XDR
 * with a clear `xdr_validation_error` before returning or committing any state.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

const CONTRACT_ID = "C" + "A".repeat(55);
const WALLET = "G" + "A".repeat(55);
const TOKEN_ID = "C" + "B".repeat(55);
const SALE_TOKEN = "C" + "C".repeat(55);

// --- Stellar mock ---------------------------------------------------------
const buildTx = jest.fn().mockResolvedValue("built-xdr");

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx,
  retryBuildTx: jest.fn().mockResolvedValue("built-xdr"),
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  u32ToScVal: jest.fn((n) => n),
  getRoyaltyRateFromContract: jest.fn().mockResolvedValue(500),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

// --- XDR validation mock (controllable per test) --------------------------
const validateXdrStructure = jest.fn(() => ({ valid: true }));

await jest.unstable_mockModule("../src/xdr-validation.js", () => ({
  validateXdrStructure,
}));

// --- Idempotency middleware: pass-through ---------------------------------
await jest.unstable_mockModule("../src/idempotency.js", () => ({
  idempotencyMiddleware: (_req, _res, next) => next(),
  clearCache: jest.fn(),
}));

// --- Logger mock ----------------------------------------------------------
await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// --- Database mock --------------------------------------------------------
const recordTransaction = jest.fn(() => 1);
const recordSecondarySale = jest.fn();
const addAuditLog = jest.fn();
const getSecondarySales = jest.fn(() => [{ id: 1, royaltyAmount: "1000" }]);
const commitSecondaryDistributionAtomic = jest.fn(() => 42);
const applyLargestRemainder = jest.fn(() => []);
const addToRetryQueue = jest.fn();

await jest.unstable_mockModule("../src/database/index.js", () => ({
  db: { transaction: (fn) => fn },
  recordTransaction,
  recordSecondarySale,
  addAuditLog,
  getSecondarySales,
  commitSecondaryDistributionAtomic,
  applyLargestRemainder,
  addToRetryQueue,
  getSecondaryRoyaltyDistributions: jest.fn(() => []),
  getRoyaltyStatistics: jest.fn(() => ({})),
  countSecondarySales: jest.fn(() => 0),
  getRetryQueueStats: jest.fn(() => ({ count: 0 })),
  getDeadLetterQueueStats: jest.fn(() => ({ count: 0 })),
  getDeadLetterItems: jest.fn(() => []),
}));

const { secondaryRoyaltyRouter } = await import("../src/routes/secondary-royalty.js");
const { assertValidXdr } = await import("../src/routes/_shared.js");

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use("/api/secondary-royalty", secondaryRoyaltyRouter);
  // Mirror the central error handler shape from index.js
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ code: err.code, error: err.message });
  });
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  buildTx.mockResolvedValue("built-xdr");
  validateXdrStructure.mockReturnValue({ valid: true });
  getSecondarySales.mockReturnValue([{ id: 1, royaltyAmount: "1000" }]);
  recordTransaction.mockReturnValue(1);
  commitSecondaryDistributionAtomic.mockReturnValue(42);
});

describe("assertValidXdr helper", () => {
  test("returns the XDR unchanged when validation passes", () => {
    validateXdrStructure.mockReturnValue({ valid: true });
    expect(assertValidXdr("built-xdr")).toBe("built-xdr");
  });

  test("throws a structured xdr_validation_error when validation fails", () => {
    validateXdrStructure.mockReturnValue({
      valid: false,
      errors: ["Fee too high: 999999 stroops (maximum 100000)"],
    });
    expect(() => assertValidXdr("bad-xdr")).toThrow();
    try {
      assertValidXdr("bad-xdr");
    } catch (err) {
      expect(err.status).toBe(500);
      expect(err.code).toBe("xdr_validation_error");
      expect(err.message).toMatch(/Fee too high/);
    }
  });
});

describe("POST /api/secondary-royalty/set-rate XDR validation", () => {
  const body = { contractId: CONTRACT_ID, walletAddress: WALLET, royaltyRate: 500 };

  test("returns XDR when the built transaction is valid", async () => {
    const res = await request(app).post("/api/secondary-royalty/set-rate").send(body);
    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("built-xdr");
    expect(validateXdrStructure).toHaveBeenCalledWith("built-xdr", expect.any(String));
  });

  test("rejects invalid XDR with a clear xdr_validation_error", async () => {
    validateXdrStructure.mockReturnValue({
      valid: false,
      errors: ["Transaction missing time bounds"],
    });
    const res = await request(app).post("/api/secondary-royalty/set-rate").send(body);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("xdr_validation_error");
    expect(res.body.error).toMatch(/time bounds/);
  });
});

describe("POST /api/secondary-royalty (record) XDR validation", () => {
  const body = {
    contractId: CONTRACT_ID,
    walletAddress: WALLET,
    nftId: "NFT_1",
    previousOwner: WALLET,
    newOwner: WALLET,
    salePrice: 10000,
    saleToken: SALE_TOKEN,
    royaltyRate: 500,
  };

  test("rejects invalid XDR and never returns it to the client", async () => {
    validateXdrStructure.mockReturnValue({
      valid: false,
      errors: ["Invalid XDR: corrupt envelope"],
    });
    const res = await request(app).post("/api/secondary-royalty").send(body);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("xdr_validation_error");
    expect(res.body.xdr).toBeUndefined();
  });
});

describe("POST /api/secondary-royalty/distribute XDR validation", () => {
  const body = { contractId: CONTRACT_ID, walletAddress: WALLET, tokenId: TOKEN_ID };

  test("rejects invalid XDR before committing any distribution state", async () => {
    validateXdrStructure.mockReturnValue({
      valid: false,
      errors: ["Transaction must contain at least one operation"],
    });
    const res = await request(app).post("/api/secondary-royalty/distribute").send(body);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("xdr_validation_error");
    // Invalid XDR is a deterministic failure: no DB commit, no retry queue.
    expect(commitSecondaryDistributionAtomic).not.toHaveBeenCalled();
    expect(addToRetryQueue).not.toHaveBeenCalled();
  });

  test("commits and returns XDR when valid", async () => {
    const res = await request(app).post("/api/secondary-royalty/distribute").send(body);
    expect(res.status).toBe(200);
    expect(res.body.xdr).toBe("built-xdr");
    expect(commitSecondaryDistributionAtomic).toHaveBeenCalledTimes(1);
  });
});
