/**
 * Compliance report storage — closes #601.
 *
 * Tracks report generation metadata and archives generated report content.
 * Report types: monthly, quarterly, annual
 * Delivery: email (configurable recipients) + stored in compliance_reports table
 */

import { db, countWrite } from "./core.js";

export const REPORT_TYPES = /** @type {const} */ (["monthly", "quarterly", "annual"]);
export const REPORT_STATUSES = /** @type {const} */ (["pending", "generating", "completed", "failed"]);

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function parseReportRow(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
    emailedTo: row.emailedTo ? JSON.parse(row.emailedTo) : [],
  };
}

/**
 * Create a new compliance report record.
 *
 * @param {object} params
 * @param {string} params.type        - "monthly" | "quarterly" | "annual"
 * @param {string} params.periodStart - ISO date of period start
 * @param {string} params.periodEnd   - ISO date of period end
 * @param {string} params.contractId  - Applicable contract (or "ALL" for global)
 * @param {string} params.generatedBy - "scheduler" | walletAddress
 * @returns {object}
 */
export function createComplianceReport({ type, periodStart, periodEnd, contractId = "ALL", generatedBy = "scheduler" }) {
  const result = db.prepare(`
    INSERT INTO compliance_reports
      (type, periodStart, periodEnd, contractId, generatedBy, status, createdAt)
    VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)
  `).run(type, periodStart, periodEnd, contractId, generatedBy);

  countWrite();
  return getComplianceReport(result.lastInsertRowid);
}

/**
 * Get a single report by id.
 *
 * @param {number} id
 * @returns {object|null}
 */
export function getComplianceReport(id) {
  return parseReportRow(
    db.prepare(`
      SELECT id, type, periodStart, periodEnd, contractId, generatedBy,
             status, filePath, emailedTo, metadata, errorMessage, createdAt, completedAt
      FROM compliance_reports WHERE id = ?
    `).get(id)
  );
}

/**
 * List reports, optionally filtered.
 *
 * @param {object} filters
 * @param {number} limit
 * @param {number} offset
 * @returns {object[]}
 */
export function listComplianceReports({ type = null, contractId = null, status = null } = {}, limit = 50, offset = 0) {
  let sql = `
    SELECT id, type, periodStart, periodEnd, contractId, generatedBy,
           status, filePath, emailedTo, metadata, errorMessage, createdAt, completedAt
    FROM compliance_reports WHERE 1=1
  `;
  const params = [];
  if (type)       { sql += " AND type = ?";       params.push(type); }
  if (contractId) { sql += " AND contractId = ?"; params.push(contractId); }
  if (status)     { sql += " AND status = ?";     params.push(status); }
  sql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  return db.prepare(sql).all(...params).map(parseReportRow);
}

/**
 * Count reports matching filters.
 */
export function countComplianceReports({ type = null, contractId = null, status = null } = {}) {
  let sql = "SELECT COUNT(*) as total FROM compliance_reports WHERE 1=1";
  const params = [];
  if (type)       { sql += " AND type = ?";       params.push(type); }
  if (contractId) { sql += " AND contractId = ?"; params.push(contractId); }
  if (status)     { sql += " AND status = ?";     params.push(status); }
  return db.prepare(sql).get(...params)?.total ?? 0;
}

/**
 * Mark a report as generating.
 */
export function markReportGenerating(id) {
  db.prepare("UPDATE compliance_reports SET status = 'generating' WHERE id = ?").run(id);
  countWrite();
}

/**
 * Mark a report as completed.
 *
 * @param {number} id
 * @param {object} result
 * @param {string} result.filePath     - Path to stored report file
 * @param {string[]} result.emailedTo  - Recipients list
 * @param {object} result.metadata     - Summary stats embedded in report
 */
export function markReportCompleted(id, { filePath, emailedTo = [], metadata = null }) {
  db.prepare(`
    UPDATE compliance_reports
    SET status = 'completed',
        filePath = ?,
        emailedTo = ?,
        metadata = ?,
        completedAt = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(filePath ?? null, JSON.stringify(emailedTo), metadata ? JSON.stringify(metadata) : null, id);
  countWrite();
}

/**
 * Mark a report as failed.
 */
export function markReportFailed(id, errorMessage) {
  db.prepare(`
    UPDATE compliance_reports
    SET status = 'failed', errorMessage = ? WHERE id = ?
  `).run(errorMessage, id);
  countWrite();
}

// ─── Scheduler helpers ────────────────────────────────────────────────────────

/**
 * Check whether a report of `type` already exists for the given period.
 *
 * @param {string} type
 * @param {string} periodStart - ISO date
 * @param {string} periodEnd   - ISO date
 * @param {string} contractId
 * @returns {boolean}
 */
export function reportExistsForPeriod(type, periodStart, periodEnd, contractId = "ALL") {
  const row = db.prepare(`
    SELECT id FROM compliance_reports
    WHERE type = ? AND periodStart = ? AND periodEnd = ? AND contractId = ?
      AND status IN ('completed', 'generating')
    LIMIT 1
  `).get(type, periodStart, periodEnd, contractId);
  return !!row;
}
