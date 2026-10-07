import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import logger from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "audit.db");

const db = new Database(dbPath);
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
    {
      version: 3,
      sql: `
        CREATE TABLE IF NOT EXISTS contributor_onboarding (
          walletAddress TEXT PRIMARY KEY,
          email TEXT,
          kycStatus TEXT DEFAULT 'pending' CHECK(kycStatus IN ('unverified', 'pending', 'verified')),
          paymentPreferencesSet INTEGER DEFAULT 0,
          payoutToken TEXT DEFAULT 'XLM',
          taxInfoSubmitted INTEGER DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
          updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `,
    },
    {
      // #984: Performance — Query optimization and database indexing strategy
      version: 4,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_distribution_payouts_txId ON distribution_payouts(transactionId);
        CREATE INDEX IF NOT EXISTS idx_distribution_payouts_collab ON distribution_payouts(collaboratorAddress, transactionId);
        CREATE INDEX IF NOT EXISTS idx_distribution_payouts_contract ON distribution_payouts(contractId);
        CREATE INDEX IF NOT EXISTS idx_distribution_payouts_collab_contract ON distribution_payouts(collaboratorAddress, contractId);
        CREATE INDEX IF NOT EXISTS idx_secondary_distributions_txId ON secondary_royalty_distributions(transactionId);
        CREATE INDEX IF NOT EXISTS idx_transactions_contract_status_time ON transactions(contractId, status, timestamp);
        CREATE INDEX IF NOT EXISTS idx_transactions_contract_time ON transactions(contractId, timestamp DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_initiator_time ON transactions(initiatorAddress, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_secondary_sales_contract_time ON secondary_sales(contractId, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_secondary_distributions_contract_time ON secondary_royalty_distributions(contractId, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_transactions_confirmed_payouts ON transactions(contractId, timestamp) WHERE status = 'confirmed';
        CREATE INDEX IF NOT EXISTS idx_secondary_sales_undistributed ON secondary_sales(contractId, timestamp) WHERE distributed = 0;
        CREATE INDEX IF NOT EXISTS idx_transactions_active_holds ON transactions(contractId, hold_placed_at) WHERE hold_status = 'active';

        CREATE TABLE IF NOT EXISTS earnings_summary_mv (
          contractId TEXT PRIMARY KEY,
          totalTransactions INTEGER NOT NULL DEFAULT 0,
          totalDistributed TEXT NOT NULL DEFAULT '0',
          averagePayout TEXT NOT NULL DEFAULT '0',
          uniqueCollaborators INTEGER NOT NULL DEFAULT 0,
          lastPayoutAt DATETIME,
          lastRefreshedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_earnings_summary_mv_refreshed ON earnings_summary_mv(lastRefreshedAt);
      `,
    },
    {
      // #959, #960, #983, #986: Four new features - collaborative editor, oracle, vesting, enhanced audit
      version: 5,
      sql: `
        -- #959: Real-time collaborative contract editor
        CREATE TABLE IF NOT EXISTS contract_edit_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          userId TEXT NOT NULL,
          field TEXT NOT NULL,
          lockedAt DATETIME NOT NULL,
          expiresAt DATETIME NOT NULL,
          lastActivity DATETIME NOT NULL,
          UNIQUE(contractId, userId, field)
        );
        CREATE INDEX IF NOT EXISTS idx_edit_sessions_contract ON contract_edit_sessions(contractId, expiresAt);
        CREATE INDEX IF NOT EXISTS idx_edit_sessions_user ON contract_edit_sessions(userId);

        CREATE TABLE IF NOT EXISTS contract_edit_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          userId TEXT NOT NULL,
          field TEXT NOT NULL,
          oldValue TEXT,
          newValue TEXT,
          operation TEXT NOT NULL,
          editedAt DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_edit_history_contract ON contract_edit_history(contractId, editedAt DESC);

        CREATE TABLE IF NOT EXISTS contract_field_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          field TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          value TEXT NOT NULL,
          updatedBy TEXT NOT NULL,
          updatedAt DATETIME NOT NULL,
          UNIQUE(contractId, field)
        );
        CREATE INDEX IF NOT EXISTS idx_field_versions_contract ON contract_field_versions(contractId);

        -- #960: Dynamic royalty oracle with ML predictions
        CREATE TABLE IF NOT EXISTS royalty_predictions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          predictedAmount TEXT NOT NULL,
          confidence REAL NOT NULL,
          factors TEXT NOT NULL,
          modelVersion TEXT NOT NULL,
          predictionHorizon TEXT NOT NULL,
          predictedAt DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_predictions_contract ON royalty_predictions(contractId, predictedAt DESC);

        CREATE TABLE IF NOT EXISTS ml_model_metadata (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT NOT NULL UNIQUE,
          accuracy REAL,
          precision REAL,
          recall REAL,
          f1Score REAL,
          trainingDataSize INTEGER,
          featuresUsed TEXT NOT NULL,
          hyperparameters TEXT,
          trainedBy TEXT,
          trainedAt DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_metadata_version ON ml_model_metadata(version);
        CREATE INDEX IF NOT EXISTS idx_model_metadata_trained ON ml_model_metadata(trainedAt DESC);

        CREATE TABLE IF NOT EXISTS market_data_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          source TEXT NOT NULL,
          floorPrice TEXT,
          volumeDay TEXT,
          volumeWeek TEXT,
          volumeMonth TEXT,
          numSales INTEGER,
          avgSalePrice TEXT,
          uniqueBuyers INTEGER,
          uniqueSellers INTEGER,
          metadata TEXT,
          snapshotAt DATETIME NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_market_data_contract ON market_data_snapshots(contractId, snapshotAt DESC);
        CREATE INDEX IF NOT EXISTS idx_market_data_source ON market_data_snapshots(source, snapshotAt DESC);

        -- #983: Time-locked vesting contracts
        CREATE TABLE IF NOT EXISTS vesting_schedules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          beneficiary TEXT NOT NULL,
          totalAmount TEXT NOT NULL,
          tokenAddress TEXT NOT NULL,
          startTime DATETIME NOT NULL,
          cliffDuration INTEGER NOT NULL,
          vestingDuration INTEGER NOT NULL,
          releasedAmount TEXT NOT NULL DEFAULT '0',
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'cancelled', 'completed')),
          createdBy TEXT NOT NULL,
          createdAt DATETIME NOT NULL,
          cancelledBy TEXT,
          cancelledAt DATETIME,
          cancellationReason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_vesting_beneficiary ON vesting_schedules(beneficiary);
        CREATE INDEX IF NOT EXISTS idx_vesting_contract ON vesting_schedules(contractId);
        CREATE INDEX IF NOT EXISTS idx_vesting_status ON vesting_schedules(status);

        CREATE TABLE IF NOT EXISTS vesting_releases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scheduleId INTEGER NOT NULL,
          amount TEXT NOT NULL,
          releasedAt DATETIME NOT NULL,
          txHash TEXT,
          FOREIGN KEY(scheduleId) REFERENCES vesting_schedules(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_vesting_releases_schedule ON vesting_releases(scheduleId, releasedAt DESC);

        -- #986: Enhanced audit logging with immutable hash-chain
        CREATE TABLE IF NOT EXISTS audit_chain (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contractId TEXT NOT NULL,
          action TEXT NOT NULL,
          user TEXT NOT NULL,
          details TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'admin_action' CHECK(category IN ('admin_action', 'transaction', 'configuration', 'dispute', 'access')),
          severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'critical')),
          ipAddress TEXT,
          userAgent TEXT,
          timestamp DATETIME NOT NULL,
          previousHash TEXT,
          entryHash TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_audit_chain_contract ON audit_chain(contractId, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_user ON audit_chain(user, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_action ON audit_chain(action);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_category ON audit_chain(category, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_severity ON audit_chain(severity, timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_chain_hash ON audit_chain(entryHash);
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

    CREATE TABLE IF NOT EXISTS contributor_onboarding (
      walletAddress TEXT PRIMARY KEY,
      email TEXT,
      kycStatus TEXT DEFAULT 'pending' CHECK(kycStatus IN ('unverified', 'pending', 'verified')),
      paymentPreferencesSet INTEGER DEFAULT 0,
      payoutToken TEXT DEFAULT 'XLM',
      taxInfoSubmitted INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
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
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user);
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

// Transaction tracking functions
export function recordTransaction(contractId, type, initiatorAddress, data) {
  const { requestedAmount, tokenId } = data;

  const stmt = db.prepare(`
    INSERT INTO transactions 
    (contractId, type, initiatorAddress, requestedAmount, tokenId, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const result = stmt.run(contractId, type, initiatorAddress, requestedAmount, tokenId);
  countWrite();
  return result.lastInsertRowid;
}

export function updateTransactionHash(transactionId, txHash) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET txHash = ? 
    WHERE id = ?
  `);

  stmt.run(txHash, transactionId);
  countWrite();
}

export function updateTransactionStatus(txHash, status, blockTime = null, errorMessage = null) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET status = ?, blockTime = ?, errorMessage = ? 
    WHERE txHash = ?
  `);

  stmt.run(status, blockTime, errorMessage, txHash);
  countWrite();
}

export function addDistributionPayout(
  transactionId,
  contractId,
  collaboratorAddress,
  amountReceived
) {
  const stmt = db.prepare(`
    INSERT INTO distribution_payouts 
    (transactionId, contractId, collaboratorAddress, amountReceived)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(transactionId, contractId, collaboratorAddress, amountReceived);
  countWrite();
}

export function getTransactionCount(contractId) {
  const stmt = db.prepare(`SELECT COUNT(*) as total FROM transactions WHERE contractId = ?`);
  return stmt.get(contractId).total;
}

export function getTransactionHistory(contractId, limit = 50, offset = 0) {
  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage,
      COUNT(dp.id) as payoutCount
    FROM transactions t
    LEFT JOIN distribution_payouts dp ON t.id = dp.transactionId
    WHERE t.contractId = ?
    GROUP BY t.id
    ORDER BY t.timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

export function getTransactionDetails(txHash) {
  if (!txHash) return null;

  const stmt = db.prepare(`
    SELECT 
      t.id,
      t.txHash,
      t.contractId,
      t.type,
      t.initiatorAddress,
      t.requestedAmount,
      t.tokenId,
      t.timestamp,
      t.blockTime,
      t.status,
      t.errorMessage
    FROM transactions t
    WHERE t.txHash = ?
  `);

  let transaction = stmt.get(txHash);

  if (!transaction) {
    // Check contract_event_archive if transaction was archived
    const archiveStmt = db.prepare(`
      SELECT
        originalTransactionId as id,
        txHash,
        contractId,
        type,
        initiatorAddress,
        requestedAmount,
        tokenId,
        timestamp,
        blockTime,
        status,
        errorMessage,
        payoutsJson
      FROM contract_event_archive
      WHERE txHash = ?
    `);

    const archived = archiveStmt.get(txHash);
    if (!archived) {
      return null;
    }

    let rawPayouts = [];
    try {
      rawPayouts = JSON.parse(archived.payoutsJson || "[]");
    } catch (_) {
      rawPayouts = [];
    }

    transaction = {
      ...archived,
      payouts: rawPayouts,
      payoutsJson: undefined,
    };
  } else {
    const payoutsStmt = db.prepare(`
      SELECT collaboratorAddress, amountReceived
      FROM distribution_payouts
      WHERE transactionId = ?
    `);
    transaction.payouts = payoutsStmt.all(transaction.id);
  }

  // Calculate total payouts and share percentages per recipient
  const totalPayoutNum = (transaction.payouts || []).reduce(
    (acc, p) => acc + (parseFloat(p.amountReceived) || 0),
    0
  );

  const payoutsWithShares = (transaction.payouts || []).map((p) => {
    const amt = parseFloat(p.amountReceived) || 0;
    const sharePercentage =
      totalPayoutNum > 0 ? parseFloat(((amt / totalPayoutNum) * 100).toFixed(2)) : 0;
    return {
      ...p,
      sharePercentage,
    };
  });

  // Query edit history / audit log for this contract
  let auditHistory = [];
  try {
    const auditStmt = db.prepare(`
      SELECT id, contractId, action, user, details, timestamp
      FROM audit_log
      WHERE contractId = ?
      ORDER BY timestamp DESC
      LIMIT 20
    `);
    auditHistory = auditStmt.all(transaction.contractId).map((row) => {
      let details = null;
      try {
        details = JSON.parse(row.details || "{}");
      } catch (_) {
        details = row.details;
      }
      return { ...row, details };
    });
  } catch (_) {
    auditHistory = [];
  }

  // Construct structured Soroban contract events data
  const contractEvents = [
    {
      id: `evt-${transaction.id}-invoked`,
      type: "contract_invocation",
      contractId: transaction.contractId,
      topics: ["contract_call", transaction.type, transaction.contractId],
      data: {
        function: transaction.type,
        initiator: transaction.initiatorAddress,
        tokenId: transaction.tokenId || "XLM",
        requestedAmount: transaction.requestedAmount || "0",
        status: transaction.status,
      },
      timestamp: transaction.blockTime || transaction.timestamp,
    },
    {
      id: `evt-${transaction.id}-payouts`,
      type: "distribution_event",
      contractId: transaction.contractId,
      topics: ["royalty_split", "distribution_completed"],
      data: {
        totalDistributed: totalPayoutNum.toString(),
        recipientCount: payoutsWithShares.length,
        payoutsSummary: payoutsWithShares.map((p) => ({
          address: p.collaboratorAddress,
          amount: p.amountReceived,
          share: `${p.sharePercentage}%`,
        })),
      },
      timestamp: transaction.blockTime || transaction.timestamp,
    },
  ];

  return {
    ...transaction,
    payouts: payoutsWithShares,
    totalPayout: totalPayoutNum.toString(),
    auditHistory,
    contractEvents,
  };
}

export function getAuditLog(contractId, limit = 100, offset = 0, filters = {}) {
  const { action, user, startDate, endDate, search } = filters;

  let query = `
    SELECT 
      id,
      contractId,
      action,
      user,
      details,
      timestamp
    FROM audit_log
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (user) {
    query += ` AND user = ?`;
    params.push(user);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  if (search) {
    query += ` AND (action LIKE ? OR user LIKE ? OR details LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params).map((row) => {
    let details = null;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (_) {
      // Keep malformed legacy audit details readable as null.
    }
    return { ...row, details };
  });
}

export function countAuditLog(contractId, filters = {}) {
  const { action, user, startDate, endDate, search } = filters;

  let query = `SELECT COUNT(*) as total FROM audit_log WHERE contractId = ?`;
  const params = [contractId];

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (user) {
    query += ` AND user = ?`;
    params.push(user);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  if (search) {
    query += ` AND (action LIKE ? OR user LIKE ? OR details LIKE ?)`;
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  return db.prepare(query).get(...params).total;
}

export function addAuditLog(contractId, action, user, details) {
  const stmt = db.prepare(`
    INSERT INTO audit_log 
    (contractId, action, user, details)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, JSON.stringify(details));
  countWrite();
}

// ── Secondary Royalty Functions ──────────────────────────────────────────

/**
 * Record a secondary (resale) transaction for an NFT.
 * Returns the secondary sale record ID.
 */
export function recordSecondarySale(
  contractId,
  nftId,
  previousOwner,
  newOwner,
  salePrice,
  saleToken,
  royaltyAmount,
  royaltyRate,
  transactionHash = null
) {
  const stmt = db.prepare(`
    INSERT INTO secondary_sales 
    (contractId, nftId, previousOwner, newOwner, salePrice, saleToken, royaltyAmount, royaltyRate, transactionHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    contractId,
    nftId,
    previousOwner,
    newOwner,
    salePrice.toString(),
    saleToken,
    royaltyAmount.toString(),
    royaltyRate,
    transactionHash
  );
  countWrite();
  return result.lastInsertRowid;
}

/**
 * Get all secondary sales for a contract with optional filtering.
 * Pass undistributedOnly=true to return only rows where distributed = 0.
 * Supports optional date range filtering with startDate and endDate.
 */
export function getSecondarySales(
  contractId,
  limit = 50,
  offset = 0,
  nftId = null,
  undistributedOnly = false,
  startDate = null,
  endDate = null
) {
  let query = `
    SELECT 
      id,
      nftId,
      previousOwner,
      newOwner,
      salePrice,
      saleToken,
      royaltyAmount,
      royaltyRate,
      distributed,
      timestamp,
      transactionHash
    FROM secondary_sales
    WHERE contractId = ?
  `;
  const params = [contractId];

  if (nftId) {
    query += ` AND nftId = ?`;
    params.push(nftId);
  }

  if (undistributedOnly) {
    query += ` AND distributed = 0`;
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Count secondary sales for a contract (ignores LIMIT/OFFSET).
 * Supports optional date range filtering with startDate and endDate.
 */
export function countSecondarySales(contractId, nftId = null, startDate = null, endDate = null) {
  let query = `SELECT COUNT(*) as total FROM secondary_sales WHERE contractId = ?`;
  const params = [contractId];

  if (nftId) {
    query += ` AND nftId = ?`;
    params.push(nftId);
  }

  if (startDate) {
    query += ` AND timestamp >= ?`;
    params.push(startDate);
  }

  if (endDate) {
    query += ` AND timestamp <= ?`;
    params.push(endDate);
  }

  return db.prepare(query).get(...params).total;
}

/**
 * Mark an array of secondary sale IDs as distributed.
 */
export function markSalesDistributed(ids) {
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE secondary_sales SET distributed = 1 WHERE id IN (${placeholders})`).run(
    ...ids
  );
  countWrite();
}

/**
 * Record a secondary royalty distribution transaction.
 */
export function recordSecondaryRoyaltyDistribution(
  transactionId,
  contractId,
  totalRoyaltiesDistributed,
  numberOfSales
) {
  const stmt = db.prepare(`
    INSERT INTO secondary_royalty_distributions 
    (transactionId, contractId, totalRoyaltiesDistributed, numberOfSales)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(
    transactionId,
    contractId,
    totalRoyaltiesDistributed.toString(),
    numberOfSales
  );
  countWrite();
  return result;
}

/**
 * Get secondary royalty distribution history for a contract.
 */
export function getSecondaryRoyaltyDistributions(contractId, limit = 50, offset = 0) {
  const stmt = db.prepare(`
    SELECT 
      srd.id,
      srd.transactionId,
      srd.totalRoyaltiesDistributed,
      srd.numberOfSales,
      srd.timestamp,
      t.txHash,
      t.status,
      t.initiatorAddress
    FROM secondary_royalty_distributions srd
    LEFT JOIN transactions t ON srd.transactionId = t.id
    WHERE srd.contractId = ?
    ORDER BY srd.timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

/**
 * Get royalty statistics for a contract.
 * Always returns consistent types — numeric fields use toFixed(7) strings,
 * counts are integers, and null is never returned for aggregates.
 */
export function getRoyaltyStatistics(contractId) {
  const totalSalesStmt = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(CAST(royaltyAmount as REAL)), 0) as totalRoyalties,
      COALESCE(SUM(CAST(salePrice as REAL)), 0) as totalVolume
    FROM secondary_sales
    WHERE contractId = ?
  `);
  const totalSales = totalSalesStmt.get(contractId);

  const pendingPoolStmt = db.prepare(`
    SELECT COALESCE(SUM(CAST(royaltyAmount as REAL)), 0) as pendingPool
    FROM secondary_sales
    WHERE contractId = ?
      AND timestamp > COALESCE(
        (SELECT MAX(timestamp) FROM secondary_royalty_distributions WHERE contractId = ?),
        '1970-01-01'
      )
  `);
  const pendingPool = pendingPoolStmt.get(contractId, contractId);

  const lastDistributionStmt = db.prepare(`
    SELECT srd.timestamp, srd.totalRoyaltiesDistributed, srd.numberOfSales, t.txHash
    FROM secondary_royalty_distributions srd
    LEFT JOIN transactions t ON srd.transactionId = t.id
    WHERE srd.contractId = ?
    ORDER BY srd.timestamp DESC
    LIMIT 1
  `);
  const lastDistribution = lastDistributionStmt.get(contractId);

  return {
    totalSecondarySales: totalSales.count,
    totalRoyaltiesGenerated: totalSales.totalRoyalties.toFixed(7),
    totalVolume: totalSales.totalVolume.toFixed(7),
    pendingRoyaltyPool: pendingPool.pendingPool.toFixed(7),
    lastDistribution: lastDistribution || null,
  };
}

/**
 * SQL-aggregated analytics — replaces in-memory JS loops in the route handler.
 */
export function getAnalyticsData(contractId, startDate, endDate) {
  const summary = db
    .prepare(
      `SELECT
        COUNT(DISTINCT t.id) as totalTransactions,
        COALESCE(SUM(CAST(dp.amountReceived as REAL)), 0) as totalDistributed,
        COALESCE(AVG(CAST(dp.amountReceived as REAL)), 0) as averagePayout
      FROM transactions t
      LEFT JOIN distribution_payouts dp ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.type != 'initialize'
        AND t.timestamp BETWEEN ? AND ?`
    )
    .get(contractId, startDate, endDate);

  const trends = db
    .prepare(
      `SELECT
        DATE(t.timestamp) as date,
        SUM(CAST(dp.amountReceived as REAL)) as amount,
        COUNT(*) as count
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY DATE(t.timestamp)
      ORDER BY date ASC`
    )
    .all(contractId, startDate, endDate);

  const topEarners = db
    .prepare(
      `SELECT
        dp.collaboratorAddress as address,
        SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
        COUNT(*) as payouts
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY totalEarned DESC
      LIMIT 10`
    )
    .all(contractId, startDate, endDate);

  const collaboratorStats = db
    .prepare(
      `SELECT
        dp.collaboratorAddress as address,
        SUM(CAST(dp.amountReceived as REAL)) as totalEarned,
        COUNT(*) as payoutCount
      FROM distribution_payouts dp
      JOIN transactions t ON dp.transactionId = t.id
      WHERE t.contractId = ? AND t.status = 'confirmed'
        AND t.timestamp BETWEEN ? AND ?
      GROUP BY dp.collaboratorAddress
      ORDER BY totalEarned DESC`
    )
    .all(contractId, startDate, endDate);

  return { summary, trends, topEarners, collaboratorStats };
}

// Contributor Onboarding database functions (#567)
export function getContributorOnboarding(walletAddress) {
  if (!walletAddress) return null;
  const stmt = db.prepare(`SELECT * FROM contributor_onboarding WHERE walletAddress = ?`);
  const record = stmt.get(walletAddress);

  const payoutStmt = db.prepare(`SELECT COUNT(*) as count FROM distribution_payouts WHERE collaboratorAddress = ?`);
  const payoutCount = payoutStmt.get(walletAddress)?.count || 0;
  const firstDistributionReceived = payoutCount > 0 ? 1 : 0;

  if (!record) {
    return {
      walletAddress,
      email: "",
      kycStatus: "pending",
      paymentPreferencesSet: 0,
      payoutToken: "XLM",
      taxInfoSubmitted: 0,
      firstDistributionReceived,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ...record,
    firstDistributionReceived: record.firstDistributionReceived || firstDistributionReceived ? 1 : 0,
  };
}

export function upsertContributorOnboarding(walletAddress, data = {}) {
  if (!walletAddress) return null;

  const existing = getContributorOnboarding(walletAddress);
  const email = data.email !== undefined ? data.email : (existing?.email || "");
  const kycStatus = data.kycStatus !== undefined ? data.kycStatus : (existing?.kycStatus || "pending");
  const paymentPreferencesSet =
    data.paymentPreferencesSet !== undefined
      ? data.paymentPreferencesSet
        ? 1
        : 0
      : existing?.paymentPreferencesSet || 0;
  const payoutToken = data.payoutToken !== undefined ? data.payoutToken : (existing?.payoutToken || "XLM");
  const taxInfoSubmitted =
    data.taxInfoSubmitted !== undefined ? (data.taxInfoSubmitted ? 1 : 0) : existing?.taxInfoSubmitted || 0;

  const stmt = db.prepare(`
    INSERT INTO contributor_onboarding (
      walletAddress, email, kycStatus, paymentPreferencesSet, payoutToken, taxInfoSubmitted, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(walletAddress) DO UPDATE SET
      email = excluded.email,
      kycStatus = excluded.kycStatus,
      paymentPreferencesSet = excluded.paymentPreferencesSet,
      payoutToken = excluded.payoutToken,
      taxInfoSubmitted = excluded.taxInfoSubmitted,
      updatedAt = CURRENT_TIMESTAMP
  `);

  stmt.run(walletAddress, email, kycStatus, paymentPreferencesSet, payoutToken, taxInfoSubmitted);
  countWrite();

  return getContributorOnboarding(walletAddress);
}

export default db;

