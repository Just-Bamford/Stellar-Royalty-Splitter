import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import request from "supertest";

const retryBuildTx = jest.fn();

await jest.unstable_mockModule("../src/stellar.js", () => ({
  retryBuildTx,
  isContractInitialized: jest.fn(),
  addressToScVal: jest.fn((a) => a),
  bytesN32HexToScVal: jest.fn((h) => h),
  u32ToScVal: jest.fn((n) => n),
  vecToScVal: jest.fn((v) => v),
  bytesN32HexToScVal: jest.fn((h) => h),
  getNetworkLabel: jest.fn(() => "Testnet"),
  server: {},
  networkPassphrase: "Test SDF Network ; September 2015",
}));

const recordTransaction = jest.fn(() => "tx-456");

await jest.unstable_mockModule("../src/database/index.js", () => ({
  recordTransaction,
  addAuditLog: jest.fn(),
  recordNonceIfNew: jest.fn(() => true),
  initializeDatabase: jest.fn(),
  getMigrationVersion: jest.fn(() => 1),
}));

// Import clearCache to reset between tests
const { clearCache } = await import("../src/idempotency.js");
const { default: app } = await import("./app.js");

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const TOKEN2 = "CDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";

const validBody = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN };
const validBody2 = { contractId: CONTRACT, walletAddress: WALLET, tokenId: TOKEN2 };

describe("POST /api/v1/distribute with idempotency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  test("processes request normally without idempotency key", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res = await request(app).post("/api/v1/distribute").send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ xdr: "distribute-xdr", transactionId: "tx-456" });
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
  });

  test("returns cached response for duplicate idempotency key", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr-1");
    recordTransaction.mockReturnValue("tx-100");

    const idempotencyKey = "test-key-duplicate";

    // First request
    const res1 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send(validBody);

    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ xdr: "distribute-xdr-1", transactionId: "tx-100" });
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
    expect(recordTransaction).toHaveBeenCalledTimes(1);

    // Second request with same key
    retryBuildTx.mockResolvedValue("distribute-xdr-2"); // Different XDR
    recordTransaction.mockReturnValue("tx-200"); // Different transaction ID

    const res2 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send(validBody);

    // Should return cached response from first request
    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ xdr: "distribute-xdr-1", transactionId: "tx-100" });

    // Should NOT call retryBuildTx or recordTransaction again
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
    expect(recordTransaction).toHaveBeenCalledTimes(1);
  });

  test("different request bodies create separate cache entries", async () => {
    retryBuildTx
      .mockResolvedValueOnce("distribute-xdr-1")
      .mockResolvedValueOnce("distribute-xdr-2");
    recordTransaction.mockReturnValueOnce("tx-100").mockReturnValueOnce("tx-200");

    // First request with body1
    const res1 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", "key-1")
      .send(validBody);

    expect(res1.status).toBe(200);
    expect(res1.body).toMatchObject({ xdr: "distribute-xdr-1", transactionId: "tx-100" });

    // Second request with different body (different tokenId)
    const res2 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", "key-2")
      .send(validBody2);

    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ xdr: "distribute-xdr-2", transactionId: "tx-200" });

    // Both should have been processed (different bodies = different cache keys)
    expect(retryBuildTx).toHaveBeenCalledTimes(2);
    expect(recordTransaction).toHaveBeenCalledTimes(2);
  });

  test("rejects invalid idempotency key format", async () => {
    const res = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", "invalid key with spaces")
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid Idempotency-Key format/);
    expect(retryBuildTx).not.toHaveBeenCalled();
  });

  test("accepts valid idempotency key formats", async () => {
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const validKeys = [
      "simple-key",
      "key_with_underscores",
      "key-with-hyphens",
      "AlphaNumeric123",
      "a1b2c3d4e5f6",
    ];

    for (const key of validKeys) {
      clearCache();
      retryBuildTx.mockClear();
      recordTransaction.mockClear();

      const res = await request(app)
        .post("/api/v1/distribute")
        .set("Idempotency-Key", key)
        .send(validBody);

      expect(res.status).toBe(200);
      expect(retryBuildTx).toHaveBeenCalled();
    }
  });

  test("does not cache error responses", async () => {
    retryBuildTx.mockRejectedValue({
      status: 503,
      message: "Stellar RPC is currently unavailable",
    });

    const idempotencyKey = "error-key";

    // First request (fails)
    const res1 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send(validBody);

    expect(res1.status).toBe(503);
    expect(retryBuildTx).toHaveBeenCalledTimes(1);

    // Second request with same key (should retry, not return cached error)
    retryBuildTx.mockClear();
    retryBuildTx.mockResolvedValue("distribute-xdr-success");
    recordTransaction.mockReturnValue("tx-success");

    const res2 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send(validBody);

    expect(res2.status).toBe(200);
    expect(res2.body).toMatchObject({ xdr: "distribute-xdr-success", transactionId: "tx-success" });
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
  });

  test("handles concurrent requests with same idempotency key", async () => {
    retryBuildTx.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("distribute-xdr"), 50);
        })
    );
    recordTransaction.mockReturnValue("tx-concurrent");

    const idempotencyKey = "concurrent-key";

    // Send two requests concurrently
    const [res1, res2] = await Promise.all([
      request(app).post("/api/v1/distribute").set("Idempotency-Key", idempotencyKey).send(validBody),
      request(app).post("/api/v1/distribute").set("Idempotency-Key", idempotencyKey).send(validBody),
    ]);

    // Both should succeed
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // One should be the original, one should be cached
    // Both should have the same response
    expect(res1.body).toEqual(res2.body);

    // retryBuildTx might be called 1 or 2 times depending on timing
    // but should not be called more than 2 times
    expect(retryBuildTx.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(retryBuildTx.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test("same body with different case idempotency keys returns cached response", async () => {
    retryBuildTx.mockResolvedValueOnce("distribute-xdr-1");
    recordTransaction.mockReturnValueOnce("tx-100");

    // First request with lowercase key
    const res1 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", "mykey")
      .send(validBody);

    expect(res1.status).toBe(200);
    expect(res1.body.transactionId).toBe("tx-100");

    // Second request with uppercase key (same body, same user -> cache hit)
    const res2 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", "MYKEY")
      .send(validBody);

    expect(res2.status).toBe(200);
    // Should return the cached response from the first request
    expect(res2.body.transactionId).toBe("tx-100");

    // retryBuildTx should only have been called once (second request is cached)
    expect(retryBuildTx).toHaveBeenCalledTimes(1);
  });

  test("validation errors are returned before idempotency check", async () => {
    const idempotencyKey = "validation-error-key";

    // First request with invalid body
    const res1 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send({ contractId: CONTRACT, walletAddress: "INVALID", tokenId: TOKEN });

    expect(res1.status).toBe(400);

    // Second request with same key but valid body
    retryBuildTx.mockResolvedValue("distribute-xdr");
    recordTransaction.mockReturnValue("tx-456");

    const res2 = await request(app)
      .post("/api/v1/distribute")
      .set("Idempotency-Key", idempotencyKey)
      .send(validBody);

    // Should process normally (validation happens after idempotency middleware)
    expect(res2.status).toBe(200);
    expect(retryBuildTx).toHaveBeenCalled();
  });
});

