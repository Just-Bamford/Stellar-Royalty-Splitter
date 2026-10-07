/**
 * Tests for centralized RPC retry handler.
 * Covers transient/permanent error detection, backoff calculation, and retry behavior.
 */

import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock logger before importing rpc-retry
const mockLogger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: mockLogger,
}));

// Now import rpc-retry after logger is mocked
const {
  isTransientError,
  getBackoffDelay,
  logRetryAttempt,
  logRetryExhausted,
  logRetrySuccess,
  withRetry,
  retryConfig,
  retryMetrics,
} = await import("../src/rpc-retry.js");

// Metrics module (real prom-client; per-file module isolation keeps the
// registry fresh for this test file).
const { getMetricsSnapshot, prometheusMetrics } = await import("../src/metrics.js");

describe("RPC Retry Handler", () => {
  beforeEach(() => {
    retryMetrics.reset();
  });

  // ─── isTransientError Tests ────────────────────────────────────────────────

  describe("isTransientError", () => {
    describe("HTTP status codes", () => {
      test("identifies 429 (rate limit) as transient", () => {
        const result = isTransientError({ status: 429 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("rate_limit");
        expect(result.retryable).toBe(true);
      });

      test("identifies 503 (service unavailable) as transient", () => {
        const result = isTransientError({ status: 503 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("service_unavailable");
      });

      test("identifies 504 (gateway timeout) as transient", () => {
        const result = isTransientError({ status: 504 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("gateway_timeout");
      });

      test("identifies 408 (request timeout) as transient", () => {
        const result = isTransientError({ status: 408 });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("request_timeout");
      });

      test("identifies 400 (bad request) as permanent", () => {
        const result = isTransientError({ status: 400 });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("permanent_client_error");
        expect(result.retryable).toBe(false);
      });

      test("identifies 401 (unauthorized) as permanent", () => {
        const result = isTransientError({ status: 401 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });

      test("identifies 403 (forbidden) as permanent", () => {
        const result = isTransientError({ status: 403 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });

      test("identifies 404 (not found) as permanent", () => {
        const result = isTransientError({ status: 404 });
        expect(result.isTransient).toBe(false);
        expect(result.retryable).toBe(false);
      });
    });

    describe("Network errors", () => {
      test("identifies ENOTFOUND as transient", () => {
        const result = isTransientError({ code: "ENOTFOUND" });
        expect(result.isTransient).toBe(true);
        expect(result.category).toBe("network_ENOTFOUND");
      });

      test("identifies ECONNREFUSED as transient", () => {
        const result = isTransientError({ code: "ECONNREFUSED" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies ETIMEDOUT as transient", () => {
        const result = isTransientError({ code: "ETIMEDOUT" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies EHOSTUNREACH as transient", () => {
        const result = isTransientError({ code: "EHOSTUNREACH" });
        expect(result.isTransient).toBe(true);
      });
    });

    describe("Message patterns", () => {
      test("identifies timeout message as transient", () => {
        const result = isTransientError({ message: "Request timed out after 5000ms" });
        expect(result.isTransient).toBe(true);
        expect(result.reason).toBe("network_error_from_message");
      });

      test("identifies network message as transient", () => {
        const result = isTransientError({ message: "Network error occurred" });
        expect(result.isTransient).toBe(true);
      });

      test("identifies simulation error as permanent", () => {
        const result = isTransientError({ message: "Simulation failed: contract error" });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("simulation_error");
      });

      test("identifies contract error as permanent", () => {
        const result = isTransientError({
          message: "Contract invocation failed",
        });
        expect(result.isTransient).toBe(false);
      });

      test("identifies account not found as permanent", () => {
        const result = isTransientError({
          message: "Account not found on Stellar network",
        });
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("account_not_found");
      });
    });

    describe("Structured error formats", () => {
      test("handles response.status format", () => {
        const result = isTransientError({
          response: { status: 429 },
        });
        expect(result.isTransient).toBe(true);
      });

      test("handles code field", () => {
        const result = isTransientError({
          response: { status: 503 },
          code: "SERVICE_UNAVAILABLE",
        });
        expect(result.isTransient).toBe(true);
      });
    });

    describe("Edge cases", () => {
      test("returns false for null error", () => {
        const result = isTransientError(null);
        expect(result.isTransient).toBe(false);
        expect(result.reason).toBe("unknown_error");
      });

      test("returns false for empty object", () => {
        const result = isTransientError({});
        expect(result.isTransient).toBe(false);
      });

      test("includes operationType in analysis", () => {
        const result = isTransientError({ message: "error" }, "submitTransaction");
        expect(result.isTransient).toBe(false);
      });
    });
  });

  // ─── getBackoffDelay Tests ──────────────────────────────────────────────

  describe("getBackoffDelay", () => {
    test("returns base backoff for first retry", () => {
      const delay = getBackoffDelay(1);
      expect(delay).toBeGreaterThanOrEqual(retryConfig.baseBackoffMs * 0.9);
      expect(delay).toBeLessThanOrEqual(retryConfig.baseBackoffMs * 1.1);
    });

    test("exponentially increases delay", () => {
      const delay1 = getBackoffDelay(1);
      const delay2 = getBackoffDelay(2);
      const delay3 = getBackoffDelay(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
    });

    test("respects max backoff cap", () => {
      const delay = getBackoffDelay(10);
      expect(delay).toBeLessThanOrEqual(retryConfig.maxBackoffMs);
    });

    test("applies jitter consistently", () => {
      // Multiple calls should have slight variations due to jitter
      const delays = [getBackoffDelay(1), getBackoffDelay(1), getBackoffDelay(1)];

      const allSame = delays.every((d) => d === delays[0]);
      expect(allSame).toBe(false); // Very unlikely with jitter
    });

    test("respects custom config", () => {
      const customConfig = {
        baseBackoffMs: 500,
        maxBackoffMs: 5000,
      };
      const delay = getBackoffDelay(1, customConfig);
      expect(delay).toBeGreaterThanOrEqual(450);
      expect(delay).toBeLessThanOrEqual(550);
    });
  });

  // ─── Logging Functions Tests ────────────────────────────────────────────

  describe("Logging functions", () => {
    test("logRetryAttempt logs safe information", () => {
      mockLogger.warn.mockClear();
      logRetryAttempt({
        attemptNumber: 1,
        totalAttempts: 3,
        operationType: "getAccount",
        error: { status: 503 },
        delayMs: 1000,
        details: { walletAddress: "G..." },
      });

      expect(mockLogger.warn).toHaveBeenCalled();
      const output = mockLogger.warn.mock.calls[0][1];
      expect(output.event).toBe("rpc_retry_attempt");
      expect(output.attemptNumber).toBe(1);
      expect(output.errorReason).toBe("service_unavailable");
    });

    test("logRetryExhausted logs exhaustion event", () => {
      mockLogger.error.mockClear();
      logRetryExhausted({
        operationType: "getAccount",
        totalAttempts: 3,
        lastError: { status: 503 },
      });

      expect(mockLogger.error).toHaveBeenCalled();
    });

    test("logRetrySuccess logs recovery", () => {
      mockLogger.info.mockClear();
      logRetrySuccess({
        operationType: "getAccount",
        attemptNumber: 2,
      });

      expect(mockLogger.info).toHaveBeenCalled();
      const output = mockLogger.info.mock.calls[0][1];
      expect(output.event).toBe("rpc_retry_success");
      expect(output.successfulAttempt).toBe(2);
    });
  });

  // ─── withRetry Tests ────────────────────────────────────────────────────

  describe("withRetry", () => {
    describe("Success cases", () => {
      test("returns result on first attempt success", async () => {
        const operation = jest.fn().mockResolvedValue({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("returns result after transient error and retry", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(2);
      });

      test("retries multiple times until success", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockRejectedValueOnce({ status: 429 })
          .mockResolvedValueOnce({ data: "success" });

        const result = await withRetry(operation, { operationType: "getAccount" });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(3);
      });
    });

    describe("Failure cases", () => {
      test("throws on permanent error without retrying", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 400 });

        await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
          status: 400,
        });

        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("throws after exhausting max retries", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
          status: 503,
        });

        expect(operation).toHaveBeenCalledTimes(3);
      });

      test("respects maxRetries option", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(
          withRetry(operation, { operationType: "getAccount", maxRetries: 2 })
        ).rejects.toEqual({ status: 503 });

        expect(operation).toHaveBeenCalledTimes(2);
      });
    });

    describe("Special cases", () => {
      test("never retries submitTransaction operations", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "submitTransaction" })).rejects.toEqual({
          status: 503,
        });

        // Should reject immediately without retries
        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("never retries submit operations", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        await expect(withRetry(operation, { operationType: "submit" })).rejects.toEqual({
          status: 503,
        });

        expect(operation).toHaveBeenCalledTimes(1);
      });

      test("allows custom retry predicate", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 400 })
          .mockResolvedValueOnce({ data: "success" });

        const customShouldRetry = (error) => error?.status === 400;

        const result = await withRetry(operation, {
          operationType: "customOp",
          shouldRetry: customShouldRetry,
        });

        expect(result).toEqual({ data: "success" });
        expect(operation).toHaveBeenCalledTimes(2);
      });

      test("custom predicate can override retry logic", async () => {
        const operation = jest.fn().mockRejectedValue({ status: 503 });

        const customShouldRetry = () => false;

        await expect(
          withRetry(operation, {
            operationType: "customOp",
            shouldRetry: customShouldRetry,
          })
        ).rejects.toEqual({ status: 503 });

        expect(operation).toHaveBeenCalledTimes(1);
      });
    });

    describe("Details parameter", () => {
      test("passes details to logging", async () => {
        mockLogger.warn.mockClear();
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const details = { walletAddress: "G..." };
        await withRetry(operation, {
          operationType: "getAccount",
          details,
        });

        expect(mockLogger.warn).toHaveBeenCalled();
        const output = mockLogger.warn.mock.calls[0][1];
        expect(output.walletAddress).toBe("G...");
      });
    });

    describe("Timing", () => {
      test("applies backoff between retries", async () => {
        const operation = jest
          .fn()
          .mockRejectedValueOnce({ status: 503 })
          .mockResolvedValueOnce({ data: "success" });

        const startTime = Date.now();
        await withRetry(operation, {
          operationType: "getAccount",
          baseBackoffMs: 100, // Short delay for testing
        });
        const elapsed = Date.now() - startTime;

        // Should have at least 100ms delay (with jitter ±10%)
        // Relaxed to 85ms to account for CI variability
        expect(elapsed).toBeGreaterThanOrEqual(85);
      });
    });
  });

  // ─── Metrics Tests ─────────────────────────────────────────────────────

  describe("retryMetrics", () => {
    test("tracks retry attempts", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordAttempt();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(2);
    });

    test("tracks successful retries", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.successfulRetries).toBe(1);
    });

    test("tracks exhausted retries", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordExhausted();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.exhaustedRetries).toBe(1);
    });

    test("calculates success rate", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();

      const metrics = retryMetrics.getMetrics();
      expect(parseFloat(metrics.successRate)).toBe(50.0);
    });

    test("handles zero attempts gracefully", () => {
      const metrics = retryMetrics.getMetrics();
      expect(metrics.successRate).toBe(0);
    });

    test("resets metrics", () => {
      retryMetrics.recordAttempt();
      retryMetrics.recordSuccess();
      retryMetrics.reset();

      const metrics = retryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(0);
      expect(metrics.successfulRetries).toBe(0);
    });
  });

  // ─── Integration Tests ──────────────────────────────────────────────────

  describe("Integration scenarios", () => {
    test("recovers from rate limit with backoff", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValueOnce({ data: "success" });

      const result = await withRetry(operation, {
        operationType: "getAccount",
        baseBackoffMs: 50,
      });

      expect(result).toEqual({ data: "success" });
      expect(operation).toHaveBeenCalledTimes(3);
    });

    test("stops retrying on bad request regardless of prior failures", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockRejectedValueOnce({ status: 400 });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toEqual({
        status: 400,
      });

      // First attempt was 503 (retried), second was 400 (not retried)
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test("handles network error recovery", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ code: "ECONNREFUSED" })
        .mockResolvedValueOnce({ data: "success" });

      const result = await withRetry(operation, { operationType: "getAccount" });

      expect(result).toEqual({ data: "success" });
    });

    test("rejects account not found without retry", async () => {
      const operation = jest.fn().mockRejectedValue({
        status: 400,
        message: "Account not found on Stellar network",
      });

      await expect(withRetry(operation, { operationType: "getAccount" })).rejects.toMatchObject({
        message: expect.stringContaining("Account not found"),
      });

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Metrics wiring (retry count + success rate) ─────────────────────────

  describe("withRetry metrics wiring", () => {
    const snapshot = () => {
      const s = getMetricsSnapshot();
      return {
        attempts: s.rpcRetryAttempts,
        successes: s.rpcRetrySuccesses,
        exhausted: s.rpcRetryExhausted,
      };
    };

    test("records an attempt and a success when a retry recovers the operation", async () => {
      const before = snapshot();
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce({ data: "success" });

      await withRetry(operation, { operationType: "metricsTest", baseBackoffMs: 5 });

      const after = snapshot();
      expect(after.attempts - before.attempts).toBe(1);
      expect(after.successes - before.successes).toBe(1);
      expect(after.exhausted - before.exhausted).toBe(0);

      const inMemory = retryMetrics.getMetrics();
      expect(inMemory.successfulRetries).toBeGreaterThanOrEqual(1);
    });

    test("records attempts and exhaustion when all retries fail", async () => {
      const before = snapshot();
      const operation = jest.fn().mockRejectedValue({ status: 503 });

      await expect(
        withRetry(operation, { operationType: "metricsTest", baseBackoffMs: 5 })
      ).rejects.toEqual({ status: 503 });

      const after = snapshot();
      // 3 attempts total → 2 retries executed, then exhausted on the last one
      expect(after.attempts - before.attempts).toBe(2);
      expect(after.successes - before.successes).toBe(0);
      expect(after.exhausted - before.exhausted).toBe(1);
    });

    test("records nothing for permanent errors (no retry happens)", async () => {
      const before = snapshot();
      const operation = jest.fn().mockRejectedValue({ status: 400 });

      await expect(withRetry(operation, { operationType: "metricsTest" })).rejects.toEqual({
        status: 400,
      });

      const after = snapshot();
      expect(after.attempts - before.attempts).toBe(0);
      expect(after.successes - before.successes).toBe(0);
      expect(after.exhausted - before.exhausted).toBe(0);
    });

    function labeledValue(promText, metricName, operationType) {
      const line = promText
        .split("\n")
        .find((l) => l.startsWith(`${metricName}{operationType="${operationType}"}`));
      return line ? Number(line.split(" ").pop()) : 0;
    }

    test("exposes retry counters in the prometheus metrics output", async () => {
      const before = await prometheusMetrics();
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce({ data: "success" });

      await withRetry(operation, { operationType: "metricsProm", baseBackoffMs: 5 });

      const promText = await prometheusMetrics();
      // Legacy (unlabeled) retry counters
      expect(promText).toContain("stellar_rpc_retry_attempts_total");
      expect(promText).toContain("stellar_rpc_retry_successes_total");
      expect(promText).toContain("stellar_rpc_retry_exhausted_total");
      // Labeled prometheus counters from the registry (delta, since other
      // tests in this file also increment labeled counters)
      expect(
        labeledValue(promText, "stellar_rpc_retries_total", "metricsProm") -
          labeledValue(before, "stellar_rpc_retries_total", "metricsProm")
      ).toBe(1);
      expect(
        labeledValue(promText, "stellar_rpc_retry_successes_total", "metricsProm") -
          labeledValue(before, "stellar_rpc_retry_successes_total", "metricsProm")
      ).toBe(1);
    });
  });

  // ─── Per-call backoff option ─────────────────────────────────────────────

  describe("per-call baseBackoffMs", () => {
    test("honors a small per-call base backoff (not the global default)", async () => {
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ status: 503 })
        .mockResolvedValueOnce({ data: "success" });

      const startedAt = Date.now();
      await withRetry(operation, { operationType: "getAccount", baseBackoffMs: 20 });
      const elapsed = Date.now() - startedAt;

      // With the (now-respected) 20ms base the wait is ~20ms ± jitter.
      // If the option were ignored, the global 1000ms default would dominate.
      expect(elapsed).toBeLessThan(400);
      expect(elapsed).toBeGreaterThanOrEqual(18);
    });
  });
});
