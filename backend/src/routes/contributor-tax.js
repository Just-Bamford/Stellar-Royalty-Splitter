import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { sendError } from "../error-response.js";
import { requireRole } from "../middleware/rbac.js";
import {
  getContributorTax,
  upsertContributorTax,
  getTaxComplianceReport,
  getContributorsMissingTaxInfo,
} from "../database/contributor-tax.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads", "tax-documents");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

// W-9 and W-8BEN forms are small PDFs or scans, typically well under 1 MB.
// 5 MB leaves headroom for high-resolution scans without letting a single
// upload fill disk before it is ever processed.
const MAX_TAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage,
  // busboy (used by multer) rejects a file once its size reaches the limit, so
  // the limit is one byte above the largest file that should be accepted.
  limits: { fileSize: MAX_TAX_DOCUMENT_BYTES + 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = [".pdf", ".png", ".jpg", ".jpeg"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, PNG, and JPG files are allowed"));
    }
  },
});

export const contributorTaxRouter = Router();

/**
 * GET /api/v1/contributor-tax/export
 * CSV export of contributor payout/tax records for tax reporting (#741).
 * Admin only — this covers all contributors, not a single wallet's own data.
 *
 * Registered before the `/:walletAddress` route below so the literal
 * `/export` path isn't swallowed by that param route.
 */
function escapeCSVField(value) {
  if (value === null || value === undefined) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

contributorTaxRouter.get("/export", requireRole("admin"), (_req, res) => {
  try {
    const report = getTaxComplianceReport();

    const headers = [
      "Wallet Address",
      "Tax Status",
      "Tax ID",
      "Compliance Status",
      "W9 File Name",
      "Updated At",
    ];
    const rows = [headers.map(escapeCSVField).join(",")];

    for (const row of report) {
      rows.push(
        [
          escapeCSVField(row.walletAddress),
          escapeCSVField(row.tax_status),
          escapeCSVField(row.tax_id),
          escapeCSVField(row.compliance_status),
          escapeCSVField(row.w9_file_name),
          escapeCSVField(row.updated_at),
        ].join(","),
      );
    }

    const csvContent = rows.join("\n");

    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="contributor-tax-export.csv"`);
    return res.status(200).send(csvContent);
  } catch (err) {
    sendError(res, 500, "export_generation_failed", "Failed to generate contributor tax export");
  }
});

contributorTaxRouter.get("/:walletAddress", (req, res) => {
  try {
    const taxInfo = getContributorTax(req.params.walletAddress);
    res.json({ success: true, data: taxInfo });
  } catch (err) {
    sendError(res, 500, "tax_fetch_error", err.message);
  }
});

contributorTaxRouter.post("/", (req, res) => {
  try {
    const { walletAddress, tax_status, tax_id } = req.body;
    if (!walletAddress) {
      return sendError(res, 400, "validation_error", "walletAddress is required");
    }
    if (!tax_status) {
      return sendError(res, 400, "validation_error", "tax_status is required");
    }
    const validStatuses = ["not_collected", "pending", "completed", "exempt"];
    if (!validStatuses.includes(tax_status)) {
      return sendError(res, 400, "validation_error", `tax_status must be one of: ${validStatuses.join(", ")}`);
    }
    const taxInfo = upsertContributorTax({ walletAddress, tax_status, tax_id });
    res.json({ success: true, data: taxInfo });
  } catch (err) {
    sendError(res, 500, "tax_save_error", err.message);
  }
});

/**
 * Runs the multer upload and turns its errors into the standard error shape:
 * oversized files get 413, and rejected types or other multer failures get 400.
 */
function handleTaxDocumentUpload(req, res, next) {
  upload.single("taxDocument")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return sendError(
        res,
        413,
        "file_too_large",
        `Tax documents must be ${MAX_TAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller`,
      );
    }
    return sendError(res, 400, "upload_error", err.message);
  });
}

contributorTaxRouter.post("/upload/:walletAddress", handleTaxDocumentUpload, (req, res) => {
  let stored = false;
  try {
    if (!req.file) {
      return sendError(res, 400, "upload_error", "No file uploaded");
    }
    const taxInfo = upsertContributorTax({
      walletAddress: req.params.walletAddress,
      tax_status: "pending",
      w9_file_path: req.file.path,
      w9_file_name: req.file.originalname,
    });
    stored = true;
    res.json({ success: true, data: taxInfo, file: { name: req.file.originalname, size: req.file.size } });
  } catch (err) {
    sendError(res, 500, "upload_error", err.message);
  } finally {
    if (req.file && !stored) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // The processing error is the response clients need; cleanup is best effort.
      }
    }
  }
});

contributorTaxRouter.get("/document/:walletAddress", (req, res) => {
  try {
    const taxInfo = getContributorTax(req.params.walletAddress);
    if (!taxInfo || !taxInfo.w9_file_path) {
      return sendError(res, 404, "document_not_found", "No tax document found");
    }
    if (!fs.existsSync(taxInfo.w9_file_path)) {
      return sendError(res, 404, "document_not_found", "Tax document file not found on disk");
    }
    res.download(taxInfo.w9_file_path, taxInfo.w9_file_name ?? "tax-document.pdf");
  } catch (err) {
    sendError(res, 500, "document_error", err.message);
  }
});

contributorTaxRouter.get("/report/compliance", requireRole("admin"), (_req, res) => {
  try {
    const report = getTaxComplianceReport();
    res.json({
      success: true,
      data: report,
      summary: {
        total: report.length,
        compliant: report.filter(r => r.compliance_status === 'compliant').length,
        nonCompliant: report.filter(r => r.compliance_status === 'non_compliant').length,
        missing: report.filter(r => r.compliance_status === 'missing').length,
      }
    });
  } catch (err) {
    sendError(res, 500, "report_error", err.message);
  }
});

contributorTaxRouter.get("/report/missing", requireRole("admin"), (_req, res) => {
  try {
    const missing = getContributorsMissingTaxInfo();
    res.json({ success: true, data: missing, count: missing.length });
  } catch (err) {
    sendError(res, 500, "report_error", err.message);
  }
});
