/**
 * SQLite connection pool for concurrent request handling (#763).
 *
 * better-sqlite3 is synchronous and single-connection. Under load,
 * concurrent requests queue behind a single lock. This module wraps the
 * existing `db` singleton with a lightweight async-queue so callers
 * can await database work without Node's event loop stalling.
 *
 * Design:
 *   - A fixed-size set of `better-sqlite3` connections share the same WAL file.
 *   - Each `acquire()` call checks out a connection or waits in a FIFO queue.
 *   - `release()` returns the connection and dispatches the next waiter.
 *   - Connections are lazily created up to `SQLITE_POOL_SIZE`.
 *   - Pool drains gracefully on shutdown: no new acquires; in-flight work completes.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POOL_SIZE = Math.max(
  1,
  parseInt(process.env.SQLITE_POOL_SIZE ?? "5", 10),
);
const CONNECTION_TIMEOUT_MS = parseInt(
  process.env.SQLITE_CONNECTION_TIMEOUT_MS ?? "5000",
  10,
);
const DB_PATH =
  process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

function applyPragmas(conn) {
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("cache_size = -16000");
  conn.pragma("foreign_keys = ON");
  conn.pragma("temp_store = MEMORY");
}

class SqlitePool {
  #connections = [];
  #available = [];
  #waiters = [];
  #draining = false;

  /** Pool utilisation metrics */
  metrics = {
    poolSize: POOL_SIZE,
    activeConnections: 0,
    queueLength: 0,
    totalWaitMs: 0,
    timeouts: 0,
    acquires: 0,
  };

  constructor() {
    // Pre-create all connections eagerly so the first requests don't pay
    // the connection-creation cost under load.
    for (let i = 0; i < POOL_SIZE; i++) {
      const conn = new Database(DB_PATH);
      applyPragmas(conn);
      this.#connections.push(conn);
      this.#available.push(conn);
    }
    logger.info(
      `SQLite connection pool initialised: size=${POOL_SIZE} timeout=${CONNECTION_TIMEOUT_MS}ms`,
    );
  }

  /**
   * Acquire a connection. Resolves immediately if one is free, otherwise
   * queues and resolves when a connection becomes available, or rejects
   * after CONNECTION_TIMEOUT_MS.
   */
  acquire() {
    if (this.#draining) {
      return Promise.reject(new Error("Pool is draining — no new connections accepted"));
    }

    this.metrics.acquires++;

    if (this.#available.length > 0) {
      const conn = this.#available.pop();
      this.metrics.activeConnections++;
      return Promise.resolve(conn);
    }

    // No free connection — queue the waiter
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      this.metrics.queueLength++;

      const timer = setTimeout(() => {
        const idx = this.#waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        this.metrics.queueLength--;
        this.metrics.timeouts++;
        reject(
          new Error(
            `Database connection pool timeout after ${CONNECTION_TIMEOUT_MS}ms`,
          ),
        );
      }, CONNECTION_TIMEOUT_MS);

      this.#waiters.push({
        resolve: (conn) => {
          clearTimeout(timer);
          this.metrics.queueLength--;
          this.metrics.totalWaitMs += Date.now() - startedAt;
          this.metrics.activeConnections++;
          resolve(conn);
        },
        reject,
      });
    });
  }

  /**
   * Return a previously acquired connection to the pool.
   */
  release(conn) {
    this.metrics.activeConnections--;
    if (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter.resolve(conn);
    } else {
      this.#available.push(conn);
    }
  }

  /**
   * Run `fn(conn)` with an automatically managed connection.
   * Releases the connection even if `fn` throws.
   */
  async run(fn) {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Stop accepting new acquires and close all connections once all in-flight
   * work has returned connections to the pool.
   */
  async drain() {
    this.#draining = true;
    logger.info("SQLite pool draining — waiting for active connections");

    return new Promise((resolve) => {
      const check = () => {
        if (this.metrics.activeConnections === 0) {
          for (const conn of this.#connections) {
            try {
              conn.pragma("wal_checkpoint(TRUNCATE)");
              conn.close();
            } catch (_) { /* best-effort */ }
          }
          logger.info("SQLite pool drained and closed");
          resolve();
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * Clear the one-way draining flag.
   *
   * Used by tests to keep the draining state from leaking between test
   * cases, and by `reinitialize()` after the automatic-reconnection path
   * has rebuilt the pool (without it, the post-drain health probe would
   * permanently report "Pool is draining" and reconnection could never
   * succeed).
   */
  resetDraining() {
    this.#draining = false;
  }

  /**
   * Rebuild the pool with fresh connections.
   *
   * Used by the automatic-reconnection path (health-monitor's
   * `attemptReconnection`) after a drain: the drained connections are
   * closed, the draining flag is cleared, and POOL_SIZE brand-new
   * connections are created so the pool accepts acquires again.
   */
  reinitialize() {
    for (const conn of this.#connections) {
      try {
        conn.close();
      } catch (_) { /* best-effort */ }
    }
    this.#connections = [];
    this.#available = [];
    // Defensive: any waiter still queued (drain normally guarantees none)
    // is rejected rather than left hanging forever.
    for (const waiter of this.#waiters) {
      try {
        waiter.reject(new Error("Connection pool was reinitialised"));
      } catch (_) { /* best-effort */ }
    }
    this.#waiters = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      const conn = new Database(DB_PATH);
      applyPragmas(conn);
      this.#connections.push(conn);
      this.#available.push(conn);
    }
    this.#draining = false;
  }

  getMetrics() {
    return {
      ...this.metrics,
      poolSize: POOL_SIZE,
      available: this.#available.length,
      draining: this.#draining,
    };
  }
}

export const pool = new SqlitePool();
