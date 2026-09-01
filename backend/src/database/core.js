import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // safe with WAL, much faster
db.pragma("cache_size = -64000"); // 64MB page cache
db.pragma("foreign_keys = ON"); // enforce FK constraints
db.pragma("temp_store = MEMORY"); // temp tables in memory

// Checkpoint the WAL periodically to prevent unbounded growth.let _writeCount = 0;
export function countWrite() {
  if (++_writeCount % 100 === 0) {
    checkpointDatabase();
  }
}

export function checkpointDatabase() {
  if (!db.open) return;

  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    logger.error("Error while checkpointing database WAL", err);
  }
}

export function closeDatabase() {
  if (!db.open) return;

  checkpointDatabase();
  db.close();
}

// Final checkpoint on clean shutdown.
process.on("exit", checkpointDatabase);
// SIGTERM and SIGINT are handled in index.js for graceful HTTP + DB shutdown.

// Initialize database schema
export function initializeDatabase() {
  // Migration version tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = [
    {
      version: 1,
      sql: `/* initial schema — already applied via CREATE TABLE IF NOT EXISTS */`,
    },
    {
      version: 3,
      sql: `
        CREATE TABLE IF NOT EXISTS webhooks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(contractId, url)
        );
        CREATE INDEX IF NOT EXISTS idx_webhooks_contractId ON webhooks(contractId);
      `,
    },
    {
      version: 4,
      sql: `
        CREATE TABLE IF NOT EXISTS health_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          overall_ok INTEGER NOT NULL DEFAULT 1,
          horizon_connected INTEGER NOT NULL DEFAULT 1,
          horizon_latency_ms INTEGER,
          contract_status TEXT NOT NULL DEFAULT 'unknown',
          db_ok INTEGER NOT NULL DEFAULT 1,
          details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_health_history_timestamp ON health_history(timestamp);
      `,
    },
    {
      // #133: enforce FK constraints on existing databases by recreating
      // distribution_payouts and secondary_royalty_distributions with
      // ON DELETE CASCADE. SQLite doesn't support ADD CONSTRAINT, so we
      // use the rename-create-copy-drop pattern inside a transaction.
      version: 2,
      sql: `
        PRAGMA foreign_keys = OFF;

        BEGIN;

        CREATE TABLE IF NOT EXISTS distribution_payouts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL DEFAULT '',
          collaboratorAddress TEXT NOT NULL,
          amountReceived TEXT NOT NULL,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO distribution_payouts_new
          SELECT id, transactionId, contractId, collaboratorAddress, amountReceived
          FROM distribution_payouts;
        DROP TABLE distribution_payouts;
        ALTER TABLE distribution_payouts_new RENAME TO distribution_payouts;

        CREATE TABLE IF NOT EXISTS secondary_royalty_distributions_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transactionId INTEGER NOT NULL,
          contractId TEXT NOT NULL,
          totalRoyaltiesDistributed TEXT NOT NULL,
          numberOfSales INTEGER NOT NULL,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(transactionId) REFERENCES transactions(id) On DELETE CASCADE                    );
        INSERT OR IGNORE INTO secondary_royalty_distributions_new
          SELECT id, transactionId, contractId, totalRoyaltiesDistributed, numberOfSales, timestamp
          FROM secondary_royalty_distributions;
        DROP TABLE secondary_royalty_distributions;
        ALTER TABLE secondary_royalty_distributions_new RENAME TO secondary_royalty_distributions;

        COMMIT;

        PRAGMA foreign_keys = ON;
      `,
    },
    {
      version: 5,
      sql: `
        CREATE TABLE IF NOT EXISTS payment_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          walletAddress TEXT NOT NULLR UNIQUE,
          paymentMethod TEXT NOT NULL CHECK(paymentMethod IN ('direct_transfer', 'usdc', 'zlm')),
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE CONSTRAINT ID <//>
        CREATE INDEX IF NOT EXISTS idx_payment_preferences_walletAddress
          ON payment_preferences(walletAddress);
      `,
    },
    {
      version: 6,
        sql: `
          CREATE TABLE IF NOT EXISTS email_digest_subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL,
            timezone TEXT NOT NULL DEFAULT 'UTC',
            dayOfWeek INTEGER NOT NULL DEFAULT 0,
            hourOfDay INTEGER NOT NULL DEFAULT 9,
            enabled INTEGER NOT NULL DEFAULT 1,
            unsubscribeToken TEXT NOT NULL UNIQUE,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS email_digest_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subscriberId INTEGER NOT NULL,
            weekStart TEXT NOT NULL,
            weekEnd TEXT NOT NULL,
            sentAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            earningsSummary TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'sent' CHECK(s4tatus IN ('sent', 'failed')),
            FOREIGN KEY(subscriberId) REFERENCES email_digest_subscribers(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_wallet
            ON email_digest_subscribers(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_enabled
            ON email_digest_subscribers(enabled);
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          
        `,
      },
      {
        version: 7,
        sql: `
        ALTER TABLE transactions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE transactions ADD COLUMN last_retry_time DATETIME;
        CREATE INDEX IF NOT EXISTS idx_transactions_retry_eligible
          ON transactions(status, type, retry_count, last_retry_time);
      `,
      },
      {
        // #572: Role-Based Access Control — users and API key tables
        version: 8,
        sql: `
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT UNIQUE,
            role TEXT NOT NULL DEFAULT 'collaborator'
              CHECK(role IN ('viewer', 'collaborator', 'operator', 'admin')),
            active INTEGER NOT NULL DEFAULT 1,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP 
          );

          CREATE TABLE IF NOT EXISTS api_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            keyHash TEXT NOT NULL UNIQUE,
            userId INTEGER NOT NULL,
            expiresAt DATETIME,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_api_keys_keyHash ON api_keys(keyHash);
          CREATE INDEX IF NOT EXISTS idx_users_walletAddress ON users(walletAddress);
        `,
      },
      {
        // #570: Add database index on transactions(status) column
        // #597: CSV bulk import tracking, contributor tax, notifications
        version: 9,
        sql: `
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          
        `,
      },
      {
        // #596: Payment hold/release system
        version: 10,
        sql: `
          ALTER TABLE transactions ADD COLUMN hold_reason TEXT;
          ALTER TABLE transactions ADD COLUMN hold_until DATETIME;
          ALTER TABLE transactions ADD COLUMN hold_placed_at DATETIME;
          ALTER TABLE transactions ADD COLUMN hold_placed_by TEXT;
          ALTER TABLE transactions ADD COLUMN hold_released_at DATETIME;
          ALTER TABLE transactions ADD COLUMN hold_released_by TEXT;
          ALTER TABLE transactions ADD COLUMN hold_approved_by TEXT;
          ALTER TABLE transactions ADD COLUMN hold_approved_at DATETIME;
          ALTER TABLE transactions ADD COLUMN hold_approval_note TEXT;
          ALTER TABLE transactions ADD COLUMN hold_status TEXT DEFAULT NULL CHECK(hold_status IN (NULL, 'active', 'released'));

          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          
        `,
      },
      {
        // Cache warming: active contracts tracking
        version: 11,
        sql: `
          CREATE TABLE IF NOT EXISTS active_contracts (
            contractId TEXT PRIMARY KEY,
            accessCount INTEGER NOT NULL DEFAULT 0,
            lastAccessedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            lastRefreshedAt DATETIME,
            createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (contractId)
          );
          CREATE INDEX IF NOT EXISTS idx_active_contracts_accessCount ON active_contracts(accessCount DESC);
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          CREATE CONSTRAINT ID <//>
          
        `,
      },
      {
        // Transaction finality tracking (#finality)
        // Stores per-transaction Horizon polling state so contributors can
        // query or subscribe via WebSocket to know when their transaction
        // is confirmed, failed, or timed out.
        version: 12,
        sql: `
          CREATE TABLE IF NOT EXISTS transaction_finality (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_id INTEGER NOT NULL UNIQUE,
            tx_hash TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'confirmed', 'failed', 'timeout')),
            confirmations INTEGER NOT NULL DEFAULT 0,
            fee_paid TEXT,
            submission_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            first_confirmation_at DATETIME,
            final_status TEXT,
            final_status_at DATETIME,
            error_message TEXT,
            poll_attempts INTEGER NOT NULL DEFAULT 0,
            next_poll_at DATETIME,
            FOREIGN KEY(transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_transaction_finality_transaction_id
            ON transaction_finality(transaction_id);
          CREATE INDEX IF NOT EXISTS idx_transaction_finality_status
            ON transaction_finality(status);
          CREATE INDEX IF NOT EXISTS idx_transaction_finality_tx_hash
            ON transaction_finality(tx_hash);
          CREATE INDEX IF NOT EXISTS idx_transaction_finality_submission_at
            ON transaction_finality(submission_at);
        `,
      },
      {
        // #818: Dead Letter Queue for failed webhooks
        version: 13,
        sql: `
          CREATE TABLE IF NOT EXISTS webhook_dlq (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            webhook_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            contract_id TEXT NOT NULL,
            payload TEXT,
            error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_webhook_dlq_webhook_id ON webhook_dlq(webhook_id);
          CREATE INDEX IF NOT EXISTS idx_webhook_dlq_contract_id ON webhook_dlq(contract_id);
          CREATE INDEX IF NOT EXISTS idx_webhook_dlq_created_at ON webhook_dlq(created_at);
        `,
      },
      {
        // #874: centralized structured log aggregation and retention
        version: 14,
        sql: `
          CREATE TABLE IF NOT EXISTS application_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            correlation_id TEXT,
            request_id TEXT,
            service TEXT NOT NULL DEFAULT 'api',
            metadata TEXT NOT NULL DEFAULT '{}'
          );
          CREATE INDEX IF NOT EXISTS idx_application_logs_timestamp ON application_logs(timestamp);
          CREATE INDEX IF NOT EXISTS idx_application_logs_level_timestamp ON application_logs(level, timestamp);
          CREATE INDEX IF NOT EXISTS idx_application_logs_correlation_id ON application_logs(correlation_id);
          CREATE INDEX IF NOT EXISTS idx_application_logs_request_id ON application_logs(request_id);
        `,
      },
  ];

  for (const migration of migrations) {
    const current = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(migration.version);
    if (!current) {
      const apply = db.transaction(() => {
        db.exec(migration.sql);
        db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      });
      apply();
    }
  }
}

