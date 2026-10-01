/**
 * Multi-signature proposal & signing-flow service (#1042).
 *
 * Maintains a set of operations that require M-of-N approval (the "critical
 * operations" listed in the issue: pause contract, change royalty rate >10%,
 * remove collaborator, upgrade contract, change admin list), collects signatures
 * from authorized signers, and executes a proposal once the threshold is met.
 *
 * The pure helpers (`isCriticalOperation`, `verifySignatures`,
 * `isThresholdMet`, `missingSigners`) perform the M-of-N validation without any
 * I/O and are fully unit-tested. The database-backed CRUD wraps them.
 */

import { db } from "../database/core.js";
import logger from "../logger.js";

/** Operations that must clear the multi-sig threshold before execution. */
export const CRITICAL_OPERATIONS = new Set([
  "pause_contract",
  "change_royalty_rate",
  "remove_collaborator",
  "upgrade_contract",
  "change_admin_list",
]);

/** Default M when a proposal does not specify a threshold (capped at N). */
export const DEFAULT_THRESHOLD = 3;

function initializeDatabase() {
  const sql = `
    CREATE TABLE IF NOT EXISTS multisig_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      dataJson TEXT NOT NULL,
      requiredSignersJson TEXT NOT NULL,
      threshold INTEGER NOT NULL DEFAULT ${DEFAULT_THRESHOLD},
      status TEXT NOT NULL DEFAULT 'pending',
      creator TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_multisig_proposals_status ON multisig_proposals(status, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_multisig_proposals_creator ON multisig_proposals(creator, createdAt DESC);
    CREATE TABLE IF NOT EXISTS multisig_signatures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposalId INTEGER NOT NULL,
      signer TEXT NOT NULL,
      signature TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE(proposalId, signer)
    );
    CREATE INDEX IF NOT EXISTS idx_multisig_signatures_proposal ON multisig_signatures(proposalId);
  `;

  try {
    db.exec(sql);
  } catch (err) {
    logger.error("Failed to initialise multisig tables", { error: err.message });
    throw err;
  }
}

initializeDatabase();

function now() {
  return Math.floor(Date.now() / 1000);
}

/* -------------------------------------------------------------------------- */
/* Pure M-of-N logic (no I/O, unit-tested)                                     */
/* -------------------------------------------------------------------------- */

export function isCriticalOperation(operation) {
  return CRITICAL_OPERATIONS.has(operation);
}

/**
 * Validate a batch of signatures against the authorized signer set.
 *
 * - Unknown signers are dropped (signatures they produced do not count toward
 *   the threshold).
 * - Duplicate signatures from the same signer are collapsed (an address may
 *   only count once toward M-of-N).
 *
 * @param {string[]} signers        - The N authorized signers.
 * @param {Array<{ signer: string, signature: string }>} signatures
 * @returns {{ validSignatureCount: number, signers: string[], signatures: object[] }}
 */
export function verifySignatures(signers, signatures) {
  const signerSet = new Set(Array.isArray(signers) ? signers : []);
  const seen = new Set();
  const valid = [];

  for (const sig of Array.isArray(signatures) ? signatures : []) {
    const signer = sig && sig.signer;
    if (!signer || seen.has(signer)) {
      continue;
    }
    if (signerSet.has(signer)) {
      seen.add(signer);
      valid.push(sig);
    }
  }

  return {
    validSignatureCount: valid.length,
    signers: valid.map((s) => s.signer),
    signatures: valid,
  };
}

/** Whether `signerCount` distinct valid signatures meet the M threshold. */
export function isThresholdMet(threshold, signerCount) {
  const t = Number(threshold);
  if (!Number.isFinite(t) || t < 1) {
    return false;
  }
  return signerCount >= t;
}

/** Authorized signers who have not yet signed. */
export function missingSigners(requiredSigners, signatures) {
  const signerSet = new Set(Array.isArray(requiredSigners) ? requiredSigners : []);
  const signed = new Set((Array.isArray(signatures) ? signatures : []).map((s) => s && s.signer));
  return Array.from(signerSet).filter((s) => !signed.has(s));
}

/* -------------------------------------------------------------------------- */
/* DB-backed proposal flow                                                     */
/* -------------------------------------------------------------------------- */

export function resolveThreshold(threshold, n) {
  let resolved = threshold == null ? Math.min(DEFAULT_THRESHOLD, n) : Number(threshold);
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > n) {
    throw new Error(`threshold must be between 1 and ${n}`);
  }
  return resolved;
}

