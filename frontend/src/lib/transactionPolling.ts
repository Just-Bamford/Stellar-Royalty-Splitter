/**
 * Transaction confirmation polling (#414)
 *
 * A framework-agnostic loop that polls a backend transaction-status endpoint
 * until the transaction settles (confirmed / failed), the caller aborts, or a
 * timeout is reached. Kept free of React so it can be unit-tested with fake
 * timers and reused by the WebSocket fallback.
 *
 * Behaviour required by the issue:
 * - Poll every 5s by default.
 * - Stop on confirmation or after a 60s timeout.
 * - Cancel cleanly via an AbortSignal (the hook aborts on unmount).
 * - Exponential backoff after consecutive failures so a flaky backend is not
 *   hammered with retries.
 */

/** Status values the backend reports for a transaction. */
export type TxStatus = "pending" | "confirmed" | "failed";

/** A status read may also come back as "not_found" before the row is written. */
export type PolledStatus = TxStatus | "not_found";

/** Terminal result of a polling run. */
export type PollOutcome = "confirmed" | "failed" | "timeout" | "aborted";

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;

export interface PollTransactionStatusOptions {
  /** Reads the current status. Receives a signal so the request can be aborted. */
  fetchStatus: (signal: AbortSignal) => Promise<PolledStatus>;
  /** Aborts the run (e.g. component unmount). */
  signal?: AbortSignal;
  /** Base interval between polls. Default 5000ms. */
  intervalMs?: number;
  /** Maximum total time before giving up. Default 60000ms. */
  timeoutMs?: number;
  /** Cap on the backoff delay between failed polls. Default 30000ms. */
  maxBackoffMs?: number;
  /** Called after every successful status read, for real-time UI updates. */
  onUpdate?: (status: PolledStatus) => void;
  /** Called when a poll request throws (network/backend error). */
  onError?: (error: unknown, consecutiveFailures: number) => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Promise-based delay that rejects with an AbortError when the signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort);
  });
}

/**
 * Polls `fetchStatus` until the transaction reaches a terminal state, the
 * caller aborts, or the timeout elapses. Resolves with the outcome rather than
 * throwing, so callers can switch on the result.
 */
export async function pollTransactionStatus(
  options: PollTransactionStatusOptions,
): Promise<PollOutcome> {
  const {
    fetchStatus,
    signal,
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    onUpdate,
    onError,
  } = options;

  // A real signal for fetchStatus even when the caller passed none.
  const effectiveSignal = signal ?? new AbortController().signal;
  const start = Date.now();
  let consecutiveFailures = 0;

  while (true) {
    if (signal?.aborted) return "aborted";
    if (Date.now() - start >= timeoutMs) return "timeout";

    try {
      const status = await fetchStatus(effectiveSignal);
      consecutiveFailures = 0;
      onUpdate?.(status);
      if (status === "confirmed") return "confirmed";
      if (status === "failed") return "failed";
      // "pending" / "not_found" → keep polling.
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return "aborted";
      consecutiveFailures += 1;
      onError?.(error, consecutiveFailures);
    }

    // Exponential backoff while the backend is failing; steady interval
    // otherwise. Never sleep past the overall timeout deadline.
    const backoff =
      consecutiveFailures > 0
        ? Math.min(intervalMs * 2 ** (consecutiveFailures - 1), maxBackoffMs)
        : intervalMs;
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) return "timeout";

    try {
      await delay(Math.min(backoff, remaining), signal);
    } catch {
      return "aborted";
    }
  }
}
