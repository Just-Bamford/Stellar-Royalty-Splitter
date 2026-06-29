/**
 * Tests for pagination and date-range validation on
 * GET /api/secondary-royalty/sales/:contractId (issue #459).
 *
 * Verifies:
 *  - contractId is validated before pagination params are parsed
 *  - limit must be 1–100 (integers only)
 *  - offset must be >= 0 (integers only)
 *  - startDate / endDate must be valid ISO 8601 strings
 *  - startDate must be <= endDate when both are provided
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import request from "supertest";
import express from "express";

await jest.unstable_mockModule("../src/stellar.js", () => ({
  buildTx: jest.fn(),
  retryBuildTx: jest.fn(),
  getRoyaltyRateFromContract: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  i128ToScVal: jest.fn((n) => n),
  u32ToScVal: jest.fn((n) => n),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

// secondary-royalty.js now pulls in the XDR validator via _shared.js; stub it
// so these GET-route tests don't depend on real envelope parsing.
await jest.unstable_mockModule("../src/xdr-validation.js", () => ({
  validateXdrStructure: () => ({ valid: true }),
}));

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const getSecondarySalesMock = jest.fn(() => []);
const countSecondarySalesMock = jest.fn(() => 0);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  db: { transaction: (fn) => fn },
  recordTransaction: jest.fn(() => 1),
  recordSecondarySale: jest.fn(),
  addAuditLog: jest.fn(),
  getSecondarySales: getSecondarySalesMock,
  countSecondarySales: countSecondarySalesMock,
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

const app = express();
app.use(express.json());
app.use("/api/secondary-royalty", secondaryRoyaltyRouter);
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

const CONTRACT = "C" + "A".repeat(55);

function salesUrl(contractId = CONTRACT, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `/api/secondary-royalty/sales/${contractId}${qs ? `?${qs}` : ""}`;
}

describe("GET /api/secondary-royalty/sales/:contractId — pagination validation (issue #459)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSecondarySalesMock.mockReturnValue([]);
    countSecondarySalesMock.mockReturnValue(0);
  });

  test("valid request with defaults returns 200", async () => {
    const res = await request(app).get(salesUrl());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sales");
    expect(res.body).toHaveProperty("total");
  });

  test("invalid contractId format returns 400 before parsing pagination", async () => {
    const res = await request(app).get(salesUrl("INVALID_CONTRACT", { limit: "999" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_contract_id");
  });

  test("limit=0 returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { limit: "0" }));
    expect(res.status).toBe(400);
  });

  test("limit=101 returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { limit: "101" }));
    expect(res.status).toBe(400);
  });

  test("limit=100 (max boundary) returns 200", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { limit: "100" }));
    expect(res.status).toBe(200);
  });

  test("offset=-1 returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { offset: "-1" }));
    expect(res.status).toBe(400);
  });

  test("non-integer limit returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { limit: "abc" }));
    expect(res.status).toBe(400);
  });

  test("float limit returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { limit: "5.5" }));
    expect(res.status).toBe(400);
  });

  test("invalid startDate format returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { startDate: "not-a-date" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("invalid endDate format returns 400", async () => {
    const res = await request(app).get(salesUrl(CONTRACT, { endDate: "not-a-date" }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("startDate after endDate returns 400", async () => {
    const res = await request(app).get(
      salesUrl(CONTRACT, { startDate: "2024-12-31", endDate: "2024-01-01" })
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_query_parameter");
  });

  test("startDate equal to endDate returns 200 (boundary valid)", async () => {
    const res = await request(app).get(
      salesUrl(CONTRACT, { startDate: "2024-06-01", endDate: "2024-06-01" })
    );
    expect(res.status).toBe(200);
  });

  test("valid limit and offset are forwarded to getSecondarySales", async () => {
    await request(app).get(salesUrl(CONTRACT, { limit: "25", offset: "50" }));
    expect(getSecondarySalesMock).toHaveBeenCalledWith(
      CONTRACT, 25, 50, undefined, false, undefined, undefined
    );
  });
});
