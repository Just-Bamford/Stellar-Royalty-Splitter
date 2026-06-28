import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");

export const db = new Database(dbPath);
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

  const migrations = [
    {
      version: 1,
      sql: `/* initial schema — already applied via CREATE TABLE IF NOT EXISTS */`,
    },
    {
      // Issue #462: composite index for single-query royalty statistics
      version: 8,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId_timestamp
          ON secondary_royalty_distributions(contractId, timestamp);
      `,
    },
    {
      // Issue #427: track dust allocated per secondary-royalty distribution round
      // Issue #428: add max_attempts to webhooks; add cleanup index on DLQ
      version: 7,
      sql: `
        -- #427: dust_allocated column on secondary_royalty_distributions
        ALTER TABLE secondary_royalty_distributions ADD COLUMN dustAllocated TEXT NOT NULL DEFAULT '0';

        -- #428: max_attempts per webhook row (0 = unlimited / legacy)
        ALTER TABLE webhooks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;

        -- #428: createdAt index on dead_letters for efficient 30-day cleanup
        CREATE INDEX IF NOT EXISTS idx_dead_letters_createdAt ON webhook_dead_letters(createdAt);
      `,
    },
    {
      // Issue #421: permanent per-contract nonce dedup for /api/v1/initialize.
      version: 6,
      sql: `
        CREATE TABLE IF NOT EXISTS request_nonces (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          nonce TEXT NOT NULL,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(contractId, nonce)
        );
        CREATE INDEX IF NOT EXISTS idx_request_nonces_contractId ON request_nonces(contractId);
      `,
    },
    {
      version: 5,
      sql: `
        -- Issue #401: Dead-letter queue for failed webhook deliveries
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
        CREATE INDEX IF NOT EXISTS idx_dead_letters_contractId ON webhook_dead_letters(contractId);
        CREATE INDEX IF NOT EXISTS idx_dead_letters_retryCount ON webhook_dead_letters(retryCount);
      `,
    },
    {
      version: 4,
      sql: `
        -- Issue #395: Add hash chain to audit_log for integrity verification
        BEGIN;
        
        -- Add hash columns if they don't exist
        ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;
        ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
        
        -- Create index on entry_hash for faster verification
        CREATE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash);
        
        COMMIT;
      `,
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
          FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO secondary_royalty_distributions_new
          SELECT id, transactionId, contractId, totalRoyaltiesDistributed, numberOfSales, timestamp
          FROM secondary_royalty_distributions;
        DROP TABLE secondary_royalty_distributions;
        ALTER TABLE secondary_royalty_distributions_new RENAME TO secondary_royalty_distributions;

        COMMIT;

        PRAGMA foreign_keys = ON;
      `,
    },
  ];

  const applied = db
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((r) => r.version);

  for (const migration of migrations) {
    if (!applied.includes(migration.version)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(migration.version);
      logger.info(`Applied migration v${migration.version}`);
    }
  }

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
    CREATE INDEX IF NOT EXISTS idx_transactions_txHash ON transactions(txHash);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_contractId ON secondary_sales(contractId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_nftId ON secondary_sales(nftId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_timestamp ON secondary_sales(timestamp);
    CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId ON secondary_royalty_distributions(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_contractId ON audit_log(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
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
  const result = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get();
  return result?.version ?? 0;
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
