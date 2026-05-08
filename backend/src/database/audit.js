/**
 * Audit logging functions.
 * Tracks all contract-related actions for compliance and debugging.
 */

import { db, countWrite } from "./core.js";

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

  return stmt.all(contractId, limit, offset).map((row) => {
    let details = null;
    try {
      details = JSON.parse(row.details || "{}");
    } catch (_) {}
    return { ...row, details };
  });
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
