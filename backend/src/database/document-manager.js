/**
 * Document Manager Database Layer
 * Issue #1060 - Advanced document management system with IPFS
 *
 * Implements database persistence for documents, version history,
 * collaborator access control permissions, digital signatures, and
 * tamper-evident audit trails.
 */

import crypto from "crypto";
import { db, countWrite } from "./core.js";
import logger from "../logger.js";

// In-memory fallback store for testing environments or mock SQLite
const inMemoryStore = {
  documents: new Map(),
  versions: new Map(), // key: `${docId}_${version}`
  permissions: new Map(), // key: `${docId}_${collaboratorAddress}`
  signatures: new Map(), // key: `${docId}_${version}_${signerAddress}`
  auditTrail: [], // array of audit objects
};

/**
 * Initialize document management tables in SQLite
 */
export function initializeDocumentTables() {
  if (!db || !db.open) return;

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        owner_address TEXT NOT NULL,
        contract_id TEXT,
        description TEXT,
        current_version INTEGER NOT NULL DEFAULT 1,
        current_cid TEXT NOT NULL,
        signature_status TEXT NOT NULL DEFAULT 'unsigned',
        tags TEXT DEFAULT '[]',
        is_archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        cid TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_by TEXT NOT NULL,
        change_summary TEXT,
        parent_version_id INTEGER,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        UNIQUE(document_id, version_number)
      );

      CREATE TABLE IF NOT EXISTS document_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        collaborator_address TEXT NOT NULL,
        permission_level TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        expires_at INTEGER,
        UNIQUE(document_id, collaborator_address)
      );

      CREATE TABLE IF NOT EXISTS document_signatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        signer_address TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        signature TEXT,
        signed_at INTEGER,
        rejection_reason TEXT,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        UNIQUE(document_id, version_number, signer_address)
      );

      CREATE TABLE IF NOT EXISTS document_audit_trail (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        version_number INTEGER,
        action TEXT NOT NULL,
        performed_by TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        previous_hash TEXT,
        integrity_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_address);
      CREATE INDEX IF NOT EXISTS idx_documents_contract ON documents(contract_id);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
      CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON document_versions(document_id);
      CREATE INDEX IF NOT EXISTS idx_document_permissions_doc ON document_permissions(document_id);
      CREATE INDEX IF NOT EXISTS idx_document_permissions_collab ON document_permissions(collaborator_address);
      CREATE INDEX IF NOT EXISTS idx_document_signatures_doc ON document_signatures(document_id, version_number);
      CREATE INDEX IF NOT EXISTS idx_document_audit_doc ON document_audit_trail(document_id);
    `);
  } catch (err) {
    logger.warn("Document tables initialization notice", { message: err.message });
  }
}

// Auto-run schema initialization
initializeDocumentTables();

/**
 * Generate unique Document ID
 */
export function generateDocumentId() {
  return `doc_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Calculate audit integrity hash (SHA-256 hash chain)
 */
function calculateAuditHash(docId, version, action, performedBy, details, timestamp, previousHash) {
  const payload = `${docId}|${version ?? ""}|${action}|${performedBy}|${typeof details === "string" ? details : JSON.stringify(details)}|${timestamp}|${previousHash || "GENESIS"}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Record a document audit event with hash chaining
 */
export function recordDocumentAudit({
  documentId,
  versionNumber = null,
  action,
  performedBy,
  details = {},
  timestamp = Date.now(),
}) {
  const previousAudit = inMemoryStore.auditTrail
    .filter((a) => a.document_id === documentId)
    .pop();
  const previousHash = previousAudit ? previousAudit.integrity_hash : "GENESIS";
  const integrityHash = calculateAuditHash(
    documentId,
    versionNumber,
    action,
    performedBy,
    details,
    timestamp,
    previousHash,
  );

  const auditRecord = {
    id: inMemoryStore.auditTrail.length + 1,
    document_id: documentId,
    version_number: versionNumber,
    action,
    performed_by: performedBy,
    details: typeof details === "object" ? details : {},
    previous_hash: previousHash,
    integrity_hash: integrityHash,
    timestamp,
  };

  inMemoryStore.auditTrail.push(auditRecord);

  if (db && db.open) {
    try {
      db.prepare(`
        INSERT INTO document_audit_trail (
          document_id, version_number, action, performed_by, details, previous_hash, integrity_hash, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentId,
        versionNumber,
        action,
        performedBy,
        JSON.stringify(details),
        previousHash,
        integrityHash,
        timestamp,
      );
      countWrite();
    } catch (_err) {
      // Handled in memory fallback
    }
  }

  return auditRecord;
}

