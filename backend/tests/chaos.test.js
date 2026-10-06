/**
 * Chaos Engineering Tests
 * Issue #966 - Testing system resilience under failure conditions
 *
 * Tests fault injection, retry behavior, and error handling under various failure scenarios
 */

import {
  enableChaos,
  disableChaos,
  isChaosEnabled,
  getChaosMetrics,
  resetChaosMetrics,
  injectRpcFault,
  injectDbFault,
  injectNetworkFault,
  withChaos,
  FaultType,
} from "../src/chaos/fault-injector.js";
import { withRetry, isTransientError } from "../src/rpc-retry.js";

describe("Chaos Engineering - Fault Injection", () => {
  beforeEach(() => {
    disableChaos();
    resetChaosMetrics();
  });

  afterEach(() => {
    disableChaos();
  });

  describe("Chaos Control", () => {
    it("should enable and disable chaos testing", () => {
      expect(isChaosEnabled()).toBe(false);

      enableChaos({ rpcFailureRate: 0.5 });
      expect(isChaosEnabled()).toBe(true);

      disableChaos();
      expect(isChaosEnabled()).toBe(false);
    });

    it("should track chaos metrics", async () => {
      enableChaos({ rpcFailureRate: 1.0 }); // 100% failure rate

      const metrics1 = getChaosMetrics();
      expect(metrics1.rpcFailuresInjected).toBe(0);

      try {
        await injectRpcFault(async () => "success", "test");
      } catch (error) {
        // Expected failure
      }

      const metrics2 = getChaosMetrics();
      expect(metrics2.rpcFailuresInjected).toBe(1);
    });

    it("should reset metrics", async () => {
      enableChaos({ rpcFailureRate: 1.0 });

      try {
        await injectRpcFault(async () => "success", "test");
      } catch (error) {
        // Expected
      }

      expect(getChaosMetrics().rpcFailuresInjected).toBe(1);

      resetChaosMetrics();
      expect(getChaosMetrics().rpcFailuresInjected).toBe(0);
    });
  });

  describe("RPC Fault Injection", () => {
    it("should not inject faults when chaos is disabled", async () => {
      disableChaos();

      const result = await injectRpcFault(async () => "success", "test");
      expect(result).toBe("success");

      const metrics = getChaosMetrics();
      expect(metrics.rpcFailuresInjected).toBe(0);
    });

    it("should inject RPC timeouts", async () => {
      enableChaos({ rpcFailureRate: 0, timeoutRate: 1.0 }); // 100% timeout

      await expect(
        injectRpcFault(async () => "success", "test")
      ).rejects.toThrow(/timeout/i);

      const metrics = getChaosMetrics();
      expect(metrics.timeoutsInjected).toBe(1);
    });

    it("should inject rate limit errors", async () => {
      enableChaos({ rpcFailureRate: 1.0, timeoutRate: 0 });

      // Since the fault type is random, we'll run multiple attempts
      let rateLimitFound = false;
      for (let i = 0; i < 10; i++) {
        resetChaosMetrics();
        try {
          await injectRpcFault(async () => "success", "test");
        } catch (error) {
          if (error.status === 429) {
            rateLimitFound = true;
            expect(error.message).toMatch(/rate limit/i);
            expect(error.isChaosFault).toBe(true);
            break;
          }
        }
      }
      expect(rateLimitFound).toBe(true);
    });

    it("should inject service unavailable errors", async () => {
      enableChaos({ rpcFailureRate: 1.0, timeoutRate: 0 });

      let serviceUnavailableFound = false;
      for (let i = 0; i < 10; i++) {
        resetChaosMetrics();
        try {
          await injectRpcFault(async () => "success", "test");
        } catch (error) {
          if (error.status === 503) {
            serviceUnavailableFound = true;
            expect(error.message).toMatch(/unavailable/i);
            expect(error.isChaosFault).toBe(true);
            break;
          }
        }
      }
      expect(serviceUnavailableFound).toBe(true);
    });

    it("should pass through successful operations", async () => {
      enableChaos({ rpcFailureRate: 0, timeoutRate: 0 });

      const result = await injectRpcFault(async () => "success", "test");
      expect(result).toBe("success");
    });
  });

  describe("Database Fault Injection", () => {
    it("should inject database connection errors", async () => {
      enableChaos({ dbFailureRate: 1.0, timeoutRate: 0 });

      await expect(
        injectDbFault(async () => "success", "test")
      ).rejects.toThrow();

      const metrics = getChaosMetrics();
      expect(metrics.dbFailuresInjected).toBeGreaterThan(0);
    });

    it("should inject database timeouts", async () => {
      enableChaos({ dbFailureRate: 0, timeoutRate: 1.0 });

      await expect(
        injectDbFault(async () => "success", "test")
      ).rejects.toThrow(/timeout/i);
    });

    it("should not inject faults when disabled", async () => {
      disableChaos();

      const result = await injectDbFault(async () => "db-success", "test");
      expect(result).toBe("db-success");
    });
  });

  describe("Network Fault Injection", () => {
    it("should inject network errors", async () => {
      enableChaos({ networkFailureRate: 1.0 });

      await expect(
        injectNetworkFault(async () => "success", "test")
      ).rejects.toThrow();

      const metrics = getChaosMetrics();
      expect(metrics.networkFailuresInjected).toBe(1);
    });

    it("should inject various network error types", async () => {
      enableChaos({ networkFailureRate: 1.0 });

      const errorCodes = new Set();
      for (let i = 0; i < 20; i++) {
        resetChaosMetrics();
        try {
          await injectNetworkFault(async () => "success", "test");
        } catch (error) {
          errorCodes.add(error.code);
        }
      }

      // Should see multiple error types
      expect(errorCodes.size).toBeGreaterThan(1);
    });
  });

  describe("Latency Injection", () => {
    it("should inject latency into operations", async () => {
      enableChaos({
        rpcFailureRate: 0,
        timeoutRate: 0,
        dbFailureRate: 0,
        networkFailureRate: 0,
        latencyMs: 100,
        latencyJitter: 0, // No jitter for predictable timing
      });

      const start = Date.now();
      await injectRpcFault(async () => "success", "test");
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance
      expect(getChaosMetrics().latencyInjections).toBe(1);
    });

    it("should apply jitter to latency", async () => {
      enableChaos({
        rpcFailureRate: 0,
        timeoutRate: 0,
        dbFailureRate: 0,
        networkFailureRate: 0,
        latencyMs: 100,
        latencyJitter: 0.5, // ±50% variation
      });

      const latencies = [];
      for (let i = 0; i < 10; i++) {
        const start = Date.now();
        await injectRpcFault(async () => "success", "test");
        latencies.push(Date.now() - start);
      }

      // Latencies should vary (not all the same)
      const uniqueLatencies = new Set(latencies);
      expect(uniqueLatencies.size).toBeGreaterThan(1);

      // All latencies should be within jitter range (50ms - 150ms)
      latencies.forEach((latency) => {
        expect(latency).toBeGreaterThanOrEqual(45); // 50ms - 5ms tolerance
        expect(latency).toBeLessThanOrEqual(160); // 150ms + 10ms tolerance
      });
    });
  });

  describe("Integration with Retry Logic", () => {
    it("should retry transient chaos failures", async () => {
      enableChaos({ rpcFailureRate: 1.0, timeoutRate: 0 });

      let attemptCount = 0;
      const operation = async () => {
        attemptCount++;
        // First 2 attempts will inject chaos, 3rd will succeed
        if (attemptCount >= 3) {
          disableChaos(); // Disable chaos to allow success
        }
        return await injectRpcFault(async () => "success", "test");
      };

      const result = await withRetry(operation, {
        operationType: "chaosTest",
        maxRetries: 3,
      });

      expect(result).toBe("success");
      expect(attemptCount).toBe(3);
    });

    it("should recognize chaos-injected errors as transient", () => {
      const timeoutError = new Error("Request timeout - chaos injection");
      timeoutError.code = "ETIMEDOUT";
      timeoutError.isChaosFault = true;

      const analysis = isTransientError(timeoutError);
      expect(analysis.isTransient).toBe(true);
      expect(analysis.category).toContain("network");
    });

    it("should exhaust retries on persistent chaos failures", async () => {
      enableChaos({ rpcFailureRate: 1.0 }); // Always fail

      const operation = async () => {
        return await injectRpcFault(async () => "success", "test");
      };

      await expect(
        withRetry(operation, {
          operationType: "chaosTest",
          maxRetries: 2,
        })
      ).rejects.toThrow();

      // Should have attempted twice (original + 1 retry with maxRetries=2)
      const metrics = getChaosMetrics();
      expect(metrics.rpcFailuresInjected).toBeGreaterThanOrEqual(2);
    });
  });

  describe("withChaos Wrapper", () => {
    it("should route to RPC fault injection", async () => {
      enableChaos({ rpcFailureRate: 1.0, timeoutRate: 0 });

      await expect(
        withChaos(async () => "success", { type: "rpc", operationType: "test" })
      ).rejects.toThrow();

      expect(getChaosMetrics().rpcFailuresInjected).toBeGreaterThan(0);
    });

    it("should route to DB fault injection", async () => {
      enableChaos({ dbFailureRate: 1.0, timeoutRate: 0 });

      await expect(
        withChaos(async () => "success", { type: "db", operationType: "test" })
      ).rejects.toThrow();

      expect(getChaosMetrics().dbFailuresInjected).toBeGreaterThan(0);
    });

    it("should route to network fault injection", async () => {
      enableChaos({ networkFailureRate: 1.0 });

      await expect(
        withChaos(async () => "success", { type: "network", operationType: "test" })
      ).rejects.toThrow();

      expect(getChaosMetrics().networkFailuresInjected).toBeGreaterThan(0);
    });

    it("should execute without chaos for unknown types", async () => {
      enableChaos({ rpcFailureRate: 1.0 });

      const result = await withChaos(async () => "success", {
        type: "unknown",
        operationType: "test",
      });

      expect(result).toBe("success");
    });
  });

  describe("Probabilistic Behavior", () => {
    it("should inject faults according to configured probability", async () => {
      const failureRate = 0.3; // 30% failure rate
      enableChaos({ rpcFailureRate: failureRate, timeoutRate: 0 });

      const trials = 100;
      let failures = 0;

      for (let i = 0; i < trials; i++) {
        try {
          await injectRpcFault(async () => "success", "test");
        } catch (error) {
          failures++;
        }
      }

      // Statistical test: failures should be roughly 30% ±15%
      const actualRate = failures / trials;
      expect(actualRate).toBeGreaterThan(failureRate - 0.15);
      expect(actualRate).toBeLessThan(failureRate + 0.15);
    });

    it("should inject no faults at 0% rate", async () => {
      enableChaos({ rpcFailureRate: 0, timeoutRate: 0 });

      for (let i = 0; i < 20; i++) {
        const result = await injectRpcFault(async () => "success", "test");
        expect(result).toBe("success");
      }

      expect(getChaosMetrics().rpcFailuresInjected).toBe(0);
    });

    it("should inject faults consistently at 100% rate", async () => {
      enableChaos({ rpcFailureRate: 1.0, timeoutRate: 0 });

      for (let i = 0; i < 10; i++) {
        await expect(
          injectRpcFault(async () => "success", "test")
        ).rejects.toThrow();
      }

      expect(getChaosMetrics().rpcFailuresInjected).toBe(10);
    });
  });
});
