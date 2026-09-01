/**
 * Centralized retry strategy for transient Stellar RPC failures.
 *
 * Purpose:
 *   - Distinguishes transient failures (network errors, timeouts, rate limits)
 *     from permanent failures (invalid requests, contract errors, auth failures)
 *   - Applies configurable bounded retries with exponential backoff
 *   - Logs retry attempts safely without exposing sensitive data
 *   - Provides metrics for monitoring retry behavior
 *
 * Design Principles:
 *   - NEVER retry transaction submission (causes duplicate operations)
 *   - Only retry truly transient errors
 *   - Use exponential backoff to prevent overwhelming the server
 *   - Log safely without exposing sensitive wallet/contract data
 *   - Allow per-operation customization of retry behavior
 *
 * Transient Failures (retried):
 *   - HTTP 408 (Request Timeout)
 *   - HTTP 429 (Rate Limit)
 *   - HTTP 503 (Service Unavailable)
 *   - HTTP 504 (Gateway Timeout)
 *   - Network errors (ENOTFOUND, ECONNREFUSED, ETIMEDOUT)
 *   - Timeout errors from withTimeout wrapper
 *   - RPC server errors without result codes
 *
 * Permanent Failures (NOT retried):
 *   - HTTP 400 (Bad Request)
 *   - HTTP 401 (Unauthorized)
 *   - HTTP 403 (Forbidden)
 *   - HTTP 404 (Not Found)
 *   - Simulation errors (contract logic failures)
 *   - Invalid XDR or malformed requests
 *   - Account not found errors (caller doesn't exist on network)
 *
 * Special Cases:
 *   - Transaction submission: Never automatically retry (would create duplicates)
 *   - Rate limits: Retry with aggressive backoff
 *   - Sequence number mismatches: Caller should rebuild, not retry
 *
 * Configuration:
 *   RPC_MAX_RETRIES (default 3)
 *   RPC_BASE_BACKOFF_MS (default 1000)
 *   RPC_MAX_BACKOFF_MS (default 30000)
 */

import logger from "./logger.js";
import { recordRpcRetry } from "./metrics.js";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;

/**
 * Configuration for retry behavior.
 */
export const retryConfig = {
  maxRetries: parseInt(process.env.RPC_MAX_RETRIES, 10) || DEFAULT_MAX_RETRIES,
  baseBackoffMs: parseInt(process.env.RPC_BASE_BACKOFF_MS, 10) || DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs: parseInt(process.env.RPC_MAX_BACKOFF_MS, 10) || 30_000,
};

/**
 * Determine if an error is transient and worth retrying.
 * Returns { isTransient: boolean, reason: string, category: string }
 */
