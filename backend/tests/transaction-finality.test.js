/**
 * Tests for the TransactionFinality service.
 *
 * Covers:
 *   - computeBackoffMs: exponential growth, jitter bounds, cap at MAX_POLL_MS
 *   - startTracking: DB record created, polling loop launched
 *   - polling loop: confirms, fails, times out correctly
 *   - cancelTracking: stops the loop
 *   - Horizon unreachable: transient errors are retried
 *   - Stuck transaction: timeout path fires after MAX_POLL_DURATION_MS
 *   - cleanupJob: deletes records older than retention window
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ─── Mock dependencies ────────────────────────────────────────────────────────

const pollHorizonTransaction = jest.fn();
await jest.unstable_mockModule("../src/stellar.js", () => ({
  pollHorizonTransaction,
}));

const createFinalityRecord = jest.fn().mockReturnValue(1);
const setFinalityTxHash = jest.fn();
const incrementPollAttempt = jest.fn();
const markFinalityConfirmed = jest.fn();
const markFinalityFailed = jest.fn();
const markFinalityTimeout = jest.fn();
const getFinalityByTransactionId = jest.fn();
const deleteOldFinalityRecords = jest.fn().mockReturnValue(0);

await jest.unstable_mockModule("../src/database/transaction-finality.js", () => ({
  createFinalityRecord,
  setFinalityTxHash,
  incrementPollAttempt,
  markFinalityConfirmed,
  markFinalityFailed,
  markFinalityTimeout,
  getFinalityByTransactionId,
  deleteOldFinalityRecords,
}));

const broadcastFinalityUpdate = jest.fn();
await jest.unstable_mockModule("../src/websocket.js", () => ({
  broadcastFinalityUpdate,
  sendNotification: jest.fn(),
  broadcastToContract: jest.fn(),
  initializeWebSocket: jest.fn(),
}));

// Import subject under test AFTER mocks are registered
const {
  computeBackoffMs,
  startTracking,
  cancelTracking,
  isTracking,
  MAX_POLL_DURATION_MS,
  JITTER_FACTOR,
} = await import("../src/transaction-finality.js");

const {
  executeFinalityCleanup,
} = await import("../src/jobs/finality-cleanup-job.js");

// ─── computeBackoffMs ─────────────────────────────────────────────────────────

describe("computeBackoffMs", () => {
  test("attempt 0 returns a value near BASE_POLL_MS (100ms)", () => {
    // Run many times to check jitter bounds
    for (let i = 0; i < 200; i++) {
      const ms = computeBackoffMs(0);
      // BASE_POLL_MS = 100, jitter = ±25%, so range [75, 125]
      expect(ms).toBeGreaterThanOrEqual(75);
      expect(ms).toBeLessThanOrEqual(125);
    }
  });

  test("doubles each attempt until capped at MAX_POLL_MS (5000ms)", () => {
    // The un-jittered base should double each attempt
    // We sample attempt 10 and expect it to be near the MAX cap
    for (let i = 0; i < 100; i++) {
      const ms = computeBackoffMs(10);
      // MAX_POLL_MS = 5000, jitter = ±25%, so range [3750, 6250]
      expect(ms).toBeGreaterThanOrEqual(3750);
      expect(ms).toBeLessThanOrEqual(6250);
    }
  });

  test("result is always a positive number", () => {
    for (let attempt = 0; attempt <= 15; attempt++) {
      for (let i = 0; i < 20; i++) {
        expect(computeBackoffMs(attempt)).toBeGreaterThan(0);
      }
    }
  });

  test("result is always a rounded integer", () => {
    for (let attempt = 0; attempt <= 10; attempt++) {
      const ms = computeBackoffMs(attempt);
      expect(Number.isInteger(ms)).toBe(true);
    }
  });

  test("jitter factor is ≤ JITTER_FACTOR of the base interval", () => {
    // The jitter magnitude should never exceed JITTER_FACTOR (25%) of the
    // (capped) base interval.  We verify by checking that for attempt 0 the
    // result stays within BASE*(1±JITTER_FACTOR) = [75, 125].
    const BASE = 100;
    for (let i = 0; i < 500; i++) {
      const ms = computeBackoffMs(0);
      const lo = Math.round(BASE * (1 - JITTER_FACTOR));
      const hi = Math.round(BASE * (1 + JITTER_FACTOR));
      expect(ms).toBeGreaterThanOrEqual(lo);
      expect(ms).toBeLessThanOrEqual(hi);
    }
  });

  test("sequential attempts grow monotonically in expectation", () => {
    // The median should increase each step (ignoring jitter noise by averaging)
    const samples = 100;
    const avg = (attempt) => {
      let sum = 0;
      for (let i = 0; i < samples; i++) sum += computeBackoffMs(attempt);
      return sum / samples;
    };
    expect(avg(1)).toBeGreaterThan(avg(0));
    expect(avg(2)).toBeGreaterThan(avg(1));
    expect(avg(3)).toBeGreaterThan(avg(2));
  });
});

// ─── startTracking ────────────────────────────────────────────────────────────

describe("startTracking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("creates a finality record and returns its ID", async () => {
    createFinalityRecord.mockReturnValue(99);
    pollHorizonTransaction.mockResolvedValue({ status: "confirmed", ledger: 1, createdAt: null });

    const id = startTracking({ transactionId: 1, txHash: "a".repeat(64) });
    expect(id).toBe(99);
    expect(createFinalityRecord).toHaveBeenCalledWith(1, "a".repeat(64));

    // Clean up by cancelling (so poll loop doesn't linger)
    cancelTracking(1);
  });

  test("does not create a duplicate record if already tracking", () => {
    createFinalityRecord.mockReturnValue(10);
    pollHorizonTransaction.mockResolvedValue({ status: "confirmed", ledger: 1, createdAt: null });

    startTracking({ transactionId: 2, txHash: null });
    const result = startTracking({ transactionId: 2, txHash: null }); // duplicate
    expect(result).toBeUndefined();
    expect(createFinalityRecord).toHaveBeenCalledTimes(1);

    cancelTracking(2);
  });

  test("isTracking returns true while polling and false after cancel", () => {
    createFinalityRecord.mockReturnValue(20);
    pollHorizonTransaction.mockResolvedValue({ status: "confirmed", ledger: 1, createdAt: null });

    startTracking({ transactionId: 3, txHash: "b".repeat(64) });
    expect(isTracking(3)).toBe(true);

    cancelTracking(3);
    expect(isTracking(3)).toBe(false);
  });
});

// ─── Poll loop: confirmed ─────────────────────────────────────────────────────

describe("finality polling — confirmed", () => {
  beforeEach(() => jest.clearAllMocks());

  test("marks confirmed and broadcasts when Horizon returns confirmed", async () => {
    const txHash = "c".repeat(64);
    createFinalityRecord.mockReturnValue(5);
    pollHorizonTransaction.mockResolvedValueOnce({
      status: "confirmed",
      ledger: 42,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    startTracking({ transactionId: 10, txHash });

    // Allow microtasks (the poll loop fires after the first backoff delay)
    await new Promise((r) => setImmediate(r));
    // Give the async loop time to run
    await new Promise((r) => setTimeout(r, 300));

    expect(markFinalityConfirmed).toHaveBeenCalledWith(10, expect.objectContaining({
      firstConfirmationAt: "2026-08-01T00:00:00.000Z",
    }));
    expect(broadcastFinalityUpdate).toHaveBeenCalledWith(10, expect.objectContaining({
      status: "confirmed",
      txHash,
    }));
  });
});

// ─── Poll loop: failed ────────────────────────────────────────────────────────

describe("finality polling — failed", () => {
  beforeEach(() => jest.clearAllMocks());

  test("marks failed and broadcasts when Horizon returns failed", async () => {
    const txHash = "d".repeat(64);
    createFinalityRecord.mockReturnValue(6);
    pollHorizonTransaction.mockResolvedValueOnce({
      status: "failed",
      ledger: 43,
      errorMessage: "bad sequence",
    });

    startTracking({ transactionId: 11, txHash });

    await new Promise((r) => setTimeout(r, 300));

    expect(markFinalityFailed).toHaveBeenCalledWith(11, "bad sequence");
    expect(broadcastFinalityUpdate).toHaveBeenCalledWith(11, expect.objectContaining({
      status: "failed",
    }));
  });
});

// ─── Poll loop: Horizon unreachable (transient errors) ───────────────────────

describe("finality polling — transient errors", () => {
  beforeEach(() => jest.clearAllMocks());

  test("retries on transient Horizon errors then confirms", async () => {
    const txHash = "e".repeat(64);
    createFinalityRecord.mockReturnValue(7);

    // First two calls fail, third succeeds
    pollHorizonTransaction
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ status: "confirmed", ledger: 100, createdAt: null });

    startTracking({ transactionId: 12, txHash });

    // Wait long enough for 3 poll cycles (100ms + ~200ms + ~400ms + buffer)
    await new Promise((r) => setTimeout(r, 1200));

    expect(markFinalityConfirmed).toHaveBeenCalledWith(12, expect.any(Object));
    expect(pollHorizonTransaction).toHaveBeenCalledTimes(3);
  }, 5000);
});

// ─── Poll loop: stuck transaction timeout ─────────────────────────────────────

describe("finality polling — timeout (stuck transaction)", () => {
  beforeEach(() => jest.clearAllMocks());

  test("timeout path: markFinalityTimeout is called when Horizon never confirms", async () => {
    // This test verifies the timeout code path by using a fresh module import
    // with FINALITY_MAX_DURATION_MS and FINALITY_BASE_POLL_MS set very small.
    // Because ESM caches modules we rely on jest.resetModules() + dynamic
    // re-import inside the test.
    process.env.FINALITY_MAX_DURATION_MS = "150";
    process.env.FINALITY_BASE_POLL_MS    = "30";
    process.env.FINALITY_MAX_POLL_MS     = "40";

    jest.resetModules();

    // Re-register mocks under the new module registry
    await jest.unstable_mockModule("../src/stellar.js", () => ({
      pollHorizonTransaction,
    }));
    await jest.unstable_mockModule("../src/database/transaction-finality.js", () => ({
      createFinalityRecord,
      setFinalityTxHash,
      incrementPollAttempt,
      markFinalityConfirmed,
      markFinalityFailed,
      markFinalityTimeout,
      getFinalityByTransactionId,
      deleteOldFinalityRecords,
    }));
    await jest.unstable_mockModule("../src/websocket.js", () => ({
      broadcastFinalityUpdate,
      sendNotification: jest.fn(),
      broadcastToContract: jest.fn(),
      initializeWebSocket: jest.fn(),
    }));

    // status "not_found" to keep polling until timeout
    pollHorizonTransaction.mockResolvedValue({ status: "not_found" });

    const { startTracking: start } = await import("../src/transaction-finality.js");
    start({ transactionId: 99, txHash: "f".repeat(64) });

    // Wait longer than the 150ms window
    await new Promise((r) => setTimeout(r, 400));

    expect(markFinalityTimeout).toHaveBeenCalledWith(99);
    expect(broadcastFinalityUpdate).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ status: "timeout" })
    );

    delete process.env.FINALITY_MAX_DURATION_MS;
    delete process.env.FINALITY_BASE_POLL_MS;
    delete process.env.FINALITY_MAX_POLL_MS;
  }, 5000);
});

// ─── cancelTracking ───────────────────────────────────────────────────────────

describe("cancelTracking", () => {
  beforeEach(() => jest.clearAllMocks());

  test("returns false for an unknown transactionId", () => {
    expect(cancelTracking(99999)).toBe(false);
  });

  test("returns true for an active tracker and removes it", () => {
    createFinalityRecord.mockReturnValue(30);
    pollHorizonTransaction.mockResolvedValue({ status: "confirmed", ledger: 1, createdAt: null });

    startTracking({ transactionId: 50, txHash: "g".repeat(64) });
    expect(cancelTracking(50)).toBe(true);
    expect(isTracking(50)).toBe(false);
  });
});

// ─── Cleanup job ──────────────────────────────────────────────────────────────

describe("executeFinalityCleanup", () => {
  beforeEach(() => jest.clearAllMocks());

  test("calls deleteOldFinalityRecords with the correct cutoff", () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    deleteOldFinalityRecords.mockReturnValue(5);

    const result = executeFinalityCleanup(now, 7);

    expect(deleteOldFinalityRecords).toHaveBeenCalledWith(
      new Date("2026-08-19T00:00:00.000Z")
    );
    expect(result.deleted).toBe(5);
    expect(result.cutoff).toBe("2026-08-19T00:00:00.000Z");
  });

  test("returns deleted=0 when there are no old records", () => {
    deleteOldFinalityRecords.mockReturnValue(0);

    const result = executeFinalityCleanup(new Date(), 7);
    expect(result.deleted).toBe(0);
  });

  test("uses custom retentionDays", () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    deleteOldFinalityRecords.mockReturnValue(3);

    executeFinalityCleanup(now, 30);

    // 30 days before 2026-08-26 is 2026-07-27
    expect(deleteOldFinalityRecords).toHaveBeenCalledWith(
      new Date("2026-07-27T00:00:00.000Z")
    );
  });
});
