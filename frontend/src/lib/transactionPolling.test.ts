import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  pollTransactionStatus,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
} from "./transactionPolling";

describe("pollTransactionStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves 'confirmed' once the status confirms and stops polling", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("pending")
      .mockResolvedValueOnce("confirmed");
    const onUpdate = vi.fn();

    const run = pollTransactionStatus({ fetchStatus, onUpdate });
    // Two 5s intervals separate the three reads.
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_POLL_INTERVAL_MS);

    await expect(run).resolves.toBe("confirmed");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    // No further polling after confirmation.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
    expect(onUpdate).toHaveBeenLastCalledWith("confirmed");
  });

  test("resolves 'failed' when the backend reports a failed transaction", async () => {
    const fetchStatus = vi.fn().mockResolvedValue("failed");

    const run = pollTransactionStatus({ fetchStatus });
    await vi.advanceTimersByTimeAsync(0);

    await expect(run).resolves.toBe("failed");
    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  test("resolves 'timeout' after 60s when the status stays pending", async () => {
    const fetchStatus = vi.fn().mockResolvedValue("pending");

    const run = pollTransactionStatus({ fetchStatus });
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_TIMEOUT_MS);

    await expect(run).resolves.toBe("timeout");
    // ~12 polls over 60s at a 5s interval; never indefinitely.
    expect(fetchStatus.mock.calls.length).toBeLessThanOrEqual(
      DEFAULT_POLL_TIMEOUT_MS / DEFAULT_POLL_INTERVAL_MS + 1,
    );
  });

  test("stops polling when the signal is aborted", async () => {
    const controller = new AbortController();
    const fetchStatus = vi.fn().mockResolvedValue("pending");

    const run = pollTransactionStatus({
      fetchStatus,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    const callsBeforeAbort = fetchStatus.mock.calls.length;

    controller.abort();
    await vi.advanceTimersByTimeAsync(3 * DEFAULT_POLL_INTERVAL_MS);

    await expect(run).resolves.toBe("aborted");
    // No additional polls fire after abort.
    expect(fetchStatus.mock.calls.length).toBe(callsBeforeAbort);
  });

  test("applies exponential backoff after failures, then recovers", async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce("confirmed");
    const onError = vi.fn();

    const run = pollTransactionStatus({ fetchStatus, onError });

    // First read is immediate and fails.
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(1);

    // Backoff after one failure is 5s (interval * 2^0); only then the 2nd read.
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(expect.any(Error), 2);
    expect(fetchStatus).toHaveBeenCalledTimes(2);

    // Backoff after two failures is 10s (interval * 2^1) before the 3rd read.
    await vi.advanceTimersByTimeAsync(2 * DEFAULT_POLL_INTERVAL_MS);

    await expect(run).resolves.toBe("confirmed");
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  test("keeps polling on 'not_found' until the row is written", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce("not_found")
      .mockResolvedValueOnce("confirmed");
    const onUpdate = vi.fn();

    const run = pollTransactionStatus({ fetchStatus, onUpdate });
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);

    await expect(run).resolves.toBe("confirmed");
    expect(onUpdate).toHaveBeenNthCalledWith(1, "not_found");
    expect(onUpdate).toHaveBeenNthCalledWith(2, "confirmed");
  });
});
