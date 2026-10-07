/**
 * Chaos Engineering: Fault Injection Framework
 * Issue #966 - Testing system resilience under failure conditions
 *
 * Purpose:
 *   - Inject controlled failures into RPC, database, and network operations
 *   - Test system behavior under various failure scenarios
 *   - Validate retry logic, fallback mechanisms, and error handling
 *   - Simulate real-world production issues in a controlled environment
 *
 * Supported Fault Types:
 *   - RPC timeouts (simulates Soroban network delays)
 *   - RPC failures (random errors, rate limits, service unavailability)
 *   - Database connection failures
 *   - Network partitions
 *   - Latency injection (slow responses)
 *   - Random errors (intermittent failures)
 *
 * Usage:
 *   // Enable in test environment only
 *   if (process.env.CHAOS_TESTING_ENABLED === "true") {
 *     enableChaos({ rpcFailureRate: 0.3, dbFailureRate: 0.1 });
 *   }
 *
 * Configuration:
 *   CHAOS_TESTING_ENABLED - Enable/disable chaos testing
 *   CHAOS_RPC_FAILURE_RATE - Probability of RPC failures (0.0-1.0)
 *   CHAOS_DB_FAILURE_RATE - Probability of DB failures (0.0-1.0)
 *   CHAOS_LATENCY_MS - Additional latency to inject (milliseconds)
 *   CHAOS_TIMEOUT_RATE - Probability of timeout errors (0.0-1.0)
 */

import logger from "../logger.js";

// Chaos testing state
const chaosState = {
  enabled: false,
  config: {
    rpcFailureRate: 0,
    dbFailureRate: 0,
    networkFailureRate: 0,
    timeoutRate: 0,
    latencyMs: 0,
    latencyJitter: 0,
  },
  metrics: {
    rpcFailuresInjected: 0,
    dbFailuresInjected: 0,
    networkFailuresInjected: 0,
    timeoutsInjected: 0,
    latencyInjections: 0,
  },
};

/**
 * Error types that can be injected
 */
export const FaultType = {
  RPC_TIMEOUT: "rpc_timeout",
  RPC_RATE_LIMIT: "rpc_rate_limit",
  RPC_SERVICE_UNAVAILABLE: "rpc_service_unavailable",
  RPC_GATEWAY_TIMEOUT: "rpc_gateway_timeout",
  DB_CONNECTION_ERROR: "db_connection_error",
  DB_TIMEOUT: "db_timeout",
  NETWORK_ERROR: "network_error",
  LATENCY: "latency",
  RANDOM_ERROR: "random_error",
};

/**
 * Enable chaos testing with specified configuration
 */
export function enableChaos(config = {}) {
  chaosState.enabled = true;
  chaosState.config = {
    rpcFailureRate: config.rpcFailureRate ?? 0.2,
    dbFailureRate: config.dbFailureRate ?? 0.1,
    networkFailureRate: config.networkFailureRate ?? 0.05,
    timeoutRate: config.timeoutRate ?? 0.15,
    latencyMs: config.latencyMs ?? 0,
    latencyJitter: config.latencyJitter ?? 0.5, // ±50% variation
  };

  logger.info("Chaos testing enabled", {
    event: "chaos_enabled",
    config: chaosState.config,
  });
}

/**
 * Disable chaos testing
 */
export function disableChaos() {
  chaosState.enabled = false;
  logger.info("Chaos testing disabled", {
    event: "chaos_disabled",
    metrics: chaosState.metrics,
  });
}

/**
 * Check if chaos testing is currently enabled
 */
export function isChaosEnabled() {
  return chaosState.enabled;
}

/**
 * Get current chaos metrics
 */
export function getChaosMetrics() {
  return { ...chaosState.metrics };
}

/**
 * Reset chaos metrics
 */
export function resetChaosMetrics() {
  chaosState.metrics = {
    rpcFailuresInjected: 0,
    dbFailuresInjected: 0,
    networkFailuresInjected: 0,
    timeoutsInjected: 0,
    latencyInjections: 0,
  };
}

