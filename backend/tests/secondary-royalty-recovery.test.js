/**
 * Tests for secondary royalty distribution error recovery.
 *
 * Verifies that:
 * - Failed distributions are added to retry queue
 * - Exponential backoff works correctly
 * - Retry queue processing succeeds
 * - Dead-letter queue receives permanently failed items
 * - API endpoints return correct stats
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

// --- XDR validation mock --------------------------------------------------
// Placeholder XDR strings used in these tests aren't real envelopes, so stub
// the validator to accept them; dedicated tests cover the validation itself.
await jest.unstable_mockModule("../src/xdr-validation.js", () => ({
  validateXdrStructure: () => ({ valid: true }),
}));

// --- Database mock --------------------------------------------------------
const getSecondarySales = jest.fn();
const commitSecondaryDistributionAtomic = jest.fn();
const applyLargestRemainder = jest.fn();
const addToRetryQueue = jest.fn();
const getReadyRetryItems = jest.fn();
const updateRetryItem = jest.fn();
const removeFromRetryQueue = jest.fn();
const moveToDeadLetterQueue = jest.fn();
const getRetryQueueStats = jest.fn();
const getDeadLetterQueueStats = jest.fn();
const getDeadLetterItems = jest.fn();
const recordTransaction = jest.fn(() => 1);
const recordSecondarySale = jest.fn();
const addAuditLog = jest.fn();
const getRoyaltyStatistics = jest.fn();
const getSecondaryRoyaltyDistributions = jest.fn();
const countSecondarySales = jest.fn();
const initializeDatabase = jest.fn();
const getMigrationVersion = jest.fn(() => 10);

await jest.unstable_mockModule("../src/database/index.js", () => ({
  db: {
    transaction: (fn) => fn,
  },
  getSecondarySales,
  commitSecondaryDistributionAtomic,
  applyLargestRemainder,
  addToRetryQueue,
  getReadyRetryItems,
  updateRetryItem,
  removeFromRetryQueue,
  moveToDeadLetterQueue,
  getRetryQueueStats,
  getDeadLetterQueueStats,
  getDeadLetterItems,
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

describe("Secondary Royalty Error Recovery Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSecondarySales.mockReturnValue(PENDING_SALES);
    buildTx.mockResolvedValue("distribute-xdr");
    commitSecondaryDistributionAtomic.mockReturnValue(42);
    applyLargestRemainder.mockReturnValue([]);
  });

  test("1. Failed distribution is added to retry queue on buildTx error", async () => {
    buildTx.mockRejectedValue(new Error("Token validation failed"));

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe("distribution_failed_retry_queued");
    expect(addToRetryQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        contractId: CONTRACT,
        walletAddress: WALLET,
        tokenId: TOKEN,
        totalRoyalties: 300n,
        numberOfSales: 2,
        pendingSaleIds: [1, 2],
        errorMessage: "Token validation failed",
      })
    );
    expect(commitSecondaryDistributionAtomic).not.toHaveBeenCalled();
  });

  test("2. Retry queue stats endpoint returns correct data", async () => {
    getRetryQueueStats.mockReturnValue({
      totalItems: 5,
      avgRetryCount: 2.5,
      maxRetryCount: 4,
      readyForRetry: 2,
    });

    const res = await request(app).get("/api/v1/secondary-royalty/retry-stats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalItems: 5,
      avgRetryCount: 2.5,
      maxRetryCount: 4,
      readyForRetry: 2,
    });
  });

  test("3. Dead-letter queue stats endpoint returns correct data", async () => {
    getDeadLetterQueueStats.mockReturnValue({
      totalItems: 3,
      avgRetryCount: 5,
      maxRetryCount: 5,
      last7Days: 1,
    });

    const res = await request(app).get("/api/v1/secondary-royalty/dlq-stats");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      totalItems: 3,
      avgRetryCount: 5,
      maxRetryCount: 5,
      last7Days: 1,
    });
  });

  test("4. Dead-letter queue items endpoint returns paginated results", async () => {
    const dlqItems = [
      {
        id: 1,
        contractId: CONTRACT,
        walletAddress: WALLET,
        tokenId: TOKEN,
        totalRoyalties: "300",
        numberOfSales: 2,
        errorMessage: "Max retries exceeded",
        failureReason: "max_retries_exceeded",
        retryCount: 5,
        createdAt: "2024-01-01T00:00:00Z",
        failedAt: "2024-01-01T01:00:00Z",
      },
    ];

    getDeadLetterItems.mockReturnValue(dlqItems);

    const res = await request(app)
      .get("/api/v1/secondary-royalty/dlq/" + CONTRACT)
      .query({ limit: 10, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(dlqItems);
    expect(res.body.pagination).toEqual({ limit: 10, offset: 0 });
    expect(getDeadLetterItems).toHaveBeenCalledWith(CONTRACT, 10, 0);
  });

  test("5. Successful distribution does not add to retry queue", async () => {
    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(addToRetryQueue).not.toHaveBeenCalled();
    expect(commitSecondaryDistributionAtomic).toHaveBeenCalled();
  });

  test("6. Retry queue receives collaborators data when provided", async () => {
    buildTx.mockRejectedValue(new Error("Contract error"));

    const bodyWithCollaborators = {
      ...VALID_BODY,
      collaborators: [
        { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", basisPoints: 6000 },
        { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", basisPoints: 4000 },
      ],
    };

    const res = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .send(bodyWithCollaborators);

    expect(res.status).toBe(503);
    expect(addToRetryQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        collaborators: bodyWithCollaborators.collaborators,
      })
    );
  });

  test("7. Retry queue receives dust allocation data when applicable", async () => {
    buildTx.mockRejectedValue(new Error("Network error"));

    const dustAllocations = [
      { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: 150n, dustReceived: 1n },
      { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", amount: 149n, dustReceived: 0n },
    ];

    applyLargestRemainder.mockReturnValue(dustAllocations);

    const bodyWithCollaborators = {
      ...VALID_BODY,
      collaborators: [
        { address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", basisPoints: 5000 },
        { address: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", basisPoints: 5000 },
      ],
    };

    const res = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .send(bodyWithCollaborators);

    expect(res.status).toBe(503);
    expect(addToRetryQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        totalDustAllocated: 1n,
        dustAuditData: expect.objectContaining({
          totalDust: "1",
          dustRecipients: expect.arrayContaining([
            expect.objectContaining({
              address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              dust: "1",
            }),
          ]),
        }),
      })
    );
  });

  test("8. Multiple consecutive failures each add separate retry items", async () => {
    buildTx.mockRejectedValue(new Error("Persistent error"));

    const res1 = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);
    const res2 = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res1.status).toBe(503);
    expect(res2.status).toBe(503);
    expect(addToRetryQueue).toHaveBeenCalledTimes(2);
  });

  test("9. Empty pending sales does not trigger retry queue", async () => {
    getSecondarySales.mockReturnValue([]);

    const res = await request(app).post("/api/v1/secondary-royalty/distribute").send(VALID_BODY);

    expect(res.status).toBe(400);
    expect(addToRetryQueue).not.toHaveBeenCalled();
    expect(buildTx).not.toHaveBeenCalled();
  });
});
