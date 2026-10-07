/**
 * Disputes database helpers — closes #607, enhanced for #961.
 *
 * Provides CRUD operations for the disputes ticket system:
 *   - createDispute        — open a new ticket
 *   - getDisputeByTicketId — fetch a single dispute (+ comments) by public ticket ID
 *   - getDisputesByWallet  — list all disputes for a contributor
 *   - getAllDisputes        — admin: paginated list, optional status filter
 *   - updateDisputeStatus  — admin: change status and optionally set adminNote
 *   - addDisputeComment    — append a comment (contributor or admin)
 *   - getDisputeComments   — fetch all comments for a dispute
 *
 * Enhanced AI-powered mediation (#961):
 *   - addDisputeEvidence   — attach evidence documents
 *   - getDisputeEvidence   — retrieve all evidence for a dispute
 *   - analyzeDispute       — run AI analysis on dispute data
 *   - getDisputeAnalysis   — retrieve AI analysis results
 *   - addMediationRecommendation — store AI mediation suggestions
 */

import { db, countWrite } from "./core.js";
import { randomUUID } from "crypto";
import logger from "../logger.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable ticket ID with a "DSP-" prefix followed by 8
 * uppercase hex characters, e.g. "DSP-A3F2C019".
 * @returns {string}
 */
function generateTicketId() {
  return "DSP-" + randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
}

/**
 * Attach comments to a dispute row.
 * @param {{ id: number, [key: string]: unknown }} dispute
 * @returns {{ id: number, comments: object[], [key: string]: unknown }}
 */
