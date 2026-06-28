/**
 * Tests for idempotency key support on secondary-royalty endpoints (#472).
 *
 * Verifies that:
 *  - POST /secondary-royalty/distribute accepts an Idempotency-Key header
 *  - Duplicate requests within 24 h return the cached response
 *  - Error responses are never cached
 *  - Cache expires after the 24-hour TTL
 *  - Invalid key formats are rejected with 400
 *  - Different request bodies create separate cache entries
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
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

// --- Import idempotency cache helpers and build app ----------------------
const { clearCache } = await import("../src/idempotency.js");

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
const WALLET   = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_A  = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN_B  = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

const PENDING   = [{ id: 1, royaltyAmount: "500" }];
const DIST_BODY = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN_A };

// =========================================================================

describe("POST /api/v1/secondary-royalty/distribute — idempotency (#472)", () => {
  beforeEach(() => {
    // resetAllMocks clears both call history AND the Once-implementation queue,
    // preventing unconsumed Once values from leaking between tests.
    jest.resetAllMocks();
    clearCache();
    getSecondarySales.mockReturnValue(PENDING);
    buildTx.mockResolvedValue("dist-xdr");
    commitSecondaryDistributionAtomic.mockReturnValue(99);
  });

  afterEach(() => {
    clearCache();
  });

  test("1. processes normally without Idempotency-Key header", async () => {
    const res = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .send(DIST_BODY);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "dist-xdr", transactionId: 99 });
    expect(buildTx).toHaveBeenCalledTimes(1);
  });

  test("2. duplicate Idempotency-Key returns cached response without re-processing", async () => {
    buildTx.mockResolvedValue("xdr-first");
    commitSecondaryDistributionAtomic.mockReturnValue(101);

    const res1 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "key-dedup-test")
      .send(DIST_BODY);

    expect(res1.status).toBe(200);
    expect(res1.body.transactionId).toBe(101);
    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(commitSecondaryDistributionAtomic).toHaveBeenCalledTimes(1);

    // Second request with same key — backend must not be called again
    buildTx.mockResolvedValue("xdr-second");
    commitSecondaryDistributionAtomic.mockReturnValue(999);

    const res2 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "key-dedup-test")
      .send(DIST_BODY);

    // Still returns the first cached response
    expect(res2.status).toBe(200);
    expect(res2.body.transactionId).toBe(101);
    // Neither mock is called a second time
    expect(buildTx).toHaveBeenCalledTimes(1);
    expect(commitSecondaryDistributionAtomic).toHaveBeenCalledTimes(1);
  });

  test("3. invalid Idempotency-Key format returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "bad key with spaces!")
      .send(DIST_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Idempotency-Key format/);
    expect(buildTx).not.toHaveBeenCalled();
  });

  test("4. error responses are NOT cached — retry with same key re-processes", async () => {
    buildTx.mockRejectedValue(new Error("Stellar RPC unavailable"));

    const res1 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "key-error-test")
      .send(DIST_BODY);

    expect(res1.status).toBe(500);
    expect(buildTx).toHaveBeenCalledTimes(1);

    // Retry after fixing the transient error — must be processed fresh
    buildTx.mockResolvedValue("xdr-retry-ok");
    commitSecondaryDistributionAtomic.mockReturnValue(202);

    const res2 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "key-error-test")
      .send(DIST_BODY);

    expect(res2.status).toBe(200);
    expect(res2.body.transactionId).toBe(202);
    expect(buildTx).toHaveBeenCalledTimes(2);
  });

  test("5. different request bodies with same Idempotency-Key produce separate cache entries", async () => {
    let callCount = 0;
    buildTx.mockImplementation(() => {
      callCount++;
      return Promise.resolve(`xdr-${callCount}`);
    });
    commitSecondaryDistributionAtomic.mockImplementation(() => callCount);

    const resA = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "shared-key")
      .send({ ...DIST_BODY, tokenId: TOKEN_A });

    const resB = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "shared-key")
      .send({ ...DIST_BODY, tokenId: TOKEN_B });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    // Different bodies → different content hash → different cache keys → both processed
    expect(buildTx).toHaveBeenCalledTimes(2);
    expect(resA.body.transactionId).toBe(1);
    expect(resB.body.transactionId).toBe(2);
  });

  test("6. cache expires after 24-hour TTL — re-sends as a new request", async () => {
    const realNow = Date.now;
    const start = 1_000_000_000_000;
    Date.now = jest.fn(() => start);

    buildTx.mockResolvedValue("xdr-initial");
    commitSecondaryDistributionAtomic.mockReturnValue(300);

    const res1 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "ttl-test-key")
      .send(DIST_BODY);

    expect(res1.status).toBe(200);
    expect(res1.body.transactionId).toBe(300);

    // Advance past 24-hour TTL
    Date.now = jest.fn(() => start + 86_400_001);

    buildTx.mockResolvedValue("xdr-after-ttl");
    commitSecondaryDistributionAtomic.mockReturnValue(301);

    const res2 = await request(app)
      .post("/api/v1/secondary-royalty/distribute")
      .set("Idempotency-Key", "ttl-test-key")
      .send(DIST_BODY);

    expect(res2.status).toBe(200);
    expect(res2.body.transactionId).toBe(301);   // fresh response, not cached
    expect(buildTx).toHaveBeenCalledTimes(2);

    Date.now = realNow;
  });

  test("7. Idempotency-Key header accepted with various valid formats", async () => {
    const validKeys = [
      "simple-key",
      "key_with_underscores",
      "AlphaNumeric123",
      "a1b2c3d4e5f6",
    ];

    for (const key of validKeys) {
      clearCache();
      jest.resetAllMocks();
      getSecondarySales.mockReturnValue(PENDING);
      buildTx.mockResolvedValue("dist-xdr");
      commitSecondaryDistributionAtomic.mockReturnValue(99);

      const res = await request(app)
        .post("/api/v1/secondary-royalty/distribute")
        .set("Idempotency-Key", key)
        .send(DIST_BODY);

      expect(res.status).toBe(200);
      expect(buildTx).toHaveBeenCalledTimes(1);
    }
  });

  test("8. concurrent identical requests both succeed and return same response", async () => {
    buildTx.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("xdr-concurrent"), 30))
    );
    commitSecondaryDistributionAtomic.mockReturnValue(500);

    const [r1, r2] = await Promise.all([
      request(app)
        .post("/api/v1/secondary-royalty/distribute")
        .set("Idempotency-Key", "concurrent-key")
        .send(DIST_BODY),
      request(app)
        .post("/api/v1/secondary-royalty/distribute")
        .set("Idempotency-Key", "concurrent-key")
        .send(DIST_BODY),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual(r2.body);
    expect(buildTx.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(buildTx.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
