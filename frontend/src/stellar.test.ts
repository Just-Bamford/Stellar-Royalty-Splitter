/**
 * Integration tests for signAndSubmitTransaction (Freighter + Soroban RPC).
 *
 * Verifies the submission retry strategy end-to-end:
 *   - Transient submission failures (network/timeout) are retried with
 *     100ms → 500ms → 2s backoff, up to 3 retries
 *   - Permanent failures (auth, deterministic RPC rejections) fail fast
 *   - The signed transaction is NEVER re-signed on retry (same signed XDR is
 *     resubmitted — safe because the network deduplicates by hash)
 *   - The onRetry callback fires so the UI can show a "retrying…" state
 *   - Transient RPC hiccups while polling for confirmation do not fail the
 *     whole submission
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => {
  const sendTransaction = vi.fn();
  const getTransaction = vi.fn();
  const fromXDR = vi.fn().mockReturnValue({ __mockTx: true });
  const signTransaction = vi.fn();

  class MockSorobanRpcServer {
    constructor(public url: string) {}
    sendTransaction = (...args: unknown[]) => sendTransaction(...args);
    getTransaction = (...args: unknown[]) => getTransaction(...args);
  }

  return { sendTransaction, getTransaction, fromXDR, signTransaction, MockSorobanRpcServer };
});

vi.mock("@stellar/stellar-sdk", () => ({
  TransactionBuilder: { fromXDR: mocks.fromXDR },
  Networks: {
    TESTNET: "Test SDF Future Network ; October 2022",
    PUBLIC: "Public Global Stellar Network ; formally known as",
  },
  SorobanRpc: { Server: mocks.MockSorobanRpcServer },
}));

import { signAndSubmitTransaction } from "./stellar";
import { submissionRetryMetrics } from "./lib/submission-retry";

function setFreighter() {
  mocks.signTransaction.mockReset().mockResolvedValue("signed-xdr");
  (window as unknown as { freighter: unknown }).freighter = {
    signTransaction: mocks.signTransaction,
  };
}

beforeEach(() => {
  mocks.sendTransaction.mockReset();
  mocks.getTransaction.mockReset();
  submissionRetryMetrics.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("signAndSubmitTransaction", () => {
  test("happy path: signs once, submits once, polls to confirmation", async () => {
    setFreighter();
    mocks.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "HASH1" });
    mocks.getTransaction.mockResolvedValueOnce({ status: "SUCCESS" });

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry: vi.fn() });

    await vi.advanceTimersByTimeAsync(0); // let signing + submission settle
    await vi.advanceTimersByTimeAsync(3000); // one confirmation poll

    const hash = await promise;
    expect(hash).toBe("HASH1");
    expect(mocks.signTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.getTransaction).toHaveBeenCalledTimes(1);
  });

  test("retries transient network failure with 100ms backoff and never re-signs", async () => {
    setFreighter();
    mocks.sendTransaction
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ status: "PENDING", hash: "HASH2" });
    mocks.getTransaction.mockResolvedValueOnce({ status: "SUCCESS" });
    const onRetry = vi.fn();

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry });

    // First attempt fails; backoff sleep (100ms) is scheduled.
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({
      attempt: 1,
      maxAttempts: 4,
      reason: "network_error",
      delayMs: 100,
    });

    // 100ms backoff elapses → second attempt succeeds.
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(2);

    // Confirmation poll succeeds.
    await vi.advanceTimersByTimeAsync(3000);
    const hash = await promise;
    expect(hash).toBe("HASH2");

    // The wallet was asked to sign exactly once — the same signed XDR is
    // resubmitted, so a retry can never create a duplicate operation.
    expect(mocks.signTransaction).toHaveBeenCalledTimes(1);
    expect(submissionRetryMetrics.getMetrics().recoveredAfterRetry).toBe(1);
  });

  test("applies the full 100ms / 500ms / 2s backoff across retries", async () => {
    setFreighter();
    mocks.sendTransaction
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }))
      .mockRejectedValueOnce({ status: 503, message: "Service Unavailable" })
      .mockResolvedValueOnce({ status: "PENDING", hash: "HASH3" });
    mocks.getTransaction.mockResolvedValueOnce({ status: "SUCCESS" });
    const onRetry = vi.fn();

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry });

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(3000);
    const hash = await promise;
    expect(hash).toBe("HASH3");
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map((c) => c[0].delayMs)).toEqual([100, 500, 2000]);
    expect(mocks.signTransaction).toHaveBeenCalledTimes(1);
  });

  test("permanent auth error fails fast without retry", async () => {
    setFreighter();
    mocks.sendTransaction.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }));
    const onRetry = vi.fn();

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry });
    // Attach the rejection handler BEFORE timers advance so the rejection
    // can never go unhandled.
    const assertion = expect(promise).rejects.toThrow("unauthorized");

    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  test("deterministic RPC rejection (ERROR result) fails fast without retry", async () => {
    setFreighter();
    mocks.sendTransaction.mockResolvedValueOnce({
      status: "ERROR",
      errorResult: "TX_BAD_SEQ: sequence number too old",
    });
    const onRetry = vi.fn();

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry });
    const assertion = expect(promise).rejects.toThrow(
      "Transaction submission failed: TX_BAD_SEQ: sequence number too old",
    );

    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
    expect(mocks.getTransaction).not.toHaveBeenCalled();
  });

  test("DUPLICATE on retry resolves with the hash (no double submission)", async () => {
    setFreighter();
    mocks.sendTransaction
      .mockRejectedValueOnce(new Error("Request timed out after 10000ms"))
      .mockResolvedValueOnce({ status: "DUPLICATE", hash: "LANDED" });
    mocks.getTransaction.mockResolvedValueOnce({ status: "SUCCESS" });

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(3000);

    const hash = await promise;
    expect(hash).toBe("LANDED");
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(2);
  });

  test("exhausts retries (4 attempts) and surfaces the last error", async () => {
    setFreighter();
    mocks.sendTransaction.mockRejectedValue(new Error("socket hang up"));
    const onRetry = vi.fn();

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet", { onRetry });
    const assertion = expect(promise).rejects.toThrow("socket hang up");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);

    await assertion;
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(4);
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(submissionRetryMetrics.getMetrics().failedAfterRetries).toBe(1);
  });

  test("transient RPC error while polling confirmation does not fail the submission", async () => {
    setFreighter();
    mocks.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "HASH4" });
    mocks.getTransaction
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ status: "SUCCESS" });

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet");

    await vi.advanceTimersByTimeAsync(0);
    // Poll 1 (t=3000): transient network error → keep polling.
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.getTransaction).toHaveBeenCalledTimes(1);
    // Poll 2 (t=6000): confirmed.
    await vi.advanceTimersByTimeAsync(3000);

    const hash = await promise;
    expect(hash).toBe("HASH4");
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test("permanent RPC error while polling confirmation throws", async () => {
    setFreighter();
    mocks.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "HASH5" });
    mocks.getTransaction.mockRejectedValueOnce(Object.assign(new Error("bad request"), { status: 400 }));

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet");
    const assertion = expect(promise).rejects.toThrow("bad request");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    await assertion;
  });

  test("on-chain FAILED status throws with the hash", async () => {
    setFreighter();
    mocks.sendTransaction.mockResolvedValueOnce({ status: "PENDING", hash: "HASH6" });
    mocks.getTransaction.mockResolvedValueOnce({ status: "FAILED" });

    const promise = signAndSubmitTransaction("unsigned-xdr", "testnet");
    const assertion = expect(promise).rejects.toThrow("Transaction failed on-chain: HASH6");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);

    await assertion;
  });

  test("throws when Freighter is not installed", async () => {
    delete (window as unknown as { freighter?: unknown }).freighter;

    await expect(signAndSubmitTransaction("unsigned-xdr", "testnet")).rejects.toThrow(
      "Freighter wallet not found",
    );
  });
});
