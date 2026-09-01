/**
 * Database connection health monitor (#496).
 *
 * Runs periodic checks every HEALTH_CHECK_INTERVAL_MS (default 30s),
 * tracks pool utilization, attempts automatic reconnection on failure,
 * and exposes health status for the /health endpoints.
 *
 * Acceptance criteria addressed:
 *   - Health check every 30 seconds
 *   - Pool utilization tracked
 *   - Reconnection working
 *   - Alerts on connection problems
 *   - Metrics exported
 */

import { pool } from "./pool.js";
import logger from "../logger.js";

// ── Configuration ────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.DB_HEALTH_CHECK_INTERVAL_MS ?? "30000",
  10,
);
const RECONNECT_BACKOFF_BASE_MS = parseInt(
  process.env.DB_RECONNECT_BACKOFF_BASE_MS ?? "1000",
  10,
);
const RECONNECT_BACKOFF_MAX_MS = parseInt(
  process.env.DB_RECONNECT_BACKOFF_MAX_MS ?? "30000",
  10,
);
const POOL_UTILIZATION_WARN_THRESHOLD = parseFloat(
  process.env.DB_POOL_UTILIZATION_WARN_THRESHOLD ?? "0.8",
);

// ── Internal state ───────────────────────────────────────────────────────

let _timer = null;
let _isRunning = false;

/** Connection health metrics (mutable). */
const _metrics = {
  lastCheckAt: null,
  lastCheckDurationMs: null,
  lastCheckHealthy: true,
  consecutiveFailures: 0,
  totalChecks: 0,
  totalFailures: 0,
  reconnectionsAttempted: 0,
  reconnectionsSucceeded: 0,
  reconnectionsFailed: 0,
  poolUtilization: 0,
};

// ── Core health check ────────────────────────────────────────────────────

/**
 * Perform a single connection health check.
 *
 * Verifies the SQLite connection by running a lightweight PRAGMA query,
 * checking pool utilization, and detecting connection errors.
 *
 * @returns {object} Health status with connected, pool, and timing info.
 */
