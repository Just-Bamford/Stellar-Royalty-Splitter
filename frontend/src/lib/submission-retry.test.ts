/**
 * Tests for the transaction-submission retry strategy.
 *
 * Acceptance criteria covered:
 *   - Submissions are retried on transient failures (timeout, network)
 *   - Exponential backoff implemented correctly: 100ms → 500ms → 2s
 *   - Permanent errors (validation, auth, deterministic RPC rejection) are
 *     NOT retried and fail fast
 *   - Metrics: retry count and success rate
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  SUBMISSION_RETRY_POLICY,
  isTransientSubmissionError,
  submitTransactionWithRetry,
  submissionRetryMetrics,
  type SendTransactionLike,
  type SendTransactionResult,
} from "./submission-retry";

const FAST = { maxRetries: 3, delaysMs: [100, 500, 2000] };

function makeServer(script: Array<SendTransactionResult | (() => never)>): {
  server: SendTransactionLike;
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  const sendTransaction = vi.fn();
  script.forEach((step, i) => {
    if (typeof step === "function") {
      sendTransaction.mockImplementationOnce(step);
    } else {
      sendTransaction.mockResolvedValueOnce(step);
    }
  });
  return { server: { sendTransaction }, sendTransaction };
}

const rejects =
  (error: unknown) =>
  () =>
    Promise.reject(error);

describe("SUBMISSION_RETRY_POLICY", () => {
  test("retries up to 3 times with 100ms / 500ms / 2s backoff", () => {
    expect(SUBMISSION_RETRY_POLICY.maxRetries).toBe(3);
    expect(SUBMISSION_RETRY_POLICY.delaysMs).toEqual([100, 500, 2000]);
  });
});

describe("isTransientSubmissionError", () => {
  describe("transient errors (retried)", () => {
    test("fetch network failure (TypeError: Failed to fetch)", () => {
      const result = isTransientSubmissionError(new TypeError("Failed to fetch"));
      expect(result.transient).toBe(true);
      expect(result.reason).toBe("network_error");
    });

    test("explicit timeout messages", () => {
      expect(
        isTransientSubmissionError(new Error("Request timed out after 10000ms")).transient,
      ).toBe(true);
      expect(isTransientSubmissionError({ message: "timeout" }).transient).toBe(true);
      expect(isTransientSubmissionError(new Error("socket timed out")).transient).toBe(true);
    });

    test("network error codes", () => {
      for (const code of ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"]) {
        const result = isTransientSubmissionError(Object.assign(new Error("net"), { code }));
        expect(result.transient).toBe(true);
        expect(result.reason).toBe(`network_${code}`);
      }
    });

    test("abort / timeout error names", () => {
      const abort = new DOMException("The operation was aborted.", "AbortError");
      expect(isTransientSubmissionError(abort).transient).toBe(true);
      const timeoutErr = Object.assign(new Error("aborted"), { name: "TimeoutError" });
      expect(isTransientSubmissionError(timeoutErr).transient).toBe(true);
    });

    test("transient HTTP status codes (408, 429, 5xx)", () => {
      expect(isTransientSubmissionError({ status: 408 }).transient).toBe(true);
      expect(isTransientSubmissionError({ status: 429 }).transient).toBe(true);
      expect(isTransientSubmissionError({ status: 500 }).transient).toBe(true);
      expect(isTransientSubmissionError({ status: 502 }).transient).toBe(true);
      expect(isTransientSubmissionError({ status: 503 }).transient).toBe(true);
      expect(isTransientSubmissionError({ status: 504 }).transient).toBe(true);
      expect(isTransientSubmissionError({ response: { status: 504 } }).transient).toBe(true);
    });

    test("rate limit messages", () => {
      expect(isTransientSubmissionError(new Error("429 Too Many Requests")).transient).toBe(true);
      expect(isTransientSubmissionError(new Error("rate limit exceeded")).transient).toBe(true);
    });

    test("gateway / availability messages", () => {
      expect(isTransientSubmissionError(new Error("Bad Gateway")).transient).toBe(true);
      expect(isTransientSubmissionError(new Error("Service Unavailable")).transient).toBe(true);
    });

    test("socket-level messages", () => {
      expect(isTransientSubmissionError(new Error("socket hang up")).transient).toBe(true);
      expect(isTransientSubmissionError(new Error("other side closed")).transient).toBe(true);
    });
  });

  describe("permanent errors (NOT retried)", () => {
    test("validation errors (400 / invalid / malformed)", () => {
      expect(isTransientSubmissionError({ status: 400 }).transient).toBe(false);
      expect(isTransientSubmissionError(new Error("Invalid XDR payload")).transient).toBe(false);
      expect(isTransientSubmissionError(new Error("Malformed request body")).transient).toBe(false);
    });

    test("auth errors (401 / 403 / unauthorized / forbidden)", () => {
      expect(isTransientSubmissionError({ status: 401 }).transient).toBe(false);
      expect(isTransientSubmissionError({ status: 403 }).transient).toBe(false);
      expect(isTransientSubmissionError(new Error("unauthorized")).transient).toBe(false);
      expect(isTransientSubmissionError(new Error("forbidden")).transient).toBe(false);
      expect(isTransientSubmissionError(new Error("Bad auth: invalid signature")).transient).toBe(false);
    });

    test("not-found errors (404)", () => {
      expect(isTransientSubmissionError({ status: 404 }).transient).toBe(false);
    });

    test("on-chain / sequence failures are permanent", () => {
      expect(
        isTransientSubmissionError(new Error("Transaction failed on-chain: BAD_SEQUENCE")).transient,
      ).toBe(false);
      expect(
        isTransientSubmissionError(new Error("Soroban RPC returned: TX_FAILED")).transient,
      ).toBe(false);
    });

    test("unknown errors default to permanent (fail fast)", () => {
      expect(isTransientSubmissionError(new Error("something weird happened")).transient).toBe(false);
      expect(isTransientSubmissionError(null).transient).toBe(false);
      expect(isTransientSubmissionError({}).transient).toBe(false);
    });
  });

  describe("precedence: permanent wins over transient-looking signals", () => {
    test("401 is permanent even when the message mentions a timeout", () => {
      const result = isTransientSubmissionError(new Error("unauthorized (request timed out)"));
      expect(result.transient).toBe(false);
    });

    test("invalid XDR is permanent even with a network-sounding suffix", () => {
      const result = isTransientSubmissionError(new Error("Invalid XDR (network response)"));
      expect(result.transient).toBe(false);
    });
  });
});

describe("submitTransactionWithRetry", () => {
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    submissionRetryMetrics.reset();
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  const o = (extra: Record<string, unknown> = {}) => ({ sleep, ...extra });

  describe("success paths", () => {
    test("resolves hash on first attempt — no retries, no onRetry", async () => {
      const { server, sendTransaction } = makeServer([{ status: "PENDING", hash: "abc123" }]);
      const onRetry = vi.fn();

      const hash = await submitTransactionWithRetry(server, "tx", o({ onRetry }));

      expect(hash).toBe("abc123");
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
      expect(submissionRetryMetrics.getMetrics().totalRetryAttempts).toBe(0);
    });

    test("treats DUPLICATE as success (transaction already landed)", async () => {
      const { server } = makeServer([{ status: "DUPLICATE", hash: "dup999" }]);

      const hash = await submitTransactionWithRetry(server, "tx", o());

      expect(hash).toBe("dup999");
      expect(submissionRetryMetrics.getMetrics().failedPermanent).toBe(0);
    });
  });

  describe("transient failures are retried", () => {
    test("retries a network failure and succeeds on attempt 2 (100ms backoff)", async () => {
      const { server, sendTransaction } = makeServer([
        rejects(new TypeError("Failed to fetch")),
        { status: "PENDING", hash: "h2" },
      ]);
      const onRetry = vi.fn();

      const hash = await submitTransactionWithRetry(server, "tx", o({ onRetry }));

      expect(hash).toBe("h2");
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry.mock.calls[0][0]).toMatchObject({
        attempt: 1,
        maxAttempts: 4,
        reason: "network_error",
        delayMs: 100,
      });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(100);
    });

    test("applies the full backoff schedule 100ms → 500ms → 2s", async () => {
      const { server, sendTransaction } = makeServer([
        rejects(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" })),
        rejects(new Error("socket hang up")),
        rejects(new Error("Bad Gateway")),
        { status: "PENDING", hash: "h4" },
      ]);

      const hash = await submitTransactionWithRetry(server, "tx", o());

      expect(hash).toBe("h4");
      expect(sendTransaction).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls).toEqual([[100], [500], [2000]]);
    });

    test("retries timeout and rate-limit errors", async () => {
      const { server, sendTransaction } = makeServer([
        rejects({ status: 504, message: "gateway timeout" }),
        rejects({ status: 429, message: "too many requests" }),
        { status: "PENDING", hash: "ok" },
      ]);

      await submitTransactionWithRetry(server, "tx", o());

      expect(sendTransaction).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[100], [500]]);
    });

    test("recovers via DUPLICATE after a lost-response timeout", async () => {
      const { server, sendTransaction } = makeServer([
        rejects(new Error("Request timed out after 10000ms")),
        { status: "DUPLICATE", hash: "landed" },
      ]);

      const hash = await submitTransactionWithRetry(server, "tx", o());

      expect(hash).toBe("landed");
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      const metrics = submissionRetryMetrics.getMetrics();
      expect(metrics.recoveredAfterRetry).toBe(1);
    });
  });

  describe("permanent failures fail fast", () => {
    test("validation error (400) is not retried", async () => {
      const { server, sendTransaction } = makeServer([rejects({ status: 400, message: "bad request" })]);
      const onRetry = vi.fn();

      await expect(submitTransactionWithRetry(server, "tx", o({ onRetry }))).rejects.toEqual(
        expect.objectContaining({ status: 400 }),
      );

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(onRetry).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    });

    test("auth error (401) is not retried", async () => {
      const { server, sendTransaction } = makeServer([rejects(new Error("unauthorized"))]);

      await expect(submitTransactionWithRetry(server, "tx", o())).rejects.toThrow("unauthorized");

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    test("malformed XDR / validation message is not retried", async () => {
      const { server, sendTransaction } = makeServer([rejects(new Error("Invalid XDR payload"))]);

      await expect(submitTransactionWithRetry(server, "tx", o())).rejects.toThrow("Invalid XDR payload");

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(submissionRetryMetrics.getMetrics().failedPermanent).toBe(1);
    });

    test("deterministic RPC rejection (ERROR result) is not retried", async () => {
      const { server, sendTransaction } = makeServer([
        { status: "ERROR", errorResult: "TX_FAILED: internal error" },
      ]);

      await expect(submitTransactionWithRetry(server, "tx", o())).rejects.toThrow(
        "Transaction submission failed: TX_FAILED: internal error",
      );

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(submissionRetryMetrics.getMetrics().failedPermanent).toBe(1);
    });

    test("unknown error is not retried", async () => {
      const { server, sendTransaction } = makeServer([rejects(new Error("mystery failure"))]);

      await expect(submitTransactionWithRetry(server, "tx", o())).rejects.toThrow("mystery failure");

      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(submissionRetryMetrics.getMetrics().failedPermanent).toBe(1);
    });
  });

  describe("retry exhaustion", () => {
    test("gives up after 3 retries (4 attempts) and throws the last error", async () => {
      const lastError = new Error("socket hang up");
      const { server, sendTransaction } = makeServer([
        rejects(new Error("socket hang up")),
        rejects(new Error("socket hang up")),
        rejects(new Error("socket hang up")),
        rejects(lastError),
      ]);
      const onRetry = vi.fn();

      await expect(submitTransactionWithRetry(server, "tx", o({ onRetry }))).rejects.toBe(
        lastError,
      );

      expect(sendTransaction).toHaveBeenCalledTimes(4);
      expect(onRetry).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[100], [500], [2000]]);
      const metrics = submissionRetryMetrics.getMetrics();
      expect(metrics.failedAfterRetries).toBe(1);
      expect(metrics.totalRetryAttempts).toBe(3);
    });
  });

  describe("metrics (retry count and success rate)", () => {
    test("records attempts, recoveries, and success rate", async () => {
      // Op 1: fails once, recovers. Op 2: fails twice, recovers.
      const { server: s1 } = makeServer([rejects(new Error("network error")), { status: "PENDING", hash: "a" }]);
      const { server: s2 } = makeServer([
        rejects(new Error("network error")),
        rejects(new Error("network error")),
        { status: "PENDING", hash: "b" },
      ]);
      await submitTransactionWithRetry(s1, "tx", o());
      await submitTransactionWithRetry(s2, "tx", o());

      const metrics = submissionRetryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(3);
      expect(metrics.recoveredAfterRetry).toBe(2);
      expect(metrics.retrySuccessRate).toBe(100);
    });

    test("success rate drops when a retried submission exhausts its retries", async () => {
      // Op 1: recovers after one retry.
      const { server: s1 } = makeServer([rejects(new Error("network error")), { status: "PENDING", hash: "a" }]);
      // Op 2: exhausts all retries.
      const { server: s2 } = makeServer([
        rejects(new Error("network error")),
        rejects(new Error("network error")),
        rejects(new Error("network error")),
        rejects(new Error("network error")),
      ]);
      await submitTransactionWithRetry(s1, "tx", o());
      await expect(submitTransactionWithRetry(s2, "tx", o())).rejects.toThrow("network error");

      const metrics = submissionRetryMetrics.getMetrics();
      expect(metrics.recoveredAfterRetry).toBe(1);
      expect(metrics.failedAfterRetries).toBe(1);
      expect(metrics.retrySuccessRate).toBe(50);
    });

    test("permanent failures do not count as retry attempts", async () => {
      const { server } = makeServer([rejects({ status: 400 })]);
      await expect(submitTransactionWithRetry(server, "tx", o())).rejects.toBeDefined();

      const metrics = submissionRetryMetrics.getMetrics();
      expect(metrics.totalRetryAttempts).toBe(0);
      expect(metrics.failedPermanent).toBe(1);
      expect(metrics.retrySuccessRate).toBeNull();
    });
  });

  describe("custom policy", () => {
    test("honors a custom policy (fewer retries, custom delays)", async () => {
      const { server, sendTransaction } = makeServer([
        rejects(new Error("network error")),
        rejects(new Error("network error")),
      ]);

      await expect(
        submitTransactionWithRetry(server, "tx", {
          policy: { maxRetries: 1, delaysMs: [10] },
          sleep,
        }),
      ).rejects.toThrow("network error");

      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sleep.mock.calls).toEqual([[10]]);
    });
  });
});
