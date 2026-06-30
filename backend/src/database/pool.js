import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const POOL_MIN = 5;
export const POOL_MAX = 20;
export const ACQUIRE_TIMEOUT_MS = 5_000;

/**
 * Connection pool for better-sqlite3.
 *
 * Maintains a bounded set of pre-opened database connections. Callers
 * acquire a connection, use it synchronously, then release it back to
 * the pool. When all connections are busy a waiter queue is used, and
 * new connections are created on-demand up to `max`. If the pool is
 * saturated, acquire() rejects after `acquireTimeoutMs`.
 *
 * In WAL mode, multiple readers can run concurrently on separate connections
 * even though better-sqlite3 is synchronous per connection.
 */
export class ConnectionPool {
  #dbPath;
  #min;
  #max;
  #acquireTimeoutMs;
  #connections = [];
  #available = [];
  #waitQueue = [];
  #metrics = {
    created: 0,
    acquired: 0,
    released: 0,
    timeouts: 0,
    healthChecksPassed: 0,
    healthChecksFailed: 0,
  };

  constructor(dbPath, options = {}) {
    this.#dbPath = dbPath;
    this.#min = options.min ?? POOL_MIN;
    this.#max = options.max ?? POOL_MAX;
    this.#acquireTimeoutMs = options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS;
  }

  initialize() {
    for (let i = 0; i < this.#min; i++) {
      this.#createConnection();
    }
    return this;
  }

  #createConnection() {
    const db = new Database(this.#dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -64000");
    db.pragma("temp_store = MEMORY");
    this.#connections.push(db);
    this.#available.push(db);
    this.#metrics.created++;
    return db;
  }

  acquire() {
    if (this.#available.length > 0) {
      const conn = this.#available.pop();
      this.#metrics.acquired++;
      return Promise.resolve(conn);
    }

    if (this.#connections.length < this.#max) {
      const conn = this.#createConnection();
      this.#available.pop();
      this.#metrics.acquired++;
      return Promise.resolve(conn);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#metrics.timeouts++;
        const idx = this.#waitQueue.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.#waitQueue.splice(idx, 1);
        reject(new Error(`Connection pool acquire timed out after ${this.#acquireTimeoutMs}ms`));
      }, this.#acquireTimeoutMs);

      this.#waitQueue.push({ resolve, reject, timer });
    });
  }

  release(conn) {
    const waiter = this.#waitQueue.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(conn);
      this.#metrics.acquired++;
      this.#metrics.released++;
    } else {
      this.#available.push(conn);
      this.#metrics.released++;
    }
  }

  healthCheck() {
    const results = { passed: 0, failed: 0, total: this.#connections.length };
    for (const conn of this.#connections) {
      try {
        conn.prepare("SELECT 1").get();
        results.passed++;
        this.#metrics.healthChecksPassed++;
      } catch (err) {
        results.failed++;
        this.#metrics.healthChecksFailed++;
        logger.warn("Connection health check failed", { error: err.message });
      }
    }
    return results;
  }

  getMetrics() {
    return {
      ...this.#metrics,
      poolSize: this.#connections.length,
      available: this.#available.length,
      waiting: this.#waitQueue.length,
      minConnections: this.#min,
      maxConnections: this.#max,
    };
  }

  close() {
    for (const waiter of this.#waitQueue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Pool is closing"));
    }
    this.#waitQueue = [];

    for (const conn of this.#connections) {
      try {
        conn.close?.();
      } catch (err) {
        logger.warn("Error closing pooled connection", { error: err.message });
      }
    }
    this.#connections = [];
    this.#available = [];
  }

  get size() { return this.#connections.length; }
  get availableCount() { return this.#available.length; }
  get waitingCount() { return this.#waitQueue.length; }
}

const dbPath =
  process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

export const pool = new ConnectionPool(dbPath, {
  min: POOL_MIN,
  max: POOL_MAX,
  acquireTimeoutMs: ACQUIRE_TIMEOUT_MS,
}).initialize();

export default pool;