export function checkConnectionHealth() {
  const start = Date.now();
  let connected = true;
  let error = null;

  _metrics.totalChecks++;
  _metrics.lastCheckAt = new Date().toISOString();

  const poolMetrics = pool.getMetrics();
  const utilization =
    poolMetrics.poolSize > 0
      ? poolMetrics.activeConnections / poolMetrics.poolSize
      : 0;
  _metrics.poolUtilization = utilization;

  // Check pool draining state
  if (poolMetrics.draining) {
    connected = false;
    error = "Pool is draining";
  }

  // Check connection timeout pressure
  if (poolMetrics.timeouts > 0 && poolMetrics.acquires > 0) {
    const timeoutRate = poolMetrics.timeouts / poolMetrics.acquires;
    if (timeoutRate > 0.1) {
      connected = false;
      error = `High timeout rate: ${Math.round(timeoutRate * 100)}%`;
    }
  }

  // Probe the primary db connection via pool if not already disconnected
  if (connected) {
    try {
      const probeResult = pool.run(async (conn) => {
        try {
          const row = conn
            .prepare("SELECT 1 AS health_check")
            .get();
          return row && row.health_check === 1;
        } catch (err) {
          throw err;
        }
      });

      // pool.run returns a Promise — handle it
      if (probeResult instanceof Promise) {
        probeResult.catch((err) => {
          connected = false;
          error = err instanceof Error ? err.message : String(err);
        });
      }
    } catch (err) {
      connected = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const durationMs = Date.now() - start;
  _metrics.lastCheckDurationMs = durationMs;
  _metrics.lastCheckHealthy = connected;

  if (!connected) {
    _metrics.consecutiveFailures++;
    _metrics.totalFailures++;
    logger.warn("Database connection health check failed", {
      error,
      consecutiveFailures: _metrics.consecutiveFailures,
      durationMs,
    });
    _alertOnConnectionFailure(error);
  } else {
    if (_metrics.consecutiveFailures > 0) {
      logger.info("Database connection recovered", {
        afterFailures: _metrics.consecutiveFailures,
        durationMs,
      });
    }
    _metrics.consecutiveFailures = 0;
  }

  _checkPoolUtilizationWarning(utilization);

  return {
    connected,
    error,
    durationMs,
    lastCheckAt: _metrics.lastCheckAt,
    consecutiveFailures: _metrics.consecutiveFailures,
    pool: {
      poolSize: poolMetrics.poolSize,
      activeConnections: poolMetrics.activeConnections,
      available: poolMetrics.available,
      utilization: Math.round(utilization * 100),
      queueLength: poolMetrics.queueLength,
      timeouts: poolMetrics.timeouts,
      acquires: poolMetrics.acquires,
    },
  };
}

/**
 * Async version for use in routes that need to await the probe result.
 */
export async function checkConnectionHealthAsync() {
  const start = Date.now();
  let connected = true;
  let error = null;

  _metrics.totalChecks++;
  _metrics.lastCheckAt = new Date().toISOString();

  const poolMetrics = pool.getMetrics();
  const utilization =
    poolMetrics.poolSize > 0
      ? poolMetrics.activeConnections / poolMetrics.poolSize
      : 0;
  _metrics.poolUtilization = utilization;

  if (poolMetrics.draining) {
    connected = false;
    error = "Pool is draining";
  }

  if (poolMetrics.timeouts > 0 && poolMetrics.acquires > 0) {
    const timeoutRate = poolMetrics.timeouts / poolMetrics.acquires;
    if (timeoutRate > 0.1) {
      connected = false;
      error = `High timeout rate: ${Math.round(timeoutRate * 100)}%`;
    }
  }

  if (connected) {
    try {
      const result = await pool.run(async (conn) => {
        const row = conn.prepare("SELECT 1 AS health_check").get();
        return row && row.health_check === 1;
      });
      if (!result) {
        connected = false;
        error = "Health check query returned unexpected result";
      }
    } catch (err) {
      connected = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const durationMs = Date.now() - start;
  _metrics.lastCheckDurationMs = durationMs;
  _metrics.lastCheckHealthy = connected;

  if (!connected) {
    _metrics.consecutiveFailures++;
    _metrics.totalFailures++;
    logger.warn("Database connection health check failed", {
      error,
      consecutiveFailures: _metrics.consecutiveFailures,
      durationMs,
    });
    _alertOnConnectionFailure(error);
  } else {
    if (_metrics.consecutiveFailures > 0) {
      logger.info("Database connection recovered", {
        afterFailures: _metrics.consecutiveFailures,
        durationMs,
      });
    }
    _metrics.consecutiveFailures = 0;
  }

  _checkPoolUtilizationWarning(utilization);

  return {
    connected,
    error,
    durationMs,
    lastCheckAt: _metrics.lastCheckAt,
    consecutiveFailures: _metrics.consecutiveFailures,
    pool: {
      poolSize: poolMetrics.poolSize,
      activeConnections: poolMetrics.activeConnections,
      available: poolMetrics.available,
      utilization: Math.round(utilization * 100),
      queueLength: poolMetrics.queueLength,
      timeouts: poolMetrics.timeouts,
      acquires: poolMetrics.acquires,
    },
  };
}

// ── Automatic reconnection ──────────────────────────────────────────────

/**
 * Attempt to reconnect to the database by draining and reinitialising the pool.
 * Uses exponential backoff capped at RECONNECT_BACKOFF_MAX_MS.
 *
 * @returns {Promise<boolean>} true if reconnection succeeded.
 */
export async function attemptReconnection() {
  _metrics.reconnectionsAttempted++;
  const attempt = _metrics.reconnectionsAttempted;

  const backoffMs = Math.min(
    RECONNECT_BACKOFF_BASE_MS * 2 ** (attempt - 1),
    RECONNECT_BACKOFF_MAX_MS,
  );

  logger.info("Attempting database reconnection", {
    attempt,
    backoffMs,
  });

  await new Promise((resolve) => setTimeout(resolve, backoffMs));

  try {
    await pool.drain();
    // After drain, the connections are closed and the one-way draining
    // flag would permanently reject new acquires (and make the health probe
    // below report "Pool is draining"). Rebuild the pool with fresh
    // connections and clear the flag so it accepts acquires again.
    pool.reinitialize();
    // Verify the new connection works.
    const health = await checkConnectionHealthAsync();
    if (health.connected) {
      _metrics.reconnectionsSucceeded++;
      logger.info("Database reconnection succeeded", { attempt });
      return true;
    }
    _metrics.reconnectionsFailed++;
    logger.error("Database reconnection health check still failing", { attempt });
    return false;
  } catch (err) {
    _metrics.reconnectionsFailed++;
    logger.error("Database reconnection attempt failed", {
      attempt,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Alerting ─────────────────────────────────────────────────────────────

/**
 * Emit an alert log when a connection failure is detected.
 * Called on every failed health check; consecutive failures are logged
 * at increasing severity.
 */
function _alertOnConnectionFailure(error) {
  const consecutive = _metrics.consecutiveFailures;

  if (consecutive === 1) {
    logger.error("Database connection problem detected", {
      error,
      consecutiveFailures: consecutive,
    });
  } else if (consecutive % 5 === 0) {
    logger.error("Database connection still failing — escalating alert", {
      error,
      consecutiveFailures: consecutive,
    });
  }
}

/**
 * Emit a warning when pool utilization exceeds the configured threshold.
 */
function _checkPoolUtilizationWarning(utilization) {
  if (utilization >= POOL_UTILIZATION_WARN_THRESHOLD) {
    logger.warn("Database pool utilization high", {
      utilization: Math.round(utilization * 100),
      threshold: Math.round(POOL_UTILIZATION_WARN_THRESHOLD * 100),
    });
  }
}

// ── Periodic scheduler ───────────────────────────────────────────────────

/**
 * Start the periodic health check loop.
 * Checks every HEALTH_CHECK_INTERVAL_MS milliseconds.
 * Automatically attempts reconnection on consecutive failures.
 */
export function startHealthMonitor() {
  if (_isRunning) return;

  _isRunning = true;
  logger.info("Database connection health monitor started", {
    intervalMs: HEALTH_CHECK_INTERVAL_MS,
  });

  // Run the first check immediately
  _runCheck();

  _timer = setInterval(() => _runCheck(), HEALTH_CHECK_INTERVAL_MS);

  // Allow the process to exit without waiting for the timer
  if (_timer && typeof _timer.unref === "function") {
    _timer.unref();
  }
}

/**
 * Stop the periodic health check loop.
 */
export function stopHealthMonitor() {
  if (!_isRunning) return;

  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _isRunning = false;
  logger.info("Database connection health monitor stopped");
}

async function _runCheck() {
  try {
    const health = await checkConnectionHealthAsync();

    if (!health.connected && _metrics.consecutiveFailures >= 3) {
      logger.info("Health monitor triggering automatic reconnection", {
        consecutiveFailures: _metrics.consecutiveFailures,
      });
      await attemptReconnection();
    }
  } catch (err) {
    logger.error("Health monitor check error", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Status & metrics ─────────────────────────────────────────────────────

/**
 * Get the current health monitor status (read-only snapshot).
 */
export function getHealthStatus() {
  return {
    ..._metrics,
    isRunning: _isRunning,
  };
}

/**
 * Get the current health metrics for Prometheus export.
 */
export function getHealthMetrics() {
  return {
    connectionHealthLastCheckDurationMs: _metrics.lastCheckDurationMs ?? 0,
    connectionHealthConsecutiveFailures: _metrics.consecutiveFailures,
    connectionHealthTotalChecks: _metrics.totalChecks,
    connectionHealthTotalFailures: _metrics.totalFailures,
    connectionHealthReconnectionsAttempted: _metrics.reconnectionsAttempted,
    connectionHealthReconnectionsSucceeded: _metrics.reconnectionsSucceeded,
    connectionHealthReconnectionsFailed: _metrics.reconnectionsFailed,
    connectionHealthPoolUtilization: Math.round(_metrics.poolUtilization * 100),
  };
}

/**
 * Reset health monitor state (for tests).
 */
export function resetHealthMonitorState() {
  _metrics.lastCheckAt = null;
  _metrics.lastCheckDurationMs = null;
  _metrics.lastCheckHealthy = true;
  _metrics.consecutiveFailures = 0;
  _metrics.totalChecks = 0;
  _metrics.totalFailures = 0;
  _metrics.reconnectionsAttempted = 0;
  _metrics.reconnectionsSucceeded = 0;
  _metrics.reconnectionsFailed = 0;
  _metrics.poolUtilization = 0;
  stopHealthMonitor();
}
