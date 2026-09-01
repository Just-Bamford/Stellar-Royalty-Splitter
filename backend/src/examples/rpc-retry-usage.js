/**
 * Example usage of the centralized RPC retry handler.
 * Shows how to wrap various Stellar RPC operations with retry logic.
 *
 * Do not run this directly - it's for reference only.
 */

import { withRetry } from "../rpc-retry.js";
import { server, buildTx, fetchFeeStats } from "../stellar.js";

// ── Example 1: Simple Account Fetch with Retry ─────────────────────────────

async function getAccountWithRetry(address) {
  return withRetry(() => server.getAccount(address), {
    operationType: "getAccount",
    details: { address: address.slice(0, 8) + "..." },
  });
}

// ── Example 2: Custom Retry Predicate ──────────────────────────────────────

async function getTransactionWithCustomLogic(txHash) {
  return withRetry(() => server.getTransaction(txHash), {
    operationType: "getTransaction",
    // Only retry on transient network errors, not on "not found"
    shouldRetry: (error) => {
      const httpStatus = error?.response?.status ?? error?.status;
      // Don't retry 404 (transaction not yet on ledger is normal)
      if (httpStatus === 404) return false;
      // Retry transient errors
      return httpStatus >= 500 || httpStatus === 429;
    },
    details: { txHash: txHash.slice(0, 8) },
  });
}

// ── Example 3: More Aggressive Retry for Critical Operations ────────────────

async function getFreshAccountWithAggressiveRetry(address) {
  return withRetry(() => server.getAccount(address), {
    operationType: "getAccount",
    maxRetries: 5, // More retries
    baseBackoffMs: 500, // Start faster
    details: {
      address: address.slice(0, 8) + "...",
      priority: "critical", // For logging
    },
  });
}

// ── Example 4: Fast Fail for Non-Critical Operations ────────────────────────

async function getWalletBalanceWithFastFail(address) {
  return withRetry(() => server.getAccount(address), {
    operationType: "getAccount",
    maxRetries: 1, // Fail fast
    baseBackoffMs: 100, // Minimal backoff
    details: { address: address.slice(0, 8) + "...", readOnly: true },
  });
}

// ── Example 5: Chaining Multiple Retried Operations ────────────────────────

async function buildTransactionWithRetry(callerAddress, contractId, method, args) {
  // Step 1: Get fresh account with retry
  const account = await withRetry(() => server.getAccount(callerAddress), {
    operationType: "getAccount",
  });

  // Step 2: Get recommended fee with retry
  const fee = await withRetry(
    () => fetchFeeStats(),
    { operationType: "getFeeStats", maxRetries: 2 } // Fewer retries for non-critical
  );

  // Step 3: Build transaction with retry (handles rate limits)
  const tx = await withRetry(() => buildTx(account, contractId, method, args, fee), {
    operationType: "buildTransaction",
  });

  return tx;
}

// ── Example 6: Error Handling with Retry ────────────────────────────────────

async function robustAccountFetch(address) {
  try {
    // Try to get account with retries
    const account = await withRetry(() => server.getAccount(address), {
      operationType: "getAccount",
      details: { address: address.slice(0, 8) + "..." },
    });
    return { success: true, account };
  } catch (error) {
    // After retries exhausted, handle the error
    if (error?.message?.includes("Account not found")) {
      return { success: false, reason: "account_not_found" };
    }
    if (error?.status === 429) {
      return { success: false, reason: "rate_limited" };
    }
    if (error?.status >= 500) {
      return { success: false, reason: "server_error" };
    }
    return { success: false, reason: "unknown_error", error: error.message };
  }
}

// ── Example 7: Monitoring Retry Metrics ────────────────────────────────────

import { retryMetrics } from "../rpc-retry.js";

async function getMetricsEndpoint() {
  const metrics = retryMetrics.getMetrics();

  return {
    retries: {
      total_attempts: metrics.totalRetryAttempts,
      successful: metrics.successfulRetries,
      exhausted: metrics.exhaustedRetries,
      success_rate: `${metrics.successRate}%`,
    },
    recommendation:
      parseFloat(metrics.successRate) < 50
        ? "High retry failure rate - check RPC connectivity"
        : "Retry rate healthy",
  };
}

// ── Example 8: Batch Operations with Retry ────────────────────────────────

async function getMultipleAccounts(addresses) {
  const results = await Promise.allSettled(
    addresses.map((address) =>
      withRetry(() => server.getAccount(address), {
        operationType: "getAccount",
        details: { address: address.slice(0, 8) + "..." },
      })
    )
  );

  return results.map((result, index) => ({
    address: addresses[index],
    status: result.status,
    account: result.value,
    error: result.reason,
  }));
}

// ── Example 9: Retry with Request ID for Tracing ──────────────────────────

async function getAccountWithTracing(address, requestId) {
  return withRetry(() => server.getAccount(address), {
    operationType: "getAccount",
    details: {
      address: address.slice(0, 8) + "...",
      requestId, // Helps trace retries in logs
      timestamp: new Date().toISOString(),
    },
  });
}

// ── Example 10: Fallback Strategy ──────────────────────────────────────────

async function getAccountWithFallback(address, fallbackCachedAccount = null) {
  try {
    // Try fresh fetch with retries
    return await withRetry(() => server.getAccount(address), {
      operationType: "getAccount",
      maxRetries: 2,
      details: { address: address.slice(0, 8) + "..." },
    });
  } catch (error) {
    // Fall back to cached account if available
    if (fallbackCachedAccount) {
      console.warn(`Using cached account after retry exhaustion`, {
        address: address.slice(0, 8),
        error: error.message,
      });
      return fallbackCachedAccount;
    }
    throw error;
  }
}

export {
  getAccountWithRetry,
  getTransactionWithCustomLogic,
  getFreshAccountWithAggressiveRetry,
  getWalletBalanceWithFastFail,
  buildTransactionWithRetry,
  robustAccountFetch,
  getMetricsEndpoint,
  getMultipleAccounts,
  getAccountWithTracing,
  getAccountWithFallback,
};
