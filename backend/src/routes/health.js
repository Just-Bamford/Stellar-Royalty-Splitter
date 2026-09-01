import { Router } from "express";
import {
  getMigrationVersion,
  recordHealthSnapshot,
  pruneHealthHistory,
  getHealthHistory,
  getSLAStats,
  checkDatabase,
} from "../database/index.js";
import * as database from "../database/index.js";
import {
  checkConnectionHealthAsync,
  getHealthStatus,
  getHealthMetrics,
} from "../database/health-monitor.js";

import {
  getConfiguredContractId,
  getNetworkLabel,
  checkHorizonConnectivity,
  checkContractDeploymentStatus,
  checkSorobanConnectivity,
  getCacheStatus,
} from "../stellar.js";
import { recordConnectionHealthCheck } from "../metrics.js";
import logger from "../logger.js";
import { recordDetailedHealthCheck } from "../metrics.js";

export const healthRouter = Router();

const CACHE_TTL_MS = parseInt(process.env.HEALTH_CACHE_TTL_MS ?? "30000", 10);
const RECORD_INTERVAL_MS = parseInt(
  process.env.HEALTH_RECORD_INTERVAL_MS ?? "3600000",
  10
); // 1 hour default
let cachedHealth = null;
let cacheExpiresAt = 0;
let lastRecordedAt = 0;

/**
 * Gather quick DB health metrics — row counts and last-activity timestamp.
 * Wrapped in a try/catch so a DB issue never crashes the health endpoint.
 */
