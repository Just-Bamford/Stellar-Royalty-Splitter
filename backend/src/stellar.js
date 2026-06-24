/**
 * Shared Soroban RPC client and helpers.
 * Real transactions are assembled here and returned as XDR so the
 * frontend can sign them with Freighter before submission.
 *
 * Operational hardening (#273, #274, #275):
 *   - Every RPC call goes through `withTimeout()` so the backend never
 *     hangs on a slow upstream. Configurable via SOROBAN_RPC_TIMEOUT_MS
 *     (default 10s) and HORIZON_TIMEOUT_MS (default 10s).
 *   - The transaction fee is fetched from Horizon's /fee_stats endpoint
 *     and cached for 30 seconds (configurable via HORIZON_FEE_CACHE_MS).
 *     Falls back to BASE_FEE on fetch failure.
 *   - `retryBuildTx` calls `getFreshAccount()` on every attempt, so each
 *     rebuilt transaction carries a freshly refetched sequence number.
 *   - Per-address build locks (#294) serialize concurrent `buildTx` calls for
 *     the same wallet so two simultaneous requests never reuse one sequence.
 */
import StellarSdk from "@stellar/stellar-sdk";
import logger from "./logger.js";
import { recordHorizonResponseTime, recordStellarRpcCall } from "./metrics.js";

const {
  Contract,
  Networks,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  Account,
  xdr,
} = StellarSdk;

const RPC_URL =
  process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL =
  process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK = process.env.STELLAR_NETWORK ?? "testnet";

function parsePositiveInt(value, fallback) {
  const n = parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SOROBAN_RPC_TIMEOUT_MS = parsePositiveInt(
  process.env.SOROBAN_RPC_TIMEOUT_MS,
  10_000,
);
const HORIZON_TIMEOUT_MS = parsePositiveInt(
  process.env.HORIZON_TIMEOUT_MS,
  10_000,
);
const HORIZON_FEE_CACHE_MS = parsePositiveInt(
  process.env.HORIZON_FEE_CACHE_MS,
  30_000,
);
const TRANSACTION_POLL_TIMEOUT_MS = parsePositiveInt(
  process.env.TRANSACTION_POLL_TIMEOUT_MS,
  60_000,
);
const TRANSACTION_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.TRANSACTION_POLL_INTERVAL_MS,
  2_000,
);

export const server = new SorobanRpc.Server(RPC_URL, { allowHttp: false });
export const networkPassphrase =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

export function getNetworkLabel() {
  return NETWORK === "mainnet" ? "Mainnet" : "Testnet";
}

export function getConfiguredContractId() {
  return process.env.ROYALTY_CONTRACT_ID ?? process.env.CONTRACT_ID ?? null;
}

// ── RPC timeout wrapper (#273) ─────────────────────────────────────────────

/**
 * Reject `promise` after `ms` milliseconds with a `{ status: 504, message }`
 * shape so the route layer can pass the error straight through.
 *
 * #396: When `correlationId` is provided, records the RPC call duration and
 * outcome via `recordStellarRpcCall` so it shows up in Prometheus metrics.
 */
