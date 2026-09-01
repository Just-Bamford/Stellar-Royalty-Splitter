/**
 * Audit logging functions.
 * Tracks all contract-related actions for compliance and debugging.
 */

import { db, countWrite } from "./core.js";
import { AUDIT_ACTIONS } from "../validation.js";

// Field names that must never end up in an audit log's `details` blob. This
// is a defense-in-depth guard on top of the fact that no call site in this
// codebase ever passes secrets into addAuditLog — see routes/_shared.js and
// routes/secondary-royalty.js, none of which forward SERVER_SECRET_KEY,
// signed XDR, or wallet auth material into auditMetadata.
const SENSITIVE_DETAIL_KEY_PATTERN = /secret|private[_-]?key|password|token|auth/i;

function stripSensitiveDetails(details) {
  if (!details || typeof details !== "object") return details;
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_DETAIL_KEY_PATTERN.test(key)) continue;
    clean[key] = value;
  }
  return clean;
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
  // Defense-in-depth: only the closed set of actions the app itself emits
  // may ever be persisted, even from internal call sites. There is no public
  // endpoint that accepts an audit entry from a client request body — see
  // routes/history.js — so this primarily guards against future call sites
  // accidentally passing through unvalidated input.
  if (!AUDIT_ACTIONS.includes(action)) {
    throw new Error(`Refusing to record unsupported audit action: ${action}`);
  }

  const stmt = db.prepare(`
    INSERT INTO audit_log
    (contractId, action, user, details)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, JSON.stringify(stripSensitiveDetails(details)));
  countWrite();
}
