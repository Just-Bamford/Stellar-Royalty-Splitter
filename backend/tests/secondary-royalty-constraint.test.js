/**
 * Tests for SQLite constraint error handling in the secondary-royalty route (issue #458).
 *
 * Verifies that all SQLITE_CONSTRAINT_* error code variants are caught and
 * returned as 409 Conflict rather than propagating as 500, and that
 * non-constraint errors still surface as 500.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx: jest.fn().mockResolvedValue("mock-xdr"),
  retryBuildTx: jest.fn().mockResolvedValue("mock-xdr"),
  getRoyaltyRateFromContract: jest.fn().mockResolvedValue(500),
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  u32ToScVal: jest.fn((n) => n),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

// Placeholder XDR strings used in these tests aren't real envelopes, so stub
// the validator to accept them; dedicated tests cover the validation itself.
await jest.unstable_mockModule("../src/xdr-validation.js", () => ({
  validateXdrStructure: () => ({ valid: true }),
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const recordTransactionMock = jest.fn(() => 1);
const recordSecondarySaleMock = jest.fn();
const addAuditLogMock = jest.fn();

const mockDb = {
  transaction: (fn) => fn,
};

await jest.unstable_mockModule("../src/database/index.js", () => ({
  db: mockDb,
  recordTransaction: recordTransactionMock,
  recordSecondarySale: recordSecondarySaleMock,
  addAuditLog: addAuditLogMock,
  getSecondarySales: jest.fn(() => []),
  countSecondarySales: jest.fn(() => 0),
  getSecondaryRoyaltyDistributions: jest.fn(() => []),
  getRoyaltyStatistics: jest.fn(() => ({
    totalSecondarySales: 0,
    totalRoyaltiesGenerated: "0.0000000",
    totalVolume: "0.0000000",
    pendingRoyaltyPool: "0.0000000",
    lastDistribution: null,
  })),
  markSalesDistributed: jest.fn(),
  recordSecondaryRoyaltyDistribution: jest.fn(),
  applyLargestRemainder: jest.fn(() => []),
  addToRetryQueue: jest.fn(),
  getRetryQueueStats: jest.fn(() => ({ count: 0 })),
  getDeadLetterQueueStats: jest.fn(() => ({ count: 0 })),
  getDeadLetterItems: jest.fn(() => []),
  commitSecondaryDistributionAtomic: jest.fn(),
}));

const { secondaryRoyaltyRouter } = await import("../src/routes/secondary-royalty.js");
const { default: logger } = await import("../src/logger.js");

const app = express();
app.use(express.json());
app.use("/api/secondary-royalty", secondaryRoyaltyRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "C" + "A".repeat(55);
const WALLET = "G" + "A".repeat(55);
const SALE_TOKEN = "C" + "B".repeat(55);
const PREV_OWNER = "G" + "B".repeat(55);
const NEW_OWNER = "G" + "C".repeat(55);

const validBody = {
  contractId: CONTRACT,
  walletAddress: WALLET,
  nftId: "nft-1",
  previousOwner: PREV_OWNER,
  newOwner: NEW_OWNER,
  salePrice: 1000000,
  saleToken: SALE_TOKEN,
  royaltyRate: 500,
};

function makeConstraintError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

describe("POST /api/secondary-royalty — SQLite constraint handling (issue #458)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    recordTransactionMock.mockReturnValue(1);
    recordSecondarySaleMock.mockReturnValue(1);
  });

  test("SQLITE_CONSTRAINT_UNIQUE returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("SQLITE_CONSTRAINT (generic) returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT", "constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("SQLITE_CONSTRAINT_PRIMARYKEY returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_PRIMARYKEY", "PRIMARY KEY constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("SQLITE_CONSTRAINT_NOTNULL returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_NOTNULL", "NOT NULL constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("SQLITE_CONSTRAINT_CHECK returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_CHECK", "CHECK constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("SQLITE_CONSTRAINT_FOREIGNKEY returns 409 conflict", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_FOREIGNKEY", "FOREIGN KEY constraint failed");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("conflict");
  });

  test("non-constraint SQLITE error propagates as 500", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_IOERR", "disk I/O error");
    });
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(500);
  });

  test("constraint violation logs the actual SQLite error code", async () => {
    recordSecondarySaleMock.mockImplementation(() => {
      throw makeConstraintError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed");
    });
    await request(app).post("/api/secondary-royalty").send(validBody);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "SQLITE_CONSTRAINT_UNIQUE" })
    );
  });

  test("successful insert returns xdr and transactionId", async () => {
    const res = await request(app).post("/api/secondary-royalty").send(validBody);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("xdr");
    expect(res.body).toHaveProperty("transactionId");
  });
});
