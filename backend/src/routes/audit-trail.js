import { Router } from "express";
import { requirePermission } from "../middleware/rbac-check.js";
import { PERMISSIONS } from "../models/rbac.js";
import { sendError } from "../error-response.js";
import {
  buildComplianceExport,
  getAuditTrailStore,
  verifyAuditTrail,
  COMPLIANCE_STANDARDS,
} from "../services/audit-trail.js";

/**
 * Immutable audit trail administration (#938). Mounted at /admin/audit-trail.
 * Read-only by design: there is no route that modifies or deletes an entry.
 */
export const auditTrailRouter = Router();

auditTrailRouter.use(requirePermission(PERMISSIONS.AUDIT_READ));

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * GET /admin/audit-trail/status
 * Chain head, entry count, retention policy, and the last recorded verification.
 */
auditTrailRouter.get("/status", (_req, res, next) => {
  try {
    const trail = getAuditTrailStore();
    res.json({
      entries: trail.count(),
      head: trail.head(),
      anchor: trail.latestAnchor(),
      retentionDays: trail.retentionDays,
      hashAlgorithm: trail.hmacKey ? "hmac-sha256" : "sha256",
      lastVerification: trail.lastVerification(),
      standards: Object.keys(COMPLIANCE_STANDARDS),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/audit-trail/verify
 * Run a full hash-chain verification now. 200 when intact, 409 when tampering
 * was detected (the result body lists the failing entries either way).
 */
auditTrailRouter.post("/verify", async (_req, res, next) => {
  try {
    const result = await verifyAuditTrail();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /admin/audit-trail/export?standard=SOX|FINRA|GDPR&format=json|csv
 *   &from=<ISO>&to=<ISO>&contractId=<id>&subject=<address>
 */
auditTrailRouter.get("/export", (req, res, next) => {
  const { standard, format = "json", from, to, contractId, subject } = req.query;

  if (typeof standard !== "string" || !COMPLIANCE_STANDARDS[standard.toUpperCase()]) {
    return sendError(
      res,
      400,
      "bad_request",
      `standard must be one of ${Object.keys(COMPLIANCE_STANDARDS).join(", ")}`,
    );
  }
  for (const [name, value] of Object.entries({ from, to })) {
    if (value !== undefined && !isIsoDate(value)) {
      return sendError(res, 400, "bad_request", `${name} must be an ISO-8601 timestamp`);
    }
  }

  try {
    const exported = buildComplianceExport({
      standard: standard.toUpperCase(),
      format,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      contractId,
      subject,
    });
    res
      .status(200)
      .set("Content-Type", exported.contentType)
      .set("Content-Disposition", `attachment; filename="${exported.filename}"`)
      .set("X-Report-SHA256", exported.digest)
      .send(exported.body);
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, "bad_request", err.message);
    next(err);
  }
});
