/**
 * Audit logging functions.
 * Tracks all contract-related actions for compliance and debugging.
 */

import { db, countWrite } from "./core.js";
import { AUDIT_ACTIONS } from "../validation.js";
import { createHash } from "node:crypto";

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contractId TEXT NOT NULL,
    action TEXT NOT NULL,
    user TEXT,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    prevHash TEXT,
    entryHash TEXT
  );
`);
for (const column of ["prevHash", "entryHash"]) {
  try { db.exec(`ALTER TABLE audit_log ADD COLUMN ${column} TEXT`); } catch (_) { /* already exists */ }
}
let legacyPrevious = null;
for (const row of db.prepare("SELECT id, contractId, action, user, details, timestamp, prevHash, entryHash FROM audit_log ORDER BY id ASC").all()) {
  if (row.entryHash) {
    legacyPrevious = row.entryHash;
    continue;
  }
  let details = row.details;
  try { details = JSON.parse(row.details || "{}"); } catch (_) { /* preserve legacy text */ }
  const payload = JSON.stringify({ contractId: row.contractId, action: row.action, user: row.user, details, timestamp: row.timestamp, prevHash: legacyPrevious });
  const entryHash = createHash("sha256").update(payload).digest("hex");
  db.prepare("UPDATE audit_log SET prevHash = ?, entryHash = ? WHERE id = ?").run(legacyPrevious, entryHash, row.id);
  legacyPrevious = entryHash;
}

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
      timestamp,
      prevHash,
      entryHash
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

  const cleanDetails = stripSensitiveDetails(details);
  const previous = db.prepare("SELECT entryHash FROM audit_log ORDER BY id DESC LIMIT 1").get();
  const timestamp = new Date().toISOString();
  const prevHash = previous?.entryHash ?? null;
  const payload = JSON.stringify({ contractId, action, user, details: cleanDetails, timestamp, prevHash });
  const entryHash = createHash("sha256").update(payload).digest("hex");
  const stmt = db.prepare(`
    INSERT INTO audit_log
    (contractId, action, user, details, timestamp, prevHash, entryHash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(contractId, action, user, JSON.stringify(cleanDetails), timestamp, prevHash, entryHash);
  countWrite();
}
