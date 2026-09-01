import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock better-sqlite3 so the pool doesn't open real DB files
const mockPragma = jest.fn();
const mockClose = jest.fn();

await jest.unstable_mockModule("better-sqlite3", () => {
  function MockDatabase() {
    this.pragma = mockPragma;
    this.close = mockClose;
  }
  return { default: MockDatabase };
});

await jest.unstable_mockModule("../src/logger.js", () => ({
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const { pool } = await import("../src/database/pool.js");

describe("SqlitePool (via exported pool singleton)", () => {
  beforeEach(() => {
    // Reset metrics between tests
    pool.metrics.acquires = 0;
    pool.metrics.activeConnections = 0;
    pool.metrics.queueLength = 0;
    pool.metrics.timeouts = 0;
    pool.metrics.totalWaitMs = 0;
  });

  test("acquire returns a connection immediately when pool has free slots", async () => {
    const conn = await pool.acquire();
    expect(conn).toBeDefined();
    pool.release(conn);
  });

  test("metrics.acquires increments on each acquire", async () => {
    const conn = await pool.acquire();
    expect(pool.metrics.acquires).toBe(1);
    pool.release(conn);
  });

  test("activeConnections increments after acquire and decrements after release", async () => {
    const conn = await pool.acquire();
    expect(pool.metrics.activeConnections).toBeGreaterThan(0);
    pool.release(conn);
    expect(pool.metrics.activeConnections).toBe(0);
  });

  test("run() executes fn with a connection and releases it", async () => {
    const result = await pool.run(async (conn) => {
      expect(conn).toBeDefined();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(pool.metrics.activeConnections).toBe(0);
  });

  test("run() releases connection even if fn throws", async () => {
    await expect(
      pool.run(async () => { throw new Error("fn error"); }),
    ).rejects.toThrow("fn error");
    expect(pool.metrics.activeConnections).toBe(0);
  });

  test("getMetrics() returns pool state shape", () => {
    const m = pool.getMetrics();
    expect(m).toHaveProperty("poolSize");
    expect(m).toHaveProperty("available");
    expect(m).toHaveProperty("activeConnections");
    expect(m).toHaveProperty("draining");
    expect(m).toHaveProperty("acquires");
    expect(typeof m.poolSize).toBe("number");
    expect(typeof m.draining).toBe("boolean");
  });

  test("concurrent run() calls all complete without error", async () => {
    const results = await Promise.all([
      pool.run(async () => "a"),
      pool.run(async () => "b"),
      pool.run(async () => "c"),
    ]);
    expect(results.sort()).toEqual(["a", "b", "c"]);
    expect(pool.metrics.activeConnections).toBe(0);
  });
});
