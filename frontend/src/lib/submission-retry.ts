/**
 * Retry strategy for transaction submission.
 *
 * A signed transaction submission can fail transiently (RPC timeout, network
 * hiccup, rate limit, gateway error). Retrying the *same signed transaction*
 * is safe: the Stellar network deduplicates by transaction hash, so a lost
 * response can never produce a double distribution — in the worst case the
 * retry is answered with `DUPLICATE`, which this module treats as
 * "already submitted" and continues with confirmation polling.
 *
 * Policy (per issue spec):
 *   - Up to 3 retries (4 attempts total)
 *   - Backoff between retries: 100ms → 500ms → 2s
 *   - Transient errors only: timeouts, network failures, rate limits,
 *     gateway/service errors (HTTP 408/429/5xx)
 *   - Permanent errors are NOT retried and fail fast: validation (400,
 *     malformed XDR), auth (401/403/404), and deterministic RPC rejections
 *     (`sendTransaction` resolving with status "ERROR").
 *
 * All retry attempts are logged with the classified reason and recorded in
 * `submissionRetryMetrics` (retry count + success rate).
 */

export interface SubmissionRetryPolicy {
  /** Maximum number of retries after the initial attempt (3 → 4 total attempts). */
  maxRetries: number;
  /** Delay before retry N (1-based) in ms: retry 1 → 100ms, retry 2 → 500ms, retry 3 → 2s. */
  delaysMs: number[];
}

export const SUBMISSION_RETRY_POLICY: SubmissionRetryPolicy = {
  maxRetries: 3,
  delaysMs: [100, 500, 2000],
};

/** Shape of a Soroban `sendTransaction` result (structural, SDK-compatible). */
export interface SendTransactionResult {
  status: "PENDING" | "ERROR" | "DUPLICATE";
  hash?: string;
  errorResult?: unknown;
}

/** Anything that can send a transaction (e.g. `SorobanRpc.Server`). */
export interface SendTransactionLike {
  sendTransaction(tx: unknown): Promise<SendTransactionResult>;
}

export interface SubmissionRetryInfo {
  /** The attempt that just failed (1-based; 1 = initial attempt). */
  attempt: number;
  /** Total number of attempts the policy allows (maxRetries + 1). */
  maxAttempts: number;
  /** Classified reason the attempt was considered transient. */
  reason: string;
  /** Delay in ms before the next attempt. */
  delayMs: number;
}

export interface SubmissionRetryOptions {
  /** Override the retry policy (defaults to SUBMISSION_RETRY_POLICY). */
  policy?: SubmissionRetryPolicy;
  /** Invoked before each retry so the UI can show a single "retrying…" state. */
  onRetry?: (info: SubmissionRetryInfo) => void;
  /** Injectable sleep for tests (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export interface TransientAnalysis {
  transient: boolean;
  reason: string;
}

// ── Error classification ─────────────────────────────────────────────────────

const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PERMANENT_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 413]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSIENT_ERROR_NAMES = new Set(["AbortError", "TimeoutError", "NetworkError"]);

const PERMANENT_MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/\binvalid\b|malformed|bad request/, "validation_error"],
  [/\bunauthorized\b|forbidden|bad auth/, "auth_error"],
  [/\bnot found\b|unknown contract|unknown account/, "resource_not_found"],
  [/\bbad sequence\b|sequence number|stale sequence/, "sequence_error"],
  [/\btx_failed\b|transaction failed|failed on-chain/, "on_chain_failure"],
];

const TRANSIENT_MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/timed out|timeout/, "rpc_timeout"],
  [/too many requests|rate limit|rate-limit/, "rate_limit"],
  [/temporarily unavailable|service unavailable|gateway timeout|bad gateway|internal server error/, "rpc_unavailable"],
  [
    /failed to fetch|fetch failed|network request failed|load failed|networkerror|network error|network socket disconnected/,
    "network_error",
  ],
  [
    /econnrefused|econnreset|eai_again|socket hang up|other side closed|socket closed|broken pipe|connection (reset|closed)/,
    "network_error",
  ],
];

function statusOf(error: unknown): number | null {
  if (error && typeof error === "object") {
    const anyErr = error as { status?: unknown; response?: { status?: unknown } };
    if (typeof anyErr.status === "number") return anyErr.status;
    if (anyErr.response && typeof anyErr.response.status === "number") return anyErr.response.status;
  }
  return null;
}

function messageOf(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message.toLowerCase();
  const anyErr = error as { message?: unknown; msg?: unknown };
  const raw = anyErr.message ?? anyErr.msg ?? (typeof error === "string" ? error : "");
  return String(raw).toLowerCase();
}

/**
 * Classify a submission error as transient (retry) or permanent (fail fast).
 *
 * Permanent conditions are checked first so they can never be misclassified
 * as transient. Unknown errors default to permanent: only clearly transient
 * failures (timeout / network / rate limit / gateway) are retried.
 */
export function isTransientSubmissionError(error: unknown): TransientAnalysis {
  if (!error) {
    return { transient: false, reason: "unknown_error" };
  }

  // 1) Permanent HTTP status codes (validation, auth, not found)
  const httpStatus = statusOf(error);
  if (httpStatus !== null && PERMANENT_HTTP_STATUS.has(httpStatus)) {
    return { transient: false, reason: `permanent_http_${httpStatus}` };
  }

  // 2) Permanent message patterns (checked before transient ones)
  const message = messageOf(error);
  for (const [pattern, reason] of PERMANENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return { transient: false, reason };
    }
  }