function withComments(dispute) {
  if (!dispute) return null;
  return { ...dispute, comments: getDisputeComments(dispute.id) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a new dispute ticket.
 *
 * @param {object} params
 * @param {string}        params.walletAddress  Stellar G-address of the submitter
 * @param {string|null}   params.contractId     Optional contract address the dispute relates to
 * @param {"wrong_amount"|"missing_payment"|"other"} params.category
 * @param {string}        params.description    Free-text description of the issue
 * @returns {{ ticketId: string, id: number, walletAddress: string, contractId: string|null,
 *             category: string, description: string, status: string,
 *             adminNote: string|null, createdAt: string, updatedAt: string }}
 */
export function createDispute({ walletAddress, contractId = null, category, description }) {
  const ticketId = generateTicketId();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO disputes (ticketId, walletAddress, contractId, category, description, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ticketId, walletAddress, contractId, category, description, now, now);

  countWrite();

  return {
    id: result.lastInsertRowid,
    ticketId,
    walletAddress,
    contractId,
    category,
    description,
    status: "open",
    adminNote: null,
    createdAt: now,
    updatedAt: now,
    comments: [],
  };
}

/**
 * Fetch a single dispute by its public ticket ID, including all comments.
 *
 * @param {string} ticketId  e.g. "DSP-A3F2C019"
 * @returns {object|null}
 */
export function getDisputeByTicketId(ticketId) {
  const row = db
    .prepare(`SELECT * FROM disputes WHERE ticketId = ?`)
    .get(ticketId);

  return withComments(row ?? null);
}

/**
 * Fetch all disputes submitted by a specific wallet address, newest first.
 *
 * @param {string} walletAddress
 * @param {{ limit?: number, offset?: number }} [pagination]
 * @returns {object[]}
 */
export function getDisputesByWallet(walletAddress, { limit = 50, offset = 0 } = {}) {
  return db
    .prepare(
      `SELECT * FROM disputes
       WHERE walletAddress = ?
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(walletAddress, limit, offset);
}

/**
 * Count disputes for a wallet address (for pagination metadata).
 *
 * @param {string} walletAddress
 * @returns {number}
 */
export function countDisputesByWallet(walletAddress) {
  return db
    .prepare(`SELECT COUNT(*) AS total FROM disputes WHERE walletAddress = ?`)
    .get(walletAddress).total;
}

/**
 * Admin: fetch all disputes with optional status filter, newest first.
 *
 * @param {{ status?: string, limit?: number, offset?: number }} [opts]
 * @returns {object[]}
 */
export function getAllDisputes({ status, limit = 50, offset = 0 } = {}) {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM disputes
         WHERE status = ?
         ORDER BY createdAt DESC
         LIMIT ? OFFSET ?`
      )
      .all(status, limit, offset);
  }

  return db
    .prepare(
      `SELECT * FROM disputes
       ORDER BY createdAt DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

/**
 * Admin: count all disputes with optional status filter (for pagination metadata).
 *
 * @param {{ status?: string }} [opts]
 * @returns {number}
 */
export function countAllDisputes({ status } = {}) {
  if (status) {
    return db
      .prepare(`SELECT COUNT(*) AS total FROM disputes WHERE status = ?`)
      .get(status).total;
  }
  return db.prepare(`SELECT COUNT(*) AS total FROM disputes`).get().total;
}

/**
 * Admin: update the status and optional admin note of a dispute.
 *
 * @param {number}  disputeId  Internal row ID
 * @param {string}  status     One of: open | under_review | resolved | closed
 * @param {string|null} [adminNote]  Optional note to attach to the ticket
 * @returns {object|null}  Updated dispute row with comments, or null if not found
 */
export function updateDisputeStatus(disputeId, status, adminNote = undefined) {
  const now = new Date().toISOString();

  const hasNote = adminNote !== undefined;
  const stmt = hasNote
    ? db.prepare(
        `UPDATE disputes
         SET status = ?, adminNote = ?, updatedAt = ?
         WHERE id = ?`
      )
    : db.prepare(
        `UPDATE disputes
         SET status = ?, updatedAt = ?
         WHERE id = ?`
      );

  const changes = hasNote
    ? stmt.run(status, adminNote, now, disputeId).changes
    : stmt.run(status, now, disputeId).changes;

  if (changes === 0) return null;

  countWrite();

  const updated = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(disputeId);
  return withComments(updated ?? null);
}

/**
 * Append a comment to a dispute from either the contributor or admin.
 *
 * @param {number} disputeId  Internal row ID
 * @param {"contributor"|"admin"} author
 * @param {string} message
 * @returns {{ id: number, disputeId: number, author: string, message: string, createdAt: string }}
 */
export function addDisputeComment(disputeId, author, message) {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO dispute_comments (disputeId, author, message, createdAt)
       VALUES (?, ?, ?, ?)`
    )
    .run(disputeId, author, message, now);

  countWrite();

  return { id: result.lastInsertRowid, disputeId, author, message, createdAt: now };
}

/**
 * Fetch all comments for a dispute, oldest first.
 *
 * @param {number} disputeId  Internal row ID
 * @returns {{ id: number, disputeId: number, author: string, message: string, createdAt: string }[]}
 */
export function getDisputeComments(disputeId) {
  return db
    .prepare(
      `SELECT id, disputeId, author, message, createdAt
       FROM dispute_comments
       WHERE disputeId = ?
       ORDER BY createdAt ASC`
    )
    .all(disputeId);
}

// ─── AI-Powered Mediation (#961) ──────────────────────────────────────────────

/**
 * Add evidence document to a dispute.
 *
 * @param {number} disputeId  Internal row ID
 * @param {string} submittedBy  wallet address or 'admin'
 * @param {string} evidenceType  Type of evidence: document, transaction_proof, screenshot, other
 * @param {string} fileUrl  URL or path to the stored evidence file
 * @param {string} description  Description of the evidence
 * @param {object} metadata  Additional metadata (file size, mime type, etc.)
 * @returns {{ id: number, disputeId: number, submittedBy: string, evidenceType: string, 
 *             fileUrl: string, description: string, metadata: string, createdAt: string }}
 */
export function addDisputeEvidence(disputeId, submittedBy, evidenceType, fileUrl, description, metadata = {}) {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO dispute_evidence (disputeId, submittedBy, evidenceType, fileUrl, description, metadata, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(disputeId, submittedBy, evidenceType, fileUrl, description, JSON.stringify(metadata), now);

  countWrite();

  return {
    id: result.lastInsertRowid,
    disputeId,
    submittedBy,
    evidenceType,
    fileUrl,
    description,
    metadata: JSON.stringify(metadata),
    createdAt: now,
  };
}

/**
 * Retrieve all evidence for a dispute.
 *
 * @param {number} disputeId  Internal row ID
 * @returns {object[]}
 */
export function getDisputeEvidence(disputeId) {
  return db
    .prepare(
      `SELECT id, disputeId, submittedBy, evidenceType, fileUrl, description, metadata, createdAt
       FROM dispute_evidence
       WHERE disputeId = ?
       ORDER BY createdAt ASC`
    )
    .all(disputeId)
    .map(row => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    }));
}

/**
 * Store AI analysis results for a dispute.
 *
 * @param {number} disputeId  Internal row ID
 * @param {string} analysisType  Type of analysis: transaction_pattern, evidence_review, sentiment_analysis
 * @param {object} findings  AI analysis findings
 * @param {number} confidenceScore  Confidence score 0-100
 * @param {object} recommendations  AI recommendations
 * @returns {{ id: number, disputeId: number, analysisType: string, findings: string,
 *             confidenceScore: number, recommendations: string, createdAt: string }}
 */
export function storeDisputeAnalysis(disputeId, analysisType, findings, confidenceScore, recommendations) {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO dispute_ai_analysis (disputeId, analysisType, findings, confidenceScore, recommendations, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      disputeId,
      analysisType,
      JSON.stringify(findings),
      confidenceScore,
      JSON.stringify(recommendations),
      now
    );

  countWrite();

  return {
    id: result.lastInsertRowid,
    disputeId,
    analysisType,
    findings: JSON.stringify(findings),
    confidenceScore,
    recommendations: JSON.stringify(recommendations),
    createdAt: now,
  };
}

