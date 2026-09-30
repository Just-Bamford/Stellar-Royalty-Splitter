/**
 * Rights Management Database Schema and Operations
 * 
 * Implements tracking of collaborator rights (composition, performance, mechanical, sync),
 * license terms, metadata standards (DDEX, ISO 20022), proof of ownership verifications,
 * historical change logs, and dispute linkages.
 */

import { db, countWrite } from "./core.js";

// In-memory store fallback for mocked SQLite environments in unit testing
const _memoryRights = new Map();
const _memoryMetadata = new Map();
const _memoryVerifications = new Map();
const _memoryHistory = [];
const _memoryDisputes = [];
let _nextRightId = 1;
let _nextProofId = 1;
let _nextMetaId = 1;
let _nextHistoryId = 1;
let _nextDisputeLinkId = 1;

/**
 * Initialize all database tables for the Rights Management system.
 */
export function initializeRightsTables() {
  if (!db.open) return;

  try {
    db.exec(`
      -- Rights table: tracks ownership allocations per right type and contract
      CREATE TABLE IF NOT EXISTS rights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contractId TEXT NOT NULL,
        rightType TEXT NOT NULL CHECK(rightType IN ('composition', 'performance', 'mechanical', 'sync')),
        ownerAddress TEXT NOT NULL,
        percentage REAL NOT NULL DEFAULT 0.0 CHECK(percentage >= 0.0 AND percentage <= 100.0),
        licenseTerms TEXT NOT NULL DEFAULT 'commercial' CHECK(licenseTerms IN ('commercial', 'personal', 'non-commercial')),
        status TEXT NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified', 'pending', 'verified', 'rejected')),
        isVerified INTEGER NOT NULL DEFAULT 0,
        effectiveDate DATETIME,
        expirationDate DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(contractId, rightType, ownerAddress)
      );

      CREATE INDEX IF NOT EXISTS idx_rights_contractId ON rights(contractId);
      CREATE INDEX IF NOT EXISTS idx_rights_ownerAddress ON rights(ownerAddress);

      -- Metadata table: DDEX, ISO 20022, and custom metadata fields per right
      CREATE TABLE IF NOT EXISTS rights_metadata (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rightId INTEGER NOT NULL UNIQUE,
        contractId TEXT NOT NULL,
        ddex TEXT,
        iso20022 TEXT,
        customFields TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(rightId) REFERENCES rights(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rights_metadata_rightId ON rights_metadata(rightId);

      -- Ownership verifications: proof of ownership documents
      CREATE TABLE IF NOT EXISTS rights_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rightId INTEGER NOT NULL,
        contractId TEXT NOT NULL,
        ownerAddress TEXT NOT NULL,
        documentName TEXT NOT NULL,
        documentType TEXT NOT NULL CHECK(documentType IN ('contract', 'copyright_cert', 'split_sheet', 'other')),
        documentUrl TEXT NOT NULL,
        documentHash TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'rejected')),
        verifierAddress TEXT,
        verifierNotes TEXT,
        verifiedAt DATETIME,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(rightId) REFERENCES rights(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rights_verifications_rightId ON rights_verifications(rightId);

      -- Rights history log: audit trail of all ownership & status changes
      CREATE TABLE IF NOT EXISTS rights_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rightId INTEGER NOT NULL,
        contractId TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('create', 'update', 'delete', 'verify', 'reject', 'metadata_update')),
        changedBy TEXT NOT NULL,
        oldValues TEXT,
        newValues TEXT,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_rights_history_contractId ON rights_history(contractId);
      CREATE INDEX IF NOT EXISTS idx_rights_history_rightId ON rights_history(rightId);

      -- Rights disputes link table
      CREATE TABLE IF NOT EXISTS rights_disputes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rightId INTEGER NOT NULL,
        ticketId TEXT NOT NULL,
        notes TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(rightId) REFERENCES rights(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_rights_disputes_rightId ON rights_disputes(rightId);
      CREATE INDEX IF NOT EXISTS idx_rights_disputes_ticketId ON rights_disputes(ticketId);
    `);
  } catch (_e) {
    // Ignore in mocked environment
  }
}

// Ensure tables are initialized when this module is loaded
initializeRightsTables();

/**
 * Clear all rights tables and memory state (for testing)
 */