  // 3) Transient error names (fetch aborts, explicit timeouts)
  const name =
    error instanceof Error ? error.name : typeof (error as { name?: unknown })?.name === "string"
      ? ((error as { name?: string }).name as string)
      : "";
  if (name && TRANSIENT_ERROR_NAMES.has(name)) {
    return { transient: true, reason: `transient_${name.toLowerCase()}` };
  }

  // 4) Transient network error codes
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) {
    return { transient: true, reason: `network_${code}` };
  }

  // 5) Transient HTTP status codes (timeouts, rate limits, gateway errors)
  if (httpStatus !== null && TRANSIENT_HTTP_STATUS.has(httpStatus)) {
    return { transient: true, reason: `http_${httpStatus}` };
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return { transient: true, reason: `http_${httpStatus}` };
  }

  // 6) Transient message patterns (timeout / network / availability)
  for (const [pattern, reason] of TRANSIENT_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return { transient: true, reason };
    }
  }

  // 7) Unknown errors fail fast — never retry what we cannot classify.
  return { transient: false, reason: "unknown_error" };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * In-process metrics for the submission retry strategy:
 *   - retryAttempts:        total retry attempts executed (excludes initial)
 *   - recoveredAfterRetry:  submissions that succeeded after ≥1 retry
 *   - failedAfterRetries:   submissions that exhausted all retries
 *   - failedPermanent:      submissions that failed fast on a permanent error
 */
export const submissionRetryMetrics = {
  retryAttempts: 0,
  recoveredAfterRetry: 0,
  failedAfterRetries: 0,
  failedPermanent: 0,

  recordAttempt() {
    this.retryAttempts += 1;
  },

  recordSuccess() {
    this.recoveredAfterRetry += 1;
  },

  recordExhausted() {
    this.failedAfterRetries += 1;
  },

  recordPermanent() {
    this.failedPermanent += 1;
  },

  /**
   * Retry count and success rate. `retrySuccessRate` is the percentage of
   * retried submissions that ultimately succeeded (null when nothing has
   * been retried yet).
   */
  getMetrics() {
    const retriedOutcomes = this.recoveredAfterRetry + this.failedAfterRetries;
    return {
      totalRetryAttempts: this.retryAttempts,
      recoveredAfterRetry: this.recoveredAfterRetry,
      failedAfterRetries: this.failedAfterRetries,
      failedPermanent: this.failedPermanent,
      retrySuccessRate:
        retriedOutcomes > 0
          ? Number(((this.recoveredAfterRetry / retriedOutcomes) * 100).toFixed(2))
          : null,
    };
  },

  reset() {
    this.retryAttempts = 0;
    this.recoveredAfterRetry = 0;
    this.failedAfterRetries = 0;
    this.failedPermanent = 0;
  },
};

