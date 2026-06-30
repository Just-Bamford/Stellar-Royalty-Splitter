/**
 * Distribution retry + circuit breaker (#502)
 *
 * A network hiccup while building/submitting a distribution should not force the
 * user to resubmit by hand (which risks a duplicate). This wraps the transient
 * network step in exponential backoff (1s, 2s, 4s, …) via {@link retryWithBackoff}
 * and adds two things that util deliberately leaves out:
 *
 *  - a circuit breaker that "opens" after a run of failed operations so we stop
 *    hammering a backend that is clearly down, and
 *  - lightweight success-rate metrics for observability.
 *
 * Retries are bounded (MAX_RETRIES) and abortable via an AbortSignal so an
 * unmount or manual cancel tears the loop down immediately.
 */

import { retryWithBackoff } from "./retryWithBackoff";

export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 1_000;

export interface RetryMetrics {
  /** Total individual retry attempts performed (across all operations). */
  attempts: number;
  /** Operations that ultimately succeeded. */
  successes: number;
  /** Operations that ultimately failed after exhausting retries. */
  failures: number;
}

const metrics: RetryMetrics = { attempts: 0, successes: 0, failures: 0 };

/** Snapshot of retry metrics including a derived success rate in [0, 1]. */
export function getRetryMetrics(): RetryMetrics & { successRate: number } {
  const total = metrics.successes + metrics.failures;
  return {
    ...metrics,
    successRate: total === 0 ? 1 : metrics.successes / total,
  };
}

export function resetRetryMetrics(): void {
  metrics.attempts = 0;
  metrics.successes = 0;
  metrics.failures = 0;
}

// Circuit breaker: trips once we see MAX_RETRIES consecutive failed operations.
let consecutiveFailures = 0;

export function isCircuitOpen(threshold = MAX_RETRIES): boolean {
  return consecutiveFailures >= threshold;
}

export function resetCircuit(): void {
  consecutiveFailures = 0;
}

/**
 * A failure is worth retrying only if it's transient: a network/connection error
 * (no HTTP status) or a server-side 5xx. Deterministic 4xx responses (validation,
 * not-found, conflict) will never succeed on retry, so we fail fast on those.
 */
export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    return status >= 500;
  }
  return true;
}

export class CircuitOpenError extends Error {
  constructor() {
    super("Too many failed attempts. Please wait a moment and try again.");
    this.name = "CircuitOpenError";
  }
}

interface RunOptions {
  signal?: AbortSignal;
  /** Called before each backoff sleep so the UI can show a countdown. */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Runs `fn` with bounded exponential backoff and circuit-breaker protection.
 * Resolves with the first success; rejects with {@link CircuitOpenError} when the
 * breaker is open, or the last error once retries are exhausted.
 */
export async function runWithDistributionRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RunOptions = {},
): Promise<T> {
  if (isCircuitOpen()) {
    throw new CircuitOpenError();
  }

  try {
    const result = await retryWithBackoff(fn, {
      retries: MAX_RETRIES,
      baseDelayMs: BASE_DELAY_MS,
      signal: options.signal,
      shouldRetry: isTransientError,
      onRetry: (attempt, delayMs, error) => {
        metrics.attempts += 1;
        options.onRetry?.(attempt, delayMs, error);
      },
    });
    metrics.successes += 1;
    consecutiveFailures = 0;
    return result;
  } catch (error) {
    // An abort is a user/lifecycle cancel, not a backend failure — don't trip
    // the breaker or count it against the success rate.
    if (!(error instanceof Error && error.name === "AbortError")) {
      metrics.failures += 1;
      consecutiveFailures += 1;
    }
    throw error;
  }
}
