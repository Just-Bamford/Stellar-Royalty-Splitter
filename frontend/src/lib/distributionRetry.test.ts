import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  runWithDistributionRetry,
  getRetryMetrics,
  resetRetryMetrics,
  resetCircuit,
  isCircuitOpen,
  CircuitOpenError,
  MAX_RETRIES,
} from "./distributionRetry";

describe("distributionRetry (#502)", () => {
  beforeEach(() => {
    resetRetryMetrics();
    resetCircuit();
  });

  it("returns immediately on success and records a 100% success rate", async () => {
    const result = await runWithDistributionRetry(async () => "ok");
    expect(result).toBe("ok");
    expect(getRetryMetrics().successes).toBe(1);
    expect(getRetryMetrics().successRate).toBe(1);
  });

  it("retries with backoff then succeeds, invoking onRetry", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error("network");
      return "recovered";
    });

    const promise = runWithDistributionRetry(fn, { onRetry });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(getRetryMetrics().attempts).toBe(1);
    vi.useRealTimers();
  });

  it("does not retry a deterministic 4xx error", async () => {
    const err = Object.assign(new Error("bad request"), { status: 400 });
    const fn = vi.fn(async () => {
      throw err;
    });
    await expect(runWithDistributionRetry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getRetryMetrics().attempts).toBe(0);
  });

  it("opens the circuit breaker after repeated failures and short-circuits", async () => {
    vi.useFakeTimers();
    const failing = async () => {
      throw new Error("down");
    };

    for (let i = 0; i < MAX_RETRIES; i++) {
      const p = runWithDistributionRetry(failing).catch(() => {});
      await vi.runAllTimersAsync();
      await p;
    }
    vi.useRealTimers();

    expect(isCircuitOpen()).toBe(true);
    await expect(runWithDistributionRetry(async () => "x")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });
});
