/**
 * Tests for atomic secondary royalty distribution (#471).
 *
 * Verifies that all database writes (transaction record, mark-sales-distributed,
 * distribution record, and audit logs) occur as a single atomic operation, and
 * that the Stellar XDR is built BEFORE any DB writes so that a Stellar failure
 * never leaves sales in an inconsistent state.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";

// --- Stellar mock ---------------------------------------------------------
const buildTx = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx,
  retryBuildTx: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  u32ToScVal: jest.fn((n) => n),
  getRoyaltyRateFromContract: jest.fn(),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

// --- Database mock --------------------------------------------------------
const getSecondarySales = jest.fn();
const commitSecondaryDistributionAtomic = jest.fn();
const applyLargestRemainder = jest.fn();
const recordTransaction = jest.fn(() => 1);
const recordSecondarySale = jest.fn();
const addAuditLog = jest.fn();
const getRoyaltyStatistics = jest.fn();
const getSecondaryRoyaltyDistributions = jest.fn();
const countSecondarySales = jest.fn();
const initializeDatabase = jest.fn();
const getMigrationVersion = jest.fn(() => 7);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  getSecondarySales,
  commitSecondaryDistributionAtomic,
  applyLargestRemainder,
  recordTransaction,
  recordSecondarySale,
  addAuditLog,
  getRoyaltyStatistics,
  getSecondaryRoyaltyDistributions,
  countSecondarySales,
  initializeDatabase,
  getMigrationVersion,
}));

// --- Build test app after mocks ------------------------------------------
const express = (await import("express")).default;
const { secondaryRoyaltyRouter } = await import("../src/routes/secondary-royalty.js");

const app = express();
app.use(express.json({ limit: "10kb" }));
app.use("/api/v1/secondary-royalty", secondaryRoyaltyRouter);
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.message ?? "Internal server error" });
});

// --- Constants -----------------------------------------------------------
const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET  = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN   = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const PENDING_SALES = [
  { id: 1, royaltyAmount: "100" },
  { id: 2, royaltyAmount: "200" },
];

const VALID_BODY = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };

// =========================================================================

describe("POST /api/v1/secondary-royalty/distribute — atomic DB commit (#471)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSecondarySales.mockReturnValue(PENDING_SALES);
    buildTx.mockResolvedValue("distribute-xdr");
    commitSecondaryDistributionAtomic.mockReturnValue(42);
  });

  test("1. successful distribution: commitSecondaryDistributionAtomic called after buildTx", async () => {
    const callOrder = [];
    buildTx.mockImplementation(async () => {
      callOrder.push("buildTx");
      return "dist-xdr";
    });
    commitSecondaryDistributionAtomic.mockImplementation((params) => {
      callOrder.push("commit");
      return 42;
    });

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      xdr: "dist-xdr",
      transactionId: 42,
      numberOfSales: 2,
    });
    // XDR must be built before any DB writes
    expect(callOrder).toEqual(["buildTx", "commit"]);
  });

  test("2. Stellar failure prevents any DB writes", async () => {
    buildTx.mockRejectedValue(new Error("Stellar RPC unavailable"));

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(500);
    // The atomic commit must NEVER be called when buildTx fails
    expect(commitSecondaryDistributionAtomic).not.toHaveBeenCalled();
  });

  test("3. DB commit failure propagates as 500 and does not send a partial response", async () => {
    commitSecondaryDistributionAtomic.mockImplementation(() => {
      throw new Error("SQLITE constraint violation");
    });

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/SQLITE constraint violation/);
    // buildTx was called (XDR was built) but the route never returned 200
    expect(buildTx).toHaveBeenCalledTimes(1);
  });

  test("4. no pending sales returns 400 before buildTx or commit are called", async () => {
    getSecondarySales.mockReturnValue([]);

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No pending secondary royalties/);
    expect(buildTx).not.toHaveBeenCalled();
    expect(commitSecondaryDistributionAtomic).not.toHaveBeenCalled();
  });

  test("5. commitSecondaryDistributionAtomic receives correct sale IDs and totals", async () => {
    await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(commitSecondaryDistributionAtomic).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: CONTRACT,
        walletAddress: WALLET,
        totalRoyalties: 300n,       // 100 + 200
        numberOfSales: 2,
        pendingSaleIds: [1, 2],
        totalDustAllocated: 0n,
        dustAuditData: null,
      })
    );
  });

  test("6. buildTx is called exactly once regardless of sale count", async () => {
    getSecondarySales.mockReturnValue([
      { id: 1, royaltyAmount: "50" },
      { id: 2, royaltyAmount: "50" },
      { id: 3, royaltyAmount: "50" },
    ]);

    await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(commitSecondaryDistributionAtomic).toHaveBeenCalledTimes(1);
  });
});
