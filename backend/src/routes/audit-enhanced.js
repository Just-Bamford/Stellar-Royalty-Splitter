import express from "express";
import { sendError } from "../error-response.js";
import {
  addAuditEntry,
  verifyAuditChainIntegrity,
  getAuditEntries,
  getAuditStatistics,
  exportAuditLogJSON,
  exportAuditLogCSV,
  getComplianceReport,
  searchAuditLog,
} from "../database/index.js";
import { broadcastAuditEvent } from "../websocket.js";
import { attachRole, requireRole } from "../middleware/rbac.js";
import logger from "../logger.js";

const router = express.Router();

/**
 * #986: Enhanced audit logging with immutable hash-chain
 */

/**
 * POST /api/v1/audit-enhanced/entry
 * Add an audit log entry (system use)
 */
router.post("/audit-enhanced/entry", attachRole, requireRole("operator"), (req, res) => {
  try {
    const {
      contractId,
      action,
      user,
      details,
      category = "admin_action",
      severity = "info",
    } = req.body;

    if (!contractId || !action || !user) {
      return sendError(res, 400, "validation_failed", "contractId, action, and user are required");
    }

    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get("user-agent");

    const entryId = addAuditEntry({
      contractId,
      action,
      user,
      details: details || {},
      category,
      severity,
      ipAddress,
      userAgent,
    });

    // Broadcast audit event in real-time
    broadcastAuditEvent(contractId, {
      id: entryId,
      action,
      user,
      category,
      severity,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      entryId,
      message: "Audit entry added successfully",
    });
  } catch (err) {
    logger.error("Failed to add audit entry", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to add audit entry");
  }
});

/**
 * GET /api/v1/audit-enhanced/verify
 * Verify audit chain integrity (admin only)
 */
router.get("/audit-enhanced/verify", attachRole, requireRole("admin"), (req, res) => {
  try {
    const result = verifyAuditChainIntegrity();

    res.json({
      success: true,
      integrity: result,
    });
  } catch (err) {
    logger.error("Failed to verify audit chain", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to verify audit chain");
  }
});

/**
 * GET /api/v1/audit-enhanced/entries
 * Get audit entries with advanced filtering
 */
router.get("/audit-enhanced/entries", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const {
      contractId,
      action,
      user,
      category,
      severity,
      startDate,
      endDate,
      limit = 100,
      offset = 0,
    } = req.query;

    const entries = getAuditEntries({
      contractId,
      action,
      user,
      category,
      severity,
      startDate,
      endDate,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    res.json({
      success: true,
      entries: entries.map((e) => ({
        ...e,
        details: JSON.parse(e.details),
      })),
      count: entries.length,
    });
  } catch (err) {
    logger.error("Failed to get audit entries", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get audit entries");
  }
});

/**
 * GET /api/v1/audit-enhanced/statistics
 * Get audit statistics
 */
router.get("/audit-enhanced/statistics", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { contractId, days = 30 } = req.query;

    const stats = getAuditStatistics(contractId || null, parseInt(days));

    res.json({
      success: true,
      statistics: stats,
    });
  } catch (err) {
    logger.error("Failed to get audit statistics", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to get audit statistics");
  }
});

/**
 * GET /api/v1/audit-enhanced/export/json
 * Export audit log as JSON
 */
router.get("/audit-enhanced/export/json", attachRole, requireRole("admin"), (req, res) => {
  try {
    const { contractId, startDate, endDate } = req.query;

    const exportData = exportAuditLogJSON(contractId || null, startDate || null, endDate || null);

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${contractId || "all"}-${new Date().toISOString()}.json"`
    );
    res.json(exportData);
  } catch (err) {
    logger.error("Failed to export audit log as JSON", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to export audit log");
  }
});

/**
 * GET /api/v1/audit-enhanced/export/csv
 * Export audit log as CSV
 */
router.get("/audit-enhanced/export/csv", attachRole, requireRole("admin"), (req, res) => {
  try {
    const { contractId, startDate, endDate } = req.query;

    const csv = exportAuditLogCSV(contractId || null, startDate || null, endDate || null);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${contractId || "all"}-${new Date().toISOString()}.csv"`
    );
    res.send(csv);
  } catch (err) {
    logger.error("Failed to export audit log as CSV", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to export audit log");
  }
});

/**
 * GET /api/v1/audit-enhanced/compliance-report/:contractId
 * Get compliance report
 */
router.get("/audit-enhanced/compliance-report/:contractId", attachRole, requireRole("admin"), (req, res) => {
  try {
    const { contractId } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return sendError(res, 400, "validation_failed", "startDate and endDate are required");
    }

    const report = getComplianceReport(contractId, startDate, endDate);

    res.json({
      success: true,
      report,
    });
  } catch (err) {
    logger.error("Failed to generate compliance report", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to generate compliance report");
  }
});

/**
 * GET /api/v1/audit-enhanced/search
 * Search audit log
 */
router.get("/audit-enhanced/search", attachRole, requireRole("viewer"), (req, res) => {
  try {
    const { q, contractId, limit = 100 } = req.query;

    if (!q) {
      return sendError(res, 400, "validation_failed", "Search term (q) is required");
    }

    const results = searchAuditLog(q, contractId || null, parseInt(limit));

    res.json({
      success: true,
      results: results.map((r) => ({
        ...r,
        details: JSON.parse(r.details),
      })),
      count: results.length,
    });
  } catch (err) {
    logger.error("Failed to search audit log", { error: err.message });
    return sendError(res, 500, "server_error", "Failed to search audit log");
  }
});

export const auditEnhancedRouter = router;
