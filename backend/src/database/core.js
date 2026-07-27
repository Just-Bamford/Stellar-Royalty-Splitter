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
    {
      version: 5,
      sql: `
        CREATE TABLE IF NOT EXISTS payment_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          walletAddress TEXT NOT NULL UNIQUE,
          paymentMethod TEXT NOT NULL CHECK(paymentMethod IN ('direct_transfer', 'usdc', 'xlm')),
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
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
            status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'failed')),
            FOREIGN KEY(subscriberId) REFERENCES email_digest_subscribers(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_wallet
            ON email_digest_subscribers(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_email_digest_subscribers_enabled
            ON email_digest_subscribers(enabled);
          CREATE INDEX IF NOT EXISTS idx_email_digest_log_subscriber
            ON email_digest_log(subscriberId);
          CREATE INDEX IF NOT EXISTS idx_email_digest_log_week
            ON email_digest_log(weekStart, weekEnd);
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
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
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
          CREATE INDEX IF NOT EXISTS idx_transactions_status
            ON transactions(status);

          CREATE TABLE IF NOT EXISTS csv_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contractId TEXT NOT NULL,
            fileName TEXT NOT NULL,
            rowCount INTEGER NOT NULL DEFAULT 0,
            importedBy TEXT NOT NULL DEFAULT 'unknown',
            status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'failed')),
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME
          );
          CREATE INDEX IF NOT EXISTS idx_csv_imports_contractId ON csv_imports(contractId);

          CREATE TABLE IF NOT EXISTS csv_import_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            importId INTEGER NOT NULL,
            rowIndex INTEGER NOT NULL,
            address TEXT NOT NULL DEFAULT '',
            share INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN ('success', 'error')),
            errorMessage TEXT,
            FOREIGN KEY(importId) REFERENCES csv_imports(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_csv_import_results_importId ON csv_import_results(importId);

          CREATE TABLE IF NOT EXISTS contributor_tax (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            tax_status TEXT CHECK(tax_status IN ('not_collected', 'pending', 'completed', 'exempt')),
            tax_id TEXT,
            w9_file_path TEXT,
            w9_file_name TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_contributor_tax_wallet ON contributor_tax(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_contributor_tax_status ON contributor_tax(tax_status);

          CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            message TEXT,
            data TEXT,
            read INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_notifications_wallet ON notifications(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(walletAddress, read);

          CREATE TABLE IF NOT EXISTS notification_preferences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            email_enabled INTEGER NOT NULL DEFAULT 1,
            in_app_enabled INTEGER NOT NULL DEFAULT 1,
            sms_enabled INTEGER NOT NULL DEFAULT 0,
            notify_distribution INTEGER NOT NULL DEFAULT 1,
            notify_payment INTEGER NOT NULL DEFAULT 1,
            notify_failure INTEGER NOT NULL DEFAULT 1,
            notify_hold INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_notification_prefs_wallet ON notification_preferences(walletAddress);
        `,
      },
      {
        // #598: KYC integration hooks — contributor_kyc and kyc_events tables
        version: 11,
        sql: `
          CREATE TABLE IF NOT EXISTS contributor_kyc (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL UNIQUE,
            verification_status TEXT NOT NULL DEFAULT 'not_started'
              CHECK(verification_status IN ('not_started', 'pending', 'verified', 'rejected', 'expired')),
            provider TEXT CHECK(provider IN ('veriff', 'jumio', 'manual')),
            provider_session_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_contributor_kyc_wallet ON contributor_kyc(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_contributor_kyc_status ON contributor_kyc(verification_status);

          CREATE TABLE IF NOT EXISTS kyc_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            walletAddress TEXT,
            raw_payload TEXT NOT NULL,
            resolved_status TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_kyc_events_wallet ON kyc_events(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_kyc_events_provider ON kyc_events(provider);
          CREATE INDEX IF NOT EXISTS idx_kyc_events_created ON kyc_events(created_at);
        `,
      },
      {
        // #599: Payment schedule templates
        version: 12,
        sql: `
          CREATE TABLE IF NOT EXISTS payment_schedules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            contractId TEXT NOT NULL,
            schedule_type TEXT NOT NULL CHECK(schedule_type IN ('monthly', 'biweekly', 'weekly', 'custom')),
            day_of_month INTEGER CHECK(day_of_month BETWEEN 1 AND 28),
            day_of_week INTEGER CHECK(day_of_week BETWEEN 0 AND 6),
            hour_of_day INTEGER NOT NULL DEFAULT 9 CHECK(hour_of_day BETWEEN 0 AND 23),
            timezone TEXT NOT NULL DEFAULT 'UTC',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_by TEXT NOT NULL DEFAULT 'admin',
            last_run_at DATETIME,
            next_run_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_payment_schedules_contract ON payment_schedules(contractId);
          CREATE INDEX IF NOT EXISTS idx_payment_schedules_enabled ON payment_schedules(enabled);
          CREATE INDEX IF NOT EXISTS idx_payment_schedules_next_run ON payment_schedules(next_run_at);

          CREATE TABLE IF NOT EXISTS scheduled_distribution_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            scheduleId INTEGER NOT NULL,
            contractId TEXT NOT NULL,
            triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT NOT NULL CHECK(status IN ('triggered', 'failed', 'skipped')),
            error_message TEXT,
            transaction_id INTEGER,
            FOREIGN KEY(scheduleId) REFERENCES payment_schedules(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_scheduled_dist_log_schedule ON scheduled_distribution_log(scheduleId);
          CREATE INDEX IF NOT EXISTS idx_scheduled_dist_log_contract ON scheduled_distribution_log(contractId);
        `,
      },
      {
        // #600: Contributor performance metrics
        version: 13,
        sql: `
          CREATE TABLE IF NOT EXISTS contributor_performance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            walletAddress TEXT NOT NULL,
            contractId TEXT NOT NULL,
            success_rate REAL NOT NULL DEFAULT 0,
            avg_payout_time_hours REAL,
            reliability_score REAL NOT NULL DEFAULT 0,
            total_payouts INTEGER NOT NULL DEFAULT 0,
            total_earned REAL NOT NULL DEFAULT 0,
            period_start DATETIME NOT NULL,
            period_end DATETIME NOT NULL,
            computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(walletAddress, contractId, period_start)
          );
          CREATE INDEX IF NOT EXISTS idx_contributor_perf_wallet ON contributor_performance(walletAddress);
          CREATE INDEX IF NOT EXISTS idx_contributor_perf_contract ON contributor_performance(contractId);
          CREATE INDEX IF NOT EXISTS idx_contributor_perf_score ON contributor_performance(reliability_score DESC);
        `,
      },
      {
        // #601: Automated compliance reports
        version: 14,
        sql: `
          CREATE TABLE IF NOT EXISTS compliance_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            report_type TEXT NOT NULL CHECK(report_type IN ('monthly', 'quarterly', 'annual', 'custom')),
            period_start DATETIME NOT NULL,
            period_end DATETIME NOT NULL,
            generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            generated_by TEXT NOT NULL DEFAULT 'system',
            file_path TEXT,
            emailed_to TEXT,
            status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated', 'emailed', 'failed')),
            summary TEXT,
            UNIQUE(report_type, period_start, period_end)
          );
          CREATE INDEX IF NOT EXISTS idx_compliance_reports_type ON compliance_reports(report_type);
          CREATE INDEX IF NOT EXISTS idx_compliance_reports_period ON compliance_reports(period_start, period_end);
          CREATE INDEX IF NOT EXISTS idx_compliance_reports_generated ON compliance_reports(generated_at);

          CREATE TABLE IF NOT EXISTS compliance_report_schedules (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            monthly_enabled INTEGER NOT NULL DEFAULT 1,
            quarterly_enabled INTEGER NOT NULL DEFAULT 1,
            annual_enabled INTEGER NOT NULL DEFAULT 1,
            email_recipients TEXT NOT NULL DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT OR IGNORE INTO compliance_report_schedules (id, monthly_enabled, quarterly_enabled, annual_enabled, email_recipients)
          VALUES (1, 1, 1, 1, '[]');
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

          CREATE TABLE IF NOT EXISTS hold_audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transactionId INTEGER NOT NULL,
            action TEXT NOT NULL,
            reason TEXT,
            performedBy TEXT,
            details TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hold_audit_transaction ON hold_audit(transactionId);
        `,
      },
      {
        version: 4,
        sql: `
        CREATE TABLE IF NOT EXISTS contract_event_archive (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          originalTransactionId INTEGER NOT NULL,
          txHash TEXT,
          contractId TEXT NOT NULL,
          type TEXT NOT NULL,
          initiatorAddress TEXT NOT NULL,
          requestedAmount TEXT,
          tokenId TEXT,
          timestamp DATETIME,
          blockTime DATETIME,
          status TEXT NOT NULL,
          errorMessage TEXT,
          payoutCount INTEGER NOT NULL DEFAULT 0,
          payoutsJson TEXT NOT NULL DEFAULT '[]',
          archivedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(originalTransactionId)
        );

        CREATE TABLE IF NOT EXISTS event_archive_policy (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          enabled INTEGER NOT NULL DEFAULT 1,
          retentionDays INTEGER NOT NULL DEFAULT 90,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        INSERT OR IGNORE INTO event_archive_policy (id, enabled, retentionDays)
        VALUES (1, 1, 90);

        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contractId
          ON contract_event_archive(contractId);
        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_timestamp
          ON contract_event_archive(COALESCE(blockTime, timestamp));
        CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contract_time
          ON contract_event_archive(contractId, COALESCE(blockTime, timestamp));
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
      errorMessage TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_time DATETIME
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
    CREATE INDEX IF NOT EXISTS idx_transactions_event_time ON transactions(COALESCE(blockTime, timestamp));
    CREATE INDEX IF NOT EXISTS idx_transactions_retry_eligible
      ON transactions(status, type, retry_count, last_retry_time);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_contractId ON secondary_sales(contractId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_nftId ON secondary_sales(nftId);
    CREATE INDEX IF NOT EXISTS idx_secondary_sales_timestamp ON secondary_sales(timestamp);
    CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contractId ON secondary_royalty_distributions(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_contractId ON audit_log(contractId);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_secondary_sales_dedup ON secondary_sales(contractId, nftId, previousOwner, newOwner, salePrice, saleToken);

    CREATE TABLE IF NOT EXISTS contract_event_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      originalTransactionId INTEGER NOT NULL,
      txHash TEXT,
      contractId TEXT NOT NULL,
      type TEXT NOT NULL,
      initiatorAddress TEXT NOT NULL,
      requestedAmount TEXT,
      tokenId TEXT,
      timestamp DATETIME,
      blockTime DATETIME,
      status TEXT NOT NULL,
      errorMessage TEXT,
      payoutCount INTEGER NOT NULL DEFAULT 0,
      payoutsJson TEXT NOT NULL DEFAULT '[]',
      archivedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(originalTransactionId)
    );

    CREATE TABLE IF NOT EXISTS event_archive_policy (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      retentionDays INTEGER NOT NULL DEFAULT 90,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO event_archive_policy (id, enabled, retentionDays)
    VALUES (1, 1, 90);
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contractId ON contract_event_archive(contractId);
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_timestamp ON contract_event_archive(COALESCE(blockTime, timestamp));
    CREATE INDEX IF NOT EXISTS idx_contract_event_archive_contract_time ON contract_event_archive(contractId, COALESCE(blockTime, timestamp));
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

  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
  } catch (_) {
    /* column already exists */
  }

  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN last_retry_time DATETIME`);
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
