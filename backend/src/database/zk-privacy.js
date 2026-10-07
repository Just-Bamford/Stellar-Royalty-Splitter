/**
 * Zero-knowledge proof database functions — closes #972.
 *
 * Stores and manages privacy-preserving distribution proofs and credentials.
 */

import { db, countWrite } from "./core.js";
import logger from "../logger.js";

/**
 * Initialize ZK privacy tables.
 */
export function initializeZKPrivacyTables() {
  db.exec(`
    -- Private distribution proofs
    CREATE TABLE IF NOT EXISTS zk_distribution_proofs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractId TEXT NOT NULL,
      transactionId INTEGER,
      proofType TEXT NOT NULL DEFAULT 'private_distribution' CHECK(proofType IN ('private_distribution', 'range_proof', 'membership_proof')),
      totalCommitment TEXT NOT NULL,
      collaboratorCount INTEGER NOT NULL,
      proofData TEXT NOT NULL,
      verified INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(transactionId) REFERENCES transactions(id) ON DELETE SET NULL
    );

    -- Anonymous credentials for collaborators
    CREATE TABLE IF NOT EXISTS zk_anonymous_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credentialId TEXT NOT NULL UNIQUE,
      walletAddress TEXT NOT NULL,
      commitment TEXT NOT NULL,
      attributes TEXT NOT NULL DEFAULT '{}',
      signature TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      issuedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      expiresAt DATETIME,
      lastUsed DATETIME
    );

    -- Nullifier registry (prevents double-spending of proofs)
    CREATE TABLE IF NOT EXISTS zk_nullifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nullifier TEXT NOT NULL UNIQUE,
      proofId INTEGER NOT NULL,
      usedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(proofId) REFERENCES zk_distribution_proofs(id) ON DELETE CASCADE
    );

    -- Privacy audit log (records proof verification events)
    CREATE TABLE IF NOT EXISTS zk_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proofId INTEGER,
      credentialId TEXT,
      action TEXT NOT NULL CHECK(action IN ('proof_generated', 'proof_verified', 'credential_issued', 'credential_used', 'credential_revoked')),
      result TEXT,
      metadata TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_zk_proofs_contract ON zk_distribution_proofs(contractId);
    CREATE INDEX IF NOT EXISTS idx_zk_proofs_transaction ON zk_distribution_proofs(transactionId);
    CREATE INDEX IF NOT EXISTS idx_zk_proofs_type ON zk_distribution_proofs(proofType);
    CREATE INDEX IF NOT EXISTS idx_zk_credentials_wallet ON zk_anonymous_credentials(walletAddress);
    CREATE INDEX IF NOT EXISTS idx_zk_credentials_id ON zk_anonymous_credentials(credentialId);
    CREATE INDEX IF NOT EXISTS idx_zk_nullifiers_nullifier ON zk_nullifiers(nullifier);
    CREATE INDEX IF NOT EXISTS idx_zk_audit_proof ON zk_audit_log(proofId);
    CREATE INDEX IF NOT EXISTS idx_zk_audit_credential ON zk_audit_log(credentialId);
  `);
}

/**
 * Store a ZK distribution proof.
 */
export function storeDistributionProof(contractId, transactionId, proofType, totalCommitment, collaboratorCount, proofData) {
  const result = db.prepare(`
    INSERT INTO zk_distribution_proofs 
    (contractId, transactionId, proofType, totalCommitment, collaboratorCount, proofData)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contractId,
    transactionId,
    proofType,
    totalCommitment,
    collaboratorCount,
    JSON.stringify(proofData)
  );

  countWrite();

  // Log audit event
  logZKAudit(result.lastInsertRowid, null, 'proof_generated', 'success', {
    contractId,
    proofType,
    collaboratorCount,
  });

  return {
    id: result.lastInsertRowid,
    contractId,
    transactionId,
    proofType,
    totalCommitment,
    collaboratorCount,
  };
}

/**
 * Get a distribution proof by ID.
 */
export function getDistributionProof(proofId) {
  const proof = db.prepare(`
    SELECT * FROM zk_distribution_proofs WHERE id = ?
  `).get(proofId);

  if (!proof) return null;

  return {
    ...proof,
    proofData: JSON.parse(proof.proofData),
  };
}

/**
 * Get distribution proofs for a contract.
 */
export function getDistributionProofs(contractId, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT id, contractId, transactionId, proofType, totalCommitment, 
           collaboratorCount, verified, createdAt
    FROM zk_distribution_proofs
    WHERE contractId = ?
    ORDER BY createdAt DESC
    LIMIT ? OFFSET ?
  `).all(contractId, limit, offset);
}

/**
 * Mark a proof as verified.
 */
export function markProofVerified(proofId, verificationResult) {
  db.prepare(`
    UPDATE zk_distribution_proofs
    SET verified = ?
    WHERE id = ?
  `).run(verificationResult ? 1 : 0, proofId);

  countWrite();

  // Log audit event
  logZKAudit(proofId, null, 'proof_verified', verificationResult ? 'success' : 'failed', {
    proofId,
    verified: verificationResult,
  });
}

/**
 * Store a nullifier to prevent reuse.
 */
export function storeNullifier(nullifier, proofId) {
  try {
    db.prepare(`
      INSERT INTO zk_nullifiers (nullifier, proofId)
      VALUES (?, ?)
    `).run(nullifier, proofId);

    countWrite();
    return true;
  } catch (error) {
    // Unique constraint violation means nullifier already used
    if (error.message.includes('UNIQUE')) {
      logger.warn("Nullifier already used", { nullifier, proofId });
      return false;
    }
    throw error;
  }
}