/**
 * Determine if a fault should be injected based on probability
 */
function shouldInjectFault(probability) {
  return Math.random() < probability;
}

/**
 * Create an RPC timeout error
 */
function createRpcTimeoutError() {
  const error = new Error("Request timeout - chaos injection");
  error.code = "ETIMEDOUT";
  error.isChaosFault = true;
  return error;
}

/**
 * Create an RPC rate limit error
 */
function createRpcRateLimitError() {
  const error = new Error("Rate limit exceeded - chaos injection");
  error.response = { status: 429 };
  error.status = 429;
  error.isChaosFault = true;
  return error;
}

/**
 * Create an RPC service unavailable error
 */
function createRpcServiceUnavailableError() {
  const error = new Error("Service temporarily unavailable - chaos injection");
  error.response = { status: 503 };
  error.status = 503;
  error.isChaosFault = true;
  return error;
}

/**
 * Create an RPC gateway timeout error
 */
function createRpcGatewayTimeoutError() {
  const error = new Error("Gateway timeout - chaos injection");
  error.response = { status: 504 };
  error.status = 504;
  error.isChaosFault = true;
  return error;
}

/**
 * Create a database connection error
 */
function createDbConnectionError() {
  const error = new Error("Database connection failed - chaos injection");
  error.code = "ECONNREFUSED";
  error.isChaosFault = true;
  return error;
}

/**
 * Create a database timeout error
 */
function createDbTimeoutError() {
  const error = new Error("Database query timeout - chaos injection");
  error.code = "ETIMEDOUT";
  error.isChaosFault = true;
  return error;
}

/**
 * Create a network error
 */
function createNetworkError() {
  const errors = [
    { message: "Network unreachable", code: "ENETUNREACH" },
    { message: "Connection refused", code: "ECONNREFUSED" },
    { message: "Host not found", code: "ENOTFOUND" },
  ];
  const selected = errors[Math.floor(Math.random() * errors.length)];
  const error = new Error(`${selected.message} - chaos injection`);
  error.code = selected.code;
  error.isChaosFault = true;
  return error;
}

/**
 * Inject random latency into an operation
 */
async function injectLatency() {
  if (chaosState.config.latencyMs <= 0) return;

  const baseLatency = chaosState.config.latencyMs;
  const jitter = chaosState.config.latencyJitter;
  const minLatency = baseLatency * (1 - jitter);
  const maxLatency = baseLatency * (1 + jitter);
  const latency = Math.floor(minLatency + Math.random() * (maxLatency - minLatency));

  chaosState.metrics.latencyInjections++;

  logger.debug("Injecting latency", {
    event: "chaos_latency_injected",
    latencyMs: latency,
  });

  await new Promise((resolve) => setTimeout(resolve, latency));
}

/**
 * Inject faults into RPC operations
 * Wraps an async RPC operation and randomly injects failures
 */
export async function injectRpcFault(operation, operationType = "unknown") {
  if (!chaosState.enabled) {
    return operation();
  }

  // Inject latency first (happens even if no error is injected)
  if (chaosState.config.latencyMs > 0) {
    await injectLatency();
  }

  // Determine if we should inject a failure
  const shouldFail = shouldInjectFault(chaosState.config.rpcFailureRate);
  const shouldTimeout = shouldInjectFault(chaosState.config.timeoutRate);

  if (shouldTimeout) {
    chaosState.metrics.timeoutsInjected++;
    logger.warn("Chaos: Injecting RPC timeout", {
      event: "chaos_rpc_timeout",
      operationType,
    });
    throw createRpcTimeoutError();
  }

  if (shouldFail) {
    chaosState.metrics.rpcFailuresInjected++;

    // Randomly select failure type
    const failureTypes = [
      { type: FaultType.RPC_RATE_LIMIT, create: createRpcRateLimitError },
      { type: FaultType.RPC_SERVICE_UNAVAILABLE, create: createRpcServiceUnavailableError },
      { type: FaultType.RPC_GATEWAY_TIMEOUT, create: createRpcGatewayTimeoutError },
    ];

    const selected = failureTypes[Math.floor(Math.random() * failureTypes.length)];

    logger.warn("Chaos: Injecting RPC failure", {
      event: "chaos_rpc_failure",
      faultType: selected.type,
      operationType,
    });

    throw selected.create();
  }

  // No fault injected, execute normally
  return operation();
}

