import { describe, test, expect, afterEach } from "@jest/globals";
import { ConnectionPool, POOL_MIN, POOL_MAX, ACQUIRE_TIMEOUT_MS } from "../src/database/pool.js";

// better-sqlite3 is mocked via __mocks__/better-sqlite3.js — no native binary loaded.
// Tests exercise pool accounting and concurrency logic, not SQLite internals.

describe("ConnectionPool — initialization", () => {
  let pool;

  afterEach(() => { pool?.close(); });

  test("creates POOL_MIN connections on initialize()", () => {
    pool = new ConnectionPool(":memory:", { min: 5, max: 20 }).initialize();
    expect(pool.size).toBe(5);
  });

  test("all connections are available immediately after initialization", () => {
    pool = new ConnectionPool(":memory:", { min: 5, max: 20 }).initialize();
    expect(pool.availableCount).toBe(5);
  });

  test("respects custom min connections", () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 10 }).initialize();
    expect(pool.size).toBe(2);
  });

  test("metrics.created matches min connections after init", () => {
    pool = new ConnectionPool(":memory:", { min: 3, max: 10 }).initialize();
    const m = pool.getMetrics();
    expect(m.created).toBe(3);
    expect(m.poolSize).toBe(3);
  });

  test("POOL_MIN is 5", () => {
    expect(POOL_MIN).toBe(5);
  });

  test("POOL_MAX is 20", () => {
    expect(POOL_MAX).toBe(20);
  });

  test("ACQUIRE_TIMEOUT_MS is a positive number", () => {
    expect(ACQUIRE_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("ConnectionPool — acquire and release", () => {
  let pool;

  afterEach(() => { pool.close(); });

  test("acquire() resolves immediately when connections are available", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 100 }).initialize();
    const conn = await pool.acquire();
    expect(conn).toBeDefined();
    pool.release(conn);
  });

  test("acquire() reduces availableCount by 1", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 100 }).initialize();
    const before = pool.availableCount;
    const conn = await pool.acquire();
    expect(pool.availableCount).toBe(before - 1);
    pool.release(conn);
  });

  test("release() returns connection to the available pool", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 100 }).initialize();
    const conn = await pool.acquire();
    const beforeRelease = pool.availableCount;
    pool.release(conn);
    expect(pool.availableCount).toBe(beforeRelease + 1);
  });

  test("acquire() creates a new connection on-demand when available pool is drained", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 100 }).initialize();
    const c1 = await pool.acquire();
    const c2 = await pool.acquire();
    expect(pool.availableCount).toBe(0);

    const c3 = await pool.acquire();
    expect(c3).toBeDefined();
    expect(pool.size).toBeGreaterThan(2);

    pool.release(c1);
    pool.release(c2);
    pool.release(c3);
  });

  test("acquire() queues request when at max capacity and resolves on release", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 500 }).initialize();
    const connections = [];
    for (let i = 0; i < 5; i++) {
      connections.push(await pool.acquire());
    }
    expect(pool.size).toBe(5);
    expect(pool.availableCount).toBe(0);

    const pending = pool.acquire();
    expect(pool.waitingCount).toBe(1);

    pool.release(connections.pop());

    const conn = await pending;
    expect(conn).toBeDefined();
    for (const c of connections) pool.release(c);
    pool.release(conn);
  });

  test("acquire() rejects with timeout error when max pool is fully saturated", async () => {
    pool = new ConnectionPool(":memory:", { min: 1, max: 1, acquireTimeoutMs: 50 }).initialize();
    const conn = await pool.acquire();

    await expect(pool.acquire()).rejects.toThrow(/timed out/i);
    pool.release(conn);
  });

  test("metrics.acquired and metrics.released increment on each acquire/release cycle", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 100 }).initialize();
    const c = await pool.acquire();
    pool.release(c);
    const m = pool.getMetrics();
    expect(m.acquired).toBeGreaterThanOrEqual(1);
    expect(m.released).toBeGreaterThanOrEqual(1);
  });
});

