import { Router } from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { sendError } from "../error-response.js";
import {
  createCsvImport,
  markImportSuccess,
  markImportFailed,
  getCsvImport,
  getCsvImportsByContract,
  addImportResult,
  getImportResults,
  getImportSummary,
} from "../database/csv-import.js";
import { addAuditLog } from "../database/audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, "..", "..", "uploads", "csv-imports");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".csv") {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are allowed"));
    }
  },
});

export const csvImportRouter = Router();

csvImportRouter.get("/template", (_req, res) => {
  const BOM = "\uFEFF";
  const headers = "address,share_percentage\n";
  const exampleRows = "GABCDEF1234567890XYZ,10\nG1234567890ABCDEFXYZ,15\nGXYZ1234567890ABCDEF,5";
  const csvContent = BOM + headers + exampleRows;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=contributor-template.csv");
  res.send(csvContent);
});

csvImportRouter.post("/validate", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, "upload_error", "No CSV file uploaded");
    }
    const csvContent = fs.readFileSync(req.file.path, "utf-8");
    const rows = parseCsv(csvContent);
    const validation = validateCsvRows(rows);
    fs.unlinkSync(req.file.path);
    res.json({ success: true, data: validation });
  } catch (err) {
    sendError(res, 500, "validation_error", err.message);
  }
});

csvImportRouter.post("/preview", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, "upload_error", "No CSV file uploaded");
    }
    const csvContent = fs.readFileSync(req.file.path, "utf-8");
    const rows = parseCsv(csvContent);
    const validation = validateCsvRows(rows);
    const importId = req.body.contractId ? Date.now().toString() : null;
    res.json({
      success: true,
      data: {
        importId,
        fileName: req.file.originalname,
        totalRows: validation.valid.length + validation.errors.length,
        validRows: validation.valid,
        errorRows: validation.errors,
        summary: {
          total: validation.valid.length + validation.errors.length,
          valid: validation.valid.length,
          errors: validation.errors.length,
        },
      },
    });
    fs.unlinkSync(req.file.path);
  } catch (err) {
    sendError(res, 500, "preview_error", err.message);
  }
});

csvImportRouter.post("/import", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return sendError(res, 400, "upload_error", "No CSV file uploaded");
    }
    const { contractId, importedBy } = req.body;
    if (!contractId) {
      return sendError(res, 400, "validation_error", "contractId is required");
    }

    const csvContent = fs.readFileSync(req.file.path, "utf-8");
    const rows = parseCsv(csvContent);
    const validation = validateCsvRows(rows);

    const csvImport = createCsvImport(
      contractId,
      req.file.originalname,
      validation.valid.length + validation.errors.length,
      importedBy ?? "unknown"
    );

    let successCount = 0;
    let errorCount = 0;

    for (const row of validation.valid) {
      addImportResult(csvImport.id, row.rowIndex, row.address, row.share, "success", null);
      successCount++;
    }

    for (const row of validation.errors) {
      addImportResult(
        csvImport.id,
        row.rowIndex,
        row.address ?? "",
        row.share ?? 0,
        "error",
        row.error
      );
      errorCount++;
    }

    if (errorCount === 0) {
      markImportSuccess(csvImport.id);
    } else {
      markImportFailed(csvImport.id, `${errorCount} row(s) had errors`);
    }

    addAuditLog(
      contractId,
      "csv_import",
      importedBy ?? "unknown",
      JSON.stringify({
        fileName: req.file.originalname,
        totalRows: validation.valid.length + validation.errors.length,
        successCount,
        errorCount,
        importId: csvImport.id,
      })
    );

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      data: {
        importId: csvImport.id,
        fileName: req.file.originalname,
        summary: {
          total: validation.valid.length + validation.errors.length,
          successCount,
          errorCount,
        },
      },
    });
  } catch (err) {
    sendError(res, 500, "import_error", err.message);
  }
});

csvImportRouter.get("/history/:contractId", (req, res) => {
  try {
    const imports = getCsvImportsByContract(req.params.contractId);
    res.json({ success: true, data: imports });
  } catch (err) {
    sendError(res, 500, "history_error", err.message);
  }
});

csvImportRouter.get("/results/:importId", (req, res) => {
  try {
    const importRecord = getCsvImport(parseInt(req.params.importId));
    if (!importRecord) {
      return sendError(res, 404, "not_found", "Import record not found");
    }
    const results = getImportResults(parseInt(req.params.importId));
    const summary = getImportSummary(parseInt(req.params.importId));
    res.json({ success: true, data: { import: importRecord, results, summary } });
  } catch (err) {
    sendError(res, 500, "results_error", err.message);
  }
});

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headerLine = lines[0]
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .trim();
  const headers = headerLine.split(",").map((h) => h.trim());

  const addressIdx = headers.indexOf("address");
  const shareIdx = headers.indexOf("share_percentage");

  if (addressIdx === -1 || shareIdx === -1) {
    throw new Error("CSV must have 'address' and 'share_percentage' columns");
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    rows.push({
      rowIndex: i,
      address: cols[addressIdx] ?? "",
      share: cols[shareIdx] ?? "",
    });
  }
  return rows;
}

function validateCsvRows(rows) {
  const valid = [];
  const errors = [];

  for (const row of rows) {
    const issues = [];

    if (!row.address) {
      issues.push("Address is required");
    } else if (!row.address.startsWith("G") || row.address.length !== 56) {
      issues.push("Invalid Stellar address (must start with G and be 56 characters)");
    }

    const shareNum = parseInt(row.share, 10);
    if (isNaN(shareNum) || shareNum < 0 || shareNum > 100) {
      issues.push("Share must be a number between 0 and 100");
    }

    if (issues.length > 0) {
      errors.push({ ...row, error: issues.join("; ") });
    } else {
      valid.push({ ...row, share: shareNum });
    }
  }

  const totalShare = valid.reduce((sum, r) => sum + r.share, 0);
  if (valid.length > 0 && totalShare !== 100) {
    errors.push(
      ...valid.splice(0, valid.length).map((r) => ({
        ...r,
        error: `Shares sum to ${totalShare}%, must sum to exactly 100%`,
      }))
    );
  }

  return { valid, errors };
}