/**
 * Inject faults into database operations
 */
export async function injectDbFault(operation, operationType = "unknown") {
  if (!chaosState.enabled) {
    return operation();
  }

  // Inject latency
  if (chaosState.config.latencyMs > 0) {
    await injectLatency();
  }

  // Determine if we should inject a failure
  const shouldFail = shouldInjectFault(chaosState.config.dbFailureRate);
  const shouldTimeout = shouldInjectFault(chaosState.config.timeoutRate);

  if (shouldTimeout) {
    chaosState.metrics.timeoutsInjected++;
    logger.warn("Chaos: Injecting database timeout", {
      event: "chaos_db_timeout",
      operationType,
    });
    throw createDbTimeoutError();
  }

  if (shouldFail) {
    chaosState.metrics.dbFailuresInjected++;

    // Randomly select failure type
    const shouldConnectionError = Math.random() < 0.5;

    const error = shouldConnectionError ? createDbConnectionError() : createDbTimeoutError();

    logger.warn("Chaos: Injecting database failure", {
      event: "chaos_db_failure",
      faultType: shouldConnectionError ? "connection_error" : "timeout",
      operationType,
    });

    throw error;
  }

  // No fault injected, execute normally
  return operation();
}

/**
 * Inject network-level faults
 */
export async function injectNetworkFault(operation, operationType = "unknown") {
  if (!chaosState.enabled) {
    return operation();
  }

  // Inject latency
  if (chaosState.config.latencyMs > 0) {
    await injectLatency();
  }

  // Determine if we should inject a failure
  const shouldFail = shouldInjectFault(chaosState.config.networkFailureRate);

  if (shouldFail) {
    chaosState.metrics.networkFailuresInjected++;
    logger.warn("Chaos: Injecting network failure", {
      event: "chaos_network_failure",
      operationType,
    });
    throw createNetworkError();
  }

  // No fault injected, execute normally
  return operation();
}

/**
 * Wrap an operation with chaos fault injection
 * Automatically determines fault type based on operation name
 */
export async function withChaos(operation, options = {}) {
  const { type = "rpc", operationType = "unknown" } = options;

  switch (type) {
    case "rpc":
      return injectRpcFault(operation, operationType);
    case "db":
    case "database":
      return injectDbFault(operation, operationType);
    case "network":
      return injectNetworkFault(operation, operationType);
    default:
      logger.warn(`Unknown chaos type: ${type}, executing without chaos`);
      return operation();
  }
}

/**
 * Initialize chaos testing from environment variables
 */
export function initializeChaosFromEnv() {
  if (process.env.CHAOS_TESTING_ENABLED === "true") {
    enableChaos({
      rpcFailureRate: parseFloat(process.env.CHAOS_RPC_FAILURE_RATE ?? "0.2"),
      dbFailureRate: parseFloat(process.env.CHAOS_DB_FAILURE_RATE ?? "0.1"),
      networkFailureRate: parseFloat(process.env.CHAOS_NETWORK_FAILURE_RATE ?? "0.05"),
      timeoutRate: parseFloat(process.env.CHAOS_TIMEOUT_RATE ?? "0.15"),
      latencyMs: parseInt(process.env.CHAOS_LATENCY_MS ?? "0", 10),
      latencyJitter: parseFloat(process.env.CHAOS_LATENCY_JITTER ?? "0.5"),
    });
  }
}

export default {
  enableChaos,
  disableChaos,
  isChaosEnabled,
  getChaosMetrics,
  resetChaosMetrics,
  injectRpcFault,
  injectDbFault,
  injectNetworkFault,
  withChaos,
  initializeChaosFromEnv,
  FaultType,
};
