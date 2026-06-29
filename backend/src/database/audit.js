/**
 * Audit logging functions.
 * Tracks all contract-related actions for compliance and debugging.
 * Issue #395: Implements hash chain for tamper-evident audit log.
 */

import { db, countWrite, computeAuditEntryHash } from "./core.js";

export function getAuditLog(contractId, limit = 100, offset = 0) {
  const stmt = db.prepare(`
    SELECT 
      id,
      contractId,
      action,
      user,
      details,
      entry_hash,
      prev_hash,
      timestamp
    FROM audit_log
    WHERE contractId = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset).map((row) => {
    let details = null;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (_) {
      // Keep malformed legacy audit details readable as null.
    }
    return { ...row, details };
  });
}

export function addAuditLog(contractId, action, user, details) {
  const timestamp = new Date().toISOString();
  const detailsJson = JSON.stringify(details);
  
  // Get the previous entry's hash to maintain the chain
  const prevEntry = db.prepare(`
    SELECT entry_hash FROM audit_log 
    ORDER BY id DESC LIMIT 1
  `).get();
  
  const prevHash = prevEntry?.entry_hash || null;
  
  // Compute hash for this entry
  const entryHash = computeAuditEntryHash(
    contractId,
    action,
    user,
    detailsJson,
    timestamp,
    prevHash
  );
  
  const stmt = db.prepare(`
    INSERT INTO audit_log 
    (contractId, action, user, details, entry_hash, prev_hash, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, detailsJson, entryHash, prevHash, timestamp);
  countWrite();
}

export function exportAuditLogs(filters = {}, limit = 10000, offset = 0) {
  const conditions = [];
  const params = [];

  if (filters.contractId) {
    conditions.push("contractId = ?");
    params.push(filters.contractId);
  }

  if (filters.action) {
    conditions.push("action = ?");
    params.push(filters.action);
  }

  if (filters.start) {
    conditions.push("timestamp >= ?");
    params.push(filters.start);
  }

  if (filters.end) {
    conditions.push("timestamp <= ?");
    params.push(filters.end);
  }

  let sql = `
    SELECT 
      timestamp,
      action,
      contractId,
      user AS actor,
      details
    FROM audit_log
  `;

  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }

  sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const stmt = db.prepare(sql);
  return stmt.all(...params).map((row) => {
    let details = null;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (_) {
      // Keep malformed legacy audit details readable as null.
    }
    return { ...row, details };
  });
}
