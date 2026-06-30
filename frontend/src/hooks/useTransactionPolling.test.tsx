import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransactionPolling } from "./useTransactionPolling";
import { api } from "../api";

vi.mock("../api", () => ({
  api: { getTransactionDetails: vi.fn() },
}));

const mockedGet = api.getTransactionDetails as unknown as ReturnType<typeof vi.fn>;

describe("useTransactionPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedGet.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("polls the status endpoint until confirmed and reports the outcome", async () => {
    mockedGet
      .mockResolvedValueOnce({ data: { status: "pending" } })
      .mockResolvedValueOnce({ data: { status: "confirmed" } });

    const { result } = renderHook(() => useTransactionPolling());

    let outcome: string | undefined;
    await act(async () => {
      const run = result.current.poll("abc123");
      await vi.advanceTimersByTimeAsync(5_000);
      outcome = await run;
    });

    expect(outcome).toBe("confirmed");
    expect(result.current.outcome).toBe("confirmed");
    expect(result.current.status).toBe("confirmed");
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(mockedGet).toHaveBeenLastCalledWith("abc123", expect.any(AbortSignal));
  });

  test("aborts in-flight polling on unmount", async () => {
    mockedGet.mockResolvedValue({ data: { status: "pending" } });

    const { result, unmount } = renderHook(() => useTransactionPolling());

    let run: Promise<string> | undefined;
    await act(async () => {
      run = result.current.poll("abc123") as Promise<string>;
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const callsBeforeUnmount = mockedGet.mock.calls.length;

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    await expect(run).resolves.toBe("aborted");
    // No further polls after the component unmounted.
    expect(mockedGet.mock.calls.length).toBe(callsBeforeUnmount);
  });
});