/**
 * Retrieve all AI analysis results for a dispute.
 *
 * @param {number} disputeId  Internal row ID
 * @returns {object[]}
 */
export function getDisputeAnalysis(disputeId) {
  return db
    .prepare(
      `SELECT id, disputeId, analysisType, findings, confidenceScore, recommendations, createdAt
       FROM dispute_ai_analysis
       WHERE disputeId = ?
       ORDER BY createdAt DESC`
    )
    .all(disputeId)
    .map(row => ({
      ...row,
      findings: row.findings ? JSON.parse(row.findings) : {},
      recommendations: row.recommendations ? JSON.parse(row.recommendations) : {},
    }));
}

/**
 * Add a mediation recommendation.
 *
 * @param {number} disputeId  Internal row ID
 * @param {string} recommendationType  Type: automated, human_review_suggested, escalation_required
 * @param {string} recommendation  Recommendation text
 * @param {object} reasoning  Reasoning behind the recommendation
 * @param {number} priority  Priority level 1-5
 * @returns {{ id: number, disputeId: number, recommendationType: string, recommendation: string,
 *             reasoning: string, priority: number, status: string, createdAt: string }}
 */
export function addMediationRecommendation(disputeId, recommendationType, recommendation, reasoning, priority) {
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO dispute_mediation_recommendations 
       (disputeId, recommendationType, recommendation, reasoning, priority, status, createdAt)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(disputeId, recommendationType, recommendation, JSON.stringify(reasoning), priority, now);

  countWrite();

  return {
    id: result.lastInsertRowid,
    disputeId,
    recommendationType,
    recommendation,
    reasoning: JSON.stringify(reasoning),
    priority,
    status: 'pending',
    createdAt: now,
  };
}

/**
 * Get mediation recommendations for a dispute.
 *
 * @param {number} disputeId  Internal row ID
 * @returns {object[]}
 */
export function getMediationRecommendations(disputeId) {
  return db
    .prepare(
      `SELECT id, disputeId, recommendationType, recommendation, reasoning, priority, status, 
              implementedBy, implementedAt, createdAt
       FROM dispute_mediation_recommendations
       WHERE disputeId = ?
       ORDER BY priority DESC, createdAt DESC`
    )
    .all(disputeId)
    .map(row => ({
      ...row,
      reasoning: row.reasoning ? JSON.parse(row.reasoning) : {},
    }));
}

/**
 * Update mediation recommendation status.
 *
 * @param {number} recommendationId
 * @param {string} status  Status: pending, implemented, rejected
 * @param {string} implementedBy  Who implemented it (wallet address or admin)
 * @returns {object|null}
 */
export function updateMediationRecommendationStatus(recommendationId, status, implementedBy = null) {
  const now = new Date().toISOString();

  const stmt = db.prepare(
    `UPDATE dispute_mediation_recommendations
     SET status = ?, implementedBy = ?, implementedAt = ?
     WHERE id = ?`
  );

  const changes = stmt.run(status, implementedBy, now, recommendationId).changes;

  if (changes === 0) return null;

  countWrite();

  return db
    .prepare(`SELECT * FROM dispute_mediation_recommendations WHERE id = ?`)
    .get(recommendationId);
}

/**
 * Get dispute statistics for AI analysis.
 *
 * @param {number} disputeId
 * @returns {object}
 */
export function getDisputeStatistics(disputeId) {
  const dispute = db.prepare(`SELECT * FROM disputes WHERE id = ?`).get(disputeId);
  if (!dispute) return null;

  const evidenceCount = db
    .prepare(`SELECT COUNT(*) as count FROM dispute_evidence WHERE disputeId = ?`)
    .get(disputeId).count;

  const commentCount = db
    .prepare(`SELECT COUNT(*) as count FROM dispute_comments WHERE disputeId = ?`)
    .get(disputeId).count;

  const analysisCount = db
    .prepare(`SELECT COUNT(*) as count FROM dispute_ai_analysis WHERE disputeId = ?`)
    .get(disputeId).count;

  const recommendationCount = db
    .prepare(`SELECT COUNT(*) as count FROM dispute_mediation_recommendations WHERE disputeId = ?`)
    .get(disputeId).count;

  // Get transaction history for the wallet address
  const transactionCount = db
    .prepare(
      `SELECT COUNT(*) as count FROM distribution_payouts WHERE collaboratorAddress = ?`
    )
    .get(dispute.walletAddress).count;

  return {
    disputeId,
    evidenceCount,
    commentCount,
    analysisCount,
    recommendationCount,
    transactionCount,
    status: dispute.status,
    category: dispute.category,
    createdAt: dispute.createdAt,
    updatedAt: dispute.updatedAt,
  };
}