export function createMultisigProposal({ operation, data, requiredSigners, threshold, creator }) {
  if (!operation) {
    throw new Error("operation is required");
  }
  if (!Array.isArray(requiredSigners) || requiredSigners.length === 0) {
    throw new Error("requiredSigners must be a non-empty array");
  }

  const signers = Array.from(new Set(requiredSigners));
  const resolvedThreshold = resolveThreshold(threshold, signers.length);

  const result = db
    .prepare(
      `INSERT INTO multisig_proposals
         (operation, dataJson, requiredSignersJson, threshold, status, creator, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      operation,
      JSON.stringify(data || {}),
      JSON.stringify(signers),
      resolvedThreshold,
      creator || null,
      now(),
      now(),
    );

  const proposal = db
    .prepare(`SELECT * FROM multisig_proposals WHERE id = ?`)
    .get(result.lastID);

  logger.info("Multisig proposal created", {
    id: result.lastID,
    operation,
    threshold: resolvedThreshold,
    creator,
  });
  return proposalEvaluation(proposal, []);
}

function proposalEvaluation(proposal, signatures) {
  if (!proposal) return null;
  const requiredSigners = JSON.parse(proposal.requiredSignersJson || "[]");
  const verification = verifySignatures(requiredSigners, signatures);
  const isFullySigned = isThresholdMet(proposal.threshold, verification.validSignatureCount);
  return {
    id: proposal.id,
    operation: proposal.operation,
    threshold: proposal.threshold,
    requiredSigners,
    status: proposal.status,
    signerCount: verification.validSignatureCount,
    signers: verification.signers,
    isFullySigned,
    missingSigners: isFullySigned ? [] : missingSigners(requiredSigners, signatures),
    creator: proposal.creator,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
  };
}

export function addSignature(proposalId, signer, signature) {
  const proposal = db.prepare(`SELECT * FROM multisig_proposals WHERE id = ?`).get(proposalId);
  if (!proposal) {
    throw new Error(`proposal not found: ${proposalId}`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${proposalId} is not pending (status: ${proposal.status})`);
  }

  const requiredSigners = JSON.parse(proposal.requiredSignersJson || "[]");
  if (!requiredSigners.includes(signer)) {
    throw new Error(`signer ${signer} is not authorized for proposal ${proposalId}`);
  }

  db.prepare(
    `INSERT OR IGNORE INTO multisig_signatures (proposalId, signer, signature, createdAt)
     VALUES (?, ?, ?, ?)`,
  ).run(proposalId, signer, signature, now());

  const signatures = db
    .prepare(`SELECT signer, signature FROM multisig_signatures WHERE proposalId = ?`)
    .all(proposalId);

  const evaluation = proposalEvaluation(proposal, signatures);
  if (evaluation.isFullySigned) {
    logger.info("Multisig threshold reached", { proposalId, operation: proposal.operation });
  }
  return evaluation;
}

export function getProposal(id) {
  const proposal = db.prepare(`SELECT * FROM multisig_proposals WHERE id = ?`).get(id);
  if (!proposal) return null;
  const signatures = db
    .prepare(`SELECT signer, signature FROM multisig_signatures WHERE proposalId = ?`)
    .all(id);
  return proposalEvaluation(proposal, signatures);
}

export function getProposals({ status = "pending", operation } = {}) {
  const params = [];
  let query = `SELECT * FROM multisig_proposals WHERE 1=1`;
  if (status && status !== "all") {
    query += ` AND status = ?`;
    params.push(status);
  }
  if (operation) {
    query += ` AND operation = ?`;
    params.push(operation);
  }
  query += ` ORDER BY createdAt DESC`;
  const rows = db.prepare(query).all(...params);
  return rows.map((row) => {
    const signatures = db
      .prepare(`SELECT signer, signature FROM multisig_signatures WHERE proposalId = ?`)
      .all(row.id);
    return proposalEvaluation(row, signatures);
  });
}

export function executeProposal(id) {
  const proposal = db.prepare(`SELECT * FROM multisig_proposals WHERE id = ?`).get(id);
  if (!proposal) {
    throw new Error(`proposal not found: ${id}`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${id} is not pending (status: ${proposal.status})`);
  }

  const requiredSigners = JSON.parse(proposal.requiredSignersJson || "[]");
  const signatures = db
    .prepare(`SELECT signer, signature FROM multisig_signatures WHERE proposalId = ?`)
    .all(id);
  const verification = verifySignatures(requiredSigners, signatures);

  if (!isThresholdMet(proposal.threshold, verification.validSignatureCount)) {
    throw new Error(
      `threshold not met: have ${verification.validSignatureCount}, need ${proposal.threshold}`,
    );
  }

  db.prepare(
    `UPDATE multisig_proposals
     SET status = 'executed', updatedAt = ?
     WHERE id = ?`,
  ).run(now(), id);

  logger.info("Multisig proposal executed", { proposalId: id, operation: proposal.operation });
  return { id, status: "executed", operation: proposal.operation };
}

export function cancelProposal(id, creator) {
  const proposal = db.prepare(`SELECT * FROM multisig_proposals WHERE id = ?`).get(id);
  if (!proposal) {
    throw new Error(`proposal not found: ${id}`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`proposal ${id} is not pending (status: ${proposal.status})`);
  }
  if (proposal.creator && proposal.creator !== creator) {
    throw new Error(`only the creator may cancel proposal ${id}`);
  }

  db.prepare(
    `UPDATE multisig_proposals SET status = 'cancelled', updatedAt = ? WHERE id = ?`,
  ).run(now(), id);

  logger.info("Multisig proposal cancelled", { proposalId: id, creator });
  return { id, status: "cancelled" };
}

export default {
  CRITICAL_OPERATIONS,
  DEFAULT_THRESHOLD,
  isCriticalOperation,
  verifySignatures,
  isThresholdMet,
  missingSigners,
  createMultisigProposal,
  addSignature,
  getProposal,
  getProposals,
  executeProposal,
  cancelProposal,
};
