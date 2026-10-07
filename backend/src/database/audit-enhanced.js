import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { countWrite } from "./index.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");
const db = new Database(dbPath);

/**
 * #986: Comprehensive audit log and compliance tracking with immutable hash-chain
 */

/**
 * Calculate hash of audit entry
 */
function calculateEntryHash(entry) {
  const data = `${entry.contractId}|${entry.action}|${entry.user}|${entry.details}|${entry.timestamp}|${entry.previousHash || ""}`;
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Get the last audit chain entry
 */
function getLastChainEntry() {
  return db
    .prepare(`SELECT * FROM audit_chain ORDER BY id DESC LIMIT 1`)
    .get();
}

/**
 * Add audit log entry with immutable hash-chain
 * @param {string} contractId
 * @param {string} action
 * @param {string} user - Wallet address or user identifier
 * @param {object} details - Arbitrary JSON details
 * @param {string} category - Category: admin_action | transaction | configuration | dispute | access
 * @param {string} severity - Severity: info | warning | critical
 * @param {string} ipAddress - IP address of requester
 * @param {string} userAgent - User agent string
 * @returns {number} Entry ID
 */
export function addAuditEntry({
  contractId,
  action,
  user,
  details,
  category = "admin_action",
  severity = "info",
  ipAddress = null,
  userAgent = null,
}) {
  const now = new Date().toISOString();
  const lastEntry = getLastChainEntry();
  const previousHash = lastEntry?.entryHash || null;

  const entry = {
    contractId,
    action,
    user,
    details: JSON.stringify(details),
    timestamp: now,
    previousHash,
  };

  const entryHash = calculateEntryHash(entry);

  const stmt = db.prepare(`
    INSERT INTO audit_chain 
    (contractId, action, user, details, category, severity, ipAddress, userAgent, timestamp, previousHash, entryHash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    contractId,
    action,
    user,
    entry.details,
    category,
    severity,
    ipAddress,
    userAgent,
    now,
    previousHash,
    entryHash
  );

  countWrite();

  logger.info("Audit entry added to chain", {
    id: result.lastInsertRowid,
    contractId,
    action,
    user,
    category,
    severity,
  });

  return result.lastInsertRowid;
}

/**
 * Verify integrity of audit chain
 * @returns {object} { valid: boolean, brokenAt: number|null, totalEntries: number }
 */
export function verifyAuditChainIntegrity() {
  const entries = db
    .prepare(`SELECT * FROM audit_chain ORDER BY id ASC`)
    .all();

  if (entries.length === 0) {
    return { valid: true, brokenAt: null, totalEntries: 0 };
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const calculatedHash = calculateEntryHash(entry);

    // Verify hash matches
    if (calculatedHash !== entry.entryHash) {
      logger.error("Audit chain integrity broken: hash mismatch", {
        entryId: entry.id,
        expected: entry.entryHash,
        calculated: calculatedHash,
      });
      return { valid: false, brokenAt: entry.id, totalEntries: entries.length };
    }

    // Verify chain linkage (except for first entry)
    if (i > 0) {
      const prevEntry = entries[i - 1];
      if (entry.previousHash !== prevEntry.entryHash) {
        logger.error("Audit chain integrity broken: chain linkage mismatch", {
          entryId: entry.id,
          expectedPrevHash: prevEntry.entryHash,
          actualPrevHash: entry.previousHash,
        });
        return { valid: false, brokenAt: entry.id, totalEntries: entries.length };
      }
    }
  }

  return { valid: true, brokenAt: null, totalEntries: entries.length };
}

/**
 * Get audit entries with advanced filtering
 */
export function getAuditEntries({
  contractId = null,
  action = null,
  user = null,
  category = null,
  severity = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
}) {
  let query = `SELECT * FROM audit_chain WHERE 1=1`;
  const params = [];

  if (contractId) {
    query += ` AND contractId = ?`;
    params.push(contractId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
  }

  if (user) {
    query += ` AND user = ?`;
    params.push(user);
  }

  if (category) {
    query += ` AND category = ?`;
    params.push(category);
  }

  if (severity) {
    query += ` AND severity = ?`;
    params.push(severity);
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
 * Get audit statistics
 */
export function getAuditStatistics(contractId = null, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const baseQuery = contractId
    ? `SELECT 
         COUNT(*) as totalEntries,
         COUNT(DISTINCT user) as uniqueUsers,
         COUNT(DISTINCT action) as uniqueActions,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as criticalEvents,
         SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warningEvents,
         SUM(CASE WHEN category = 'admin_action' THEN 1 ELSE 0 END) as adminActions,
         SUM(CASE WHEN category = 'transaction' THEN 1 ELSE 0 END) as transactions,
         SUM(CASE WHEN category = 'dispute' THEN 1 ELSE 0 END) as disputes
       FROM audit_chain
       WHERE contractId = ? AND timestamp >= ?`
    : `SELECT 
         COUNT(*) as totalEntries,
         COUNT(DISTINCT user) as uniqueUsers,
         COUNT(DISTINCT contractId) as uniqueContracts,
         COUNT(DISTINCT action) as uniqueActions,
         SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as criticalEvents,
         SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) as warningEvents,
         SUM(CASE WHEN category = 'admin_action' THEN 1 ELSE 0 END) as adminActions,
         SUM(CASE WHEN category = 'transaction' THEN 1 ELSE 0 END) as transactions,
         SUM(CASE WHEN category = 'dispute' THEN 1 ELSE 0 END) as disputes
       FROM audit_chain
       WHERE timestamp >= ?`;

  const params = contractId ? [contractId, since] : [since];
  return db.prepare(baseQuery).get(...params);
}

/**
 * Export audit log to JSON format
 */
export function exportAuditLogJSON(contractId = null, startDate = null, endDate = null) {
  const entries = getAuditEntries({
    contractId,
    startDate,
    endDate,
    limit: 10000, // Large limit for export
    offset: 0,
  });

  return {
    exportedAt: new Date().toISOString(),
    contractId,
    dateRange: { start: startDate, end: endDate },
    totalEntries: entries.length,
    entries: entries.map((e) => ({
      ...e,
      details: JSON.parse(e.details),
    })),
  };
}

/**
 * Export audit log to CSV format
 */
export function exportAuditLogCSV(contractId = null, startDate = null, endDate = null) {
  const entries = getAuditEntries({
    contractId,
    startDate,
    endDate,
    limit: 10000,
    offset: 0,
  });

  const headers = [
    "ID",
    "Contract ID",
    "Action",
    "User",
    "Category",
    "Severity",
    "IP Address",
    "Timestamp",
    "Details",
    "Entry Hash",
  ];

  const rows = entries.map((e) => [
    e.id,
    e.contractId,
    e.action,
    e.user,
    e.category,
    e.severity,
    e.ipAddress || "",
    e.timestamp,
    e.details,
    e.entryHash,
  ]);

  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")
    ),
  ].join("\n");

  return csvContent;
}

/**
 * Get compliance report for a date range
 */
export function getComplianceReport(contractId, startDate, endDate) {
  const entries = getAuditEntries({ contractId, startDate, endDate, limit: 10000, offset: 0 });
  const stats = getAuditStatistics(contractId, 365); // Full year stats
  const integrity = verifyAuditChainIntegrity();

  // Group by category
  const byCategory = {};
  entries.forEach((e) => {
    if (!byCategory[e.category]) {
      byCategory[e.category] = [];
    }
    byCategory[e.category].push(e);
  });

  // Group by severity
  const bySeverity = {};
  entries.forEach((e) => {
    if (!bySeverity[e.severity]) {
      bySeverity[e.severity] = [];
    }
    bySeverity[e.severity].push(e);
  });

  return {
    reportGeneratedAt: new Date().toISOString(),
    contractId,
    dateRange: { start: startDate, end: endDate },
    totalEntries: entries.length,
    chainIntegrity: integrity,
    statistics: stats,
    entriesByCategory: Object.keys(byCategory).map((cat) => ({
      category: cat,
      count: byCategory[cat].length,
    })),
    entriesBySeverity: Object.keys(bySeverity).map((sev) => ({
      severity: sev,
      count: bySeverity[sev].length,
    })),
    criticalEvents: entries.filter((e) => e.severity === "critical"),
    recentAdminActions: entries
      .filter((e) => e.category === "admin_action")
      .slice(0, 50),
  };
}

/**
 * Search audit log
 */
export function searchAuditLog(searchTerm, contractId = null, limit = 100) {
  let query = `
    SELECT * FROM audit_chain 
    WHERE (
      action LIKE ? OR 
      user LIKE ? OR 
      details LIKE ?
    )
  `;
  const params = [`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`];

  if (contractId) {
    query += ` AND contractId = ?`;
    params.push(contractId);
  }

  query += ` ORDER BY timestamp DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(query).all(...params);
}
