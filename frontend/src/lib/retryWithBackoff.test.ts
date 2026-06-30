import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  retryWithBackoff,
  backoffDelay,
  DEFAULT_BASE_DELAY_MS,
} from "./retryWithBackoff";

describe("backoffDelay", () => {
  test("grows exponentially without jitter", () => {
    expect(backoffDelay(1, 1000, 2, false)).toBe(1000);
    expect(backoffDelay(2, 1000, 2, false)).toBe(2000);
    expect(backoffDelay(3, 1000, 2, false)).toBe(4000);
  });

  test("equal jitter keeps the delay within [raw/2, raw]", () => {
    expect(backoffDelay(3, 1000, 2, true, () => 0)).toBe(2000); // raw/2
    expect(backoffDelay(3, 1000, 2, true, () => 1)).toBe(4000); // raw
    expect(backoffDelay(3, 1000, 2, true, () => 0.5)).toBe(3000); // midpoint
  });
});

describe("retryWithBackoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves on the first attempt without any delay", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryWithBackoff(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("retries and resolves after transient failures", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValueOnce("GADDRESS");
    const onRetry = vi.fn();

    const run = retryWithBackoff(fn, { jitter: false, onRetry });
    await vi.advanceTimersByTimeAsync(1000 + 2000);

    await expect(run).resolves.toBe("GADDRESS");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test("uses 1s, 2s, 4s exponential delays (3 retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("down"));
    const onRetry = vi.fn();

    const run = retryWithBackoff(fn, { jitter: false, onRetry }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    const err = await run;
    expect((err as Error).message).toBe("down");
    // 1 initial + 3 retries = 4 attempts.
    expect(fn).toHaveBeenCalledTimes(4);
    expect(onRetry.mock.calls.map((c) => c[1])).toEqual([1000, 2000, 4000]);
  });

  test("rejects with the last error once retries are exhausted", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValue(new Error("final"));

    const run = retryWithBackoff(fn, { jitter: false }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000);

    const err = await run;
    expect((err as Error).message).toBe("final");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  test("stops retrying when aborted and rejects with AbortError", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("down"));

    const run = retryWithBackoff(fn, {
      jitter: false,
      signal: controller.signal,
    }).catch((e) => e);

    // First attempt fails, loop is sleeping before retry 1.
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeAbort = fn.mock.calls.length;
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    const err = await run;
    expect((err as Error).name).toBe("AbortError");
    expect(fn.mock.calls.length).toBe(callsBeforeAbort);
  });

  test("honours a custom base delay", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
    const onRetry = vi.fn();

    const run = retryWithBackoff(fn, { baseDelayMs: 50, jitter: false, onRetry });
    await vi.advanceTimersByTimeAsync(50);

    await expect(run).resolves.toBe("ok");
    expect(onRetry.mock.calls[0][1]).toBe(50);
    expect(DEFAULT_BASE_DELAY_MS).toBe(1000);
  });
});
