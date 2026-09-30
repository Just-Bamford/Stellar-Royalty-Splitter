/**
 * Compliance and regulatory reporting routes — closes #997.
 *
 * GET /api/v1/compliance/form-8949
 *   Generate IRS Form 8949 for capital gains/losses.
 *
 * GET /api/v1/compliance/turbotax
 *   Generate TurboTax-compatible CSV import.
 *
 * GET /api/v1/compliance/csv-export
 *   Export tax forms as CSV for spreadsheets.
 *
 * GET /api/v1/compliance/generic-ledger
 *   Export generic ledger format (JSON or CSV).
 *
 * GET /api/v1/compliance/sec-form-d
 *   Generate SEC Form D for private placements.
 *
 * GET /api/v1/compliance/finra-trace
 *   Generate FINRA TRACE trade report.
 *
 * GET /api/v1/compliance/export
 *   Full compliance export with multiple format options.
 *
 * GET /api/v1/compliance/audit-trail
 *   Audit trail of all generated reports.
 *
 * POST /api/v1/compliance/verify
 *   Verify accuracy of a generated report.
 *
 * All endpoints accept query params for filtering by walletAddress, date range, etc.
 * Admin role required for bulk exports; individual forms available to any authenticated caller.
 */

import { Router } from "express";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  generateForm8949,
  generateTurboTaxImport,
  generateCsvExport,
  generateGenericLedger,
  generateSecFormD,
  generateFinraTrace,
  exportComplianceReport,
  getAuditTrail,
  verifyReportAccuracy,
} from "../services/compliance-reporting.js";

export const complianceRouter = Router();

function parseCommonParams(req, res, { requireWallet = false } = {}) {
  const { walletAddress, taxYear, startDate, endDate } = req.query;

  if (requireWallet) {
    if (!walletAddress || typeof walletAddress !== "string") {
      sendError(res, 400, "missing_wallet_address", "walletAddress query parameter is required");
      return null;
    }
    if (!/^G[A-Z2-7]{55}$/.test(walletAddress)) {
      sendError(res, 400, "invalid_stellar_address", "walletAddress must be a valid Stellar G-address");
      return null;
    }
  }

  const year = taxYear ? String(taxYear) : String(new Date().getFullYear() - 1);
  if (!/^\d{4}$/.test(year) || Number(year) < 2020 || Number(year) > new Date().getFullYear()) {
    sendError(
      res,
      400,
      "invalid_tax_year",
      `taxYear must be a 4-digit year between 2020 and ${new Date().getFullYear()}`,
    );
    return null;
  }

  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    sendError(res, 400, "invalid_start_date", "startDate must be YYYY-MM-DD");
    return null;
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    sendError(res, 400, "invalid_end_date", "endDate must be YYYY-MM-DD");
    return null;
  }

  return { walletAddress, taxYear: year, startDate, endDate };
}