/**
 * Get the current migration version.
 */
export function getMigrationVersion() {
  try {
    if (!db.open) return 0;
    return db.prepare("SELECT MAX(version) as v FROM schema_migrations").get()?.v ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Quick database health check — returns connection status, response time,
 * migration version, WAL mode, and table count.
 */
export function checkDatabase() {
  const start = Date.now();
  try {
    if (!db.open) {
      return { connected: false, responseTimeMs: Date.now() - start, error: "Database is closed" };
    }

    // Verify the connection is alive with a simple query
    db.prepare("SELECT 1").get();

    const responseTimeMs = Date.now() - start;
    const version = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get()?.v ?? 0;
    const walMode = db.pragma("journal_mode", { simple: true }) === "wal";
    const tableCount = db.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'").get()?.c ?? 0;

    return {
      connected: true,
      responseTimeMs,
      version,
      walMode,
      tableCount,
    };
  } catch (err) {
    return {
      connected: false,
      responseTimeMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Delete health_history records older than 90 days.
 */
export function pruneHealthHistory() {
  if (!db.open) return;
  db.prepare(
    "DELETE FROM health_history WHERE timestamp < datetime('now', '-90 days')"
  ).run();
}

/**
 * Insert a health snapshot into health_history.
 */
export function recordHealthSnapshot({ ok, horizonConnected, horizonLatencyMs, contractStatus, dbOk, details }) {
  if (!db.open) return;
  return db.prepare(`
    INSERT INTO health_history (overall_ok, horizon_connected, horizon_latency_ms, contract_status, db_ok, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ok ? 1 : 0,
    horizonConnected ? 1 : 0,
    horizonLatencyMs ?? null,
    contractStatus ?? "unknown",
    dbOk ? 1 : 0,
    details ? JSON.stringify(details) : null
  );
}

/**
 * Return up to 500 health snapshots from the past `hours` hours, newest first.
 */
export function getHealthHistory(hours = 24) {
  if (!db.open) return [];
  return db.prepare(`
    SELECT * FROM health_history
    WHERE timestamp > datetime('now', ? || ' hours')
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(`-${hours}`);
}

/**
 * Return SLA statistics for the past `days` days.
 */
export function getSLAStats(days = 30) {
  if (!db.open) {
    return {
      periodDays: days,
      totalSnapshots: 0,
      healthySnapshots: 0,
      uptimePercent: 100.0,
      avgLatencyMs: null,
      minLatencyMs: null,
      maxLatencyMs: null,
    };
  }
  const rows = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(overall_ok) as healthy_count,
      AVG(horizon_latency_ms) as avg_latency_ms,
      MIN(horizon_latency_ms) as min_latency_ms,
      MAX(horizon_latency_ms) as max_latency_ms
    FROM health_history
    WHERE timestamp > datetime('now', ? || ' days')
  `).get(`-${days}`);

  const total = rows?.total ?? 0;
  const healthyCount = rows?.healthy_count ?? 0;
  const uptimePct = total > 0 ? ((healthyCount / total) * 100).toFixed(3) : "100.000";

  return {
    periodDays: days,
    totalSnapshots: total,
    healthySnapshots: healthyCount,
    uptimePercent: parseFloat(uptimePct),
    avgLatencyMs: rows?.avg_latency_ms ? Math.round(rows.avg_latency_ms) : null,
    minLatencyMs: rows?.min_latency_ms ?? null,
    maxLatencyMs: rows?.max_latency_ms ?? null,
  };
}

export default db;
