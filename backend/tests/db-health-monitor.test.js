import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPragma = jest.fn();
const mockClose = jest.fn();
const mockPrepare = jest.fn();

// Track whether the db probe succeeds or fails
let dbProbeError = null;

await jest.unstable_mockModule("better-sqlite3", () => {
  function MockDatabase() {
    this.pragma = mockPragma;
    this.close = mockClose;
    this.prepare = (sql) => ({
      run: jest.fn(),
      get: (...args) => {
        if (dbProbeError) throw dbProbeError;
        return { health_check: 1 };
      },
      all: () => [],
    });
  }
  return { default: MockDatabase };
});

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
  asyncLocalStorage: { getStore: () => ({}) },
}));

const logger = (await import("../src/logger.js")).default;
const { pool } = await import("../src/database/pool.js");

// Import the health monitor after mocks are set up
const {
  checkConnectionHealth,
  checkConnectionHealthAsync,
  attemptReconnection,
  startHealthMonitor,
  stopHealthMonitor,
  getHealthStatus,
  getHealthMetrics,
  resetHealthMonitorState,
} = await import("../src/database/health-monitor.js");

// ── Test helpers ───────────────────────────────────────────────────────────

function resetPool() {
  pool.metrics.acquires = 0;
  pool.metrics.activeConnections = 0;
  pool.metrics.queueLength = 0;
  pool.metrics.timeouts = 0;
  pool.metrics.totalWaitMs = 0;
  // `drain()` is one-way; rebuild the pool so a drained state in one test
  // does not make every later acquire() reject with "Pool is draining".
  pool.reinitialize?.();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Database connection health monitor (#496)", () => {
  beforeEach(() => {
    resetPool();
    resetHealthMonitorState();
    dbProbeError = null;
    jest.clearAllMocks();
  });

  afterEach(() => {
    stopHealthMonitor();
  });

  // ── Success path ──────────────────────────────────────────────────────

  describe("successful health check", () => {
    test("checkConnectionHealth returns healthy status", () => {
      const result = checkConnectionHealth();

      expect(result.connected).toBe(true);
      expect(result.error).toBeNull();
      expect(typeof result.durationMs).toBe("number");
      expect(result.lastCheckAt).toBeTruthy();
      expect(result.consecutiveFailures).toBe(0);
      expect(result.pool).toBeDefined();
      expect(typeof result.pool.poolSize).toBe("number");
      expect(typeof result.pool.utilization).toBe("number");
    });

    test("checkConnectionHealthAsync returns healthy status", async () => {
      const result = await checkConnectionHealthAsync();

      expect(result.connected).toBe(true);
      expect(result.error).toBeNull();
      expect(typeof result.durationMs).toBe("number");
      expect(result.pool.utilization).toBe(0);
    });

    test("pool metrics are reported in health check", () => {
      const conn = pool.acquire();
      pool.release(conn);

      const result = checkConnectionHealth();

      expect(result.pool.poolSize).toBeGreaterThan(0);
      expect(result.pool.acquires).toBe(1);
    });

    test("totalChecks increments on each call", () => {
      checkConnectionHealth();
      checkConnectionHealth();
      const status = getHealthStatus();

      expect(status.totalChecks).toBe(2);
    });
  });

  // ── Failure paths ─────────────────────────────────────────────────────

  describe("failure paths", () => {
    test("detects database probe failure", async () => {
      dbProbeError = new Error("Database is locked");

      const result = await checkConnectionHealthAsync();

      expect(result.connected).toBe(false);
      expect(result.error).toBe("Database is locked");
    });

    test("detects pool draining state", async () => {
      // Force pool into draining state — we'll drain it
      await pool.drain();

      const result = await checkConnectionHealthAsync();

      expect(result.connected).toBe(false);
      expect(result.error).toBe("Pool is draining");
    });

    test("detects high connection timeout rate", async () => {
      pool.metrics.timeouts = 5;
      pool.metrics.acquires = 10;

      const result = await checkConnectionHealthAsync();

      expect(result.connected).toBe(false);
      expect(result.error).toContain("High timeout rate");
      expect(result.error).toContain("50%");
    });

    test("consecutive failures increment correctly", async () => {
      dbProbeError = new Error("Connection lost");

      await checkConnectionHealthAsync();
      await checkConnectionHealthAsync();
      await checkConnectionHealthAsync();

      const status = getHealthStatus();
      expect(status.consecutiveFailures).toBe(3);
      expect(status.totalFailures).toBe(3);
    });

    test("consecutive failures reset on recovery", async () => {
      dbProbeError = new Error("Connection lost");
      await checkConnectionHealthAsync();
      expect(getHealthStatus().consecutiveFailures).toBe(1);

      dbProbeError = null;
      await checkConnectionHealthAsync();
      expect(getHealthStatus().consecutiveFailures).toBe(0);
    });

    test("first failure logs error alert", async () => {
      dbProbeError = new Error("Connection lost");
      await checkConnectionHealthAsync();

      expect(logger.error).toHaveBeenCalledWith(
        "Database connection problem detected",
        expect.objectContaining({ error: "Connection lost" }),
      );
    });

    test("escalating alert every 5 consecutive failures", async () => {
      dbProbeError = new Error("Connection lost");

      for (let i = 0; i < 10; i++) {
        await checkConnectionHealthAsync();
      }

      const escalationCalls = logger.error.mock.calls.filter(
        (c) => c[0] === "Database connection still failing — escalating alert",
      );
      expect(escalationCalls.length).toBe(2); // at failures 5 and 10
    });
  });

  // ── Pool utilization tracking ──────────────────────────────────────────

  describe("pool utilization tracking", () => {
    test("reports 0% utilization when pool is idle", () => {
      const result = checkConnectionHealth();
      expect(result.pool.utilization).toBe(0);
    });

    test("reports correct utilization with active connections", () => {
      const conn1 = pool.acquire();
      const conn2 = pool.acquire();

      const result = checkConnectionHealth();
      // poolSize is 5 by default, 2 active = 40%
      expect(result.pool.utilization).toBe(
        Math.round((2 / result.pool.poolSize) * 100),
      );

      pool.release(conn1);
      pool.release(conn2);
    });
  });

  // ── Reconnection ──────────────────────────────────────────────────────

  describe("automatic reconnection", () => {
    test("attemptReconnection returns true when probe succeeds after drain", async () => {
      const result = await attemptReconnection();
      expect(result).toBe(true);

      const metrics = getHealthStatus();
      expect(metrics.reconnectionsAttempted).toBe(1);
      expect(metrics.reconnectionsSucceeded).toBe(1);
    });

    test("attemptReconnection increments failure counter on probe failure", async () => {
      dbProbeError = new Error("Cannot reconnect");

      const result = await attemptReconnection();

      // drain succeeds but health check fails
      expect(result).toBe(false);
      const metrics = getHealthStatus();
      expect(metrics.reconnectionsAttempted).toBe(1);
      expect(metrics.reconnectionsFailed).toBe(1);
    });

    test("startHealthMonitor does not start twice", () => {
      startHealthMonitor();
      startHealthMonitor(); // second call is a no-op
      const status = getHealthStatus();
      expect(status.isRunning).toBe(true);
      stopHealthMonitor();
    });

    test("stopHealthMonitor stops the monitor", () => {
      startHealthMonitor();
      stopHealthMonitor();
      const status = getHealthStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  // ── Metrics export ─────────────────────────────────────────────────────

  describe("metrics export", () => {
    test("getHealthMetrics returns all required fields", () => {
      checkConnectionHealth();
      const metrics = getHealthMetrics();

      expect(metrics).toHaveProperty("connectionHealthTotalChecks");
      expect(metrics).toHaveProperty("connectionHealthTotalFailures");
      expect(metrics).toHaveProperty("connectionHealthConsecutiveFailures");
      expect(metrics).toHaveProperty("connectionHealthLastCheckDurationMs");
      expect(metrics).toHaveProperty("connectionHealthReconnectionsAttempted");
      expect(metrics).toHaveProperty("connectionHealthReconnectionsSucceeded");
      expect(metrics).toHaveProperty("connectionHealthReconnectionsFailed");
      expect(metrics).toHaveProperty("connectionHealthPoolUtilization");
    });

    test("getHealthStatus returns full status", () => {
      checkConnectionHealth();
      const status = getHealthStatus();

      expect(status).toHaveProperty("lastCheckAt");
      expect(status).toHaveProperty("lastCheckDurationMs");
      expect(status).toHaveProperty("lastCheckHealthy");
      expect(status).toHaveProperty("consecutiveFailures");
      expect(status).toHaveProperty("totalChecks");
      expect(status).toHaveProperty("totalFailures");
      expect(status).toHaveProperty("isRunning");
    });

    test("resetHealthMonitorState clears all counters", () => {
      dbProbeError = new Error("fail");
      checkConnectionHealth();
      resetHealthMonitorState();

      const status = getHealthStatus();
      expect(status.totalChecks).toBe(0);
      expect(status.totalFailures).toBe(0);
      expect(status.consecutiveFailures).toBe(0);
      expect(status.reconnectionsAttempted).toBe(0);
      expect(status.isRunning).toBe(false);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────

  describe("edge cases", () => {
    test("zero timeout rate does not trigger failure", () => {
      pool.metrics.timeouts = 0;
      pool.metrics.acquires = 100;

      const result = checkConnectionHealth();
      expect(result.connected).toBe(true);
    });

    test("10% timeout rate does not trigger failure", () => {
      pool.metrics.timeouts = 1;
      pool.metrics.acquires = 10;

      const result = checkConnectionHealth();
      expect(result.connected).toBe(true);
    });

    test("11% timeout rate triggers failure", () => {
      pool.metrics.timeouts = 2;
      pool.metrics.acquires = 18; // 2/18 ≈ 11.1%

      const result = checkConnectionHealth();
      expect(result.connected).toBe(false);
      expect(result.error).toContain("High timeout rate");
    });

    test("health check records probe duration", () => {
      const result = checkConnectionHealth();
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("pool utilization is clamped to integer percentage", () => {
      const conn = pool.acquire();
      const result = checkConnectionHealth();
      // Should be a clean integer (e.g., 20, 40, 60)
      expect(Number.isInteger(result.pool.utilization)).toBe(true);
      pool.release(conn);
    });
  });
});