export function isTransientError(error, _operationType = "unknown") {
  if (!error) {
    return {
      isTransient: false,
      reason: "unknown_error",
      category: "invalid",
      retryable: false,
    };
  }

  // Check error message patterns
  const errorMsg = (error?.message ?? error?.msg ?? "").toLowerCase();

  // Simulation errors (contract logic failures) - never retry (CHECK FIRST - more specific)
  if (
    errorMsg.includes("simulation") ||
    errorMsg.includes("contract") ||
    errorMsg.includes("invocation")
  ) {
    return {
      isTransient: false,
      reason: "simulation_error",
      category: "contract_error",
      retryable: false,
    };
  }

  // Account not found - never retry (CHECK BEFORE generic timeout - more specific)
  if (errorMsg.includes("account not found")) {
    return {
      isTransient: false,
      reason: "account_not_found",
      category: "account_error",
      retryable: false,
    };
  }

  // HTTP status codes
  const httpStatus = error?.response?.status ?? error?.status;

  // Explicitly transient HTTP statuses
  if (httpStatus === 429) {
    return {
      isTransient: true,
      reason: "rate_limit",
      category: "http_429",
      retryable: true,
    };
  }

  if (httpStatus === 503) {
    return {
      isTransient: true,
      reason: "service_unavailable",
      category: "http_503",
      retryable: true,
    };
  }

  if (httpStatus === 504) {
    return {
      isTransient: true,
      reason: "gateway_timeout",
      category: "http_504",
      retryable: true,
    };
  }

  if (httpStatus === 408) {
    return {
      isTransient: true,
      reason: "request_timeout",
      category: "http_408",
      retryable: true,
    };
  }

  // Permanent HTTP errors - never retry
  if (httpStatus === 400 || httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
    return {
      isTransient: false,
      reason: "permanent_client_error",
      category: `http_${httpStatus}`,
      retryable: false,
    };
  }

  // Network errors - transient
  const errorCode = error?.code ?? error?.errno;
  const networkErrors = ["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH"];
  if (networkErrors.includes(errorCode)) {
    return {
      isTransient: true,
      reason: "network_error",
      category: `network_${errorCode}`,
      retryable: true,
    };
  }

  // Generic network/timeout messages - transient (CHECK LAST - less specific)
  if (
    errorMsg.includes("timed out") ||
    errorMsg.includes("timeout") ||
    errorMsg.includes("network") ||
    errorMsg.includes("econnrefused")
  ) {
    return {
      isTransient: true,
      reason: "network_error_from_message",
      category: "network_error",
      retryable: true,
    };
  }

  // Unknown errors - don't retry by default
  return {
    isTransient: false,
    reason: "unknown_error",
    category: "unknown",
    retryable: false,
  };
}

/**
 * Calculate exponential backoff delay with jitter.
 * Ensures retries don't all happen at the same time.
 */
export function getBackoffDelay(attemptNumber, config = retryConfig) {
  // exponential: baseBackoffMs * 2^(attemptNumber - 1)
  const exponentialDelay = config.baseBackoffMs * Math.pow(2, attemptNumber - 1);

  // Cap at maxBackoffMs
  const cappedDelay = Math.min(exponentialDelay, config.maxBackoffMs);

  // Add jitter: ±10% randomness, but cap result at maxBackoffMs
  const jitterFactor = 0.9 + Math.random() * 0.2;
  const delayWithJitter = Math.round(cappedDelay * jitterFactor);

  // Ensure we never exceed max backoff even with jitter
  return Math.min(delayWithJitter, config.maxBackoffMs);
}

/**
 * Log a retry attempt with safe, non-sensitive information.
 */
export function logRetryAttempt({
  attemptNumber,
  totalAttempts,
  operationType,
  error,
  delayMs,
  details = {},
}) {
  const errorInfo = isTransientError(error, operationType);

  logger.warn(`RPC operation retrying after transient error`, {
    event: "rpc_retry_attempt",
    operationType,
    attemptNumber,
    totalAttempts,
    errorReason: errorInfo.reason,
    errorCategory: errorInfo.category,
    nextRetryDelayMs: delayMs,
    // Safe fields only - no sensitive data
    ...details,
  });
}

/**
 * Log retry exhaustion (all retries failed).
 */
export function logRetryExhausted({ operationType, totalAttempts, lastError, details = {} }) {
  const errorInfo = isTransientError(lastError, operationType);

  logger.error(`RPC operation failed after exhausting all retry attempts`, {
    event: "rpc_retry_exhausted",
    operationType,
    totalAttempts,
    errorReason: errorInfo.reason,
    errorCategory: errorInfo.category,
    // Safe fields only
    ...details,
  });
}

/**
 * Log successful retry (operation succeeded after initial failure).
 */
export function logRetrySuccess({ operationType, attemptNumber, details = {} }) {
  logger.info(`RPC operation succeeded after retry`, {
    event: "rpc_retry_success",
    operationType,
    successfulAttempt: attemptNumber,
    ...details,
  });
}

