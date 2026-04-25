import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "audit.db");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL"); // safe with WAL, much faster
db.pragma("cache_size = -64000"); // 64MB page cache
db.pragma("foreign_keys = ON"); // enforce FK constraints
db.pragma("temp_store = MEMORY"); // temp tables in memory

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
  ];

  const applied = db
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((r) => r.version);

  for (const migration of migrations) {
    if (!applied.includes(migration.version)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        migration.version,
      );
      console.log(`Applied migration v${migration.version}`);
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
  } catch (_) { /* column already exists */ }

  try {
    db.exec(`ALTER TABLE distribution_payouts ADD COLUMN contractId TEXT NOT NULL DEFAULT ''`);
  } catch (_) { /* column already exists */ }
}

// Transaction tracking functions
export function recordTransaction(contractId, type, initiatorAddress, data) {
  const { requestedAmount, tokenId } = data;

  const stmt = db.prepare(`
    INSERT INTO transactions 
    (contractId, type, initiatorAddress, requestedAmount, tokenId, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);

  const result = stmt.run(
    contractId,
    type,
    initiatorAddress,
    requestedAmount,
    tokenId,
  );
  return result.lastInsertRowid;
}

export function updateTransactionHash(transactionId, txHash) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET txHash = ? 
    WHERE id = ?
  `);

  stmt.run(txHash, transactionId);
}

export function updateTransactionStatus(
  txHash,
  status,
  blockTime = null,
  errorMessage = null,
) {
  const stmt = db.prepare(`
    UPDATE transactions 
    SET status = ?, blockTime = ?, errorMessage = ? 
    WHERE txHash = ?
  `);

  stmt.run(status, blockTime, errorMessage, txHash);
}

export function addDistributionPayout(
  transactionId,
  contractId,
  collaboratorAddress,
  amountReceived,
) {
  const stmt = db.prepare(`
    INSERT INTO distribution_payouts 
    (transactionId, contractId, collaboratorAddress, amountReceived)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(transactionId, contractId, collaboratorAddress, amountReceived);
}

export function getTransactionCount(contractId) {
  const stmt = db.prepare(
    `SELECT COUNT(*) as total FROM transactions WHERE contractId = ?`
  );
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

  const transaction = stmt.get(txHash);

  if (!transaction) {
    return null;
  }

  const payoutsStmt = db.prepare(`
    SELECT collaboratorAddress, amountReceived
    FROM distribution_payouts
    WHERE transactionId = ?
  `);

  const payouts = payoutsStmt.all(transaction.id);

  return {
    ...transaction,
    payouts,
  };
}

export function getAuditLog(contractId, limit = 100, offset = 0) {
  const stmt = db.prepare(`
    SELECT 
      id,
      contractId,
      action,
      user,
      details,
      timestamp
    FROM audit_log
    WHERE contractId = ?
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

export function addAuditLog(contractId, action, user, details) {
  const stmt = db.prepare(`
    INSERT INTO audit_log 
    (contractId, action, user, details)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, JSON.stringify(details));
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
  return result.lastInsertRowid;
}

/**
 * Get all secondary sales for a contract with optional filtering.
 * Pass undistributedOnly=true to return only rows where distributed = 0.
 */
export function getSecondarySales(contractId, limit = 50, offset = 0, nftId = null, undistributedOnly = false) {
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

  query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

/**
 * Count secondary sales for a contract (ignores LIMIT/OFFSET).
 */
export function countSecondarySales(contractId, nftId = null) {
  let query = `SELECT COUNT(*) as total FROM secondary_sales WHERE contractId = ?`;
  const params = [contractId];

  if (nftId) {
    query += ` AND nftId = ?`;
    params.push(nftId);
  }

  return db.prepare(query).get(...params).total;
}

/**
 * Mark an array of secondary sale IDs as distributed.
 */
export function markSalesDistributed(ids) {
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE secondary_sales SET distributed = 1 WHERE id IN (${placeholders})`).run(...ids);
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

  return stmt.run(
    transactionId,
    contractId,
    totalRoyaltiesDistributed.toString(),
    numberOfSales
  );
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

export default db;