/**
 * Create a new Document record
 */
export function insertDocument({
  id = generateDocumentId(),
  title,
  docType = "contract",
  ownerAddress,
  contractId = null,
  description = "",
  currentVersion = 1,
  currentCid,
  signatureStatus = "unsigned",
  tags = [],
  createdAt = Date.now(),
}) {
  const doc = {
    id,
    title,
    doc_type: docType,
    owner_address: ownerAddress,
    contract_id: contractId,
    description,
    current_version: currentVersion,
    current_cid: currentCid,
    signature_status: signatureStatus,
    tags: Array.isArray(tags) ? tags : [],
    is_archived: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };

  inMemoryStore.documents.set(id, doc);

  if (db && db.open) {
    try {
      db.prepare(`
        INSERT INTO documents (
          id, title, doc_type, owner_address, contract_id, description,
          current_version, current_cid, signature_status, tags, is_archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        title,
        docType,
        ownerAddress,
        contractId,
        description,
        currentVersion,
        currentCid,
        signatureStatus,
        JSON.stringify(doc.tags),
        createdAt,
        createdAt,
      );
      countWrite();
    } catch (_err) {
      // In-memory fallback
    }
  }

  return doc;
}

/**
 * Insert a document version record
 */
export function insertDocumentVersion({
  documentId,
  versionNumber,
  cid,
  fileName,
  fileSize,
  mimeType,
  checksum,
  createdBy,
  changeSummary = "",
  parentVersionId = null,
  metadata = {},
  createdAt = Date.now(),
}) {
  const version = {
    id: inMemoryStore.versions.size + 1,
    document_id: documentId,
    version_number: versionNumber,
    cid,
    file_name: fileName,
    file_size: fileSize,
    mime_type: mimeType,
    checksum,
    created_by: createdBy,
    change_summary: changeSummary,
    parent_version_id: parentVersionId,
    metadata: typeof metadata === "object" ? metadata : {},
    created_at: createdAt,
  };

  inMemoryStore.versions.set(`${documentId}_${versionNumber}`, version);

  if (db && db.open) {
    try {
      db.prepare(`
        INSERT INTO document_versions (
          document_id, version_number, cid, file_name, file_size, mime_type,
          checksum, created_by, change_summary, parent_version_id, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentId,
        versionNumber,
        cid,
        fileName,
        fileSize,
        mimeType,
        checksum,
        createdBy,
        changeSummary,
        parentVersionId,
        JSON.stringify(metadata),
        createdAt,
      );
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  return version;
}

/**
 * Get Document by ID
 */
export function getDocumentById(id) {
  if (!id) return null;

  if (inMemoryStore.documents.has(id)) {
    return inMemoryStore.documents.get(id);
  }

  if (db && db.open) {
    try {
      const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
      if (row) {
        row.tags = typeof row.tags === "string" ? JSON.parse(row.tags || "[]") : row.tags;
        return row;
      }
    } catch (_err) {
      // Fallback
    }
  }

  return null;
}

/**
 * Update Document metadata / status / version
 */
export function updateDocument(id, updates = {}) {
  const doc = getDocumentById(id);
  if (!doc) return null;

  const updated = {
    ...doc,
    ...updates,
    updated_at: Date.now(),
  };

  inMemoryStore.documents.set(id, updated);

  if (db && db.open) {
    try {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(updates)) {
        fields.push(`${key} = ?`);
        values.push(key === "tags" && Array.isArray(val) ? JSON.stringify(val) : val);
      }
      fields.push("updated_at = ?");
      values.push(updated.updated_at);
      values.push(id);

      db.prepare(`UPDATE documents SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  return updated;
}

/**
 * List & search documents
 */
export function listDocuments(filters = {}) {
  const {
    query = "",
    docType,
    signatureStatus,
    collaborator,
    owner,
    contractId,
    startDate,
    endDate,
    includeArchived = false,
    limit = 50,
    offset = 0,
  } = filters;

  let allDocs = Array.from(inMemoryStore.documents.values());

  if (!includeArchived) {
    allDocs = allDocs.filter((d) => !d.is_archived);
  }

  if (docType && docType !== "all") {
    allDocs = allDocs.filter((d) => d.doc_type === docType);
  }

  if (signatureStatus && signatureStatus !== "all") {
    allDocs = allDocs.filter((d) => d.signature_status === signatureStatus);
  }

  if (owner) {
    allDocs = allDocs.filter((d) => d.owner_address === owner);
  }

  if (contractId) {
    allDocs = allDocs.filter((d) => d.contract_id === contractId);
  }

  if (startDate) {
    const startMs = new Date(startDate).getTime();
    if (!Number.isNaN(startMs)) {
      allDocs = allDocs.filter((d) => d.created_at >= startMs);
    }
  }

  if (endDate) {
    const endMs = new Date(endDate).getTime();
    if (!Number.isNaN(endMs)) {
      allDocs = allDocs.filter((d) => d.created_at <= endMs);
    }
  }

  if (collaborator) {
    allDocs = allDocs.filter((d) => {
      if (d.owner_address === collaborator) return true;
      const permKey = `${d.id}_${collaborator}`;
      if (inMemoryStore.permissions.has(permKey)) return true;
      const sigKey = Array.from(inMemoryStore.signatures.keys()).find(
        (k) => k.startsWith(`${d.id}_`) && k.endsWith(`_${collaborator}`),
      );
      return !!sigKey;
    });
  }

  if (query && query.trim()) {
    const q = query.toLowerCase().trim();
    allDocs = allDocs.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.description && d.description.toLowerCase().includes(q)) ||
        d.id.toLowerCase().includes(q) ||
        d.current_cid.toLowerCase().includes(q) ||
        (d.tags && d.tags.some((t) => String(t).toLowerCase().includes(q))),
    );
  }

  // Sort by updated_at descending
  allDocs.sort((a, b) => b.updated_at - a.updated_at);

  const total = allDocs.length;
  const paginated = allDocs.slice(offset, offset + limit);

  return {
    total,
    documents: paginated,
    limit,
    offset,
  };
}

/**
 * Get all versions for a document
 */
export function getDocumentVersions(documentId) {
  const versions = [];
  for (const [key, val] of inMemoryStore.versions.entries()) {
    if (key.startsWith(`${documentId}_`)) {
      versions.push(val);
    }
  }
  return versions.sort((a, b) => b.version_number - a.version_number);
}

/**
 * Get specific version of a document
 */
export function getDocumentVersion(documentId, versionNumber) {
  const key = `${documentId}_${versionNumber}`;
  return inMemoryStore.versions.get(key) || null;
}

/**
 * Set collaborator permission
 */
export function setCollaboratorPermission({
  documentId,
  collaboratorAddress,
  permissionLevel = "view",
  grantedBy,
  grantedAt = Date.now(),
  expiresAt = null,
}) {
  const permission = {
    id: inMemoryStore.permissions.size + 1,
    document_id: documentId,
    collaborator_address: collaboratorAddress,
    permission_level: permissionLevel,
    granted_by: grantedBy,
    granted_at: grantedAt,
    expires_at: expiresAt,
  };

  const key = `${documentId}_${collaboratorAddress}`;
  inMemoryStore.permissions.set(key, permission);

  if (db && db.open) {
    try {
      db.prepare(`
        INSERT INTO document_permissions (
          document_id, collaborator_address, permission_level, granted_by, granted_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id, collaborator_address) DO UPDATE SET
          permission_level = excluded.permission_level,
          granted_by = excluded.granted_by,
          granted_at = excluded.granted_at,
          expires_at = excluded.expires_at
      `).run(documentId, collaboratorAddress, permissionLevel, grantedBy, grantedAt, expiresAt);
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  return permission;
}

/**
 * Revoke collaborator permission
 */
export function revokeCollaboratorPermission(documentId, collaboratorAddress) {
  const key = `${documentId}_${collaboratorAddress}`;
  const deleted = inMemoryStore.permissions.delete(key);

  if (db && db.open) {
    try {
      db.prepare(`
        DELETE FROM document_permissions
        WHERE document_id = ? AND collaborator_address = ?
      `).run(documentId, collaboratorAddress);
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  return deleted;
}

/**
 * Get all permissions for a document
 */
export function getDocumentPermissions(documentId) {
  const perms = [];
  const now = Date.now();
  for (const [key, val] of inMemoryStore.permissions.entries()) {
    if (key.startsWith(`${documentId}_`)) {
      if (!val.expires_at || val.expires_at > now) {
        perms.push(val);
      }
    }
  }
  return perms;
}

/**
 * Get user permission level for a document
 * @returns {"owner"|"admin"|"download"|"sign"|"view"|null}
 */
export function getUserPermission(documentId, userAddress) {
  if (!userAddress) return null;
  const doc = getDocumentById(documentId);
  if (!doc) return null;

  if (doc.owner_address === userAddress) {
    return "owner";
  }

  const key = `${documentId}_${userAddress}`;
  const perm = inMemoryStore.permissions.get(key);
  if (perm) {
    if (perm.expires_at && perm.expires_at <= Date.now()) {
      return null;
    }
    return perm.permission_level;
  }

  return null;
}

/**
 * Request signatures for a document version
 */
export function requestSignatures({
  documentId,
  versionNumber,
  signers = [],
  createdAt = Date.now(),
}) {
  const createdSignatures = [];

  for (const signerAddress of signers) {
    const key = `${documentId}_${versionNumber}_${signerAddress}`;
    const sig = {
      id: inMemoryStore.signatures.size + 1,
      document_id: documentId,
      version_number: versionNumber,
      signer_address: signerAddress,
      status: "pending",
      signature: null,
      signed_at: null,
      rejection_reason: null,
      metadata: {},
      created_at: createdAt,
    };
    inMemoryStore.signatures.set(key, sig);
    createdSignatures.push(sig);

    if (db && db.open) {
      try {
        db.prepare(`
          INSERT INTO document_signatures (
            document_id, version_number, signer_address, status, created_at
          ) VALUES (?, ?, ?, 'pending', ?)
          ON CONFLICT(document_id, version_number, signer_address) DO UPDATE SET
            status = 'pending',
            signature = NULL,
            signed_at = NULL,
            rejection_reason = NULL
        `).run(documentId, versionNumber, signerAddress, createdAt);
        countWrite();
      } catch (_err) {
        // Fallback
      }
    }
  }

  return createdSignatures;
}

/**
 * Record a signature
 */
export function recordSignature({
  documentId,
  versionNumber,
  signerAddress,
  signature,
  metadata = {},
  signedAt = Date.now(),
}) {
  const key = `${documentId}_${versionNumber}_${signerAddress}`;
  const existing = inMemoryStore.signatures.get(key) || {
    id: inMemoryStore.signatures.size + 1,
    document_id: documentId,
    version_number: versionNumber,
    signer_address: signerAddress,
    created_at: signedAt,
  };

  const updated = {
    ...existing,
    status: "signed",
    signature,
    signed_at: signedAt,
    metadata,
  };

  inMemoryStore.signatures.set(key, updated);

  if (db && db.open) {
    try {
      db.prepare(`
        INSERT INTO document_signatures (
          document_id, version_number, signer_address, status, signature, signed_at, metadata, created_at
        ) VALUES (?, ?, ?, 'signed', ?, ?, ?, ?)
        ON CONFLICT(document_id, version_number, signer_address) DO UPDATE SET
          status = 'signed',
          signature = excluded.signature,
          signed_at = excluded.signed_at,
          metadata = excluded.metadata
      `).run(
        documentId,
        versionNumber,
        signerAddress,
        signature,
        signedAt,
        JSON.stringify(metadata),
        existing.created_at || signedAt,
      );
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  // Update overall document signature status
  evaluateDocumentSignatureStatus(documentId, versionNumber);

  return updated;
}

/**
 * Reject a signature request
 */
export function rejectSignature({
  documentId,
  versionNumber,
  signerAddress,
  reason = "",
}) {
  const key = `${documentId}_${versionNumber}_${signerAddress}`;
  const existing = inMemoryStore.signatures.get(key) || {
    id: inMemoryStore.signatures.size + 1,
    document_id: documentId,
    version_number: versionNumber,
    signer_address: signerAddress,
    created_at: Date.now(),
  };

  const updated = {
    ...existing,
    status: "rejected",
    rejection_reason: reason,
  };

  inMemoryStore.signatures.set(key, updated);

  if (db && db.open) {
    try {
      db.prepare(`
        UPDATE document_signatures
        SET status = 'rejected', rejection_reason = ?
        WHERE document_id = ? AND version_number = ? AND signer_address = ?
      `).run(reason, documentId, versionNumber, signerAddress);
      countWrite();
    } catch (_err) {
      // Fallback
    }
  }

  // Update document signature status
  updateDocument(documentId, { signature_status: "rejected" });

  return updated;
}

/**
 * Get signatures for a document version
 */
export function getDocumentSignatures(documentId, versionNumber = null) {
  const sigs = [];
  for (const [key, val] of inMemoryStore.signatures.entries()) {
    if (key.startsWith(`${documentId}_`)) {
      if (versionNumber === null || val.version_number === versionNumber) {
        sigs.push(val);
      }
    }
  }
  return sigs;
}

/**
 * Recalculate document signature status based on all signers
 */
function evaluateDocumentSignatureStatus(documentId, versionNumber) {
  const sigs = getDocumentSignatures(documentId, versionNumber);
  if (sigs.length === 0) return "unsigned";

  const anyRejected = sigs.some((s) => s.status === "rejected");
  if (anyRejected) {
    updateDocument(documentId, { signature_status: "rejected" });
    return "rejected";
  }

  const allSigned = sigs.every((s) => s.status === "signed");
  if (allSigned) {
    updateDocument(documentId, { signature_status: "signed" });
    return "signed";
  }

  const someSigned = sigs.some((s) => s.status === "signed");
  if (someSigned) {
    updateDocument(documentId, { signature_status: "partially_signed" });
    return "partially_signed";
  }

  updateDocument(documentId, { signature_status: "pending" });
  return "pending";
}

/**
 * Get document audit trail with chain verification
 */
export function getDocumentAuditTrail(documentId) {
  const records = inMemoryStore.auditTrail.filter((a) => a.document_id === documentId);

  // Verify chain integrity
  let verified = true;
  let previousHash = "GENESIS";

  for (const rec of records) {
    const expectedHash = calculateAuditHash(
      rec.document_id,
      rec.version_number,
      rec.action,
      rec.performed_by,
      rec.details,
      rec.timestamp,
      previousHash,
    );
    if (rec.integrity_hash !== expectedHash || rec.previous_hash !== previousHash) {
      verified = false;
      break;
    }
    previousHash = rec.integrity_hash;
  }

  return {
    documentId,
    verified,
    totalEvents: records.length,
    events: [...records].sort((a, b) => b.timestamp - a.timestamp),
  };
}

/**
 * Export document audit trail in JSON or CSV format
 */
export function exportDocumentAuditTrail(documentId, format = "json") {
  const auditData = getDocumentAuditTrail(documentId);

  if (format === "csv") {
    const headers = [
      "Timestamp",
      "Action",
      "Performed By",
      "Version",
      "Details",
      "Integrity Hash",
    ];
    const rows = auditData.events.map((e) => [
      new Date(e.timestamp).toISOString(),
      e.action,
      e.performed_by,
      e.version_number ?? "",
      JSON.stringify(e.details).replace(/"/g, '""'),
      e.integrity_hash,
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r) => r.map((cell) => `"${cell}"`).join(",")),
    ].join("\n");

    return {
      contentType: "text/csv",
      fileName: `audit-trail-${documentId}-${Date.now()}.csv`,
      data: csvContent,
      verified: auditData.verified,
    };
  }

  return {
    contentType: "application/json",
    fileName: `audit-trail-${documentId}-${Date.now()}.json`,
    data: auditData,
    verified: auditData.verified,
  };
}

/**
 * Reset memory store (useful for tests)
 */
export function resetDocumentDatabase() {
  inMemoryStore.documents.clear();
  inMemoryStore.versions.clear();
  inMemoryStore.permissions.clear();
  inMemoryStore.signatures.clear();
  inMemoryStore.auditTrail.length = 0;
}