/**
 * Retry-wrapped RPC operation with exponential backoff.
 *
 * Usage:
 *   const result = await withRetry(
 *     () => server.getAccount(address),
 *     { operationType: "getAccount", walletAddress: address }
 *   );
 *
 * Never retries transaction submission to prevent duplicate operations.
 */
export async function withRetry(operation, options = {}) {
  const {
    operationType = "unknown",
    maxRetries = retryConfig.maxRetries,
    baseBackoffMs = retryConfig.baseBackoffMs,
    shouldRetry = null, // Custom retry predicate (overrides isTransientError if provided)
    details = {},
  } = options;

  // Per-call backoff base (falls back to the global config). Previously this
  // option was destructured as `_baseBackoffMs` and silently ignored.
  const effectiveBackoff = Number.isFinite(baseBackoffMs) && baseBackoffMs > 0
    ? baseBackoffMs
    : retryConfig.baseBackoffMs;
  const backoffConfig = {
    baseBackoffMs: effectiveBackoff,
    maxBackoffMs: retryConfig.maxBackoffMs,
  };

  // Prevent accidental retries of transaction submission
  if (operationType === "submitTransaction" || operationType === "submit") {
    logger.warn(
      `Skipping retry wrapper for ${operationType} — submission should never be automatically retried to prevent duplicate operations`,
      { operationType, ...details }
    );
    return operation();
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();

      // Log success if this was a retry
      if (attempt > 1) {
        logRetrySuccess({
          operationType,
          attemptNumber: attempt,
          details,
        });
        // Metrics: this operation recovered after at least one retry.
        retryMetrics.recordSuccess();
        recordRpcRetry(operationType, "success");
      }

      return result;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === maxRetries;

      // Determine if error is retryable
      const customRetryDecision = shouldRetry !== null ? shouldRetry(error, attempt) : null;
      const errorAnalysis = isTransientError(error, operationType);
      const shouldRetryThis =
        customRetryDecision !== null ? customRetryDecision : errorAnalysis.isTransient;

      // If not retryable or last attempt, throw
      if (!shouldRetryThis || isLastAttempt) {
        if (attempt > 1 && errorAnalysis.isTransient) {
          logRetryExhausted({
            operationType,
            totalAttempts: maxRetries,
            lastError: error,
            details,
          });
          // Metrics: all retry attempts were consumed without recovery.
          retryMetrics.recordExhausted();
          recordRpcRetry(operationType, "exhausted");
        }
        throw error;
      }

      // Calculate backoff and retry
      const delayMs = getBackoffDelay(attempt, backoffConfig);

      logRetryAttempt({
        attemptNumber: attempt,
        totalAttempts: maxRetries,
        operationType,
        error,
        delayMs,
        details,
      });

      // Metrics: one retry attempt is about to be executed.
      retryMetrics.recordAttempt();
      recordRpcRetry(operationType, "attempt");

      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // This should never be reached, but fail safely
  if (lastError) throw lastError;
  throw new Error(`${operationType} failed for unknown reason`);
}

/**
 * Get retry metrics from logs (for monitoring).
 * In production, this would pull from a structured log aggregator.
 */
export const retryMetrics = {
  retryAttempts: 0,
  retrySuccesses: 0,
  retryExhausted: 0,

  recordAttempt() {
    this.retryAttempts += 1;
  },

  recordSuccess() {
    this.retrySuccesses += 1;
  },

  recordExhausted() {
    this.retryExhausted += 1;
  },

  getMetrics() {
    return {
      totalRetryAttempts: this.retryAttempts,
      successfulRetries: this.retrySuccesses,
      exhaustedRetries: this.retryExhausted,
      successRate:
        this.retryAttempts > 0 ? ((this.retrySuccesses / this.retryAttempts) * 100).toFixed(2) : 0,
    };
  },

  reset() {
    this.retryAttempts = 0;
    this.retrySuccesses = 0;
    this.retryExhausted = 0;
  },
};
