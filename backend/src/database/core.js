import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import logger from "../logger.js";
import { instrumentDatabase } from "../query-profiler.js";
import { migrateUp, getCurrentVersion, MIGRATIONS } from "./migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

export const db = instrumentDatabase(new Database(dbPath));
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // safe with WAL, much faster
db.pragma("cache_size = -64000"); // 64MB page cache
db.pragma("foreign_keys = ON"); // enforce FK constraints
db.pragma("temp_store = MEMORY"); // temp tables in memory

// Checkpoint the WAL periodically to prevent unbounded growth.
let _writeCount = 0;
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

  // Ensure base tables exist before running additive migrations. Some older
  // migration entries add indexes/columns to these tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txHash TEXT UNIQUE,
      contractId TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initialize', 'distribute', 'secondary_royalty', 'secondary_distribute')),
      initiatorAddress TEXT NOT NULL,
      requestedAmount TEXT,
      tokenId TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      blockTime DATETIME,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'failed')),
      errorMessage TEXT
    );

    CREATE TABLE IF NOT EXISTS distribution_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL DEFAULT '',
      collaboratorAddress TEXT NOT NULL,
      amountReceived TEXT NOT NULL,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS secondary_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      nftId TEXT NOT NULL,
      previousOwner TEXT NOT NULL,
      newOwner TEXT NOT NULL,
      salePrice TEXT NOT NULL,
      saleToken TEXT NOT NULL,
      royaltyAmount TEXT NOT NULL,
      royaltyRate INTEGER NOT NULL,
      distributed INTEGER NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      transactionHash TEXT
    );

    CREATE TABLE IF NOT EXISTS secondary_royalty_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL,
      totalRoyaltiesDistributed TEXT NOT NULL,
      numberOfSales INTEGER NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      action TEXT NOT NULL,
      user TEXT,
      details TEXT,
      entry_hash TEXT NOT NULL,
      prev_hash TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(contractId, url)
    );

      CREATE TABLE IF NOT EXISTS webhook_dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhookId INTEGER,
        contractId TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        errorMessage TEXT,
        retryCount INTEGER NOT NULL DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastAttemptAt DATETIME,
        FOREIGN KEY(webhookId) REFERENCES webhooks(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS indexed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE,
        ledger_sequence INTEGER,
        transaction_hash TEXT,
        event_index INTEGER,
        timestamp DATETIME,
        contract_id TEXT NOT NULL,
        event_type TEXT,
        event_data TEXT,
        raw_event TEXT,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_indexed_events_contractId ON indexed_events(contract_id);
      CREATE INDEX IF NOT EXISTS idx_indexed_events_ledger_sequence ON indexed_events(ledger_sequence);
      CREATE INDEX IF NOT EXISTS idx_indexed_events_event_type ON indexed_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_indexed_events_timestamp ON indexed_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_indexed_events_transaction_hash ON indexed_events(transaction_hash);
  `);

  // Apply all pending versioned migrations through the migration engine (#519).
  // The engine tracks applied versions in `schema_migrations`, runs each
  // migration transactionally, and is shared with the `migrate` CLI so the boot
  // path and operator tooling stay in lockstep.
  migrateUp(db, {}, MIGRATIONS);

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      txHash TEXT UNIQUE,
      contractId TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initialize', 'distribute', 'secondary_royalty', 'secondary_distribute')),
      initiatorAddress TEXT NOT NULL,
      requestedAmount TEXT,
      tokenId TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      blockTime DATETIME,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'failed')),
      errorMessage TEXT
    );

    CREATE TABLE IF NOT EXISTS distribution_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL DEFAULT '',
      collaboratorAddress TEXT NOT NULL,
      amountReceived TEXT NOT NULL,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS secondary_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      nftId TEXT NOT NULL,
      previousOwner TEXT NOT NULL,
      newOwner TEXT NOT NULL,
      salePrice TEXT NOT NULL,
      saleToken TEXT NOT NULL,
      royaltyAmount TEXT NOT NULL,
      royaltyRate INTEGER NOT NULL,
      distributed INTEGER NOT NULL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      transactionHash TEXT
    );

    CREATE TABLE IF NOT EXISTS secondary_royalty_distributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionId INTEGER NOT NULL,
      contractId TEXT NOT NULL,
      totalRoyaltiesDistributed TEXT NOT NULL,
      numberOfSales INTEGER NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      action TEXT NOT NULL,
      user TEXT,
      details TEXT,
      entry_hash TEXT NOT NULL,
      prev_hash TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_contractId ON transactions(contractId);
    CREATE INDEX IF NOT EXISTS idx_transactions_contractId_timestamp_desc ON transactions(contractId, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_transactions_txHash ON transactions(txHash);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_contract_status_timestamp_type
      ON transactions(contractId, status, timestamp, type);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_contractId ON secondary_sales(contractId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_nftId ON secondary_sales(nftId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_timestamp ON secondary_sales(timestamp);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_contract_distributed_timestamp
      ON secondary_sales(contractId, distributed, timestamp);
    CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId ON secondary_royalty_distributions(contractId);
    CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contract_timestamp
      ON secondary_royalty_distributions(contractId, timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_contractId ON audit_log(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_distribution_payouts_transaction_collaborator
      ON distribution_payouts(transactionId, collaboratorAddress);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secondary_sales_dedup ON secondary_sales(contractId, nftId, previousOwner, newOwner, salePrice, saleToken);
  `);

  // Migration guards for existing databases
  try {
    db.exec(`ALTER TABLE secondary_sales ADD COLUMN distributed INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }

  try {
    db.exec(`ALTER TABLE distribution_payouts ADD COLUMN contractId TEXT NOT NULL DEFAULT ''`);
  } catch (_) {
    /* column already exists */
  }
}

/**
 * Get the current database schema migration version.
 */
export function getMigrationVersion() {
  return getCurrentVersion(db);
}

/**
 * Compute SHA-256 hash of audit log entry data.
 * Hash includes: contractId, action, user, details, timestamp, prev_hash
 */
export function computeAuditEntryHash(contractId, action, user, details, timestamp, prevHash = null) {
  const hash = crypto.createHash('sha256');
  hash.update(contractId);
  hash.update(action);
  hash.update(user || '');
  hash.update(details || '');
  hash.update(timestamp.toString());
  if (prevHash) {
    hash.update(prevHash);
  }
  return hash.digest('hex');
}

/**
 * Verify the integrity of the audit log hash chain.
 * Returns { valid: boolean, brokenAt: number|null, error: string|null }
 */
export function verifyAuditLogIntegrity(contractId = null) {
  try {
    let query = `
      SELECT id, contractId, action, user, details, entry_hash, prev_hash, timestamp
      FROM audit_log
    `;
    const params = [];
    
    if (contractId) {
      query += ` WHERE contractId = ?`;
      params.push(contractId);
    }
    
    query += ` ORDER BY id ASC`;
    
    const entries = db.prepare(query).all(...params);
    
    if (entries.length === 0) {
      return { valid: true, brokenAt: null, error: null };
    }
    
    let prevHash = null;
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      
      // Verify prev_hash matches previous entry's entry_hash
      if (i > 0) {
        if (entry.prev_hash !== prevHash) {
          return {
            valid: false,
            brokenAt: entry.id,
            error: `Hash chain broken at entry ${entry.id}: prev_hash mismatch`
          };
        }
      } else if (entry.prev_hash !== null) {
        // First entry should have null prev_hash
        return {
          valid: false,
          brokenAt: entry.id,
          error: `First entry has non-null prev_hash`
        };
      }
      
      // Recompute entry hash and verify
      const computedHash = computeAuditEntryHash(
        entry.contractId,
        entry.action,
        entry.user,
        entry.details,
        entry.timestamp,
        entry.prev_hash
      );
      
      if (computedHash !== entry.entry_hash) {
        return {
          valid: false,
          brokenAt: entry.id,
          error: `Hash mismatch at entry ${entry.id}: stored=${entry.entry_hash}, computed=${computedHash}`
        };
      }
      
      prevHash = entry.entry_hash;
    }
    
    return { valid: true, brokenAt: null, error: null };
  } catch (err) {
    logger.error("Error verifying audit log integrity", err);
    return {
      valid: false,
      brokenAt: null,
      error: err.message
    };
  }
}

/**
 * Verify audit log integrity on startup.
 * Logs warnings if integrity check fails but doesn't block startup.
 */
export function verifyAuditLogOnStartup() {
  const result = verifyAuditLogIntegrity();
  
  if (!result.valid) {
    logger.error(`Audit log integrity check failed: ${result.error}`, {
      brokenAt: result.brokenAt
    });
  } else {
    logger.info("Audit log integrity verification passed");
  }
  
  return result;
}

export default db;
