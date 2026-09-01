/**
 * Compliance reports routes — closes #601.
 *
 * POST /api/v1/compliance-reports/generate
 *   Manually trigger a compliance report for a given period.
 *
 * GET  /api/v1/compliance-reports
 *   List archived compliance reports with filtering.
 *
 * GET  /api/v1/compliance-reports/:id
 *   Get a single report record (metadata + download path).
 *
 * GET  /api/v1/compliance-reports/:id/download
 *   Stream the HTML report file for download (admin only).
 */

import fs from "fs";
import path from "path";
import { Router } from "express";
import { z } from "zod";
import { sendError, sendValidationError } from "../error-response.js";
import {
  getComplianceReport,
  listComplianceReports,
  countComplianceReports,
  REPORT_TYPES,
} from "../database/index.js";
import { generateComplianceReport } from "../jobs/compliance-report-job.js";

export const complianceReportsRouter = Router();

// ─── Validation schemas ────────────────────────────────────────────────────────

const generateSchema = z
  .object({
    type: z.enum(REPORT_TYPES),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
    contractId: z.string().optional().default("ALL"),
  })
  .refine((d) => d.periodStart <= d.periodEnd, {
    message: "periodStart must be before or equal to periodEnd",
    path: ["periodStart"],
  });

const listQuerySchema = z.object({
  type: z.enum(REPORT_TYPES).optional(),
  contractId: z.string().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// ─── POST /api/v1/compliance-reports/generate ─────────────────────────────────

complianceReportsRouter.post("/generate", async (req, res, next) => {
  const result = generateSchema.safeParse(req.body);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { type, periodStart, periodEnd, contractId } = result.data;

  try {
    const outcome = await generateComplianceReport(type, periodStart, periodEnd, contractId);
    const status = outcome.skipped ? 200 : 201;
    return res.status(status).json({
      success: true,
      data: outcome,
      message: outcome.skipped
        ? "Report already exists for this period"
        : "Compliance report generated successfully",
    });
  } catch (err) {
    if (err.status) return sendError(res, err.status, undefined, err.message);
    next(err);
  }
});

// ─── GET /api/v1/compliance-reports ────────────────────────────────────────────

complianceReportsRouter.get("/", (req, res) => {
  const result = listQuerySchema.safeParse(req.query);
  if (!result.success) {
    return sendValidationError(
      res,
      result.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }))
    );
  }

  const { type, contractId, status, limit, offset } = result.data;
  const reports = listComplianceReports({ type, contractId, status }, limit, offset);
  const total = countComplianceReports({ type, contractId, status });

  return res.json({
    success: true,
    data: reports,
    pagination: { total, limit, offset },
  });
});

// ─── GET /api/v1/compliance-reports/:id ───────────────────────────────────────

complianceReportsRouter.get("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Report ID must be a positive integer");
  }

  const report = getComplianceReport(id);
  if (!report) {
    return sendError(res, 404, "report_not_found", `No compliance report with id ${id}`);
  }

  return res.json({ success: true, data: report });
});

// ─── GET /api/v1/compliance-reports/:id/download ──────────────────────────────

complianceReportsRouter.get("/:id/download", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Report ID must be a positive integer");
  }

  const report = getComplianceReport(id);
  if (!report) {
    return sendError(res, 404, "report_not_found", `No compliance report with id ${id}`);
  }

  if (!report.filePath || !fs.existsSync(report.filePath)) {
    return sendError(res, 404, "file_not_found", "Report file not found on disk");
  }

  const fileName = path.basename(report.filePath);
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  fs.createReadStream(report.filePath).pipe(res);
});
