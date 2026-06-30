/**
 * Retry with exponential backoff + jitter (#412)
 *
 * Wraps a flaky async operation (e.g. a Freighter wallet connection that fails
 * on an RPC hiccup) and retries it a bounded number of times with exponentially
 * growing delays. Jitter spreads retries out so concurrent clients don't
 * synchronise. Kept framework-agnostic so it can be unit-tested with fake
 * timers and reused beyond the wallet flow.
 *
 * Defaults: 3 retries with ~1s, ~2s, ~4s delays (4 attempts total).
 */

export const DEFAULT_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_FACTOR = 2;

export interface RetryOptions {
  /** Max retries after the initial attempt. Default 3. */
  retries?: number;
  /** Delay before the first retry. Default 1000ms. */
  baseDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /** Apply jitter to each delay. Default true. */
  jitter?: boolean;
  /** Cancels the retry loop (e.g. component unmount / manual disconnect). */
  signal?: AbortSignal;
  /** Called before each retry sleep, for "Reconnecting…" UI. attempt is 1-based. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  /**
   * Decides whether a given error is worth retrying. Returning false stops the
   * loop immediately and rejects with that error (e.g. a deterministic 4xx that
   * will never succeed on retry). Defaults to retrying every error.
   */
  shouldRetry?: (error: unknown) => boolean;
  /** Injectable RNG for deterministic tests. Default Math.random. */
  random?: () => number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Computes the delay before retry `attempt` (1-based). With jitter, uses
 * "equal jitter": half the exponential delay plus a random share of the other
 * half — so the value stays in [raw/2, raw] and never collapses to zero.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  factor = DEFAULT_FACTOR,
  jitter = true,
  random: () => number = Math.random,
): number {
  const raw = baseDelayMs * factor ** (attempt - 1);
  if (!jitter) return raw;
  return Math.round(raw / 2 + random() * (raw / 2));
}

/** Promise delay that rejects with an AbortError when the signal fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
 * Runs `fn`, retrying on rejection up to `retries` times with exponential
 * backoff. Resolves with the first success; rejects with the last error once
 * retries are exhausted, or with an AbortError if the signal fires.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = DEFAULT_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    factor = DEFAULT_FACTOR,
    jitter = true,
    signal,
    onRetry,
    shouldRetry,
    random = Math.random,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (signal?.aborted || isAbortError(error)) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (shouldRetry && !shouldRetry(error)) break; // non-retryable
      if (attempt === retries) break; // out of retries
      const delayMs = backoffDelay(attempt + 1, baseDelayMs, factor, jitter, random);
      onRetry?.(attempt + 1, delayMs, error);
      await sleep(delayMs, signal);
    }
  }
  throw lastError;
}