// ── Retry loop ───────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayForAttempt(attempt: number, policy: SubmissionRetryPolicy): number {
  const delays = policy.delaysMs;
  if (delays.length === 0) return 0;
  return delays[Math.min(attempt, delays.length) - 1];
}

function describeErrorResult(errorResult: unknown): string {
  try {
    return typeof errorResult === "string"
      ? errorResult
      : JSON.stringify(errorResult) ?? String(errorResult);
  } catch {
    return String(errorResult);
  }
}

/**
 * Submit a signed transaction, retrying only transient failures with
 * exponential backoff (100ms → 500ms → 2s, up to 3 retries).
 *
 * - `PENDING`  → resolves with the transaction hash.
 * - `DUPLICATE`→ resolves with the transaction hash (a previous attempt
 *                already landed — never a double spend).
 * - `ERROR`    → deterministic RPC rejection: throws immediately, no retry.
 * - thrown transient error (timeout/network/…) → retry with backoff.
 * - thrown permanent error (validation/auth/…) → throws immediately, no retry.
 *
 * Resubmitting the same signed transaction is safe: the network deduplicates
 * by hash, so retrying can never create a duplicate on-chain operation.
 */
export async function submitTransactionWithRetry(
  server: SendTransactionLike,
  tx: unknown,
  options: SubmissionRetryOptions = {},
): Promise<string> {
  const policy = options.policy ?? SUBMISSION_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = policy.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: SendTransactionResult;
    try {
      result = await server.sendTransaction(tx);
    } catch (error) {
      const analysis = isTransientSubmissionError(error);
      const isLastAttempt = attempt === maxAttempts;

      if (!analysis.transient) {
        // Permanent failure (validation, auth, unknown) — fail fast.
        submissionRetryMetrics.recordPermanent();
        console.warn(
          "[submission-retry] submission failed with a permanent error — not retrying",
          {
            event: "submission_retry_permanent",
            attempt,
            maxAttempts,
            reason: analysis.reason,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }

      if (isLastAttempt) {
        // All retries exhausted — surface the last transient error.
        submissionRetryMetrics.recordExhausted();
        console.error(
          "[submission-retry] submission still failing after exhausting retries",
          {
            event: "submission_retry_exhausted",
            attempt,
            maxAttempts,
            reason: analysis.reason,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw error;
      }

      const delayMs = delayForAttempt(attempt, policy);
      submissionRetryMetrics.recordAttempt();
      console.warn("[submission-retry] transient submission error — retrying", {
        event: "submission_retry_attempt",
        attempt,
        maxAttempts,
        reason: analysis.reason,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      options.onRetry?.({ attempt, maxAttempts, reason: analysis.reason, delayMs });
      await sleep(delayMs);
      continue;
    }

    if (result.status === "PENDING" || result.status === "DUPLICATE") {
      if (attempt > 1) {
        submissionRetryMetrics.recordSuccess();
        console.info("[submission-retry] submission succeeded after retry", {
          event: "submission_retry_success",
          attempt,
          maxAttempts,
          status: result.status,
        });
      }
      if (result.status === "DUPLICATE") {
        // The network already has this transaction — an earlier attempt
        // landed (its response was lost) or the client resubmitted. Continue
        // to confirmation polling instead of surfacing an error.
        console.warn("[submission-retry] transaction already known to the network (DUPLICATE) — continuing", {
          event: "submission_duplicate",
          attempt,
          maxAttempts,
        });
      }
      return result.hash as string;
    }

    // `ERROR` — deterministic rejection (validation, fee, sequence, contract
    // error). Resubmitting the identical signed XDR cannot fix it: fail fast.
    submissionRetryMetrics.recordPermanent();
    console.warn("[submission-retry] deterministic RPC rejection — not retrying", {
      event: "submission_rpc_error_result",
      attempt,
      maxAttempts,
      errorResult: describeErrorResult(result.errorResult),
    });
    throw new Error(
      `Transaction submission failed: ${describeErrorResult(result.errorResult)}`,
    );
  }

  // Unreachable — the loop always returns or throws.
  throw new Error("submitTransactionWithRetry: unreachable state");
}