function getDbMetrics() {
  try {
    if (!database.db) return null;
    const txRow = database.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
          MAX(timestamp) AS lastActivity
         FROM transactions`
      )
      .get();

    return {
      transactions: {
        total: txRow.total ?? 0,
        confirmed: txRow.confirmed ?? 0,
        failed: txRow.failed ?? 0,
        pending: txRow.pending ?? 0,
        lastActivity: txRow.lastActivity ?? null,
      },
    };
  } catch (err) {
    logger.warn("Health: failed to gather DB metrics", { error: err.message });
    return null;
  }
}

/**
 * GET /api/v1/health
 * Extended health: DB migration version, network, Horizon (with latency),
 * contract status, and per-component color indicators (#787).
 * Automatically records hourly snapshots to health_history table.
 * Operator health: DB migration version, network, Horizon, contract status,
 * and lightweight DB metrics (#592).
 */
healthRouter.get("/", async (_req, res, next) => {
  try {
    const now = Date.now();
    if (cachedHealth && now < cacheExpiresAt) {
      return res.json(cachedHealth);
    }

    const contractId = getConfiguredContractId();
    const horizonStart = Date.now();
    const [horizon, contract] = await Promise.all([
      checkHorizonConnectivity(),
      checkContractDeploymentStatus(contractId),
    ]);
    const horizonLatencyMs = Date.now() - horizonStart;

    const contractHealthy =
      !contract.configured || (contract.deployed && contract.status !== "error");

    let dbOk = true;
    try {
      getMigrationVersion();
    } catch {
      dbOk = false;
    }
    const dbMetrics = getDbMetrics();

    const body = {
      ok: horizon.connected && contractHealthy && dbOk,
      dbVersion: getMigrationVersion(),
      dbOk,
      network: getNetworkLabel(),
      horizon: {
        ...horizon,
        latencyMs: horizonLatencyMs,
      },
      contract,
      components: {
        database: {
          status: dbOk ? "healthy" : "degraded",
          color: dbOk ? "green" : "red",
        },
        horizon: {
          status: horizon.connected
            ? horizonLatencyMs > 3000
              ? "degraded"
              : "healthy"
            : "down",
          color: horizon.connected
            ? horizonLatencyMs > 3000
              ? "yellow"
              : "green"
            : "red",
          latencyMs: horizonLatencyMs,
        },
        contract: {
          status: !contract.configured
            ? "not_configured"
            : contractHealthy
            ? "healthy"
            : "error",
          color: !contract.configured
            ? "gray"
            : contractHealthy
            ? "green"
            : "red",
        },
      },
      timestamp: new Date().toISOString(),
      ...(dbMetrics && { dbMetrics }),
      generatedAt: new Date().toISOString(),
    };

    // Connection health monitoring (#496)
    try {
      const connHealth = await checkConnectionHealthAsync();
      body.connectionHealth = {
        connected: connHealth.connected,
        durationMs: connHealth.durationMs,
        consecutiveFailures: connHealth.consecutiveFailures,
        pool: connHealth.pool,
      };
    } catch (_) {
      // Health monitor unavailable — don't crash the endpoint
    }

    cachedHealth = body;
    cacheExpiresAt = now + (Number.isNaN(CACHE_TTL_MS) ? 30_000 : CACHE_TTL_MS);

    // Record hourly snapshot (non-blocking — never fails the health check)
    if (now - lastRecordedAt >= RECORD_INTERVAL_MS) {
      lastRecordedAt = now;
      try {
        recordHealthSnapshot({
          ok: body.ok,
          horizonConnected: horizon.connected,
          horizonLatencyMs,
          contractStatus: contract.status ?? "unknown",
          dbOk,
          details: { network: body.network, contractId },
        });
        pruneHealthHistory();
      } catch (err) {
        console.error("Failed to record health snapshot", err);
      }
    }

    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/health/history?hours=24
 * Returns hourly health snapshots for trend analysis (capped at 30 days).
 */
healthRouter.get("/history", async (req, res, next) => {
  try {
    const hours = Math.min(
      parseInt(req.query.hours ?? "24", 10) || 24,
      720 // cap at 30 days
    );
    const history = getHealthHistory(hours);
    res.json({ ok: true, data: history, count: history.length, periodHours: hours });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/health/sla?days=30
 * Returns SLA statistics: uptime %, latency stats, snapshot counts (capped at 365 days).
 */
healthRouter.get("/sla", async (req, res, next) => {
  try {
    const days = Math.min(
      parseInt(req.query.days ?? "30", 10) || 30,
      365
    );
    const sla = getSLAStats(days);
    res.json({ ok: true, data: sla });
  } catch (err) {
    next(err);
  }
});

// ── Detailed health check ─────────────────────────────────────────────────

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_DEGRADED_THRESHOLD_MS = 5_000;

/**
 * Run a single component check with a per-call timeout.
 * Timeout is read dynamically from HEALTH_CHECK_TIMEOUT_MS so tests can
 * override it without reloading the module.
 *
 * Returns one of three statuses:
 *   - "ok":       component is healthy and responding within threshold
 *   - "degraded":  component is healthy but responding slowly (above threshold)
 *   - "error":     component is unhealthy or timed out
 *
 * @param {string} name - Human label used in timeout error messages.
 * @param {() => Promise<object>} fn - The check to run.
 * @param {(result: object) => boolean} [isHealthy] - Custom health predicate.
 *   Defaults to: result.connected !== false && !result.error
 * @returns {{ status: "ok"|"degraded"|"error", responseTimeMs: number, [key: string]: any }}
 */
async function runCheck(name, fn, isHealthy) {
  const timeoutMs = parseInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS ?? String(DEFAULT_HEALTH_CHECK_TIMEOUT_MS),
    10
  );
  const degradedThresholdMs = parseInt(
    process.env.HEALTH_DEGRADED_THRESHOLD_MS ?? String(DEFAULT_HEALTH_DEGRADED_THRESHOLD_MS),
    10
  );
  const start = Date.now();
  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)),
          timeoutMs
        )
      ),
    ]);
    const responseTimeMs = Date.now() - start;
    const defaultHealthy = (r) => r.connected !== false && !r.error;
    const healthy = (isHealthy ?? defaultHealthy)(result);
    // Strip the raw component `status` field so our synthesised statuses
    // are always the authoritative top-level signal (e.g. Soroban returns
    // status: "healthy", contract returns status: "initialized", etc.).
    const { status: _raw, ...rest } = result;

    if (!healthy) {
      return { status: "error", responseTimeMs, ...rest };
    }
    if (responseTimeMs > degradedThresholdMs) {
      return { status: "degraded", responseTimeMs, ...rest };
    }
    return { status: "ok", responseTimeMs, ...rest };
  } catch (err) {
    return {
      status: "error",
      responseTimeMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * GET /api/v1/health/detailed
 * Per-component breakdown: database, Horizon RPC, Soroban RPC, contract state, cache.
 * Each check is independently capped at HEALTH_CHECK_TIMEOUT_MS (default 5 s).
 * Returns 503 when any critical component (database, horizon, soroban) is down.
 */
healthRouter.get("/detailed", async (_req, res, next) => {
  try {
    const contractId = getConfiguredContractId();

    // Contract check needs a custom predicate: no `connected` field, but
    // `deployed` + raw `status` convey health. The predicate sees the raw
    // result before `status` is stripped by runCheck.
    const isContractHealthy = (r) =>
      !r.error &&
      (!r.configured ||
        (r.deployed && r.status !== "error" && r.status !== "unreachable"));

    // All checks run in parallel; each has its own internal timeout.
    const [database, horizon, soroban, contract, connectionHealth] = await Promise.all([
      runCheck("database", () => Promise.resolve(checkDatabase())),
      runCheck("horizon", checkHorizonConnectivity),
      runCheck("soroban", checkSorobanConnectivity),
      runCheck("contract", () => checkContractDeploymentStatus(contractId), isContractHealthy),
      runCheck("connectionHealth", checkConnectionHealthAsync, (r) => r.connected !== false),
    ]);

    // Cache status is synchronous — wrap in the same shape.
    const cacheRaw = getCacheStatus();
    const cacheStart = Date.now();
    const cache = {
      status: "ok",
      responseTimeMs: Date.now() - cacheStart,
      ...cacheRaw,
    };

    // Record Prometheus metrics.
    recordDetailedHealthCheck({
      databaseMs: database.responseTimeMs,
      horizonMs: horizon.responseTimeMs,
      sorobanMs: soroban.responseTimeMs,
      cacheMs: cache.responseTimeMs,
    });

    // Critical: database, horizon, soroban must all be ok or degraded.
    const criticalComponents = [database, horizon, soroban];
    const hasCriticalError = criticalComponents.some((c) => c.status === "error");
    const hasCriticalDegraded = criticalComponents.some((c) => c.status === "degraded");

    // Contract is critical only when configured; not_configured is fine.
    const contractOk = !contract.configured || contract.status === "ok";
    const contractError = contract.configured && contract.status === "error";
    const contractDegraded = contract.configured && contract.status === "degraded";

    // Compute overall status:
    //   - "unhealthy" when any critical component errors or contract errors
    //   - "degraded" when any critical component or contract is degraded
    //   - "healthy" when everything is ok
    let status;
    if (hasCriticalError || contractError) {
      status = "unhealthy";
    } else if (hasCriticalDegraded || contractDegraded) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    const ok = status !== "unhealthy";

    const body = {
      ok,
      status,
      network: getNetworkLabel(),
      checkedAt: new Date().toISOString(),
      components: { database, horizon, soroban, contract, cache, connectionHealth },
    };

    res.status(ok ? 200 : 503).json(body);
  } catch (err) {
    next(err);
  }
});

/** Reset cached health (for tests). */
export function clearHealthCache() {
  cachedHealth = null;
  cacheExpiresAt = 0;
  lastRecordedAt = 0;
}