function parseDistributions(req) {
  try {
    if (req.body && Array.isArray(req.body.distributions)) {
      return req.body.distributions;
    }
    if (req.query.distributions) {
      const parsed = JSON.parse(req.query.distributions);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch {
    return [];
  }
  return [];
}

function sendCsv(res, csv, filename) {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
}

complianceRouter.get("/form-8949", async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: true });
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const { costBasisUsdPerXlm = 0, shortTerm = "true", force = "false" } = req.query;
  const distributions = parseDistributions(req);

  const result = await generateForm8949({
    walletAddress,
    taxYear,
    distributions,
    costBasisUsdPerXlm: parseFloat(costBasisUsdPerXlm) || 0,
    shortTerm: shortTerm === "true",
    force: force === "true",
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({ success: true, data: result.form });
});

complianceRouter.get("/turbotax", async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: true });
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const { costBasisUsdPerXlm = 0, force = "false" } = req.query;
  const distributions = parseDistributions(req);

  const result = await generateTurboTaxImport({
    walletAddress,
    taxYear,
    distributions,
    costBasisUsdPerXlm: parseFloat(costBasisUsdPerXlm) || 0,
    force: force === "true",
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/csv-export", async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: false });
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const { country = null, format = "detailed" } = req.query;

  const allowedCountries = ["US", "CA", "EU"];
  if (country && !allowedCountries.includes(country)) {
    return sendError(res, 400, "invalid_country", `country must be one of: ${allowedCountries.join(", ")}`);
  }

  const result = await generateCsvExport({
    walletAddress,
    taxYear,
    country,
    format,
  });

  if (!result.ok) {
    return sendError(res, 404, result.reason, result.reason);
  }

  if (req.query.download === "true") {
    return sendCsv(res, result.csv, `tax-export-${taxYear}${walletAddress ? `-${walletAddress.slice(0, 8)}` : ""}.csv`);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/generic-ledger", async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: false });
  if (!params) return;

  const { walletAddress, startDate, endDate } = params;
  const { contractId = "ALL", format = "json" } = req.query;

  if (!startDate || !endDate) {
    return sendError(res, 400, "missing_date_range", "startDate and endDate are required (YYYY-MM-DD)");
  }

  const allowedFormats = ["json", "csv"];
  if (!allowedFormats.includes(format)) {
    return sendError(res, 400, "invalid_format", `format must be one of: ${allowedFormats.join(", ")}`);
  }

  const result = await generateGenericLedger({
    walletAddress,
    startDate,
    endDate,
    contractId,
    format,
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  if (format === "csv" && req.query.download === "true") {
    return sendCsv(res, result.csv, `generic-ledger-${startDate}-to-${endDate}.csv`);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/sec-form-d", requireRole("admin"), async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: true });
  if (!params) return;

  const { walletAddress, taxYear } = params;
  const distributions = parseDistributions(req);
  const { issuerName, issuerCik, issuerAddress, issuerState } = req.query;

  const result = await generateSecFormD({
    walletAddress,
    taxYear,
    distributions,
    issuerInfo: {
      name: issuerName,
      cik: issuerCik,
      address: issuerAddress,
      stateOfIncorporation: issuerState,
    },
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({ success: true, data: result.form });
});

complianceRouter.get("/finra-trace", requireRole("admin"), async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: false });
  if (!params) return;

  const { walletAddress, startDate, endDate } = params;
  const { contractId = "ALL" } = req.query;

  if (!startDate || !endDate) {
    return sendError(res, 400, "missing_date_range", "startDate and endDate are required (YYYY-MM-DD)");
  }

  const result = await generateFinraTrace({
    walletAddress,
    startDate,
    endDate,
    contractId,
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/export", requireRole("admin"), async (req, res) => {
  const params = parseCommonParams(req, res, { requireWallet: false });
  if (!params) return;

  const { walletAddress, taxYear, startDate, endDate } = params;
  const { country = null, format = "json" } = req.query;

  const allowedCountries = ["US", "CA", "EU"];
  if (country && !allowedCountries.includes(country)) {
    return sendError(res, 400, "invalid_country", `country must be one of: ${allowedCountries.join(", ")}`);
  }

  const allowedFormats = ["json", "csv"];
  if (!allowedFormats.includes(format)) {
    return sendError(res, 400, "invalid_format", `format must be one of: ${allowedFormats.join(", ")}`);
  }

  const result = await exportComplianceReport({
    taxYear,
    format,
    walletAddress,
    country,
    startDate,
    endDate,
  });

  if (!result.ok) {
    return sendError(res, 400, result.reason, result.reason);
  }

  if (format === "csv" && req.query.download === "true") {
    return sendCsv(res, result.csv, `compliance-export-${taxYear}.csv`);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/audit-trail", async (req, res) => {
  const { walletAddress, startDate, endDate, limit = 100, offset = 0 } = req.query;

  if (walletAddress && typeof walletAddress === "string" && !/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_stellar_address", "walletAddress must be a valid Stellar G-address");
  }

  if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    sendError(res, 400, "invalid_start_date", "startDate must be YYYY-MM-DD");
    return;
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    sendError(res, 400, "invalid_end_date", "endDate must be YYYY-MM-DD");
    return;
  }

  const result = await getAuditTrail({
    walletAddress,
    startDate,
    endDate,
    limit: Math.min(parseInt(limit, 10), 500),
    offset: parseInt(offset, 10),
  });

  return res.json({ success: true, data: result });
});

complianceRouter.post("/verify", async (req, res) => {
  const { reportId, walletAddress, taxYear, distributions } = req.body;

  if (!reportId || !Number.isInteger(reportId) || reportId <= 0) {
    return sendError(res, 400, "invalid_report_id", "reportId must be a positive integer");
  }

  if (!walletAddress || typeof walletAddress !== "string" || !/^G[A-Z2-7]{55}$/.test(walletAddress)) {
    return sendError(res, 400, "invalid_wallet_address", "walletAddress must be a valid Stellar G-address");
  }

  const year = taxYear ? String(taxYear) : String(new Date().getFullYear() - 1);
  if (!/^\d{4}$/.test(year)) {
    return sendError(res, 400, "invalid_tax_year", "taxYear must be a 4-digit year");
  }

  const dists = Array.isArray(distributions) ? distributions : [];

  const result = await verifyReportAccuracy({
    reportId,
    walletAddress,
    taxYear: year,
    distributions: dists,
  });

  if (!result.ok) {
    return sendError(res, 404, result.reason, result.reason);
  }

  return res.json({ success: true, data: result });
});

complianceRouter.get("/list", async (req, res) => {
  const { type, contractId, status, limit = 50, offset = 0 } = req.query;

  const { listComplianceReports, countComplianceReports, REPORT_TYPES } = await import("../database/compliance-reports.js");

  const allowedTypes = REPORT_TYPES;
  if (type && !allowedTypes.includes(type)) {
    return sendError(res, 400, "invalid_type", `type must be one of: ${allowedTypes.join(", ")}`);
  }

  const reports = listComplianceReports(
    { type, contractId, status },
    Math.min(parseInt(limit, 10), 200),
    parseInt(offset, 10)
  );
  const total = countComplianceReports({ type, contractId, status });

  return res.json({
    success: true,
    data: reports,
    pagination: { total, limit: parseInt(limit, 10), offset: parseInt(offset, 10) },
  });
});

complianceRouter.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Report ID must be a positive integer");
  }

  const { getComplianceReport } = await import("../database/compliance-reports.js");
  const report = getComplianceReport(id);

  if (!report) {
    return sendError(res, 404, "report_not_found", `No compliance report with id ${id}`);
  }

  return res.json({ success: true, data: report });
});

complianceRouter.get("/:id/download", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return sendError(res, 400, "invalid_id", "Report ID must be a positive integer");
  }

  const { getComplianceReport } = await import("../database/compliance-reports.js");
  const report = getComplianceReport(id);

  if (!report) {
    return sendError(res, 404, "report_not_found", `No compliance report with id ${id}`);
  }

  if (!report.filePath) {
    return sendError(res, 404, "file_not_found", "Report file not found on disk");
  }

  import("fs").then(fs => {
    if (!fs.existsSync(report.filePath)) {
      return sendError(res, 404, "file_not_found", "Report file not found on disk");
    }

    import("path").then(path => {
      const fileName = path.basename(report.filePath);
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      fs.createReadStream(report.filePath).pipe(res);
    });
  });
});