/**
 * Webhook retry logic and delivery metrics tests (#464).
 *
 * Verifies:
 *  - Exponential backoff delay between retry attempts
 *  - Success on first attempt increments successCount metric
 *  - All retries exhausted increments failureCount metric
 *  - totalAttempts reflects every fetch call across retries
 *  - getDeliveryMetrics returns a snapshot (not a live reference)
 *  - Retry succeeds on a later attempt and stops early
 *  - Backoff delay doubles on each successive failure
 *  - Metrics accumulate correctly across multiple calls
 */

import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mock database/webhooks.js — no real DB needed for delivery logic tests
// ---------------------------------------------------------------------------

const enqueueDeadLetter = jest.fn();
const listAllPendingDeadLetters = jest.fn(() => []);
const markDeadLetterRetried = jest.fn();
const deleteOldDeadLetters = jest.fn(() => 0);
const listWebhooks = jest.fn(() => []);

await jest.unstable_mockModule("../src/database/webhooks.js", () => ({
  listWebhooks,
  enqueueDeadLetter,
  listAllPendingDeadLetters,
  markDeadLetterRetried,
  deleteOldDeadLetters,
  registerWebhook: jest.fn(),
  listDeadLetters: jest.fn(() => []),
  deleteWebhook: jest.fn(),
}));

const URL = "https://example.com/webhook";
const PAYLOAD = { event: "distribute.confirmed", contractId: "CAAA" };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deliverWithRetry — delivery metrics (#464)", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.WEBHOOK_RETRY_BASE_MS = "5"; // fast backoff in tests
    process.env.WEBHOOK_MAX_RETRIES = "3";
  });

  afterEach(() => {
    delete process.env.WEBHOOK_RETRY_BASE_MS;
    delete process.env.WEBHOOK_MAX_RETRIES;
  });

  // 1. Successful first attempt increments successCount
  test("successful first attempt increments successCount and totalAttempts", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const result = await deliverWithRetry(URL, PAYLOAD);

    expect(result.success).toBe(true);
    const metrics = getDeliveryMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.totalAttempts).toBe(1);
  });

  // 2. All retries exhausted increments failureCount
  test("exhausting all retries increments failureCount", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const result = await deliverWithRetry(URL, PAYLOAD);

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    const metrics = getDeliveryMetrics();
    expect(metrics.failureCount).toBe(1);
    expect(metrics.successCount).toBe(0);
    // 3 retries → 3 attempts
    expect(metrics.totalAttempts).toBe(3);
  });

  // 3. Success on second attempt: totalAttempts = 2, successCount = 1
  test("success on second attempt counts 2 total attempts", async () => {
    let calls = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      calls++;
      return calls === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 };
    });

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const result = await deliverWithRetry(URL, PAYLOAD);

    expect(result.success).toBe(true);
    const metrics = getDeliveryMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.totalAttempts).toBe(2);
  });

  // 4. getDeliveryMetrics returns a snapshot, not a live reference
  test("getDeliveryMetrics returns a snapshot (mutation does not affect internal state)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    await deliverWithRetry(URL, PAYLOAD);
    const snapshot = getDeliveryMetrics();
    snapshot.successCount = 9999; // mutate the snapshot

    const fresh = getDeliveryMetrics();
    expect(fresh.successCount).toBe(1); // internal state unaffected
  });

  // 5. Metrics accumulate across multiple calls
  test("metrics accumulate correctly across multiple deliverWithRetry calls", async () => {
    let callNumber = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callNumber++;
      // First call chain: always succeeds. Second chain: always fails.
      // We control by tracking total invocation count:
      //   calls 1 = success (first deliverWithRetry)
      //   calls 2,3,4 = failures (second deliverWithRetry, 3 attempts)
      return callNumber === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 };
    });

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    await deliverWithRetry(URL, PAYLOAD);
    await deliverWithRetry(URL, PAYLOAD);

    const metrics = getDeliveryMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.totalAttempts).toBe(4); // 1 + 3
  });

  // 6. Exponential backoff: total elapsed time reflects geometric delay sum
  test("retry delays follow exponential backoff — elapsed time >= sum of expected waits", async () => {
    // base=20ms, max=3: delays are 20ms + 40ms = 60ms total sleep for 3 attempts
    process.env.WEBHOOK_RETRY_BASE_MS = "20";
    process.env.WEBHOOK_MAX_RETRIES = "3";

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 });

    const { deliverWithRetry, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const start = Date.now();
    const result = await deliverWithRetry(URL, PAYLOAD);
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    // With base=20ms and 3 attempts: sleep(20) + sleep(40) = 60ms minimum.
    // We check >= 50ms to give 10ms tolerance for scheduling jitter.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  }, 10_000);

  // 7. Network error (fetch throws) is treated as a failed attempt
  test("network error (fetch throws) is counted as a failed attempt", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const { deliverWithRetry, getDeliveryMetrics, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const result = await deliverWithRetry(URL, PAYLOAD);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/i);
    const metrics = getDeliveryMetrics();
    expect(metrics.failureCount).toBe(1);
    expect(metrics.totalAttempts).toBe(3);
  });

  // 8. Abort timeout error is surfaced in result.error
  test("AbortError from timeout is surfaced in result.error string", async () => {
    process.env.WEBHOOK_TIMEOUT_MS = "1";

    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => {
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          }, 5),
        ),
    );

    const { deliverWithRetry, _resetDeliveryMetrics } = await import(
      "../src/webhook-delivery.js"
    );
    _resetDeliveryMetrics();

    const result = await deliverWithRetry(URL, PAYLOAD);

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  }, 10_000);
});
