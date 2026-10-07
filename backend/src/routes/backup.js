/**
 * Backup and disaster recovery routes.
 *
 *   POST /api/v1/backup/trigger         Trigger an immediate snapshot for a contract
 *   GET  /api/v1/backup/:contractId     List backup history (paginated, max 52)
 *   GET  /api/v1/backup/:contractId/latest  Get the most recent completed backup
 *   POST /api/v1/backup/:contractId/drill   Run a non-destructive recovery drill
 *   GET  /api/v1/backup/:id/export      Export a recovery bundle from a backup
 *
 * All mutating endpoints apply the write limiter in index.js.
 * Admin token (ADMIN_ROTATE_TOKEN Bearer) is required for trigger + drill.
 */

import { Router } from "express";
import { sendError } from "../error-response.js";
import { validateContractId, parsePagination } from "../validation.js";
import {
  listBackups,
  countBackups,
  getLatestBackup,
  getBackupById,
} from "../database/backups.js";
import { takeSnapshot } from "../services/contract-backup.js";
import { exportRecoveryBundle, runRecoveryDrill } from "../services/disaster-recovery.js";
import { isAdminRotateTokenValid } from "../signing-key.js";
import logger from "../logger.js";

export const backupRouter = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_ROTATE_TOKEN) {
    return sendError(res, 503, "service_unavailable", "Admin auth not configured on this server");
  }
  const header = req.get("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!isAdminRotateTokenValid(token)) {
    return sendError(res, 401, "unauthorized", "Unauthorized");
  }
  next();
}

// ── POST /api/v1/backup/trigger ───────────────────────────────────────────────

backupRouter.post("/trigger", requireAdmin, async (req, res, next) => {
  const { contractId, force = false } = req.body ?? {};

  if (!contractId || typeof contractId !== "string") {
    return sendError(res, 400, "missing_parameter", "contractId is required");
  }
  if (!validateContractId(contractId, res)) return;

  logger.info("Manual backup trigger requested", { contractId });

  try {
    const result = await takeSnapshot(contractId, new Date(), { force: Boolean(force) });

    if (result === null) {
      return res.json({
        skipped: true,
        message: "A backup already exists for the current ISO week. Pass force:true to override.",
      });
    }

    res.status(201).json({
      backupId: result.backupId,
      cid: result.cid,
      gatewayUrl: result.gatewayUrl,
      sizeBytes: result.sizeBytes,
      metrics: result.metrics,
      dryRun: result.dryRun,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/v1/backup/:contractId ───────────────────────────────────────────

backupRouter.get("/:contractId", (req, res) => {
  const { contractId } = req.params;
  if (!validateContractId(contractId, res)) return;

  const pagination = parsePagination(req.query, res, 52, 52);
  if (!pagination) return;

  const backups = listBackups(contractId, pagination.limit, pagination.offset);
  const total = countBackups(contractId);

  res.json({ backups, total, limit: pagination.limit, offset: pagination.offset });
});

// ── GET /api/v1/backup/:contractId/latest ────────────────────────────────────

backupRouter.get("/:contractId/latest", (req, res) => {
  const { contractId } = req.params;
  if (!validateContractId(contractId, res)) return;

  const backup = getLatestBackup(contractId);
  if (!backup) {
    return sendError(res, 404, "not_found", "No completed backup found for this contract");
  }

  res.json({ backup });
});

// ── POST /api/v1/backup/:contractId/drill ────────────────────────────────────

backupRouter.post("/:contractId/drill", requireAdmin, async (req, res, next) => {
  const { contractId } = req.params;
  if (!validateContractId(contractId, res)) return;

  const backupId = req.body?.backupId ? parseInt(req.body.backupId, 10) : null;
  if (req.body?.backupId !== undefined && (!Number.isInteger(backupId) || backupId <= 0)) {
    return sendError(res, 400, "invalid_parameter", "backupId must be a positive integer");
  }

  try {
    const result = await runRecoveryDrill(contractId, backupId);
    res.json(result);
  } catch (err) {
    if (err?.message?.includes("not found") || err?.message?.includes("No completed")) {
      return sendError(res, 404, "not_found", err.message);
    }
    next(err);
  }
});

// ── GET /api/v1/backup/:contractId/export/:backupId ──────────────────────────

backupRouter.get("/:contractId/export/:backupId", requireAdmin, async (req, res, next) => {
  const { contractId } = req.params;
  if (!validateContractId(contractId, res)) return;

  const backupId = parseInt(req.params.backupId, 10);
  if (!Number.isInteger(backupId) || backupId <= 0) {
    return sendError(res, 400, "invalid_parameter", "backupId must be a positive integer");
  }

  // Verify the backup belongs to the requested contract
  const record = getBackupById(backupId);
  if (!record || record.contractId !== contractId) {
    return sendError(res, 404, "not_found", `Backup ${backupId} not found for this contract`);
  }

  try {
    const bundle = await exportRecoveryBundle(contractId, backupId);
    res.json(bundle);
  } catch (err) {
    if (err?.message?.includes("not found") || err?.message?.includes("No completed")) {
      return sendError(res, 404, "not_found", err.message);
    }
    if (err?.message?.includes("validation failed")) {
      return sendError(res, 422, "snapshot_invalid", err.message);
    }
    next(err);
  }
});