export function withTimeout(promise, ms, label, correlationId) {
  const start = Date.now();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject({
        status: 504,
        message: `${label} did not respond within ${ms}ms`,
      });
    }, ms);
  });
  return Promise.race([promise, timeout])
    .then((result) => {
      recordStellarRpcCall(label, Date.now() - start, true);
      if (correlationId) {
        logger.debug("Stellar RPC call succeeded", {
          correlationId,
          operation: label,
          durationMs: Date.now() - start,
        });
      }
      return result;
    })
    .catch((err) => {
      recordStellarRpcCall(label, Date.now() - start, false);
      if (correlationId) {
        logger.warn("Stellar RPC call failed", {
          correlationId,
          operation: label,
          durationMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err?.message ?? err),
        });
      }
      throw err;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Probe Horizon with a lightweight ledgers request.
 */
export async function checkHorizonConnectivity() {
  const url = `${HORIZON_URL.replace(/\/$/, "")}/ledgers?order=desc&limit=1`;
  const timeoutMs = parsePositiveInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS,
    5_000,
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestStart = Date.now();
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    recordHorizonResponseTime(Date.now() - requestStart);
    return {
      connected: response.ok,
      url: HORIZON_URL,
    };
  } catch {
    return {
      connected: false,
      url: HORIZON_URL,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report whether a default contract ID is configured and reachable on Soroban RPC.
 */
export async function checkContractDeploymentStatus(contractId) {
  if (!contractId) {
    return {
      configured: false,
      contractId: null,
      deployed: false,
      initialized: false,
      status: "not_configured",
    };
  }

  try {
    const contract = new Contract(contractId);
    const dummyAccount = new Account(
      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      "0",
    );
    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call("is_initialized"))
      .setTimeout(30)
      .build();

    const sim = await withTimeout(
      server.simulateTransaction(tx),
      SOROBAN_RPC_TIMEOUT_MS,
      "Soroban simulateTransaction",
    );
    if (SorobanRpc.Api.isSimulationError(sim)) {
      return {
        configured: true,
        contractId,
        deployed: false,
        initialized: false,
        status: "unreachable",
      };
    }

    const initialized = sim.result?.retval?.bool() ?? false;
    return {
      configured: true,
      contractId,
      deployed: true,
      initialized,
      status: initialized ? "initialized" : "deployed",
    };
  } catch {
    return {
      configured: true,
      contractId,
      deployed: false,
      initialized: false,
      status: "error",
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll Horizon until a transaction is confirmed in a ledger (#297).
 * Returns { status, ledger, createdAt } when the transaction is found.
 * Throws { status: 504, message } on timeout.
 */
export async function pollHorizonTransaction(txHash) {
  const url = `${HORIZON_URL.replace(/\/$/, "")}/transactions/${txHash}`;
  const start = Date.now();

  while (Date.now() - start < TRANSACTION_POLL_TIMEOUT_MS) {
    try {
      const requestStart = Date.now();
      const response = await withTimeout(
        fetch(url, { headers: { Accept: "application/json" } }),
        HORIZON_TIMEOUT_MS,
        "Horizon getTransaction",
      );
      recordHorizonResponseTime(Date.now() - requestStart);

      if (response.status === 404) {
        await sleep(TRANSACTION_POLL_INTERVAL_MS);
        continue;
      }

      if (!response.ok) {
        throw new Error(`Horizon returned HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        status: data.successful ? "confirmed" : "failed",
        ledger: data.ledger,
        createdAt: data.created_at ?? null,
      };
    } catch (error) {
      if (error?.status === 504) {
        throw error;
      }
      logger.warn?.("Horizon transaction poll attempt failed", {
        txHash: txHash.substring(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await sleep(TRANSACTION_POLL_INTERVAL_MS);
  }

  throw {
    status: 504,
    message: `Transaction not confirmed within ${TRANSACTION_POLL_TIMEOUT_MS}ms`,
  };
}

// ── Dynamic fee (#274) ─────────────────────────────────────────────────────

let feeCache = null; // { fee: string, fetchedAt: number }

/**
 * Reset the cached fee. Exposed for tests; production code shouldn't call this.
 */
export function _resetFeeCache() {
  feeCache = null;
}

/**
 * Fetch the recommended transaction fee from Horizon's `/fee_stats` endpoint,
 * cached for HORIZON_FEE_CACHE_MS (default 30s). Falls back to `BASE_FEE` on
 * any error so transaction submission keeps working even when fee stats are
 * unavailable.
 */
export async function getRecommendedFee() {
  const now = Date.now();
  if (feeCache && now - feeCache.fetchedAt < HORIZON_FEE_CACHE_MS) {
    return feeCache.fee;
  }

  const url = `${HORIZON_URL.replace(/\/$/, "")}/fee_stats`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HORIZON_TIMEOUT_MS);

  try {
    const requestStart = Date.now();
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    recordHorizonResponseTime(Date.now() - requestStart);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // Prefer `p50_accepted_fee` (median accepted), fall back to
    // `last_ledger_base_fee`, then BASE_FEE.
    const candidate =
      data?.fee_charged?.p50 ??
      data?.last_ledger_base_fee ??
      BASE_FEE;
    const fee = String(candidate);
    feeCache = { fee, fetchedAt: now };
    return fee;
  } catch (error) {
    logger.warn?.("Horizon fee fetch failed; falling back to BASE_FEE", {
      error: error instanceof Error ? error.message : String(error),
    });
    return BASE_FEE;
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-address build lock (#294) ──────────────────────────────────────────

/** @type {Map<string, Promise<void>>} */
const accountBuildLocks = new Map();

/**
 * Serialize async work per Stellar account so concurrent transaction builds
 * never fetch the same sequence number (#294).
 */
export async function withAccountBuildLock(callerAddress, fn) {
  const key = callerAddress;
  const previous = accountBuildLocks.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  accountBuildLocks.set(
    key,
    previous.then(() => current),
  );

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (accountBuildLocks.get(key) === current) {
      accountBuildLocks.delete(key);
    }
  }
}

/** Reset build locks (for tests). */
export function _resetAccountBuildLocks() {
  accountBuildLocks.clear();
}

// ── Build path (#273, #274, #275, #294) ────────────────────────────────────

/**
 * Fetch a fresh account record (including the current sequence number) for
 * `callerAddress`. Each `retryBuildTx` attempt funnels through here, which
 * is what guarantees retries don't reuse a stale sequence (#275).
 *
 * #396: Optional `correlationId` is forwarded to `withTimeout` for tracing.
 */
export async function getFreshAccount(callerAddress, correlationId) {
  return withTimeout(
    server.getAccount(callerAddress),
    SOROBAN_RPC_TIMEOUT_MS,
    "Soroban getAccount",
    correlationId,
  );
}

/**
 * Parse a Soroban simulation or submission error into a structured object
 * with a human-readable message, error code, and any available context.
 */
export function parseSorobanError(error) {
  // Simulation error from prepareTransaction / simulateTransaction
  if (error?.result?.error) {
    const raw = error.result.error;
    return {
      status: 400,
      code: "SOROBAN_SIMULATION_ERROR",
      message: `Contract simulation failed: ${raw}`,
      detail: raw,
    };
  }

  // SorobanRpc simulation error object
  if (error?._type === "SimulateTransactionError" || error?.events !== undefined && error?.error) {
    return {
      status: 400,
      code: "SOROBAN_SIMULATION_ERROR",
      message: `Contract simulation failed: ${error.error}`,
      detail: error.error,
    };
  }

  // Horizon submission error — extract result_codes
  const resultCodes =
    error?.response?.data?.extras?.result_codes ??
    error?.data?.extras?.result_codes ??
    error?.extras?.result_codes;

  if (resultCodes) {
    const txCode = resultCodes.transaction ?? "unknown";
    const opCodes = resultCodes.operations ?? [];
    const detail = opCodes.length
      ? `transaction: ${txCode}, operations: ${opCodes.join(", ")}`
      : `transaction: ${txCode}`;
    return {
      status: 400,
      code: "SOROBAN_INVOCATION_ERROR",
      message: `Contract invocation failed — ${detail}`,
      detail: resultCodes,
    };
  }

  // Generic Horizon/RPC HTTP error
  const httpStatus = error?.response?.status ?? error?.status;
  if (httpStatus && httpStatus >= 400) {
    return {
      status: httpStatus >= 500 ? 502 : 400,
      code: "STELLAR_RPC_ERROR",
      message: error?.message ?? `Stellar RPC returned HTTP ${httpStatus}`,
      detail: error?.response?.data ?? null,
    };
  }

  return null;
}

/**
 * Build an unsigned Soroban transaction XDR for a contract invocation.
 * The frontend signs and submits it.
 *
 * #396: Accepts an optional `correlationId` that is threaded through all
 * RPC calls so every Stellar operation for a single HTTP request shares
 * the same tracing context in logs and metrics.
 */
export async function buildTx(callerAddress, contractId, method, args = [], correlationId) {
  return withAccountBuildLock(callerAddress, async () => {
    const account = await getFreshAccount(callerAddress, correlationId);
    const fee = await getRecommendedFee();
    const contract = new Contract(contractId);

    const tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const prepared = await withTimeout(
      server.prepareTransaction(tx),
      SOROBAN_RPC_TIMEOUT_MS,
      "Soroban prepareTransaction",
      correlationId,
    );
    return prepared.toXDR();
  });
}

function isRateLimitError(error) {
  return (
    error?.response?.status === 429 ||
    error?.status === 429 ||
    error?.message?.includes("429") ||
    error?.message?.toLowerCase?.().includes("too many requests") ||
    error?.message?.toLowerCase?.().includes("rate limit")
  );
}

function isTimeoutError(error) {
  return error?.status === 504;
}

/**
 * Retry wrapper for buildTx with exponential backoff.
 *
 * Sequence-number freshness (#275, #294): every attempt re-enters `buildTx`,
 * which always calls `getFreshAccount` under a per-address lock — concurrent
 * requests for the same wallet are serialized so they never reuse one sequence.
 *
 * Timeouts (#273) surface as `{ status: 504 }` and are retried like other
 * network errors up to `maxRetries`.
 *
 * Handles HTTP 429 rate-limit responses from Horizon explicitly.
 *
 * #396: Optional `correlationId` is threaded through every `buildTx` call so
 * all Stellar RPC operations for a single HTTP request share the same trace ID.
 */
export async function retryBuildTx(callerAddress, contractId, method, args = [], correlationId) {
  const maxRetries = 3;
  const baseBackoffMs = 1000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await buildTx(callerAddress, contractId, method, args, correlationId);
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isNetworkError =
        error.message?.includes("network") ||
        error.message?.includes("timeout") ||
        error.code === "ENOTFOUND";
      const isAccountNotFound = error.message?.includes("account not found");
      const isSimulationError =
        error.message?.includes("simulation") ||
        error.message?.includes("prepare");
      const isRateLimit = isRateLimitError(error);
      const isTimeout = isTimeoutError(error);

      if (isAccountNotFound) {
        throw {
          status: 400,
          message: "Caller account not found on Stellar network",
        };
      }

      if (isRateLimit) {
        if (isLastAttempt) {
          logger.warn("Horizon rate limit exceeded after max retries", {
            correlationId,
            method,
            contractId,
            attempt,
          });
          throw {
            status: 429,
            message:
              "Stellar Horizon rate limit exceeded. Please try again later.",
          };
        }
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        logger.warn(`Horizon rate limit hit, retrying with backoff`, {
          correlationId,
          method,
          contractId,
          attempt,
          maxRetries,
          delayMs: delay,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (isTimeout) {
        if (isLastAttempt) {
          logger.warn("Soroban RPC timed out after max retries", {
            correlationId,
            method,
            contractId,
            attempt,
            timeoutMs: SOROBAN_RPC_TIMEOUT_MS,
          });
          throw {
            status: 504,
            message: `Soroban RPC timed out after ${SOROBAN_RPC_TIMEOUT_MS}ms`,
          };
        }
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (isNetworkError || isSimulationError) {
        if (isLastAttempt) {
          throw {
            status: 503,
            message:
              "Stellar RPC is currently unavailable. Please try again later.",
          };
        }
        const delay = baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error;
    }
  }
}

// ── ScVal helpers ────────────────────────────────────────────────────────

export function addressToScVal(addr) {
  return new Address(addr).toScVal();
}

export function u32ToScVal(n) {
  return xdr.ScVal.scvU32(n);
}

export function bytesN32HexToScVal(hex) {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) {
    throw new Error("Expected 32-byte hex value");
  }
  return xdr.ScVal.scvBytes(buf);
}

export function i128ToScVal(n) {
  return nativeToScVal(BigInt(n), { type: "i128" });
}

export function vecToScVal(items) {
  return xdr.ScVal.scvVec(items);
}

/**
 * Fetch the royalty rate from the contract using a read-only simulation.
 * Returns the rate as a u32 (basis points), or 0 on error.
 */
export async function getRoyaltyRateFromContract(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_royalty_rate"))
    .setTimeout(30)
    .build();

  const sim = await withTimeout(
    server.simulateTransaction(tx),
    SOROBAN_RPC_TIMEOUT_MS,
    "Soroban simulateTransaction",
  );
  if (SorobanRpc.Api.isSimulationError(sim)) return 0;
  return sim.result?.retval?.u32() ?? 0;
}

/**
 * Check if a contract has been initialized by simulating is_initialized().
 * Returns true if initialized, false if not.
 */
export async function isContractInitialized(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("is_initialized"))
    .setTimeout(30)
    .build();

  const sim = await withTimeout(
    server.simulateTransaction(tx),
    SOROBAN_RPC_TIMEOUT_MS,
    "Soroban simulateTransaction",
  );
  if (SorobanRpc.Api.isSimulationError(sim)) return false;
  return sim.result?.retval?.bool() ?? false;
}

/**
 * Fetch the on-chain contract version via read-only simulation.
 * Returns the semver string, or null when the contract is not initialized.
 */
export async function getContractVersionFromContract(contractId) {
  const contract = new Contract(contractId);
  const dummyAccount = new Account(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
    "0",
  );
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call("get_version"))
    .setTimeout(30)
    .build();

  const sim = await withTimeout(
    server.simulateTransaction(tx),
    SOROBAN_RPC_TIMEOUT_MS,
    "Soroban simulateTransaction",
  );
  if (SorobanRpc.Api.isSimulationError(sim)) return null;

  const retval = sim.result?.retval;
  if (!retval) return null;

  try {
    return retval.str().toString();
  } catch {
    return null;
  }
}

// ── Test exports ───────────────────────────────────────────────────────────
// Internal config snapshot for the test layer.
export const _config = {
  SOROBAN_RPC_TIMEOUT_MS,
  HORIZON_TIMEOUT_MS,
  HORIZON_FEE_CACHE_MS,
  HORIZON_URL,
  TRANSACTION_POLL_TIMEOUT_MS,
  TRANSACTION_POLL_INTERVAL_MS,
};