describe("ConnectionPool — health checks", () => {
  let pool;

  afterEach(() => { pool.close(); });

  test("healthCheck() returns all connections as passed when pool is healthy", () => {
    pool = new ConnectionPool(":memory:", { min: 3, max: 10 }).initialize();
    const result = pool.healthCheck();
    expect(result.passed).toBe(pool.size);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(pool.size);
  });

  test("healthCheck() increments healthChecksPassed metric", () => {
    pool = new ConnectionPool(":memory:", { min: 3, max: 10 }).initialize();
    pool.healthCheck();
    const m = pool.getMetrics();
    expect(m.healthChecksPassed).toBeGreaterThanOrEqual(3);
  });
});

describe("ConnectionPool — metrics export", () => {
  let pool;

  afterEach(() => { pool?.close(); });

  test("getMetrics() returns all required fields", () => {
    pool = new ConnectionPool(":memory:", { min: 5, max: 20 }).initialize();
    const m = pool.getMetrics();
    expect(m).toHaveProperty("created");
    expect(m).toHaveProperty("acquired");
    expect(m).toHaveProperty("released");
    expect(m).toHaveProperty("timeouts");
    expect(m).toHaveProperty("healthChecksPassed");
    expect(m).toHaveProperty("healthChecksFailed");
    expect(m).toHaveProperty("poolSize");
    expect(m).toHaveProperty("available");
    expect(m).toHaveProperty("waiting");
    expect(m).toHaveProperty("minConnections");
    expect(m).toHaveProperty("maxConnections");
  });

  test("minConnections and maxConnections reflect constructor arguments", () => {
    pool = new ConnectionPool(":memory:", { min: 5, max: 20 }).initialize();
    const m = pool.getMetrics();
    expect(m.minConnections).toBe(5);
    expect(m.maxConnections).toBe(20);
  });

  test("metrics.timeouts increments when an acquire times out at max capacity", async () => {
    pool = new ConnectionPool(":memory:", { min: 1, max: 1, acquireTimeoutMs: 50 }).initialize();
    const conn = await pool.acquire();

    await expect(pool.acquire()).rejects.toThrow(/timed out/i);
    expect(pool.getMetrics().timeouts).toBe(1);
    pool.release(conn);
  });
});

describe("ConnectionPool — concurrent load tests", () => {
  let pool;

  afterEach(() => { pool?.close(); });

  test("100 sequential acquire/release cycles complete without errors", async () => {
    pool = new ConnectionPool(":memory:", { min: 5, max: 20 }).initialize();

    for (let i = 0; i < 100; i++) {
      const conn = await pool.acquire();
      pool.release(conn);
    }

    const m = pool.getMetrics();
    expect(m.acquired).toBe(100);
    expect(m.released).toBe(100);
  });

  test("10 concurrent acquires all resolve when pool min ≥ 10", async () => {
    pool = new ConnectionPool(":memory:", { min: 10, max: 20 }).initialize();
    const acquires = Array.from({ length: 10 }, () => pool.acquire());
    const connections = await Promise.all(acquires);

    expect(connections).toHaveLength(10);
    for (const c of connections) pool.release(c);
  });

  test("pool recovers after full saturation — subsequent requests resolve once slots free", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 3, acquireTimeoutMs: 500 }).initialize();

    const conns = [];
    for (let i = 0; i < 3; i++) {
      conns.push(await pool.acquire());
    }

    const pending = conns.map(() => pool.acquire().catch((e) => e));

    for (const c of conns) pool.release(c);

    const results = await Promise.all(pending);
    const errors = results.filter((r) => r instanceof Error);
    expect(errors).toHaveLength(0);
    for (const r of results) pool.release(r);
  });

  test("pool size does not exceed max connections under load", async () => {
    pool = new ConnectionPool(":memory:", { min: 2, max: 5, acquireTimeoutMs: 500 }).initialize();

    const conns = [];
    for (let i = 0; i < 5; i++) {
      conns.push(await pool.acquire());
    }

    expect(pool.size).toBeLessThanOrEqual(5);
    for (const c of conns) pool.release(c);
  });
});
