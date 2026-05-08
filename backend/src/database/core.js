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

// Checkpoint the WAL periodically to prevent unbounded growth.
let _writeCount = 0;
export function countWrite() {
  if (++_writeCount % 100 === 0) {
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

// Final checkpoint on clean shutdown.
process.on("exit", () => db.pragma("wal_checkpoint(TRUNCATE)"));
process.on("SIGINT", () => process.exit(0));
// SIGTERM is handled in index.js for graceful HTTP + DB shutdown.

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

export default db;
