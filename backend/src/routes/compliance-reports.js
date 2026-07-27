/**
 * Compliance Report routes (#601).
 *
 * GET    /api/v1/compliance-reports            — List archived reports
 * POST   /api/v1/compliance-reports/generate   — Manually generate a report
 * GET    /api/v1/compliance-reports/config     — Get schedule config
 * PATCH  /api/v1/compliance-reports/config     — Update schedule config
 * GET    /api/v1/compliance-reports/:id        — Get a specific report
 *
 * NOTE: Static-path routes (generate, config) are registered BEFORE the
 * parameterised /:id route so Express doesn't capture them as IDs.
 */

import { Router } from "express";
import { z } from "zod";
import {
  listComplianceReports,
  getComplianceReport,
  getComplianceScheduleConfig,
  updateComplianceScheduleConfig,
} from "../database/compliance-reports.js";
import { generateComplianceReport } from "../jobs/compliance-report-job.js";
import { sendError } from "../error-response.js";
import { addAuditLog } from "../database/audit.js";
import logger from "../logger.js";

const router = Router();

const generateSchema = z.object({
  report_type: z.enum(["monthly", "quarterly", "annual", "custom"]),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format"),
});

const scheduleConfigSchema = z.object({
  monthly_enabled: z.boolean().optional(),
  quarterly_enabled: z.boolean().optional(),
  annual_enabled: z.boolean().optional(),
  email_recipients: z.array(z.string().email()).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance-reports
// List archived reports, optionally filter by type
// ---------------------------------------------------------------------------
router.get("/", (req, res) => {
  const reportType = req.query.type ?? null;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const validTypes = ["monthly", "quarterly", "annual", "custom"];
  if (reportType && !validTypes.includes(reportType)) {
    return sendError(
      res,
      400,
      "invalid_query_parameter",
      `type must be one of: ${validTypes.join(", ")}`
    );
  }

  try {
    const reports = listComplianceReports(reportType, limit, offset);
    return res.json({
      success: true,
      data: reports,
      pagination: { limit, offset, count: reports.length },
    });
  } catch (err) {
    logger.error("Failed to list compliance reports", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to list reports");
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/compliance-reports/generate  (static — BEFORE /:id)
// Manually trigger report generation for any type/period
// ---------------------------------------------------------------------------
router.post("/generate", async (req, res) => {
  const result = generateSchema.safeParse(req.body);
  if (!result.success) {
    return sendError(
      res,
      400,
      "validation_error",
      result.error.issues[0]?.message ?? "Validation failed"
    );
  }

  const { report_type, period_start, period_end } = result.data;

  if (new Date(period_start) > new Date(period_end)) {
    return sendError(res, 400, "validation_error", "period_start must be before period_end");
  }

  try {
    const report = await generateComplianceReport(report_type, period_start, period_end);

    addAuditLog("system", "compliance_report_manual_generated", "admin", {
      reportId: report.id,
      report_type,
      period_start,
      period_end,
    });

    return res.status(201).json({ success: true, data: report });
  } catch (err) {
    logger.error("Failed to generate compliance report", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to generate report");
  }
});

// ---------------------------------------------------------------------------
// GET  /api/v1/compliance-reports/config  (static — BEFORE /:id)
// PATCH /api/v1/compliance-reports/config
// ---------------------------------------------------------------------------
router.get("/config", (req, res) => {
  try {
    const config = getComplianceScheduleConfig();
    if (config) {
      try {
        config.email_recipients = JSON.parse(config.email_recipients ?? "[]");
      } catch (_) {}
    }
    return res.json({ success: true, data: config });
  } catch (err) {
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get config");
  }
});

router.patch("/config", (req, res) => {
  const result = scheduleConfigSchema.safeParse(req.body);
  if (!result.success) {
    return sendError(
      res,
      400,
      "validation_error",
      result.error.issues[0]?.message ?? "Validation failed"
    );
  }

  try {
    const updated = updateComplianceScheduleConfig(result.data);
    if (updated) {
      try {
        updated.email_recipients = JSON.parse(updated.email_recipients ?? "[]");
      } catch (_) {}
    }

    addAuditLog("system", "compliance_schedule_config_updated", "admin", result.data);

    return res.json({ success: true, data: updated });
  } catch (err) {
    logger.error("Failed to update compliance config", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to update config");
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/compliance-reports/:id  (parameterised — AFTER static routes)
// ---------------------------------------------------------------------------
router.get("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return sendError(res, 400, "invalid_id", "Invalid report ID");
  }

  try {
    const report = getComplianceReport(id);
    if (!report) {
      return sendError(res, 404, "not_found", "Report not found");
    }
    return res.json({ success: true, data: report });
  } catch (err) {
    logger.error("Failed to get compliance report", { error: err.message });
    return sendError(res, 500, "internal_server_error", err.message ?? "Failed to get report");
  }
});

export { router as complianceReportsRouter };
