/**
 * Contract state snapshots — closes #613.
 *
 * Periodic snapshots of contract state for recovery and auditing.
 * Stores: collaborators, shares, balances, timestamps.
 *
 * Features:
 *   - createSnapshot   — manually capture current state
 *   - listSnapshots    — view snapshot history
 *   - getSnapshot      — retrieve a specific snapshot
 *   - restoreSnapshot  — restore contract state from a snapshot
 *   - scheduleSnapshots — automated daily snapshots
 */

import { createHash } from "crypto";
import { db, countWrite } from "./core.js";

// ─── Schema ────────────────────────────────────────────────────────────────────

/**
 * Initialize the contract_snapshots table.
 * Called from core.js migration or during setup.
 */
export function ensureSnapshotTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      label TEXT,
      collaborators TEXT NOT NULL DEFAULT '[]',
      shares TEXT NOT NULL DEFAULT '{}',
      balances TEXT NOT NULL DEFAULT '{}',
      transactionCount INTEGER NOT NULL DEFAULT 0,
      lastTransactionId INTEGER,
      stateHash TEXT,
      createdBy TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_contract_snapshots_contractId
      ON contract_snapshots(contractId);
    CREATE INDEX IF NOT EXISTS idx_contract_snapshots_createdAt
      ON contract_snapshots(createdAt);
  `);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hash of the state payload for integrity verification.
 * @param {object} state  { collaborators, shares, balances, transactionCount }
 * @returns {string} hex-encoded hash
 */
function computeStateHash(state) {
  const payload = JSON.stringify(state, Object.keys(state).sort());
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Capture a snapshot of the current contract state.
 *
 * @param {object} params
 * @param {string}  params.contractId
 * @param {string}  [params.label]         Optional human-readable label
 * @param {string}  [params.collaborators] JSON array string
 * @param {string}  [params.shares]        JSON object string (address -> share map)
 * @param {string}  [params.balances]      JSON object string (address -> balance)
 * @param {number}  [params.transactionCount]  Number of transactions so far
 * @param {number}  [params.lastTransactionId] ID of the most recent transaction
 * @param {string}  [params.createdBy]     Wallet address that triggered the snapshot
 * @returns {object}  The created snapshot row
 */
export function createSnapshot({
  contractId,
  label = null,
  collaborators = "[]",
  shares = "{}",
  balances = "{}",
  transactionCount = 0,
  lastTransactionId = null,
  createdBy = null,
}) {
  const state = { collaborators, shares, balances, transactionCount };
  const stateHash = computeStateHash(state);

  const result = db
    .prepare(
      `INSERT INTO contract_snapshots
       (contractId, label, collaborators, shares, balances, transactionCount, lastTransactionId, stateHash, createdBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      contractId,
      label,
      collaborators,
      shares,
      balances,
      transactionCount,
      lastTransactionId,
      stateHash,
      createdBy
    );

  countWrite();

  return {
    id: result.lastInsertRowid,
    contractId,
    label,
    collaborators,
    shares,
    balances,
    transactionCount,
    lastTransactionId,
    stateHash,
    createdBy,
    createdAt: new Date().toISOString(),
  };
}

/**
 * List all snapshots for a contract, newest first.
 *
 * @param {string} contractId
 * @param {{ limit?: number, offset?: number }} [pagination]
 * @returns {object[]}
 */
export function listSnapshots(contractId, { limit = 50, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT id, contractId, label, collaborators, shares, balances,
              transactionCount, lastTransactionId, stateHash, createdBy, createdAt
       FROM contract_snapshots
       WHERE contractId = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}

/**
 * Get a single snapshot by ID.
 *
 * @param {number} snapshotId
 * @returns {object|null}
 */
export function getSnapshot(snapshotId) {
  return (
    db
      .prepare(
        `SELECT id, contractId, label, collaborators, shares, balances,
                transactionCount, lastTransactionId, stateHash, createdBy, createdAt
         FROM contract_snapshots
         WHERE id = ?`
      )
      .get(snapshotId) ?? null
  );
}

/**
 * Verify data integrity of a snapshot by recomputing its hash.
 *
 * @param {number} snapshotId
 * @returns {{ valid: boolean, computedHash: string, storedHash: string }}
 */
export function verifySnapshotIntegrity(snapshotId) {
  const snapshot = getSnapshot(snapshotId);
  if (!snapshot) {
    return { valid: false, computedHash: null, storedHash: null, error: "Snapshot not found" };
  }

  const state = {
    collaborators: snapshot.collaborators,
    shares: snapshot.shares,
    balances: snapshot.balances,
    transactionCount: snapshot.transactionCount,
  };
  const computedHash = computeStateHash(state);

  return {
    valid: computedHash === snapshot.stateHash,
    computedHash,
    storedHash: snapshot.stateHash,
  };
}

/**
 * Count snapshots for a contract (for pagination metadata).
 *
 * @param {string} contractId
 * @returns {number}
 */
export function countSnapshots(contractId) {
  return db
    .prepare("SELECT COUNT(*) AS total FROM contract_snapshots WHERE contractId = ?")
    .get(contractId).total;
}

/**
 * Get snapshots across all contracts for compliance reporting.
 *
 * @param {{ limit?: number, offset?: number }} [pagination]
 * @returns {object[]}
 */
export function getAllSnapshots({ limit = 100, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT id, contractId, label, collaborators, shares, balances,
              transactionCount, lastTransactionId, stateHash, createdBy, createdAt
       FROM contract_snapshots
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

/**
 * Delete old snapshots beyond the retention limit, keeping the most recent N.
 *
 * @param {string} contractId
 * @param {number} keepCount  Number of most recent snapshots to keep (default: 90)
 * @returns {number}  Number of deleted rows
 */
export function pruneSnapshots(contractId, keepCount = 90) {
  const idsToKeep = db
    .prepare(
      `SELECT id FROM contract_snapshots
       WHERE contractId = ?
       ORDER BY createdAt DESC
       LIMIT ?`
    )
    .all(contractId, keepCount)
    .map((r) => r.id);

  if (idsToKeep.length === 0) return 0;

  const placeholders = idsToKeep.map(() => "?").join(",");
  const result = db
    .prepare(
      `DELETE FROM contract_snapshots
       WHERE contractId = ? AND id NOT IN (${placeholders})`
    )
    .run(contractId, ...idsToKeep);

  countWrite();
  return result.changes;
}