/**
 * Check if a nullifier has been used.
 */
export function isNullifierUsed(nullifier) {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM zk_nullifiers WHERE nullifier = ?
  `).get(nullifier);

  return result.count > 0;
}

/**
 * Issue an anonymous credential.
 */
export function issueAnonymousCredential(credentialId, walletAddress, commitment, attributes, signature, expiresAt = null) {
  const result = db.prepare(`
    INSERT INTO zk_anonymous_credentials 
    (credentialId, walletAddress, commitment, attributes, signature, expiresAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    credentialId,
    walletAddress,
    commitment,
    JSON.stringify(attributes),
    signature,
    expiresAt
  );

  countWrite();

  // Log audit event
  logZKAudit(null, credentialId, 'credential_issued', 'success', {
    walletAddress,
    attributes,
  });

  return {
    id: result.lastInsertRowid,
    credentialId,
    walletAddress,
    commitment,
    attributes,
    signature,
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Get an anonymous credential by ID.
 */
export function getAnonymousCredential(credentialId) {
  const credential = db.prepare(`
    SELECT * FROM zk_anonymous_credentials WHERE credentialId = ?
  `).get(credentialId);

  if (!credential) return null;

  return {
    ...credential,
    attributes: JSON.parse(credential.attributes),
  };
}

/**
 * Get credentials for a wallet address.
 */
export function getCredentialsByWallet(walletAddress, includeRevoked = false) {
  const query = includeRevoked
    ? `SELECT * FROM zk_anonymous_credentials WHERE walletAddress = ? ORDER BY issuedAt DESC`
    : `SELECT * FROM zk_anonymous_credentials WHERE walletAddress = ? AND revoked = 0 ORDER BY issuedAt DESC`;

  return db.prepare(query).all(walletAddress).map(c => ({
    ...c,
    attributes: JSON.parse(c.attributes),
  }));
}

/**
 * Mark credential as used (update lastUsed timestamp).
 */
export function markCredentialUsed(credentialId) {
  db.prepare(`
    UPDATE zk_anonymous_credentials
    SET lastUsed = CURRENT_TIMESTAMP
    WHERE credentialId = ?
  `).run(credentialId);

  countWrite();

  // Log audit event
  logZKAudit(null, credentialId, 'credential_used', 'success', { credentialId });
}

/**
 * Revoke an anonymous credential.
 */
export function revokeCredential(credentialId, reason = null) {
  db.prepare(`
    UPDATE zk_anonymous_credentials
    SET revoked = 1
    WHERE credentialId = ?
  `).run(credentialId);

  countWrite();

  // Log audit event
  logZKAudit(null, credentialId, 'credential_revoked', 'success', { credentialId, reason });
}

/**
 * Log a ZK privacy audit event.
 */
function logZKAudit(proofId, credentialId, action, result, metadata = {}) {
  db.prepare(`
    INSERT INTO zk_audit_log (proofId, credentialId, action, result, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    proofId,
    credentialId,
    action,
    result,
    JSON.stringify(metadata)
  );

  countWrite();
}

/**
 * Get ZK privacy audit log.
 */
export function getZKAuditLog(filters = {}, limit = 100, offset = 0) {
  const { proofId, credentialId, action, startDate, endDate } = filters;

  let query = `SELECT * FROM zk_audit_log WHERE 1=1`;
  const params = [];

  if (proofId) {
    query += ` AND proofId = ?`;
    params.push(proofId);
  }

  if (credentialId) {
    query += ` AND credentialId = ?`;
    params.push(credentialId);
  }

  if (action) {
    query += ` AND action = ?`;
    params.push(action);
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

  return db.prepare(query).all(...params).map(log => ({
    ...log,
    metadata: JSON.parse(log.metadata || '{}'),
  }));
}

/**
 * Get ZK privacy statistics.
 */
export function getZKPrivacyStatistics() {
  const totalProofs = db.prepare(`
    SELECT COUNT(*) as total FROM zk_distribution_proofs
  `).get().total;

  const verifiedProofs = db.prepare(`
    SELECT COUNT(*) as total FROM zk_distribution_proofs WHERE verified = 1
  `).get().total;

  const totalCredentials = db.prepare(`
    SELECT COUNT(*) as total FROM zk_anonymous_credentials WHERE revoked = 0
  `).get().total;

  const revokedCredentials = db.prepare(`
    SELECT COUNT(*) as total FROM zk_anonymous_credentials WHERE revoked = 1
  `).get().total;

  const nullifiersUsed = db.prepare(`
    SELECT COUNT(*) as total FROM zk_nullifiers
  `).get().total;

  const proofsByType = db.prepare(`
    SELECT proofType, COUNT(*) as count
    FROM zk_distribution_proofs
    GROUP BY proofType
  `).all();

  return {
    totalProofs,
    verifiedProofs,
    verificationRate: totalProofs > 0 ? (verifiedProofs / totalProofs * 100).toFixed(2) : 0,
    totalCredentials,
    revokedCredentials,
    nullifiersUsed,
    proofsByType: proofsByType.reduce((acc, { proofType, count }) => {
      acc[proofType] = count;
      return acc;
    }, {}),
  };
}