export function clearRightsTables() {
  _memoryRights.clear();
  _memoryMetadata.clear();
  _memoryVerifications.clear();
  _memoryHistory.length = 0;
  _memoryDisputes.length = 0;
  _nextRightId = 1;
  _nextProofId = 1;
  _nextMetaId = 1;
  _nextHistoryId = 1;
  _nextDisputeLinkId = 1;

  if (db.open) {
    try {
      db.prepare(`DELETE FROM rights_disputes`).run();
      db.prepare(`DELETE FROM rights_history`).run();
      db.prepare(`DELETE FROM rights_verifications`).run();
      db.prepare(`DELETE FROM rights_metadata`).run();
      db.prepare(`DELETE FROM rights`).run();
    } catch (_e) {
      // Mocked DB fallback.
    }
  }
}


/**
 * Create a new right record.
 */
export function createRightRecord({
  contractId,
  rightType,
  ownerAddress,
  percentage,
  licenseTerms = "commercial",
  effectiveDate = null,
  expirationDate = null,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const stmt = db.prepare(`
        INSERT INTO rights (
          contractId, rightType, ownerAddress, percentage, licenseTerms,
          status, isVerified, effectiveDate, expirationDate, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, 'unverified', 0, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        contractId,
        rightType,
        ownerAddress,
        percentage,
        licenseTerms,
        effectiveDate,
        expirationDate,
        now,
        now
      );
      countWrite();
      insertId = result?.lastInsertRowid;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) {
    insertId = _nextRightId++;
  }

  const newRight = {
    id: insertId,
    contractId,
    rightType,
    ownerAddress,
    percentage,
    licenseTerms,
    status: "unverified",
    isVerified: false,
    effectiveDate,
    expirationDate,
    createdAt: now,
    updatedAt: now,
  };

  _memoryRights.set(insertId, newRight);
  return newRight;
}

/**
 * Get a right by ID.
 */
export function getRightById(id) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM rights WHERE id = ?`).get(id);
      if (row) {
        return {
          ...row,
          isVerified: Boolean(row.isVerified),
        };
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return _memoryRights.get(id) || null;
}

/**
 * Get all rights for a contract.
 */
export function getRightsByContract(contractId) {
  if (db.open) {
    try {
      const rows = db.prepare(`SELECT * FROM rights WHERE contractId = ? ORDER BY rightType ASC, ownerAddress ASC`).all(contractId);
      if (rows && rows.length > 0) {
        return rows.map((r) => ({
          ...r,
          isVerified: Boolean(r.isVerified),
        }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const results = [];
  for (const r of _memoryRights.values()) {
    if (r.contractId === contractId) {
      results.push(r);
    }
  }
  return results.sort((a, b) => a.rightType.localeCompare(b.rightType));
}

/**
 * Get all rights owned by a specific wallet address.
 */
export function getRightsByOwner(ownerAddress) {
  if (db.open) {
    try {
      const rows = db.prepare(`SELECT * FROM rights WHERE ownerAddress = ? ORDER BY createdAt DESC`).all(ownerAddress);
      if (rows && rows.length > 0) {
        return rows.map((r) => ({
          ...r,
          isVerified: Boolean(r.isVerified),
        }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const results = [];
  for (const r of _memoryRights.values()) {
    if (r.ownerAddress === ownerAddress) {
      results.push(r);
    }
  }
  return results;
}

/**
 * Update right record properties.
 */
export function updateRightRecord(id, updates) {
  const existing = getRightById(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const percentage = updates.percentage !== undefined ? updates.percentage : existing.percentage;
  const licenseTerms = updates.licenseTerms !== undefined ? updates.licenseTerms : existing.licenseTerms;
  const effectiveDate = updates.effectiveDate !== undefined ? updates.effectiveDate : existing.effectiveDate;
  const expirationDate = updates.expirationDate !== undefined ? updates.expirationDate : existing.expirationDate;
  const status = updates.status !== undefined ? updates.status : existing.status;
  const isVerified = updates.isVerified !== undefined ? (updates.isVerified ? true : false) : existing.isVerified;

  if (db.open) {
    try {
      db.prepare(`
        UPDATE rights
        SET percentage = ?, licenseTerms = ?, status = ?, isVerified = ?, effectiveDate = ?, expirationDate = ?, updatedAt = ?
        WHERE id = ?
      `).run(percentage, licenseTerms, status, isVerified ? 1 : 0, effectiveDate, expirationDate, now, id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const updated = {
    ...existing,
    percentage,
    licenseTerms,
    status,
    isVerified,
    effectiveDate,
    expirationDate,
    updatedAt: now,
  };

  _memoryRights.set(id, updated);
  return updated;
}

/**
 * Delete a right record.
 */
export function deleteRightRecord(id) {
  const existing = getRightById(id);
  if (!existing) return false;

  if (db.open) {
    try {
      db.prepare(`DELETE FROM rights WHERE id = ?`).run(id);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryRights.delete(id);
  return true;
}

/**
 * Metadata CRUD
 */
export function upsertRightMetadataRecord(rightId, contractId, { ddex = null, iso20022 = null, customFields = null }) {
  const now = new Date().toISOString();
  const ddexObj = ddex ? (typeof ddex === "string" ? JSON.parse(ddex) : ddex) : null;
  const isoObj = iso20022 ? (typeof iso20022 === "string" ? JSON.parse(iso20022) : iso20022) : null;
  const customObj = customFields ? (typeof customFields === "string" ? JSON.parse(customFields) : customFields) : null;

  if (db.open) {
    try {
      const ddexStr = ddexObj ? JSON.stringify(ddexObj) : null;
      const isoStr = isoObj ? JSON.stringify(isoObj) : null;
      const customStr = customObj ? JSON.stringify(customObj) : null;

      const existing = db.prepare(`SELECT id FROM rights_metadata WHERE rightId = ?`).get(rightId);
      if (existing) {
        db.prepare(`
          UPDATE rights_metadata
          SET ddex = ?, iso20022 = ?, customFields = ?, updatedAt = ?
          WHERE rightId = ?
        `).run(ddexStr, isoStr, customStr, now, rightId);
      } else {
        db.prepare(`
          INSERT INTO rights_metadata (rightId, contractId, ddex, iso20022, customFields, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(rightId, contractId, ddexStr, isoStr, customStr, now, now);
      }
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const record = {
    id: _nextMetaId++,
    rightId,
    contractId,
    ddex: ddexObj,
    iso20022: isoObj,
    customFields: customObj,
    createdAt: now,
    updatedAt: now,
  };

  _memoryMetadata.set(rightId, record);
  return record;
}

export function getRightMetadataRecord(rightId) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM rights_metadata WHERE rightId = ?`).get(rightId);
      if (row) {
        return {
          ...row,
          ddex: row.ddex ? JSON.parse(row.ddex) : null,
          iso20022: row.iso20022 ? JSON.parse(row.iso20022) : null,
          customFields: row.customFields ? JSON.parse(row.customFields) : null,
        };
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return _memoryMetadata.get(rightId) || null;
}

/**
 * Proof Verification Documents CRUD
 */
export function createVerificationProofRecord({
  rightId,
  contractId,
  ownerAddress,
  documentName,
  documentType,
  documentUrl,
  documentHash = null,
}) {
  const now = new Date().toISOString();
  let insertId;

  if (db.open) {
    try {
      const stmt = db.prepare(`
        INSERT INTO rights_verifications (
          rightId, contractId, ownerAddress, documentName, documentType, documentUrl, documentHash, status, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `);
      const result = stmt.run(rightId, contractId, ownerAddress, documentName, documentType, documentUrl, documentHash, now);
      countWrite();
      insertId = result?.lastInsertRowid;
      db.prepare(`UPDATE rights SET status = 'pending', updatedAt = ? WHERE id = ? AND status = 'unverified'`).run(now, rightId);
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  if (!insertId) {
    insertId = _nextProofId++;
  }

  const record = {
    id: insertId,
    rightId,
    contractId,
    ownerAddress,
    documentName,
    documentType,
    documentUrl,
    documentHash,
    status: "pending",
    verifierAddress: null,
    verifierNotes: null,
    verifiedAt: null,
    createdAt: now,
  };

  _memoryVerifications.set(insertId, record);

  // Update memory right status if unverified
  const r = _memoryRights.get(rightId);
  if (r && r.status === "unverified") {
    r.status = "pending";
    r.updatedAt = now;
  }

  return record;
}

export function getVerificationProofById(id) {
  if (db.open) {
    try {
      const row = db.prepare(`SELECT * FROM rights_verifications WHERE id = ?`).get(id);
      if (row) return row;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return _memoryVerifications.get(id) || null;
}

export function getVerificationProofsRecord(rightId) {
  if (db.open) {
    try {
      const rows = db.prepare(`SELECT * FROM rights_verifications WHERE rightId = ? ORDER BY createdAt DESC`).all(rightId);
      if (rows && rows.length > 0) return rows;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const results = [];
  for (const v of _memoryVerifications.values()) {
    if (v.rightId === rightId) {
      results.push(v);
    }
  }
  return results;
}

export function updateVerificationProofStatusRecord(proofId, { status, verifierAddress = null, verifierNotes = null }) {
  const existing = getVerificationProofById(proofId);
  const now = new Date().toISOString();

  if (db.open) {
    try {
      db.prepare(`
        UPDATE rights_verifications
        SET status = ?, verifierAddress = ?, verifierNotes = ?, verifiedAt = ?
        WHERE id = ?
      `).run(status, verifierAddress, verifierNotes, now, proofId);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const updated = {
    ...(existing || { id: proofId }),
    status,
    verifierAddress,
    verifierNotes,
    verifiedAt: now,
  };

  _memoryVerifications.set(proofId, updated);
  return updated;
}

/**
 * Historical Tracking Log
 */
export function addRightHistoryRecord({
  rightId,
  contractId,
  action,
  changedBy,
  oldValues = null,
  newValues = null,
  reason = null,
}) {
  const now = new Date().toISOString();
  const oldStr = oldValues ? (typeof oldValues === "string" ? oldValues : JSON.stringify(oldValues)) : null;
  const newStr = newValues ? (typeof newValues === "string" ? newValues : JSON.stringify(newValues)) : null;

  if (db.open) {
    try {
      const stmt = db.prepare(`
        INSERT INTO rights_history (rightId, contractId, action, changedBy, oldValues, newValues, reason, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(rightId, contractId, action, changedBy, oldStr, newStr, reason, now);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  _memoryHistory.push({
    id: _nextHistoryId++,
    rightId,
    contractId,
    action,
    changedBy,
    oldValues: oldValues ? (typeof oldValues === "string" ? JSON.parse(oldValues) : oldValues) : null,
    newValues: newValues ? (typeof newValues === "string" ? JSON.parse(newValues) : newValues) : null,
    reason,
    timestamp: now,
  });
}

export function getRightHistoryRecord(contractId, rightId = null) {
  if (db.open) {
    try {
      let rows;
      if (rightId) {
        rows = db.prepare(`SELECT * FROM rights_history WHERE rightId = ? ORDER BY timestamp DESC, id DESC`).all(rightId);
      } else {
        rows = db.prepare(`SELECT * FROM rights_history WHERE contractId = ? ORDER BY timestamp DESC, id DESC`).all(contractId);
      }
      if (rows && rows.length > 0) {
        return rows.map((r) => ({
          ...r,
          oldValues: r.oldValues ? JSON.parse(r.oldValues) : null,
          newValues: r.newValues ? JSON.parse(r.newValues) : null,
        }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return _memoryHistory
    .filter((h) => (rightId ? h.rightId === rightId : h.contractId === contractId))
    .slice()
    .sort((a, b) => b.id - a.id || b.timestamp.localeCompare(a.timestamp));
}

/**
 * Dispute Reference Linkage
 */
export function linkRightToDisputeRecord(rightId, ticketId, notes = null) {
  const now = new Date().toISOString();

  if (db.open) {
    try {
      const stmt = db.prepare(`
        INSERT INTO rights_disputes (rightId, ticketId, notes, createdAt)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(rightId, ticketId, notes, now);
      countWrite();
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const record = { id: _nextDisputeLinkId++, rightId, ticketId, notes, createdAt: now };
  _memoryDisputes.push(record);
  return record;
}

export function getRightsForDisputeRecord(ticketId) {
  if (db.open) {
    try {
      const rows = db.prepare(`
        SELECT r.*, rd.ticketId, rd.notes as disputeNotes, rd.createdAt as linkedAt
        FROM rights_disputes rd
        JOIN rights r ON r.id = rd.rightId
        WHERE rd.ticketId = ?
      `).all(ticketId);
      if (rows && rows.length > 0) {
        return rows.map((r) => ({
          ...r,
          isVerified: Boolean(r.isVerified),
        }));
      }
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  const linkedRightIds = _memoryDisputes.filter((d) => d.ticketId === ticketId).map((d) => d.rightId);
  return linkedRightIds.map((id) => _memoryRights.get(id)).filter(Boolean);
}

export function getDisputesForRightRecord(rightId) {
  if (db.open) {
    try {
      const rows = db.prepare(`SELECT * FROM rights_disputes WHERE rightId = ? ORDER BY createdAt DESC`).all(rightId);
      if (rows && rows.length > 0) return rows;
    } catch (_e) {
      // Mocked DB fallback
    }
  }

  return _memoryDisputes.filter((d) => d.rightId === rightId);
}
