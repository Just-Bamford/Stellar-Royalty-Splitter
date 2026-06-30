import { Router } from "express";
import { exportAuditLogs } from "../database/index.js";
import { getSigningKeypair, isAdminRotateTokenValid } from "../signing-key.js";
import { sendError } from "../error-response.js";
import logger from "../logger.js";
import zlib from "zlib";

export const auditExportRouter = Router();

/**
 * Require valid bearer token corresponding to ADMIN_ROTATE_TOKEN.
 */
function requireAdminToken(req, res, next) {
  if (!process.env.ADMIN_ROTATE_TOKEN) {
    logger.warn("Admin export rejected: ADMIN_ROTATE_TOKEN not configured", {
      event: "audit_export_denied",
      reason: "token_not_configured",
    });
    return sendError(
      res,
      503,
      "service_unavailable",
      "Admin token is not configured on this server"
    );
  }

  const authHeader = req.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  const token = authHeader.slice("Bearer ".length).trim();
  if (!isAdminRotateTokenValid(token)) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

/**
 * Standard RFC 4180-compliant CSV serializer.
 */
export function stringifyCSV(records, headers) {
  const escapeField = (val) => {
    if (val === null || val === undefined) return "";
    const str = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [];
  lines.push(headers.join(","));

  for (const record of records) {
    const row = headers.map((header) => escapeField(record[header]));
    lines.push(row.join(","));
  }

  return lines.join("\n");
}

auditExportRouter.get("/audit-export", requireAdminToken, (req, res, next) => {
  try {
    const format = (req.query.format || "json").toLowerCase();
    if (format !== "json" && format !== "csv") {
      return sendError(
        res,
        400,
        "invalid_format",
        "Format must be either 'json' or 'csv'"
      );
    }

    const { start, end, contractId, action } = req.query;

    const dateRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?)?$/;
    if (start && !dateRegex.test(start)) {
      return sendError(
        res,
        400,
        "invalid_start_date",
        "Start date must be in YYYY-MM-DD or ISO 8601 format"
      );
    }
    if (end && !dateRegex.test(end)) {
      return sendError(
        res,
        400,
        "invalid_end_date",
        "End date must be in YYYY-MM-DD or ISO 8601 format"
      );
    }

    let startVal = start;
    if (startVal && /^\d{4}-\d{2}-\d{2}$/.test(startVal)) {
      startVal = `${startVal}T00:00:00.000Z`;
    }
    let endVal = end;
    if (endVal && /^\d{4}-\d{2}-\d{2}$/.test(endVal)) {
      endVal = `${endVal}T23:59:59.999Z`;
    }

    const maxLimit = 10000;
    let limit = parseInt(req.query.limit ?? "10000", 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > maxLimit) {
      limit = maxLimit;
    }
    let offset = parseInt(req.query.offset ?? "0", 10);
    if (Number.isNaN(offset) || offset < 0) {
      offset = 0;
    }

    const filters = {
      contractId,
      action,
      start: startVal,
      end: endVal,
    };

    const records = exportAuditLogs(filters, limit, offset);

    const keypair = getSigningKeypair();
    if (!keypair) {
      return sendError(
        res,
        500,
        "signing_key_not_configured",
        "Server signing key is not configured"
      );
    }

    const headers = ["timestamp", "action", "contractId", "actor", "details"];

    let bodyData = "";
    let contentType = "";

    if (format === "csv") {
      bodyData = stringifyCSV(records, headers);
      contentType = "text/csv";
    } else {
      // JSON format
      const dataStr = JSON.stringify(records);
      const signature = keypair.sign(Buffer.from(dataStr)).toString("base64");
      const responsePayload = {
        signature,
        publicKey: keypair.publicKey(),
        data: records,
      };
      bodyData = JSON.stringify(responsePayload);
      contentType = "application/json";
    }

    // Set signature headers
    const fullSignature = keypair.sign(Buffer.from(bodyData)).toString("base64");
    res.setHeader("X-Export-Signature", fullSignature);
    res.setHeader("X-Export-Public-Key", keypair.publicKey());
    res.setHeader("Content-Type", contentType);

    // Compress if > 1MB
    let outputBuffer = Buffer.from(bodyData, "utf8");
    if (outputBuffer.length > 1024 * 1024) {
      outputBuffer = zlib.gzipSync(outputBuffer);
      res.setHeader("Content-Encoding", "gzip");
    }

    res.send(outputBuffer);
  } catch (err) {
    next(err);
  }
});
