/**
 * Contributor communication history — closes #612.
 *
 * Stores all communications with contributors (emails, support tickets, messages)
 * in one place with a timeline view, search, and internal notes for admins.
 *
 * Features:
 *   - recordCommunication   — store any type of communication
 *   - getCommunicationsByWallet — all comms for a contributor
 *   - getCommunicationsByContract — all comms for a contract
 *   - searchCommunications  — full-text search across messages
 *   - addInternalNote       — admin-only internal notes
 *   - getCommunicationTimeline — chronological timeline
 */

import { db, countWrite } from "./core.js";

// ─── Schema ────────────────────────────────────────────────────────────────────

/**
 * Initialize the contributor_communications table.
 * Called from core.js migration or during setup.
 */
export function ensureCommunicationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contributor_communications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      walletAddress TEXT NOT NULL,
      contractId TEXT,
      type TEXT NOT NULL CHECK(type IN (
        'email', 'support_ticket', 'message', 'internal_note', 'system_notification'
      )),
      subject TEXT,
      body TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound', 'internal')),
      status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent', 'received', 'draft', 'archived')),
      isInternal INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      referenceId TEXT,
      createdBy TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_contributor_comms_wallet
      ON contributor_communications(walletAddress);
    CREATE INDEX IF NOT EXISTS idx_contributor_comms_contract
      ON contributor_communications(contractId);
    CREATE INDEX IF NOT EXISTS idx_contributor_comms_type
      ON contributor_communications(type);
    CREATE INDEX IF NOT EXISTS idx_contributor_comms_created
      ON contributor_communications(createdAt);
    CREATE INDEX IF NOT EXISTS idx_contributor_comms_wallet_created
      ON contributor_communications(walletAddress, createdAt);
  `);
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Record a communication with a contributor.
 *
 * @param {object} params
 * @param {string}  params.walletAddress  Stellar G-address
 * @param {string}  [params.contractId]   Optional contract ID
 * @param {"email"|"support_ticket"|"message"|"internal_note"|"system_notification"} params.type
 * @param {string}  [params.subject]      Subject line
 * @param {string}  params.body           Message body
 * @param {"inbound"|"outbound"|"internal"} params.direction
 * @param {"sent"|"received"|"draft"|"archived"} [params.status="sent"]
 * @param {boolean} [params.isInternal=false]  Visible to admins only
 * @param {object}  [params.metadata]     Additional structured data (JSON)
 * @param {string}  [params.referenceId]  External reference (e.g. email ID, ticket #)
 * @param {string}  [params.createdBy]    Who created this record
 * @returns {object}  The created communication record
 */
export function recordCommunication({
  walletAddress,
  contractId = null,
  type,
  subject = null,
  body,
  direction,
  status = "sent",
  isInternal = false,
  metadata = null,
  referenceId = null,
  createdBy = null,
}) {
  const now = new Date().toISOString();
  const metadataJson = metadata ? JSON.stringify(metadata) : null;

  const result = db
    .prepare(
      `INSERT INTO contributor_communications
       (walletAddress, contractId, type, subject, body, direction, status, isInternal, metadata, referenceId, createdBy, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      walletAddress,
      contractId,
      type,
      subject,
      body,
      direction,
      status,
      isInternal ? 1 : 0,
      metadataJson,
      referenceId,
      createdBy,
      now
    );

  countWrite();

  return {
    id: result.lastInsertRowid,
    walletAddress,
    contractId,
    type,
    subject,
    body,
    direction,
    status,
    isInternal,
    metadata: metadataJson,
    referenceId,
    createdBy,
    createdAt: now,
  };
}

/**
 * Get all communications for a wallet address, newest first.
 * Internal notes are only included if explicitly requested.
 *
 * @param {string} walletAddress
 * @param {{ includeInternal?: boolean, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getCommunicationsByWallet(
  walletAddress,
  { includeInternal = false, limit = 50, offset = 0 } = {}
) {
  const internalClause = includeInternal ? "" : " AND isInternal = 0";

  return db
    .prepare(
      `SELECT * FROM contributor_communications
       WHERE walletAddress = ?${internalClause}
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

/**
 * Get all communications for a contract, newest first.
 *
 * @param {string} contractId
 * @param {{ includeInternal?: boolean, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getCommunicationsByContract(
  contractId,
  { includeInternal = false, limit = 50, offset = 0 } = {}
) {
  const internalClause = includeInternal ? "" : " AND isInternal = 0";

  return db
    .prepare(
      `SELECT * FROM contributor_communications
       WHERE contractId = ?${internalClause}
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(contractId, limit, offset);
}

/**
 * Full-text search across communication bodies and subjects.
 *
 * @param {string}  query     Search term
 * @param {{ includeInternal?: boolean, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function searchCommunications(
  query,
  { includeInternal = false, limit = 50, offset = 0 } = {}
) {
  const internalClause = includeInternal ? "" : " AND isInternal = 0";
  const searchTerm = `%${query}%`;

  return db
    .prepare(
      `SELECT * FROM contributor_communications
       WHERE (body LIKE ? OR subject LIKE ? OR walletAddress LIKE ? OR referenceId LIKE ?)${internalClause}
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(searchTerm, searchTerm, searchTerm, searchTerm, limit, offset);
}

/**
 * Add an internal note to a contributor's communication history.
 * Internal notes are visible to admins only.
 *
 * @param {object} params
 * @param {string} params.walletAddress
 * @param {string} [params.contractId]
 * @param {string} params.body
 * @param {string} [params.createdBy]
 * @returns {object}
 */
export function addInternalNote({ walletAddress, contractId = null, body, createdBy = null }) {
  return recordCommunication({
    walletAddress,
    contractId,
    type: "internal_note",
    body,
    direction: "internal",
    status: "sent",
    isInternal: true,
    createdBy,
  });
}

/**
 * Get a chronological timeline of communications for a wallet.
 * Internal notes are only included if explicitly requested.
 *
 * @param {string} walletAddress
 * @param {{ includeInternal?: boolean, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getCommunicationTimeline(
  walletAddress,
  { includeInternal = false, limit = 100, offset = 0 } = {}
) {
  const internalClause = includeInternal ? "" : " AND isInternal = 0";

  return db
    .prepare(
      `SELECT * FROM contributor_communications
       WHERE walletAddress = ?${internalClause}
       ORDER BY createdAt ASC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

/**
 * Count communications for a wallet (for pagination metadata).
 *
 * @param {string} walletAddress
 * @param {{ includeInternal?: boolean }} [opts]
 * @returns {number}
 */
export function countCommunications(walletAddress, { includeInternal = false } = {}) {
  const internalClause = includeInternal ? "" : " AND isInternal = 0";

  return db
    .prepare(
      `SELECT COUNT(*) AS total FROM contributor_communications
       WHERE walletAddress = ?${internalClause}`
    )
    .get(walletAddress).total;
}
