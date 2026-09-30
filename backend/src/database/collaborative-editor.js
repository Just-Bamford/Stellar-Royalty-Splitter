import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import { countWrite } from "./index.js";
import logger from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(__dirname, "..", "..", "audit.db");
const db = new Database(dbPath);

/**
 * #959: Real-time collaborative contract editor
 * Manages edit sessions and locks for collaborative editing
 */

/**
 * Create a new edit session for a contract field
 * @param {string} contractId - Contract identifier
 * @param {string} userId - User wallet address
 * @param {string} field - Field being edited (e.g., 'collaborators', 'shares', 'settings')
 * @param {number} expiresIn - Time in seconds until session expires (default: 300 = 5 minutes)
 * @returns {object} Session object with id, contractId, userId, field, lockedAt, expiresAt
 */
export function createEditSession(contractId, userId, field, expiresIn = 300) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Check if field is already locked by someone else
  const existing = db
    .prepare(
      `SELECT * FROM contract_edit_sessions 
       WHERE contractId = ? AND field = ? AND expiresAt > ? AND userId != ?`
    )
    .get(contractId, field, now, userId);

  if (existing) {
    throw new Error(`Field '${field}' is currently being edited by another user`);
  }

  // Delete expired sessions
  db.prepare(`DELETE FROM contract_edit_sessions WHERE expiresAt <= ?`).run(now);
  countWrite();

  // Create or update session
  const stmt = db.prepare(`
    INSERT INTO contract_edit_sessions (contractId, userId, field, lockedAt, expiresAt, lastActivity)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contractId, userId, field) DO UPDATE SET
      lockedAt = excluded.lockedAt,
      expiresAt = excluded.expiresAt,
      lastActivity = excluded.lastActivity
  `);

  stmt.run(contractId, userId, field, now, expiresAt, now);
  countWrite();

  logger.info("Edit session created", { contractId, userId, field, expiresAt });

  return db
    .prepare(
      `SELECT * FROM contract_edit_sessions 
       WHERE contractId = ? AND userId = ? AND field = ?`
    )
    .get(contractId, userId, field);
}

/**
 * Extend an existing edit session
 */
export function extendEditSession(sessionId, extendBy = 300) {
  const newExpiresAt = new Date(Date.now() + extendBy * 1000).toISOString();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE contract_edit_sessions
    SET expiresAt = ?, lastActivity = ?
    WHERE id = ?
  `);

  stmt.run(newExpiresAt, now, sessionId);
  countWrite();

  logger.info("Edit session extended", { sessionId, newExpiresAt });
}

/**
 * Release an edit session (unlock)
 */
export function releaseEditSession(sessionId) {
  const stmt = db.prepare(`DELETE FROM contract_edit_sessions WHERE id = ?`);
  stmt.run(sessionId);
  countWrite();

  logger.info("Edit session released", { sessionId });
}

/**
 * Get all active edit sessions for a contract
 */
export function getActiveEditSessions(contractId) {
  const now = new Date().toISOString();

  // Clean up expired sessions first
  db.prepare(`DELETE FROM contract_edit_sessions WHERE expiresAt <= ?`).run(now);
  countWrite();

  return db
    .prepare(
      `SELECT * FROM contract_edit_sessions 
       WHERE contractId = ? AND expiresAt > ?
       ORDER BY lockedAt DESC`
    )
    .all(contractId, now);
}

/**
 * Record a contract edit operation
 */
export function recordContractEdit(contractId, userId, field, oldValue, newValue, operation = "update") {
  const stmt = db.prepare(`
    INSERT INTO contract_edit_history (contractId, userId, field, oldValue, newValue, operation, editedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();
  stmt.run(contractId, userId, field, JSON.stringify(oldValue), JSON.stringify(newValue), operation, now);
  countWrite();

  logger.info("Contract edit recorded", { contractId, userId, field, operation });
}

/**
 * Get edit history for a contract
 */
export function getContractEditHistory(contractId, limit = 50, offset = 0) {
  const stmt = db.prepare(`
    SELECT * FROM contract_edit_history
    WHERE contractId = ?
    ORDER BY editedAt DESC
    LIMIT ? OFFSET ?
  `);

  return stmt.all(contractId, limit, offset);
}

/**
 * Apply operational transform for conflict resolution
 * Implements a simple Last-Write-Wins strategy with version tracking
 */
export function applyOperationalTransform(contractId, field, operation, userId) {
  const { type, value, version } = operation;

  // Get current version
  const current = db
    .prepare(`SELECT version, value FROM contract_field_versions WHERE contractId = ? AND field = ?`)
    .get(contractId, field);

  if (current && current.version > version) {
    throw new Error("Conflict detected: field has been updated by another user");
  }

  const newVersion = (current?.version || 0) + 1;
  const stmt = db.prepare(`
    INSERT INTO contract_field_versions (contractId, field, version, value, updatedBy, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contractId, field) DO UPDATE SET
      version = excluded.version,
      value = excluded.value,
      updatedBy = excluded.updatedBy,
      updatedAt = excluded.updatedAt
  `);

  const now = new Date().toISOString();
  stmt.run(contractId, field, newVersion, JSON.stringify(value), userId, now);
  countWrite();

  return { version: newVersion, value };
}

/**
 * Get field version
 */
export function getFieldVersion(contractId, field) {
  return db
    .prepare(`SELECT * FROM contract_field_versions WHERE contractId = ? AND field = ?`)
    .get(contractId, field);
}

/**
 * Clean up expired sessions (to be called periodically)
 */
export function cleanupExpiredSessions() {
  const now = new Date().toISOString();
  const result = db.prepare(`DELETE FROM contract_edit_sessions WHERE expiresAt <= ?`).run(now);
  countWrite();

  if (result.changes > 0) {
    logger.info("Cleaned up expired edit sessions", { count: result.changes });
  }

  return result.changes;
}
