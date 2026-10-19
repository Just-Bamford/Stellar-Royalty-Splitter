import { Router } from "express";
import { createHash } from "node:crypto";
import { requireRole } from "../middleware/rbac.js";
import { db } from "../database/core.js";
import { sendError } from "../error-response.js";

export const complianceAuditRouter = Router();

function rowsFor(contractId) {
  return db.prepare(`SELECT id, contractId, action, user, details, timestamp, prevHash, entryHash FROM audit_log WHERE contractId = ? ORDER BY id ASC`).all(contractId);
}

function verify(rows) {
  let previous = null;
  for (const row of rows) {
    const details = (() => { try { return JSON.parse(row.details || "{}"); } catch { return row.details; } })();
    const payload = JSON.stringify({ contractId: row.contractId, action: row.action, user: row.user, details, timestamp: row.timestamp, prevHash: row.prevHash });
    const expected = createHash("sha256").update(payload).digest("hex");
    if (row.prevHash !== previous || row.entryHash !== expected) return { valid: false, brokenAt: row.id };
    previous = row.entryHash;
  }
  return { valid: true, entries: rows.length };
}

complianceAuditRouter.get("/:contractId", requireRole("admin"), (req, res) => {
  const rows = rowsFor(req.params.contractId);
  const result = verify(rows);
  if (!result.valid) return sendError(res, 409, "audit_integrity_failure", "Audit chain verification failed", result);
  res.json({ success: true, data: { entries: rows, ...result } });
});

complianceAuditRouter.get("/:contractId/export", requireRole("admin"), (req, res) => {
  const rows = rowsFor(req.params.contractId);
  const result = verify(rows);
  if (!result.valid) return sendError(res, 409, "audit_integrity_failure", "Audit chain verification failed", result);
  res.set("Content-Disposition", `attachment; filename="audit-${req.params.contractId}.json"`);
  res.type("application/json").send(JSON.stringify({ exportedAt: new Date().toISOString(), contractId: req.params.contractId, ...result, entries: rows }, null, 2));
});
